-- ============================================================================
-- Scan Delivery — a second business mode, not a second application
-- ============================================================================
-- A student already holds a prepaid campus meal entitlement (a "scan"). They do
-- not want to walk to the restaurant. Campus Dash sells them the errand: a
-- Partner carries the scan, redeems it at the counter, and brings the food.
--
-- THE ONE SENTENCE THAT GOVERNS EVERY LINE BELOW:
--
--   Campus Dash does not sell the food. It sells the errand.
--
-- So the food has NO price here, the restaurant earns NOTHING through us, and
-- the scan's face value never appears in our ledger in any form. The meal
-- entitlement is settled between the student and the university's own system;
-- we are not a party to it.
--
-- WHAT THIS REUSES, DELIBERATELY. Identity, the Partner system, dispatch, the
-- delivery codes, payments, allocations, settlement, notifications and the
-- storage pattern are all the existing ones. A scan order is an `orders` row
-- with a different `order_type`, not a parallel universe.
--
-- WHAT IS GENUINELY NEW. Three things, and only three:
--   1. a fourth state dimension, `scan_status`, because redemption is a fact
--      about the scan and not about the delivery (hard rule 2 forbids merging
--      them);
--   2. an artifact table + private bucket for the scan image, with release
--      tied to the currently assigned Partner;
--   3. a service fee that is not a percentage of food, because there is no food.
--
-- ON THE FEE — GH₵2.00 FLAT, and flat is the point.
--
-- `service_fee_bps` is a percentage of the food subtotal. A scan order has no
-- subtotal, so that formula yields zero — and since
-- `partner_share_of_delivery_bps` is 10000, the Partner already takes the whole
-- delivery fee. A zero fee would mean Campus Dash runs every scan errand at a
-- loss once Paystack takes its cut.
--
-- So the scan fee lives in its own column, `scan_service_fee_pesewas`, and this
-- migration sets it to 200. It is NOT a percentage of anything: there is no
-- Campus Dash food value to take a percentage of, and the meal's face value
-- belongs to the university's system, not to our pricing. The errand is the
-- same work whatever the meal is worth.
--
-- The column stays NULLABLE even though the number is now decided, because null
-- still means something: "nobody has set a price", at which point
-- price_scan_order() refuses to quote rather than quietly giving the errand
-- away. Null is undecided; 0 would be a decision to work for free.
--
-- A scan order therefore costs the customer:
--   food GH₵0.00  +  delivery GH₵5.00  +  scan service GH₵2.00  =  GH₵7.00
--
-- ON WHAT THIS DOES NOT CLAIM. Campus Dash has no integration with the
-- university's scan system and does not pretend to verify a scan. It guarantees
-- that ITS OWN order cannot be redeemed twice through this workflow. Whether
-- the underlying entitlement is still valid is answered at the restaurant
-- counter, by the restaurant, using the process it already has. See
-- partner_report_scan_redeemed() — it records a Partner's REPORT, and is named
-- that way so nobody later mistakes it for verification.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create type public.order_type as enum ('FOOD', 'SCAN');

comment on type public.order_type is
  'FOOD: Campus Dash sells the food. SCAN: the food is already paid for through '
  'the campus meal system and Campus Dash sells only the errand.';

-- The FOURTH state dimension. order_status, payment_status and delivery_status
-- are untouched and keep their exact meanings.
--
-- It exists because "the Partner has the food" and "the scan was redeemed" are
-- different claims. A Partner who accepted a delivery has NOT thereby redeemed
-- anything, and the schema has to be able to say so.
create type public.scan_status as enum (
  'UPLOADED',   -- on file, visible to nobody but the customer and an admin
  'RELEASED',   -- an assigned Partner may now read it, and only that Partner
  'REDEEMED',   -- the assigned Partner reports the restaurant honoured it
  'REFUSED'     -- the restaurant would not honour it; money is NOT moved here
);

comment on type public.scan_status is
  'The scan artifact''s own lifecycle. Independent of order_status, '
  'payment_status and delivery_status — never merge them.';


-- ---------------------------------------------------------------------------
-- 2. Which restaurants accept scans
-- ---------------------------------------------------------------------------
-- Not every vendor is on the campus meal system. Default false: a vendor
-- becomes scan-capable only when an administrator says so, which is also the
-- audit trail for that decision.

alter table public.vendors
  add column if not exists can_accept_scans boolean not null default false;

comment on column public.vendors.can_accept_scans is
  'Whether this restaurant honours campus meal scans. Set by an administrator.';


-- ---------------------------------------------------------------------------
-- 3. The scan service fee
-- ---------------------------------------------------------------------------
-- GH₵2.00 flat, set below. Nullable so that "unpriced" stays expressible and
-- keeps refusing to quote. See the header.

-- DEFAULT 200, and the default is load-bearing.
--
-- A hosted project is installed from supabase/schema.sql, whose reference-data
-- INSERT names only the pricing_config columns that have NO default and lets
-- defaults carry the rest — deliberately, so that adding a column cannot make
-- that INSERT drift. A nullable column with no default would therefore install
-- as NULL, and price_scan_order() would refuse to quote on a brand-new
-- production project. The default is what makes a fresh install correctly
-- priced.
--
-- ADD COLUMN with a DEFAULT also backfills the existing singleton row, so an
-- already-installed database is priced by this line alone.
alter table public.pricing_config
  add column if not exists scan_service_fee_pesewas bigint default 200;

alter table public.pricing_config
  drop constraint if exists pricing_config_scan_service_fee_check;
