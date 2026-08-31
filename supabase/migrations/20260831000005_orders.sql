-- ============================================================================
-- Orders
-- ============================================================================
-- THREE INDEPENDENT STATE DIMENSIONS. Never merged, and delivery state is never
-- a proxy for order state: a failed delivery does not destroy the food order.
-- ============================================================================

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null default public.next_order_number(),

  customer_id       uuid not null references public.users (id) on delete restrict,
  vendor_id         uuid not null references public.vendors (id) on delete restrict,
  partner_id        uuid references public.users (id) on delete restrict,

  fulfilment_type   public.fulfilment_type not null,

  -- Dimension 1: the food
  order_status      public.order_status not null default 'DRAFT',
  -- Dimension 2: the money
  payment_status    public.payment_status not null default 'UNPAID',
  -- Dimension 3: the Partner
  delivery_status   public.delivery_status not null default 'NONE',

  -- --- Destination --------------------------------------------------------
  -- Full room-level destination. Revealed to the Partner ONLY after the vendor
  -- confirms handoff.
  destination_location_id uuid references public.locations (id) on delete restrict,
  destination_note        text,
  -- Block-level ancestor, snapshotted at submit. This is what a Partner sees in
  -- the offer: enough to judge the walk, not enough to identify the customer.
  destination_zone_id     uuid references public.locations (id) on delete restrict,

  -- --- Money (all integer pesewas, all server-calculated) ------------------
  subtotal_pesewas          bigint not null default 0 check (subtotal_pesewas >= 0),
  service_fee_pesewas       bigint not null default 0 check (service_fee_pesewas >= 0),
  delivery_fee_pesewas      bigint not null default 0 check (delivery_fee_pesewas >= 0),
  partner_earnings_pesewas  bigint not null default 0 check (partner_earnings_pesewas >= 0),
  total_pesewas             bigint not null default 0 check (total_pesewas >= 0),

  -- --- Timestamps for the order board and staleness sorting ----------------
  submitted_at      timestamptz,
  accept_deadline_at timestamptz,
  accepted_at       timestamptz,
  preparing_at      timestamptz,
  ready_at          timestamptz,
  search_started_at timestamptz,
  search_deadline_at timestamptz,
  assigned_at       timestamptz,
  picked_up_at      timestamptz,
  delivered_at      timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  cancellation_reason text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- The server's arithmetic is checked by the database, not merely trusted.
  constraint orders_total_is_sum check (
    total_pesewas = subtotal_pesewas + service_fee_pesewas + delivery_fee_pesewas
  ),
  -- The Partner can never earn more than the delivery fee actually collected.
  constraint orders_partner_earnings_within_fee check (
    partner_earnings_pesewas <= delivery_fee_pesewas
  ),
  -- Pickup orders carry no delivery money and never enter the dispatch flow.
  constraint orders_pickup_has_no_delivery check (
    fulfilment_type <> 'PICKUP'
      or (delivery_fee_pesewas = 0
          and partner_earnings_pesewas = 0
          and delivery_status = 'NONE'
          and partner_id is null)
  ),
  -- A delivery order must have somewhere to go.
  constraint orders_delivery_needs_destination check (
    fulfilment_type <> 'DELIVERY' or destination_location_id is not null
  ),
  -- A Partner is attached exactly when the delivery is live with one.
  constraint orders_partner_matches_delivery_state check (
    (partner_id is not null) = (delivery_status in ('ASSIGNED', 'PICKED_UP', 'DELIVERED'))
  )
);

create unique index orders_order_number_key on public.orders (order_number);

-- === CONCURRENCY CONSTRAINT: one active delivery per Partner ================
-- Enforced by the database, not by JavaScript. Two Partners racing to accept
-- the same order, or one Partner racing to take a second, cannot both win.
create unique index orders_one_active_delivery_per_partner
  on public.orders (partner_id)
  where partner_id is not null and delivery_status in ('ASSIGNED', 'PICKED_UP');

-- Dispatch and order-board query paths.
create index orders_customer_idx      on public.orders (customer_id, created_at desc);
create index orders_vendor_active_idx on public.orders (vendor_id, order_status, created_at desc);
create index orders_partner_idx       on public.orders (partner_id) where partner_id is not null;
create index orders_searching_idx     on public.orders (search_started_at)
  where delivery_status = 'SEARCHING';
create index orders_awaiting_vendor_idx on public.orders (accept_deadline_at)
  where order_status = 'SUBMITTED';

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Order items — PRICE SNAPSHOT
-- ---------------------------------------------------------------------------
-- name and unit price are COPIED at submit time. If the vendor later moves an
-- item from GH₵20 to GH₵25, this order still says GH₵20 forever.
create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,

  -- Kept for reporting only. The snapshot below is what the order actually is.
  menu_item_id  uuid references public.menu_items (id) on delete set null,

  name_snapshot          text   not null,
  unit_price_pesewas     bigint not null check (unit_price_pesewas > 0),
  quantity               integer not null check (quantity > 0 and quantity <= 50),
  line_total_pesewas     bigint not null check (line_total_pesewas > 0),

  created_at    timestamptz not null default now(),

  constraint order_items_line_total_is_product check (
    line_total_pesewas = unit_price_pesewas * quantity
  )
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Order secrets — pickup and delivery codes
-- ---------------------------------------------------------------------------
-- Separate table with NO client-readable RLS policy at all. Nobody SELECTs
-- these directly, ever. They reach the entitled party by SMS and through a
-- SECURITY DEFINER function that checks entitlement first.
--
-- In particular the VENDOR must never be able to read pickup_code: if they
-- could, they could confirm handoff without the Partner presenting it, which is
-- the whole point of the code. The vendor types in what they hear.
create table public.order_secrets (
  order_id            uuid primary key references public.orders (id) on delete cascade,

  pickup_code         text,
  -- Rotated on every reassignment. Bumping this invalidates the previous code
  -- instantly; the old value is not merely unused, it is gone.
  pickup_code_version integer not null default 0,
  pickup_code_set_at  timestamptz,

  delivery_code       text,
  delivery_code_set_at timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint order_secrets_pickup_code_format check (pickup_code is null or pickup_code ~ '^\d{4}$'),
  constraint order_secrets_delivery_code_format check (delivery_code is null or delivery_code ~ '^\d{4}$')
);

create trigger order_secrets_set_updated_at
  before update on public.order_secrets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Order events — append-only transition log
-- ---------------------------------------------------------------------------
-- EVERY attempted state transition lands here, accepted or rejected. A rejected
-- transition is a fact worth keeping: it is how we detect a race, a replayed
-- request, or a client trying something it should not.
create table public.order_events (
  id            bigserial primary key,
  order_id      uuid not null references public.orders (id) on delete cascade,
  actor_id      uuid references public.users (id) on delete set null,
  actor_role    text not null,
  event         text not null,
  dimension     text,
  from_state    text,
  to_state      text,
  accepted      boolean not null,
  reason        text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, created_at desc);
create index order_events_rejected_idx on public.order_events (created_at desc) where not accepted;
