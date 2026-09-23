-- ---------------------------------------------------------------------------
-- A SWITCH DOES NOT MOVE THE ROW IT IS ON
-- ---------------------------------------------------------------------------
-- vendor_menu() sorted ON items first. So every tap on a switch moved the row
-- out from under the thumb that tapped it: turn the jollof on and it leapt to
-- the top, and the row now under the vendor's finger was a different dish,
-- still off. It read as a switch that had not worked.
--
-- The store's own list is now its catalogue in the order it was built: newest
-- first, so the dish just added is the one at the top. Nothing about whether an
-- item is on takes part in the order, so ON and OFF stay interleaved where they
-- are and a switch changes one thing only. created_at is never written after
-- the insert, so the order survives every toggle, edit and reload.
--
-- Items added in one statement share a created_at; they fall back to the order
-- they had before (sort_order, then name), and id makes the order total.
--
-- ONLY THE STORE'S LIST. What a customer sees is read from menu_items directly
-- and ordered by sort_order in the app; nothing here touches it.
-- ---------------------------------------------------------------------------

create or replace function public.vendor_menu(p_vendor_id uuid)
returns table(
  id uuid,
  name text,
  description text,
  price_pesewas bigint,
  is_active boolean,
  is_available boolean,
  unavailable_reason text,
  scan_eligible boolean,
  image_path text,
  sort_order integer,
  order_count bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select m.id, m.name, m.description, m.price_pesewas,
         m.is_active, m.is_available, m.unavailable_reason, m.scan_eligible,
         m.image_path, m.sort_order,
         -- WHETHER IT CAN BE DELETED, answered on the row rather than by
         -- letting somebody press Delete and read an error. An item any order
         -- references is turned off, never removed.
         (select count(*) from public.order_items oi where oi.menu_item_id = m.id)
    from public.menu_items m
   where m.vendor_id = p_vendor_id
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   -- NEWEST FIRST, AND NEVER BY WHETHER IT IS ON. See the header.
   order by m.created_at desc, m.sort_order, m.name, m.id;
$$;

revoke all on function public.vendor_menu(uuid) from public, anon;
grant execute on function public.vendor_menu(uuid) to authenticated;