alter table public.pricing_config
  add constraint pricing_config_scan_service_fee_check
    check (scan_service_fee_pesewas is null or scan_service_fee_pesewas >= 0);

-- THE DECIDED PRICE: GH₵2.00 flat, per scan errand.
--
-- Flat, and deliberately not a percentage of anything. There is no food value
-- in a scan order to take a percentage OF, and the meal's face value is not
-- ours to price against — it belongs to the university's meal system. So this
-- is a fee for the service Campus Dash actually performs, which is the same
-- amount of work whether the scan is worth GH₵10 or GH₵40.
--
-- Belt and braces behind the DEFAULT above. ADD COLUMN ... DEFAULT already
-- backfills the singleton, and this covers the one case it does not: a database
-- where the column somehow exists already but was never given a value, which is
-- exactly the state this migration would find if an earlier draft of it had been
-- applied.
--
-- The column stays NULLABLE so the "not configured" guard in price_scan_order()
-- keeps its meaning: if the value is ever deliberately cleared, scan ordering
-- stops rather than quietly becoming free. Null is undecided; 0 would be a
-- decision to give the errand away.
update public.pricing_config
   set scan_service_fee_pesewas = 200
 where id and scan_service_fee_pesewas is null;

comment on column public.pricing_config.scan_service_fee_pesewas is
  'Flat Campus Dash fee for one scan delivery, in pesewas. Currently 200 '
  '(GH₵2.00). NULL means not configured, and scan ordering is refused until an '
  'administrator sets it. NULL is not the same as 0: 0 would mean the errand is '
  'deliberately free.';


-- ---------------------------------------------------------------------------
-- 4. Orders gain a type and a scan dimension
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists order_type  public.order_type not null default 'FOOD';
alter table public.orders
  add column if not exists scan_status public.scan_status;

-- A scan order is delivery-only. The entire premise is "I do not want to walk
-- there", so a pickup scan order is a contradiction, not a configuration.
alter table public.orders drop constraint if exists orders_scan_is_delivery;
alter table public.orders
  add constraint orders_scan_is_delivery
    check (order_type <> 'SCAN' or fulfilment_type = 'DELIVERY');

-- The food has no price here. This is the ledger's first line of defence
-- against the scan's face value ever entering Campus Dash's books.
alter table public.orders drop constraint if exists orders_scan_has_no_food_value;
alter table public.orders
  add constraint orders_scan_has_no_food_value
    check (order_type <> 'SCAN' or subtotal_pesewas = 0);

-- The fourth dimension exists exactly when it means something.
alter table public.orders drop constraint if exists orders_scan_status_presence;
alter table public.orders
  add constraint orders_scan_status_presence
    check ((order_type = 'SCAN') = (scan_status is not null));

create index if not exists orders_scan_dispatch_idx
  on public.orders (order_type, delivery_status)
  where order_type = 'SCAN';

comment on column public.orders.order_type is
  'FOOD or SCAN. Decides pricing, whether the vendor participates, and whether '
  'a vendor allocation is written.';


-- ---------------------------------------------------------------------------
-- 5. The scan artifact
-- ---------------------------------------------------------------------------
-- One row per scan order. Separate from `orders` because it holds a private
-- image path plus the release/redemption audit, and because a table can be
-- denied to clients wholesale while `orders` stays readable.

create table if not exists public.order_scans (
  order_id        uuid primary key references public.orders(id) on delete cascade,

  -- Denormalised on purpose. Ownership is asserted here as well as on the
  -- order, so a policy or function can answer "whose scan is this?" without
  -- a join, and so a mismatch between the two is a detectable corruption
  -- rather than a silent reassignment.
  customer_id     uuid not null references public.users(id) on delete cascade,

  image_path      text not null,
  content_type    text not null,
  byte_size       bigint not null,
  uploaded_at     timestamptz not null default now(),

  -- WHO MAY READ IT, RIGHT NOW. Set when a Partner accepts, cleared if the
  -- assignment goes away. A previous Partner's access dies with this column.
  released_to     uuid references public.users(id) on delete set null,
  released_at     timestamptz,

  redeemed_at     timestamptz,
  redeemed_by     uuid references public.users(id) on delete set null,
  refused_at      timestamptz,
  refusal_reason  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint order_scans_byte_size_check check (byte_size > 0),
  constraint order_scans_release_pair check ((released_to is null) = (released_at is null)),
  constraint order_scans_redeem_pair  check ((redeemed_by is null) = (redeemed_at is null))
);

alter table public.order_scans enable row level security;

drop trigger if exists order_scans_set_updated_at on public.order_scans;
create trigger order_scans_set_updated_at
  before update on public.order_scans
  for each row execute function public.set_updated_at();

comment on table public.order_scans is
  'The customer''s uploaded scan image and its release/redemption audit. The '
  'image itself lives in the private scan-documents bucket; this row holds the '
  'path and decides who is currently allowed to be shown it.';

-- READ POLICY. Deliberately narrow, and it is the only one.
--
--   the customer who uploaded it  — it is theirs
--   the CURRENTLY assigned Partner, and only while released to them
--   an administrator
--
-- A Partner who has lost the assignment fails `released_to = auth.uid()`
-- immediately, because partner_accept_delivery and every release-clearing path
-- rewrite that column in the same statement that moves the order.
drop policy if exists order_scans_read_authorised on public.order_scans;
create policy order_scans_read_authorised on public.order_scans
  for select to authenticated
  using (
    customer_id = auth.uid()
    or (released_to = auth.uid() and released_to is not null)
    or public.is_admin()
  );

