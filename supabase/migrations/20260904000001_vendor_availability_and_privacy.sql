-- ============================================================================
-- Product decisions taken before Phase 6
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The customer's phone number stays hidden from vendors in V1
-- ---------------------------------------------------------------------------
-- Phase 2 added a policy letting a vendor read the customer's row for a LIVE
-- order, on the reasoning that they might need to phone about a missing item.
-- The product decision is that they do not get that in V1, and support handles
-- those conversations instead.
--
-- Nothing surfaced the number, so this changes no screen. It is dropped anyway:
-- a policy that permits what the product forbids is a leak waiting for the
-- first person who adds a convenient column to a query.
drop policy if exists users_read_counterparty_on_live_order on public.users;

-- ---------------------------------------------------------------------------
-- 2. Vendors control availability. Only admins control price.
-- ---------------------------------------------------------------------------
-- A stall that runs out of jollof at noon should not have to phone anybody.
-- Availability is a fact about today; price is a commercial term, and the split
-- is exactly where the risk sits.
--
-- Deliberately a SEPARATE function from admin_set_menu_item_available rather
-- than a relaxed check inside it: this one cannot reach price, sort order, name
-- or another vendor's menu, because those are not parameters it has.
create or replace function public.vendor_set_menu_item_available(
  p_menu_item_id uuid,
  p_available    boolean
)
returns public.menu_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor_id uuid;
  v_item      public.menu_items%rowtype;
begin
  select vendor_id into v_vendor_id from public.menu_items where id = p_menu_item_id;
  if v_vendor_id is null then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  update public.menu_items set is_available = p_available
   where id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;

-- Not written to admin_actions: that table records administrative OVERRIDES,
-- and its admin_user_id is NOT NULL. This is routine vendor housekeeping, in
-- the same category as opening and closing the stall, which is also not
-- audited. If it ever needs a trail it belongs in a vendor-scoped log, not in
-- the admin one.

revoke execute on function public.vendor_set_menu_item_available(uuid, boolean) from public, anon;
grant execute on function public.vendor_set_menu_item_available(uuid, boolean) to authenticated;
