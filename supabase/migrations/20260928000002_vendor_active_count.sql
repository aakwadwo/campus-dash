-- How many orders are still on the vendor's board, READY included.
--
-- WHY vendor_pending_count() COULD NOT ANSWER THIS. It counts ACCEPTED and
-- PREPARING — "orders to prepare" — which is exactly right for the badge and the
-- new-order chime, and exactly wrong for noticing that an order LEFT the board.
-- A handoff moves an order from READY to COMPLETED, and READY was never in that
-- count, so the number the board polls did not move and the board never
-- refreshed. The completed order sat there until somebody reloaded the page.
--
-- A separate read rather than a wider one, so the badge keeps meaning what it
-- has always meant.
create or replace function public.vendor_active_count("p_vendor_id" "uuid")
returns integer
language sql
stable
security definer
set search_path to ''
as $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.payment_status = 'PAID'
     and o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
     and public.is_vendor_staff(p_vendor_id);
$$;

comment on function public.vendor_active_count("uuid") is
  'Orders still on this vendor''s board: paid and ACCEPTED, PREPARING or READY. Unlike vendor_pending_count() this includes READY, so the board can tell when a handoff has taken an order off it. Staff-only, enforced by is_vendor_staff() in the body.';

revoke execute on function public.vendor_active_count("uuid") from public, anon;
grant  execute on function public.vendor_active_count("uuid") to authenticated;