-- No insert/update/delete policy, for anyone. Every write goes through a
-- SECURITY DEFINER function below. Hard rule 6.


-- ---------------------------------------------------------------------------
-- 6. Private storage for scan images
-- ---------------------------------------------------------------------------
-- Its own bucket rather than a corner of partner-documents: different subject,
-- different retention, different readers. Mixing a meal voucher in with
-- government-ID photographs would make both harder to reason about.
--
-- PRIVATE, and with NO policies on storage.objects — exactly like
-- partner-documents. Without a policy RLS denies every client read and write,
-- so nothing reaches these files except the service role, and the only way an
-- image is ever seen is a short-lived signed URL minted server-side after the
-- caller's right to it has been re-checked in SQL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'scan-documents',
  'scan-documents',
  false,
  5 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
   set public             = false,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------------------------
-- 7. Which restaurants a customer may choose
-- ---------------------------------------------------------------------------

create or replace function public.scan_restaurants()
returns table (
  id                 uuid,
  name               text,
  location_path      text,
  is_accepting_orders boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, public.location_path(v.location_id), v.is_accepting_orders
    from public.vendors v
   where v.status = 'ACTIVE'
     and v.can_accept_scans
   order by v.is_accepting_orders desc, v.name;
$$;


-- ---------------------------------------------------------------------------
-- 8. Pricing a scan order
-- ---------------------------------------------------------------------------
-- Mirrors price_order() in shape so the customer screens can share a renderer,
-- and differs in exactly the two ways the product differs: the subtotal is
-- structurally zero, and the fee is flat rather than proportional.

create or replace function public.price_scan_order(
  p_vendor_id               uuid,
  p_destination_location_id uuid
)
returns table (
  subtotal_pesewas         bigint,
  service_fee_pesewas      bigint,
  delivery_fee_pesewas     bigint,
  partner_earnings_pesewas bigint,
  total_pesewas            bigint,
  destination_zone_id      uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_service  bigint;
  v_delivery bigint;
  v_earnings bigint;
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id
       and status = 'ACTIVE'
       and is_accepting_orders
       and can_accept_scans
  ) then
    raise exception 'this restaurant is not accepting scan deliveries'
      using errcode = 'check_violation';
  end if;

  if p_destination_location_id is null then
    raise exception 'scan deliveries require a destination' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.locations
     where id = p_destination_location_id and is_deliverable and is_active
  ) then
    raise exception 'destination is not a valid delivery location'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- The refusal that keeps an unpriced product off the shelf. See the header:
  -- null is "undecided", and guessing a number here would be inventing revenue
  -- policy in a pricing function.
  if v_cfg.scan_service_fee_pesewas is null then
    raise exception
      'scan deliveries are not configured yet: an administrator must set the scan service fee'
      using errcode = 'check_violation';
  end if;

  v_service  := v_cfg.scan_service_fee_pesewas;
  v_delivery := v_cfg.delivery_fee_pesewas;
  -- Same carve as a food delivery. The Partner is paid for the errand, and the
  -- errand is identical work.
  v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;

  return query select
    0::bigint,
    v_service,
    v_delivery,
    v_earnings,
    v_service + v_delivery,
    public.location_zone(p_destination_location_id);
end;
$$;

-- The customer-facing quote. Never returns partner_earnings: what the Partner
-- earns is not the customer's business, and price_order() draws the same line.
create or replace function public.quote_scan_order(
  p_vendor_id               uuid,
  p_destination_location_id uuid
)
returns table (
  subtotal_pesewas     bigint,
  service_fee_pesewas  bigint,
  delivery_fee_pesewas bigint,
  total_pesewas        bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.subtotal_pesewas, p.service_fee_pesewas, p.delivery_fee_pesewas, p.total_pesewas
    from public.price_scan_order(p_vendor_id, p_destination_location_id) p;
$$;


-- ---------------------------------------------------------------------------
-- 9. Creating a scan order
-- ---------------------------------------------------------------------------
-- The customer has already uploaded the image through the server, which handed
-- back a path derived from THEIR user id. That path is passed here and checked
-- against the caller, so a forged path cannot attach somebody else's scan.
--
-- ORDER STATUS. The restaurant does not participate: there is nothing for it to
-- accept, prepare or price. So the order is born ACCEPTED — the state that
-- makes it payable — and no vendor is ever asked anything. It reaches dispatch
-- only after payment, in confirm_payment(). A vendor never sees it on a board.

create or replace function public.submit_scan_order(
  p_vendor_id               uuid,
  p_destination_location_id uuid,
  p_scan_image_path         text,
  p_content_type            text,
  p_byte_size               bigint,
  p_destination_note        text default null
)
returns table (order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_customer uuid := auth.uid();
  v_price    record;
  v_order    public.orders%rowtype;
  v_prefix   text;
begin
  if v_customer is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- ORDERING IS A CAPABILITY. Browsing needs no account; this needs a completed
  -- student onboarding, exactly like a food order.
  if not public.is_customer(v_customer) then
    raise exception 'complete your student details before ordering'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_scan_image_path, '')), '') is null then
    raise exception 'a scan is required' using errcode = 'check_violation';
  end if;

  -- THE PATH MUST BE THE CALLER'S OWN. Uploads land under <user_id>/scans/…,
  -- so anything else is either a mistake or an attempt to attach a scan the
  -- caller does not own. Checked here as well as at upload, because this
  -- function is the one that grants the Partner a later right to read it.
  v_prefix := v_customer::text || '/scans/';
  if left(p_scan_image_path, length(v_prefix)) <> v_prefix then
    raise exception 'that scan does not belong to this account'
      using errcode = 'insufficient_privilege';
  end if;

  -- Prices come from the server, always. Nothing the client sent is trusted.
  select * into v_price
    from public.price_scan_order(p_vendor_id, p_destination_location_id);

  insert into public.orders (
    customer_id, vendor_id, order_type, fulfilment_type,
    order_status, payment_status, delivery_status, scan_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    submitted_at, accepted_at
  )
  values (
    v_customer, p_vendor_id, 'SCAN', 'DELIVERY',
    -- ACCEPTED with no vendor involved: see above. NONE, not SEARCHING —
    -- dispatch opens on payment, so a Partner never sees an unpaid errand.
    'ACCEPTED', 'UNPAID', 'NONE', 'UPLOADED',
    p_destination_location_id, nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    0, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas,
    v_price.partner_earnings_pesewas, v_price.total_pesewas,
    now(), now()
  )
  returning * into v_order;

  insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size)
  values (v_order.id, v_customer, p_scan_image_path, p_content_type, p_byte_size);

  -- Same secrets row a food order gets. partner_accept_delivery() fills in both
  -- codes on assignment, and without this row that UPDATE would match nothing
  -- and the customer would never have a delivery code to hand over.
  --
  -- The pickup code is generated too and simply goes unused: there is no vendor
  -- handover to confirm for a scan. Leaving it is cheaper than special-casing
  -- the claim, and it is already there if the restaurants are ever brought into
  -- the handover.
  insert into public.order_secrets (order_id) values (v_order.id);

  perform public.log_order_event(
    v_order.id, 'SCAN_ORDER_SUBMITTED', true, 'CUSTOMER',
    'order_status', null, 'ACCEPTED', null,
    jsonb_build_object('vendor_id', p_vendor_id, 'scan_status', 'UPLOADED')
  );

  return query select v_order.id, v_order.order_number, v_order.total_pesewas;
