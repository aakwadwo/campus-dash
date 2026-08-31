-- ============================================================================
-- Menu catalogue and platform pricing
-- ============================================================================

create table public.menu_items (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  name         text not null,
  description  text,

  -- Integer pesewas. 1 GHS = 100 pesewas. Floats never touch money.
  price_pesewas bigint not null check (price_pesewas > 0),

  -- Admin/vendor can disable an item without deleting it, so historical orders
  -- keep a valid foreign key.
  is_available boolean not null default true,
  sort_order   integer not null default 0,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index menu_items_vendor_idx on public.menu_items (vendor_id);
create unique index menu_items_vendor_name_unique
  on public.menu_items (vendor_id, lower(name));

create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Platform pricing
-- ---------------------------------------------------------------------------
-- Single authoritative row. The client never supplies a fee; the server reads
-- it from here and SNAPSHOTS the result onto the order, so changing pricing
-- never rewrites the history of an order already placed.
--
-- V1: flat delivery fee. The column names carry no distance/zone assumption, so
-- zone-based pricing later means a new table joined at quote time — not a
-- rewrite of orders.
create table public.pricing_config (
  id                       boolean primary key default true,

  service_fee_pesewas      bigint not null check (service_fee_pesewas >= 0),
  delivery_fee_pesewas     bigint not null check (delivery_fee_pesewas >= 0),

  -- What share of the delivery fee the Partner earns, in basis points.
  -- 10000 = the Partner receives the entire delivery fee, which is what the
  -- worked example in the spec shows (GH₵2 delivery -> GH₵2 Partner).
  -- PLACEHOLDER: the real commercial split is an open business decision.
  partner_share_of_delivery_bps integer not null default 10000
    check (partner_share_of_delivery_bps between 0 and 10000),

  -- Vendor acceptance window. 60s is an assumption pending real observation.
  vendor_response_seconds  integer not null default 60 check (vendor_response_seconds > 0),

  -- How long dispatch searches before giving up and offering the customer a
  -- choice. The food is NOT cancelled when this expires.
  partner_search_seconds   integer not null default 600 check (partner_search_seconds > 0),

  updated_at               timestamptz not null default now(),

  constraint pricing_config_singleton check (id)
);

create trigger pricing_config_set_updated_at
  before update on public.pricing_config
  for each row execute function public.set_updated_at();

insert into public.pricing_config (id, service_fee_pesewas, delivery_fee_pesewas)
values (true, 200, 500);
