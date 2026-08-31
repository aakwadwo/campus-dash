-- ============================================================================
-- Row Level Security
-- ============================================================================
-- Architecture: clients get SELECT ONLY. There is not a single INSERT, UPDATE
-- or DELETE policy for anon or authenticated on any business table.
--
-- That is deliberate. It means "a customer cannot mark their order PAID" is not
-- a rule the application remembers to check — there is no grant under which the
-- statement could succeed, even with a valid session and a crafted request
-- straight to PostgREST.
--
-- Every write goes through a SECURITY DEFINER function that re-derives
-- authorisation from auth.uid().
-- ============================================================================

alter table public.users            enable row level security;
alter table public.partner_profiles enable row level security;
alter table public.vendors          enable row level security;
alter table public.vendor_users     enable row level security;
alter table public.locations        enable row level security;
alter table public.menu_items       enable row level security;
alter table public.pricing_config   enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.order_secrets    enable row level security;
alter table public.order_events     enable row level security;
alter table public.payments         enable row level security;
alter table public.allocations      enable row level security;
alter table public.settlement_runs  enable row level security;
alter table public.payouts          enable row level security;
alter table public.webhook_events   enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.admin_actions    enable row level security;

-- Remove the blanket table privileges Supabase grants by default, then hand
-- back SELECT only. Without this, RLS would be filtering an UPDATE that should
-- not have been permitted in the first place.
revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.users, public.partner_profiles, public.vendors, public.vendor_users,
  public.locations, public.menu_items, public.pricing_config,
  public.orders, public.order_items, public.order_events,
  public.payments, public.allocations, public.settlement_runs, public.payouts
to authenticated;

-- Anonymous visitors may browse the catalogue before signing in. Nothing else.
grant select on public.vendors, public.menu_items, public.locations to anon;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create policy users_read_self on public.users
  for select to authenticated
  using (id = auth.uid());

create policy users_read_admin on public.users
  for select to authenticated
  using (public.is_admin());

-- A vendor sees the customer ROW for their own live orders — needed to phone
-- someone about a wrong order. Not for completed history, and never for
-- customers who never ordered from them.
create policy users_read_counterparty_on_live_order on public.users
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.customer_id = public.users.id
         and o.vendor_id in (select public.my_vendor_ids())
         and o.order_status not in ('COMPLETED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED')
    )
  );

-- THE PHONE NUMBER RULE.
-- A Partner sees the customer's row ONLY while actively carrying their food —
-- from vendor handoff until delivery. Never before assignment (the offer shows
-- a zone, not a person), and never afterwards in history.
create policy users_read_customer_during_active_delivery on public.users
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.customer_id = public.users.id
         and o.partner_id = auth.uid()
         and o.delivery_status = 'PICKED_UP'
    )
  );

-- Symmetrically, the customer sees their Partner while the delivery is live.
create policy users_read_partner_during_active_delivery on public.users
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.partner_id = public.users.id
         and o.customer_id = auth.uid()
         and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
  );

-- ---------------------------------------------------------------------------
-- partner_profiles
-- ---------------------------------------------------------------------------
-- A Partner sees only their own profile. No Partner can enumerate other
-- Partners, their documents, or their availability.
create policy partner_profiles_read_self on public.partner_profiles
  for select to authenticated using (user_id = auth.uid());

create policy partner_profiles_read_admin on public.partner_profiles
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Catalogue — vendors, menus, locations, pricing
-- ---------------------------------------------------------------------------
create policy vendors_read_active on public.vendors
  for select to anon, authenticated using (status = 'ACTIVE');

create policy vendors_read_own on public.vendors
  for select to authenticated using (public.is_vendor_staff(id));

create policy vendors_read_admin on public.vendors
  for select to authenticated using (public.is_admin());

create policy vendor_users_read_self on public.vendor_users
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy menu_items_read_public on public.menu_items
  for select to anon, authenticated
  using (exists (select 1 from public.vendors v where v.id = vendor_id and v.status = 'ACTIVE'));