end;
$$;


-- ---------------------------------------------------------------------------
-- 10. The ledger — a scan order writes NO vendor entitlement
-- ---------------------------------------------------------------------------
-- The only change is the VENDOR row, which is skipped entirely rather than
-- written as zero. A zero-pesewa liability is still a liability on the books:
-- it appears in settlement queries, it invites a GH₵0 payout, and it tells a
-- reader that the restaurant is owed something. It is not. The restaurant was
-- paid by the university, outside Campus Dash.
--
-- The PLATFORM row is unchanged: total − subtotal. For a scan order subtotal is
-- structurally zero, so it is service fee + delivery fee, out of which
-- settle_partner_earnings() later carves the Partner's share exactly as it does
-- for food. Net platform revenue is therefore the scan service fee, and the
-- balance trigger still sees the rows sum to the order total.

create or replace function public.create_order_allocations(p_order_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_platform bigint;
  v_count    integer := 0;
begin
  perform public.assert_service_or_admin();

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Already allocated: idempotent no-op, not a duplicate ledger entry.
  if exists (select 1 from public.allocations where order_id = p_order_id) then
    return 0;
  end if;

  -- At payment time NO PARTNER EXISTS YET — dispatch has not even opened. So we
  -- allocate in two rows now, and the Partner's share is carved out of the
  -- platform row later, at the moment a Partner actually earns it
  -- (see settle_partner_earnings). The rows always sum to the total, so the
  -- balance constraint holds at every step.
  v_platform := v_order.total_pesewas - v_order.subtotal_pesewas;

  -- The vendor cooked the food; their money is eligible on payment, regardless
  -- of how the delivery later turns out.
  --
  -- SCAN ORDERS GET NO SUCH ROW. Campus Dash did not sell their food and owes
  -- them nothing for it.
  if v_order.order_type <> 'SCAN' then
    insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
    values (p_order_id, 'VENDOR', v_order.vendor_id, v_order.subtotal_pesewas, 'ELIGIBLE');
    v_count := v_count + 1;
  end if;

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE');
  v_count := v_count + 1;

  return v_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- 11. Payment opens dispatch for a scan order
-- ---------------------------------------------------------------------------
-- A food order reaches SEARCHING when the vendor marks it READY, because
-- somebody had to cook. Nobody cooks for a scan order on our side — the errand
-- can begin the moment it is paid for. So confirm_payment() moves it the rest
-- of the way itself.
--
-- Everything else in this function is byte-for-byte the original.

create or replace function public.confirm_payment(
  p_payment_id              uuid,
  p_provider_transaction_id text,
  p_amount_pesewas          bigint
)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_search  integer;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  -- Replayed confirmation: already succeeded, nothing more to do.
  if v_payment.status = 'SUCCEEDED' then
    return v_payment;
  end if;

  -- The provider must have collected exactly what we asked for. A mismatch is a
  -- reconciliation incident, not something to paper over.
  if p_amount_pesewas is distinct from v_payment.amount_pesewas then
    raise exception 'amount mismatch: provider reported % but payment is %',
      p_amount_pesewas, v_payment.amount_pesewas using errcode = 'check_violation';
  end if;

  update public.payments
     set status = 'SUCCEEDED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         succeeded_at = now()
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  update public.orders
     set payment_status = 'PAID'
   where id = v_payment.order_id and payment_status = 'PENDING'
  returning * into v_order;

  if not found then
    raise exception 'order payment status was not PENDING' using errcode = 'check_violation';
  end if;

  perform public.create_order_allocations(v_payment.order_id);

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_CONFIRMED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'PAID', null,
    jsonb_build_object('payment_id', p_payment_id, 'provider_transaction_id', p_provider_transaction_id));

  -- SCAN ONLY. There is no vendor to mark anything READY, so paying for the
  -- errand is what opens dispatch. Guarded on the current state so a replayed
  -- confirmation cannot restart a search that has already found somebody.
  if v_order.order_type = 'SCAN' then
    select partner_search_seconds into v_search from public.pricing_config where id;

    update public.orders o
       set order_status      = 'READY',
           ready_at          = now(),
           delivery_status   = 'SEARCHING',
           search_started_at = now(),
           search_deadline_at = now() + make_interval(secs => v_search)
     where o.id = v_payment.order_id
       and o.order_status = 'ACCEPTED'
       and o.delivery_status = 'NONE';

    if found then
      perform public.log_order_event(v_payment.order_id, 'SCAN_DISPATCH_OPENED', true, 'SYSTEM',
        'delivery_status', 'NONE', 'SEARCHING');
    end if;
  end if;

  return v_payment;
end;
$$;


-- ---------------------------------------------------------------------------
-- 12. Scan orders in the Partner's offer list
-- ---------------------------------------------------------------------------
-- Same eligibility rules, same conflict-of-interest predicates, both untouched.
-- Two additions: the offer says what kind of errand it is, and `food_is_ready`
-- tells the truth — for a scan order nothing has been cooked yet, because the
-- Partner is the one who will go and get it.
--
-- The scan image is NOT here and must never be. An offer is a decision aid; the
-- artifact is released only on acceptance.
--
-- DROPped rather than replaced: the result columns change, and CREATE OR
-- REPLACE cannot alter a function's return type.

drop function if exists public.get_delivery_offers();

create or replace function public.get_delivery_offers()
returns table (
  order_id         uuid,
  order_number     text,
  vendor_name      text,
  vendor_location  text,
  destination_zone text,
  walk_minutes     integer,
  earnings_pesewas bigint,
  item_count       bigint,
  ready_at         timestamptz,
  food_is_ready    boolean,
  order_type       public.order_type
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id,
    o.order_number,
    v.name,
    public.location_path(v.location_id),
    coalesce(z.name, 'Campus'),
    -- NULL when either leg is unknown: an estimate is omitted, never invented.
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    -- A food order reaches this list only after the vendor said READY. A scan
    -- order reaches it on payment, and the food does not exist yet.
    (o.order_type = 'FOOD'),
    o.order_type
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  where o.delivery_status = 'SEARCHING'
    and o.order_status = 'READY'
    and o.payment_status = 'PAID'
    -- The caller must be a dispatchable Partner...
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- ...with no active delivery. One at a time in V1.
    and not exists (
      select 1 from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
    -- CONFLICT OF INTEREST 1: never your own order. Applies to scan orders
    -- exactly as it does to food — you do not run your own errand for a fee.
    and o.customer_id <> auth.uid()
    -- CONFLICT OF INTEREST 2: never a vendor you work for. A scan order names
    -- the restaurant in the same column, so this needs no special case.
    and not exists (
      select 1 from public.vendor_users vu
       where vu.vendor_id = o.vendor_id and vu.user_id = auth.uid()
    )
  order by o.ready_at asc;
$$;


-- ---------------------------------------------------------------------------
-- 12b. The Partner's active job says which kind of errand it is
-- ---------------------------------------------------------------------------
-- Two extra columns, everything else byte-for-byte the original. The screen has
-- to know: a food collection shows a pickup code to read to the vendor, and a
-- scan collection shows the scan itself with two buttons.
--
-- DROPped, so the grants are restored at the bottom of this file.

drop function if exists public.partner_active_delivery();

create or replace function public.partner_active_delivery()
returns table (
  order_id                     uuid,
  order_number                 text,
  delivery_status              public.delivery_status,
  vendor_name                  text,
  vendor_location              text,
  vendor_phone                 text,
  destination_zone             text,
  destination                  text,
  destination_note             text,
  customer_name                text,
  customer_phone               text,
  earnings_pesewas             bigint,
  item_count                   bigint,
  assigned_at                  timestamptz,
  picked_up_at                 timestamptz,
  customer_absent_reported_at  timestamptz,
  seconds_until_absent_allowed integer,
  order_type                   public.order_type,
  scan_status                  public.scan_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.delivery_status,
         v.name,
         public.location_path(v.location_id),
         -- The vendor's phone is operational, not private: the Partner may need
         -- to say they are running late.
         v.phone,
         coalesce(z.name, 'Campus'),
         -- Released only after the food is actually in hand. For a scan order
         -- that moment is the redemption report, which is what sets PICKED_UP —
         -- so the room number is protected by exactly the same condition.
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then public.location_path(o.destination_location_id) end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then o.destination_note end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.full_name end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.phone end,
         o.partner_earnings_pesewas,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.assigned_at,
         o.picked_up_at,
         o.customer_absent_reported_at,
         case when o.customer_absent_reported_at is not null
              then greatest(
                0,
                extract(epoch from (
                  o.customer_absent_reported_at
                    + make_interval(secs => (select customer_absent_wait_seconds
                                               from public.pricing_config where id))
                  - now()))::integer
              ) end,
         o.order_type,
         o.scan_status
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    join public.users c on c.id = o.customer_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;


-- ---------------------------------------------------------------------------
-- 13. Accepting releases the scan to that Partner, and only that Partner
-- ---------------------------------------------------------------------------
-- Wraps the existing claim rather than reimplementing it: partner_accept_delivery
-- keeps its atomic UPDATE, its conflict rules and its race semantics exactly as
-- written. This trigger fires only when a claim actually succeeded, so a Partner
-- who lost the race releases nothing.
--
-- The release OVERWRITES released_to. If an order is ever reassigned, the
-- previous Partner's read right is gone in the same statement that moves the
-- assignment — there is no window in which two Partners can both read the scan.

-- BEFORE, not AFTER, and deliberately: it sets scan_status by assigning to NEW
-- rather than issuing a second UPDATE against the row the statement is already
-- updating. That keeps the whole release atomic with the claim and avoids a
-- self-referential write on `orders`.
create or replace function public.release_scan_on_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_type <> 'SCAN' then
    return new;
  end if;

  -- Assigned to somebody: that somebody, and nobody else, may read it.
  if new.partner_id is not null
     and new.delivery_status in ('ASSIGNED', 'PICKED_UP')
     and new.partner_id is distinct from old.partner_id then
    update public.order_scans
       set released_to = new.partner_id,
           released_at = now()
     where order_id = new.id;

    if new.scan_status = 'UPLOADED' then
      new.scan_status := 'RELEASED';
    end if;

  -- The assignment went away — cancelled, reassigned, search reopened. The
  -- read right goes with it. A redeemed scan keeps its history; what is
  -- revoked is the ability to fetch the image.
  elsif new.partner_id is null and old.partner_id is not null then
    update public.order_scans
       set released_to = null,
           released_at = null
     where order_id = new.id;

    if new.scan_status = 'RELEASED' then
      new.scan_status := 'UPLOADED';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_release_scan_on_assignment on public.orders;
create trigger orders_release_scan_on_assignment
  before update of partner_id, delivery_status on public.orders
  for each row execute function public.release_scan_on_assignment();


-- ---------------------------------------------------------------------------
-- 14. Reading the scan
-- ---------------------------------------------------------------------------
-- Returns a PATH, never a URL. The caller (server-side) mints a short-lived
-- signed URL from it, so the right to see the image is re-derived on every
-- single request and expires on its own.
--
-- The three readers are the customer, the currently assigned Partner, and an
-- admin. Everyone else gets nothing — not an error that confirms the order
-- exists, just no row.

create or replace function public.scan_image_path(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and (
       s.customer_id = auth.uid()
       or (s.released_to is not null and s.released_to = auth.uid())
       or public.is_admin()
     );
$$;

-- What the customer sees about their own scan, without the image.
create or replace function public.my_scan_order(p_order_id uuid)
returns table (
  order_id       uuid,
  scan_status    public.scan_status,
  uploaded_at    timestamptz,
  released_at    timestamptz,
  redeemed_at    timestamptz,
  refused_at     timestamptz,
  refusal_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.order_id, o.scan_status, s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason
    from public.order_scans s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and (s.customer_id = auth.uid() or public.is_admin());
$$;


-- ---------------------------------------------------------------------------
-- 15. Redemption — a Partner's REPORT, not a verification
-- ---------------------------------------------------------------------------
-- Campus Dash has no integration with the university's scan system and does not
-- pretend to have one. What this records is that the assigned Partner says the
-- restaurant honoured the scan and handed over the food.
--
-- It is also the scan order's equivalent of vendor_confirm_pickup(): there is
-- no vendor to press a button, so redemption is what moves the delivery to
-- PICKED_UP. That coupling is deliberate and it is what stops a Partner
-- completing a delivery they never redeemed — partner_complete_delivery still
-- requires PICKED_UP, and for a scan order the only road to PICKED_UP is here.
--
-- DOUBLE REDEMPTION is refused by the guard `scan_status = 'RELEASED'` in the
-- conditional UPDATE. The second call matches zero rows and is logged as a
-- rejection. Hard rule 3.

create or replace function public.partner_report_scan_redeemed(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  -- AUTHORISATION failures raise; state failures return. Hard rule 9.
  if not found or v_order.partner_id is distinct from v_partner then
    raise exception 'this delivery is not assigned to you' using errcode = 'insufficient_privilege';
  end if;

  if v_order.order_type <> 'SCAN' then
    raise exception 'this is not a scan delivery' using errcode = 'check_violation';
  end if;

  update public.orders o
     set scan_status     = 'REDEEMED',
         delivery_status = 'PICKED_UP',
         picked_up_at    = now()
   where o.id = p_order_id
     and o.partner_id = v_partner
     and o.scan_status = 'RELEASED'
     and o.delivery_status = 'ASSIGNED';

  if not found then
    perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', false, 'PARTNER',
      'scan_status', v_order.scan_status::text, 'REDEEMED',
      'scan was not RELEASED, or the delivery was not ASSIGNED');
    return row(false, 'this scan is not in a state that can be redeemed')::public.transition_result;
  end if;

  update public.order_scans
     set redeemed_at = now(), redeemed_by = v_partner
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', true, 'PARTNER',
    'scan_status', 'RELEASED', 'REDEEMED');
  perform public.log_order_event(p_order_id, 'PICKED_UP', true, 'PARTNER',
    'delivery_status', 'ASSIGNED', 'PICKED_UP', 'scan redeemed at the restaurant');

  return row(true, null)::public.transition_result;
end;
$$;

-- The restaurant would not honour it. NO MONEY MOVES HERE.
--
-- There is no automatic refund and no automatic Partner payment, because no
-- such policy has been decided. What this does is record the fact accurately
-- and leave the order for a person: an administrator resolves it with the
-- existing admin_mark_refunded() / admin_resolve_dispute(), both of which
-- append to admin_actions. Inventing a refund rule here would be inventing
-- company policy in a database function.

create or replace function public.partner_report_scan_refused(p_order_id uuid, p_reason text)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  if not found or v_order.partner_id is distinct from v_partner then
    raise exception 'this delivery is not assigned to you' using errcode = 'insufficient_privilege';
  end if;

  if v_order.order_type <> 'SCAN' then
    raise exception 'this is not a scan delivery' using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'say what happened at the restaurant' using errcode = 'check_violation';
  end if;

  -- Only before redemption. Once the food is in hand the problem is a delivery
  -- problem, and the delivery paths already handle those.
  update public.orders o
     set scan_status = 'REFUSED'
   where o.id = p_order_id
     and o.partner_id = v_partner
     and o.scan_status = 'RELEASED'
     and o.delivery_status = 'ASSIGNED';

  if not found then
    perform public.log_order_event(p_order_id, 'SCAN_REFUSED', false, 'PARTNER',
      'scan_status', v_order.scan_status::text, 'REFUSED',
      'scan was not RELEASED, or the delivery was not ASSIGNED');
    return row(false, 'this scan is not in a state that can be refused')::public.transition_result;
  end if;

  update public.order_scans
     set refused_at = now(), refusal_reason = btrim(p_reason)
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REFUSED', true, 'PARTNER',
    'scan_status', 'RELEASED', 'REFUSED', btrim(p_reason));

  return row(true, null)::public.transition_result;
end;
$$;


-- ---------------------------------------------------------------------------
-- 16. The vendor board never shows a scan order
-- ---------------------------------------------------------------------------
-- The restaurant has nothing to do in Campus Dash for a scan: no acceptance, no
-- preparation, no money. Putting it on their board would ask them to act on
-- something they cannot act on, and would show them a GH₵0 order they might
-- reasonably think they were owed for.

create or replace function public.vendor_pending_count(p_vendor_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.order_type = 'FOOD'
     and o.order_status = 'SUBMITTED'
     and public.is_vendor_staff(p_vendor_id);
$$;

-- Same exclusion on the board itself. Identical to the original in every other
-- respect; the only new line is `o.order_type = 'FOOD'`.
create or replace function public.vendor_order_board(
  p_vendor_id uuid,
  p_closed_limit integer default 20
)
returns table (
  order_id           uuid,
  order_number       text,
  bucket             text,
  order_status       public.order_status,
  payment_status     public.payment_status,
  delivery_status    public.delivery_status,
  fulfilment_type    public.fulfilment_type,
  item_count         bigint,
  total_pesewas      bigint,
  submitted_at       timestamptz,
  accept_deadline_at timestamptz,
  seconds_to_deadline integer,
  age_seconds        integer,
  destination_zone   text,
  partner_assigned   boolean,
  cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       -- A DRAFT order has not been sent to anyone yet.
       and o.order_status <> 'DRAFT'
       -- A scan order asks nothing of the restaurant through Campus Dash.
       and o.order_type = 'FOOD'
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket(v.order_status) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket(v.order_status)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.bucket,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         r.total_pesewas,
         r.submitted_at,
         r.accept_deadline_at,
         case when r.accept_deadline_at is not null
              then extract(epoch from (r.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
         r.partner_id is not null,
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'PREPARING' then 1 when 'READY' then 2 else 3 end,
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;


-- ---------------------------------------------------------------------------
-- 17. Admin
-- ---------------------------------------------------------------------------

-- Everything an administrator needs about one scan order EXCEPT the image.
-- Looking at somebody's meal voucher should be a deliberate second step, not a
-- side effect of opening the order.
create or replace function public.admin_scan_order(p_order_id uuid)
returns table (
  order_id        uuid,
  order_number    text,
  customer_name   text,
  restaurant_name text,
  destination     text,
  scan_status     public.scan_status,
  order_status    public.order_status,
  payment_status  public.payment_status,
  delivery_status public.delivery_status,
  partner_name    text,
  service_fee_pesewas  bigint,
  delivery_fee_pesewas bigint,
  partner_earnings_pesewas bigint,
  total_pesewas   bigint,
  has_scan_image  boolean,
  uploaded_at     timestamptz,
  released_at     timestamptz,
  redeemed_at     timestamptz,
  refused_at      timestamptz,
  refusal_reason  text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.order_number,
    c.full_name, v.name, public.location_path(o.destination_location_id),
    o.scan_status, o.order_status, o.payment_status, o.delivery_status,
    p.full_name,
    o.service_fee_pesewas, o.delivery_fee_pesewas, o.partner_earnings_pesewas, o.total_pesewas,
    (s.image_path is not null),
    s.uploaded_at, s.released_at, s.redeemed_at, s.refused_at, s.refusal_reason
  from public.orders o
  join public.users c on c.id = o.customer_id
  join public.vendors v on v.id = o.vendor_id
  left join public.users p on p.id = o.partner_id
  left join public.order_scans s on s.order_id = o.id
  where o.id = p_order_id
    and o.order_type = 'SCAN'
    and public.is_admin();
$$;

-- Turning scan acceptance on or off for a restaurant, audited like every other
-- administrative change to a vendor.
create or replace function public.admin_set_vendor_scans(
  p_vendor_id uuid,
  p_accepts   boolean,
  p_reason    text
)
returns public.vendors
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  update public.vendors
     set can_accept_scans = p_accepts
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_SCANS_SET', 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


-- ---------------------------------------------------------------------------
-- 18. Configuration
-- ---------------------------------------------------------------------------
-- Adds the scan fee to the pilot config screen. Blank leaves it alone, exactly
-- like every other field here — a partial edit must not reset what it never saw.
--
-- Setting it to NULL is not offered: once a number exists, removing it would
-- silently take scan ordering off the shelf. Turning scan deliveries off is a
-- per-restaurant decision (admin_set_vendor_scans), which is visible and audited.
--
-- DROPped rather than replaced: adding a parameter would otherwise leave two
-- overloads behind, and PostgREST could not tell which one an RPC call meant.

drop function if exists public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer,
  bigint, integer, integer, integer, integer
);

create or replace function public.admin_update_config(
  p_reason                          text,
  p_service_fee_bps                 integer default null,
  p_delivery_fee_pesewas            bigint  default null,
  p_partner_share_of_delivery_bps   integer default null,
  p_vendor_response_seconds         integer default null,
  p_partner_search_seconds          integer default null,
  p_customer_absent_wait_seconds    integer default null,
  p_payment_pending_timeout_seconds integer default null,
  p_min_payout_pesewas              bigint  default null,
  p_notification_retry_limit        integer default null,
  p_vendor_poll_seconds             integer default null,
  p_partner_poll_seconds            integer default null,
  p_customer_poll_seconds           integer default null,
  p_scan_service_fee_pesewas        bigint  default null
)
returns public.pricing_config
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.pricing_config where id;

  update public.pricing_config
     set service_fee_bps                 = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas            = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps   = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds         = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds          = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds    = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas              = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit        = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds             = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds            = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds),
         scan_service_fee_pesewas        = coalesce(p_scan_service_fee_pesewas, scan_service_fee_pesewas),
         updated_at                      = now()
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


-- ---------------------------------------------------------------------------
-- 19. Grants
-- ---------------------------------------------------------------------------
-- Clients get SELECT only, and only where a policy also lets them through.
-- Every write above is a SECURITY DEFINER function. Hard rule 6.

grant select on public.order_scans to authenticated;

-- RE-GRANTING THE TWO FUNCTIONS THIS MIGRATION DROPPED.
--
-- This is not tidiness, it is a hole. DROP FUNCTION discards the REVOKE that
-- was applied to the old definition, and CREATE hands EXECUTE back to PUBLIC by
-- default — so recreating either of these without this block would quietly make
-- them anon-callable. get_delivery_offers() would leak the live dispatch queue
-- to the internet, and admin_update_config() would be reachable (it would still
-- raise inside is_admin(), but an administrative entry point should not be
-- exposed at all). tests/schema.test.js catches exactly this, and did.
revoke execute on function public.get_delivery_offers() from public, anon;
grant execute on function public.get_delivery_offers() to authenticated;

revoke execute on function public.partner_active_delivery() from public, anon;
grant execute on function public.partner_active_delivery() to authenticated;

revoke execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer,
  bigint, integer, integer, integer, integer, bigint
) from public, anon;
grant execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer,
  bigint, integer, integer, integer, integer, bigint
) to authenticated;

-- vendor_order_board and vendor_pending_count were REPLACED, not dropped, so
-- their grants survive untouched. Named here so a later reader does not have to
-- work that out.

revoke all on function public.price_scan_order(uuid, uuid) from public;
grant execute on function public.price_scan_order(uuid, uuid) to service_role;

revoke all on function public.quote_scan_order(uuid, uuid) from public;
grant execute on function public.quote_scan_order(uuid, uuid) to service_role, authenticated;

revoke all on function public.scan_restaurants() from public;
grant execute on function public.scan_restaurants() to service_role, authenticated, anon;

revoke all on function public.submit_scan_order(uuid, uuid, text, text, bigint, text) from public;
grant execute on function public.submit_scan_order(uuid, uuid, text, text, bigint, text) to service_role, authenticated;

-- Granted to `authenticated`, not just the service role, and that is on purpose:
-- it resolves auth.uid() itself, so it must run under the CALLER's session. The
-- server calls it with the user's own client, gets a path back, and only then
-- uses the service-role client to mint a short-lived signed URL. Called with the
-- service role there is no auth.uid() and it returns nothing, which is the safe
-- direction.
revoke all on function public.scan_image_path(uuid) from public;
grant execute on function public.scan_image_path(uuid) to service_role, authenticated;

revoke all on function public.my_scan_order(uuid) from public;
grant execute on function public.my_scan_order(uuid) to service_role, authenticated;

revoke all on function public.partner_report_scan_redeemed(uuid) from public;
grant execute on function public.partner_report_scan_redeemed(uuid) to service_role, authenticated;

revoke all on function public.partner_report_scan_refused(uuid, text) from public;
grant execute on function public.partner_report_scan_refused(uuid, text) to service_role, authenticated;

revoke all on function public.admin_scan_order(uuid) from public;
grant execute on function public.admin_scan_order(uuid) to service_role, authenticated;

revoke all on function public.admin_set_vendor_scans(uuid, boolean, text) from public;
grant execute on function public.admin_set_vendor_scans(uuid, boolean, text) to service_role, authenticated;

revoke all on function public.release_scan_on_assignment() from public;