create policy menu_items_read_own on public.menu_items
  for select to authenticated using (public.is_vendor_staff(vendor_id));

create policy menu_items_read_admin on public.menu_items
  for select to authenticated using (public.is_admin());

create policy locations_read_active on public.locations
  for select to anon, authenticated using (is_active or public.is_admin());

-- Fees are public: the customer is entitled to see what they are being charged.
create policy pricing_config_read_all on public.pricing_config
  for select to anon, authenticated using (true);
grant select on public.pricing_config to anon;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create policy orders_read_customer on public.orders
  for select to authenticated using (customer_id = auth.uid());

-- A vendor sees THEIR OWN orders and no others. This is what stops one vendor
-- reading — or attempting to modify — a competitor's order.
create policy orders_read_vendor on public.orders
  for select to authenticated using (vendor_id in (select public.my_vendor_ids()));

-- A Partner sees the order they are carrying. Offers do NOT come from this
-- policy — they come from get_delivery_offers(), which exposes a zone rather
-- than a destination, so an unassigned Partner never reads the row.
create policy orders_read_assigned_partner on public.orders
  for select to authenticated using (partner_id = auth.uid());

create policy orders_read_admin on public.orders
  for select to authenticated using (public.is_admin());

-- order_items follow the visibility of their order.
create policy order_items_read on public.order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_id
         and (o.customer_id = auth.uid()
              or o.partner_id = auth.uid()
              or o.vendor_id in (select public.my_vendor_ids())
              or public.is_admin())
    )
  );

-- === order_secrets: NO POLICY AND NO GRANT ==================================
-- Not even for admins, and not even for the party the code belongs to. Pickup
-- and delivery codes are readable exclusively through get_my_pickup_code() /
-- get_my_delivery_code(), which check entitlement first.
--
-- This is what makes the handoff meaningful: a vendor who could SELECT
-- pickup_code could confirm a handoff that never happened.

create policy order_events_read on public.order_events
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.orders o
       where o.id = order_id
         and (o.customer_id = auth.uid() or o.vendor_id in (select public.my_vendor_ids()))
    )
  );

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------
create policy payments_read_customer on public.payments
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

create policy payments_read_admin on public.payments
  for select to authenticated using (public.is_admin());

-- A vendor sees what they have earned; a Partner sees what they have earned.
-- Neither can see anyone else's, and neither sees a wallet balance — Campus
-- Dash does not hold their money, it settles it.
create policy allocations_read_vendor on public.allocations
  for select to authenticated
  using (payee_type = 'VENDOR' and payee_id in (select public.my_vendor_ids()));

create policy allocations_read_partner on public.allocations
  for select to authenticated
  using (payee_type = 'PARTNER' and payee_id = auth.uid());

create policy allocations_read_admin on public.allocations
  for select to authenticated using (public.is_admin());

create policy payouts_read_own on public.payouts
  for select to authenticated
  using (
    (payee_type = 'PARTNER' and payee_id = auth.uid())
    or (payee_type = 'VENDOR' and payee_id in (select public.my_vendor_ids()))
  );

create policy payouts_read_admin on public.payouts
  for select to authenticated using (public.is_admin());

create policy settlement_runs_read_admin on public.settlement_runs
  for select to authenticated using (public.is_admin());

-- === webhook_events, idempotency_keys, admin_actions ========================
-- No policies and no grants for anon/authenticated. Provider payloads and
-- replay state are server-only. admin_actions is readable through a dedicated
-- admin function so that reading the audit log is itself a deliberate act.

-- ---------------------------------------------------------------------------
-- Admin audit access
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_actions(p_limit integer default 100)
returns setof public.admin_actions
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.admin_actions
   where public.is_admin()
   order by created_at desc
   limit least(coalesce(p_limit, 100), 1000);
$$;
