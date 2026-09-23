-- ============================================================================
-- PERFORMANCE: ASK LESS, AND ASK EACH QUESTION ONCE
-- ============================================================================
-- Three changes, none of which alters what anybody may see or do.
--
-- 1. A SIGNAL FOR THE CUSTOMER'S ORDER SCREEN. The screen watching a live
--    order used to re-render in full every few seconds — sign-in, capabilities,
--    the whole order, its items — to learn, almost every time, that nothing had
--    happened. customer_order_signal() answers the one question the poll asks:
--    has anything this screen shows moved? The screen re-renders only when it
--    has.
--
-- 2. AN INDEX FOR THE CATALOGUE'S ONE LOOKUP INTO ORDER HISTORY.
--    vendor_delete_menu_item() refuses to delete an item anybody has ordered,
--    and asked by counting order_items on menu_item_id, which had no index —
--    a scan of the fastest-growing table in the schema on every delete.
--
-- 3. RLS THAT ASKS "WHO ARE YOU" ONCE PER QUERY, NOT ONCE PER ROW. A policy
--    that calls auth.uid() or is_admin() directly may evaluate it for every
--    row it filters; wrapped in a scalar sub-select, Postgres evaluates it once
--    and reuses the answer (Supabase's own linter flags this as
--    auth_rls_initplan). is_vendor_staff(x) becomes x IN (my_vendor_ids()),
--    which is the definition of is_vendor_staff() and is likewise evaluated
--    once. Every predicate is otherwise exactly as it was.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. customer_order_signal
-- ---------------------------------------------------------------------------
-- Everything on the customer's order screen that somebody ELSE can change:
-- the stage (and every state it is computed from), whether a Partner is on it,
-- an absence report, a dispute, and the latest payment attempt. What the
-- customer changes themselves re-renders the page through their own action.
--
-- Opaque text: the screen compares it with the value it was rendered with and
-- never reads inside it. NULL for an order that is not the caller's, which the
-- route reports as not found.

create or replace function public.customer_order_signal(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select concat_ws('|',
           public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status,
                                       o.fulfilment_type, o.order_type, o.scan_status),
           o.order_status, o.payment_status, o.delivery_status, o.scan_status,
           o.partner_id is not null,
           o.customer_absent_reported_at,
           o.disputed_at, o.dispute_resolved_at,
           o.search_deadline_at,
           (select p.status from public.payments p
             where p.order_id = o.id order by p.created_at desc limit 1))
    from public.orders o
   where o.id = p_order_id
     and o.customer_id = auth.uid();
$$;

comment on function public.customer_order_signal(uuid) is
  'An opaque signature of everything on the customer''s order screen that somebody else can change. The screen polls this and re-renders only when it moves. The caller''s own orders only; NULL otherwise.';

revoke all on function public.customer_order_signal(uuid) from public, anon;
grant execute on function public.customer_order_signal(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. order_items(menu_item_id)
-- ---------------------------------------------------------------------------
create index if not exists order_items_menu_item_idx on public.order_items (menu_item_id);


-- ---------------------------------------------------------------------------
-- 3. RLS, evaluated once per query
-- ---------------------------------------------------------------------------
drop policy allocations_read_admin on public.allocations;
create policy allocations_read_admin on public.allocations for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy allocations_read_partner on public.allocations;
create policy allocations_read_partner on public.allocations for select to authenticated
  using (((payee_type = 'PARTNER'::payee_type) AND (payee_id = ( SELECT auth.uid() AS uid))));

drop policy customer_profiles_read_admin on public.customer_profiles;
create policy customer_profiles_read_admin on public.customer_profiles for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy customer_profiles_read_self on public.customer_profiles;
create policy customer_profiles_read_self on public.customer_profiles for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));

drop policy customer_rewards_read_admin on public.customer_rewards;
create policy customer_rewards_read_admin on public.customer_rewards for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy customer_rewards_read_self on public.customer_rewards;
create policy customer_rewards_read_self on public.customer_rewards for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));

drop policy locations_read_active on public.locations;
create policy locations_read_active on public.locations for select to anon,authenticated
  using ((is_active OR ( SELECT public.is_admin() AS is_admin)));

drop policy menu_items_read_admin on public.menu_items;
create policy menu_items_read_admin on public.menu_items for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy menu_items_read_own on public.menu_items;
create policy menu_items_read_own on public.menu_items for select to authenticated
  using ((vendor_id IN ( SELECT public.my_vendor_ids() AS my_vendor_ids)));

drop policy order_events_read on public.order_events;
create policy order_events_read on public.order_events for select to authenticated
  using ((( SELECT public.is_admin() AS is_admin) OR (EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.id = order_events.order_id) AND (o.customer_id = ( SELECT auth.uid() AS uid)))))));

drop policy order_items_read on public.order_items;
create policy order_items_read on public.order_items for select to authenticated
  using ((EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.id = order_items.order_id) AND ((o.customer_id = ( SELECT auth.uid() AS uid)) OR (o.partner_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin))))));

drop policy order_notes_read_customer_or_admin on public.order_notes;
create policy order_notes_read_customer_or_admin on public.order_notes for select to authenticated
  using ((( SELECT public.is_admin() AS is_admin) OR (EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.id = order_notes.order_id) AND (o.customer_id = ( SELECT auth.uid() AS uid)))))));

drop policy order_scans_read_authorised on public.order_scans;
create policy order_scans_read_authorised on public.order_scans for select to authenticated
  using (((customer_id = ( SELECT auth.uid() AS uid)) OR public.vendor_may_read_scan(order_id) OR ( SELECT public.is_admin() AS is_admin)));

drop policy orders_read_admin on public.orders;
create policy orders_read_admin on public.orders for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy orders_read_assigned_partner on public.orders;
create policy orders_read_assigned_partner on public.orders for select to authenticated
  using ((partner_id = ( SELECT auth.uid() AS uid)));

drop policy orders_read_customer on public.orders;
create policy orders_read_customer on public.orders for select to authenticated
  using ((customer_id = ( SELECT auth.uid() AS uid)));

drop policy partner_profiles_read_admin on public.partner_profiles;
create policy partner_profiles_read_admin on public.partner_profiles for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy partner_profiles_read_self on public.partner_profiles;
create policy partner_profiles_read_self on public.partner_profiles for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));

drop policy partner_ratings_read_admin on public.partner_ratings;
create policy partner_ratings_read_admin on public.partner_ratings for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy partner_ratings_read_customer on public.partner_ratings;
create policy partner_ratings_read_customer on public.partner_ratings for select to authenticated
  using ((customer_id = ( SELECT auth.uid() AS uid)));

drop policy partner_sessions_own on public.partner_sessions;
create policy partner_sessions_own on public.partner_sessions for select to authenticated
  using (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));

drop policy payments_read_admin on public.payments;
create policy payments_read_admin on public.payments for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy payments_read_customer on public.payments;
create policy payments_read_customer on public.payments for select to authenticated
  using ((EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.id = payments.order_id) AND (o.customer_id = ( SELECT auth.uid() AS uid))))));

drop policy payouts_read_admin on public.payouts;
create policy payouts_read_admin on public.payouts for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy payouts_read_own on public.payouts;
create policy payouts_read_own on public.payouts for select to authenticated
  using ((((payee_type = 'PARTNER'::payee_type) AND (payee_id = ( SELECT auth.uid() AS uid))) OR ((payee_type = 'VENDOR'::payee_type) AND (payee_id IN ( SELECT public.my_vendor_ids() AS my_vendor_ids)))));

drop policy settlement_runs_read_admin on public.settlement_runs;
create policy settlement_runs_read_admin on public.settlement_runs for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy terms_acceptances_read_own on public.terms_acceptances;
create policy terms_acceptances_read_own on public.terms_acceptances for select to authenticated
  using (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));

drop policy terms_documents_read_published on public.terms_documents;
create policy terms_documents_read_published on public.terms_documents for select to anon,authenticated
  using (((published_at IS NOT NULL) OR ( SELECT public.is_admin() AS is_admin)));

drop policy users_read_admin on public.users;
create policy users_read_admin on public.users for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy users_read_customer_during_active_delivery on public.users;
create policy users_read_customer_during_active_delivery on public.users for select to authenticated
  using ((EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.customer_id = users.id) AND (o.partner_id = ( SELECT auth.uid() AS uid)) AND (o.delivery_status = ANY (ARRAY['ASSIGNED'::delivery_status, 'PICKED_UP'::delivery_status]))))));

drop policy users_read_partner_during_active_delivery on public.users;
create policy users_read_partner_during_active_delivery on public.users for select to authenticated
  using ((EXISTS ( SELECT 1    FROM public.orders o   WHERE ((o.partner_id = users.id) AND (o.customer_id = ( SELECT auth.uid() AS uid)) AND (o.delivery_status = ANY (ARRAY['ASSIGNED'::delivery_status, 'PICKED_UP'::delivery_status]))))));

drop policy users_read_self on public.users;
create policy users_read_self on public.users for select to authenticated
  using ((id = ( SELECT auth.uid() AS uid)));

drop policy vendor_categories_read_active on public.vendor_categories;
create policy vendor_categories_read_active on public.vendor_categories for select to anon,authenticated
  using ((is_active OR ( SELECT public.is_admin() AS is_admin)));

drop policy vendor_images_read_admin on public.vendor_images;
create policy vendor_images_read_admin on public.vendor_images for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy vendor_images_read_own on public.vendor_images;
create policy vendor_images_read_own on public.vendor_images for select to authenticated
  using ((vendor_id IN ( SELECT public.my_vendor_ids() AS my_vendor_ids)));

drop policy vendors_read_admin on public.vendors;
create policy vendors_read_admin on public.vendors for select to authenticated
  using (( SELECT public.is_admin() AS is_admin));

drop policy vendors_read_own on public.vendors;
create policy vendors_read_own on public.vendors for select to authenticated
  using ((id IN ( SELECT public.my_vendor_ids() AS my_vendor_ids)));


-- ---------------------------------------------------------------------------
-- 4. THE STORE'S DASHBOARD, WITHOUT READING ITS WHOLE HISTORY
-- ---------------------------------------------------------------------------
-- Measured against ~33,000 orders a store (a synthetic load, rolled back):
-- vendor_order_board() read every one of them and sorted them on disk to find
-- the last five closed orders, and vendor_daily_sales(1) read every one of them
-- to total today. Both run on every render of the store's board.
--
-- (vendor_id, created_at): the newest end of a store's orders, for the board's
-- closed list. (vendor_id, order_day): a store's days, for its sales. The
-- existing (vendor_id, order_day, vendor_order_no) index is partial on
-- vendor_order_no, which older Meal Scan orders do not have, so it cannot
-- answer this without dropping them from the totals.

create index if not exists orders_vendor_recent_idx on public.orders (vendor_id, created_at desc);
create index if not exists orders_vendor_day_idx on public.orders (vendor_id, order_day);

CREATE OR REPLACE FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer DEFAULT 20) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "bucket" "text", "order_type" "public"."order_type", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "scan_status" "public"."scan_status", "item_count" bigint, "vendor_amount_pesewas" bigint, "scan_value_pesewas" bigint, "pack_included" boolean, "submitted_at" timestamp with time zone, "age_seconds" integer, "vendor_completed_at" timestamp with time zone, "awaiting_handoff" boolean, "cancellation_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- THE LIVE BOARD AND THE LAST FEW CLOSED ORDERS, read separately. This used
  -- to rank every order the store had ever taken to pick out the newest few
  -- closed ones — at a few thousand orders a store, a sort that spilled to
  -- disk on every board render. Now the live orders come from the status
  -- index and the closed ones from the newest end of (vendor_id, created_at),
  -- stopping at the limit. Same rows, same buckets, same order.
  with allowed as (
    select (public.is_vendor_staff(p_vendor_id) or public.is_admin()) as ok
  ),
  live as (
    select o.*
      from public.orders o, allowed
     where allowed.ok
       and o.vendor_id = p_vendor_id
       and o.vendor_completed_at is null
       and o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
       -- PAID ONLY. A store is never shown an order somebody has not paid for.
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  closed as (
    select o.*
      from public.orders o, allowed
     where allowed.ok
       and o.vendor_id = p_vendor_id
       and (o.vendor_completed_at is not null
            or o.order_status not in ('ACCEPTED', 'PREPARING', 'READY'))
       and o.order_status <> 'DRAFT'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     order by o.created_at desc
     limit greatest(coalesce(p_closed_limit, 20), 0)
  ),
  r as (
    select v.*, public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at) as bucket
      from (select * from live union all select * from closed) v
  )
  select r.id,
         r.order_number,
         r.vendor_order_no,
         r.bucket,
         r.order_type,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         r.scan_status,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         -- THE STORE'S AMOUNT THROUGH CAMPUS DASH. The food on a food order,
         -- the pack on a scan order. Never the total, never a Campus Dash fee.
         r.subtotal_pesewas + coalesce(r.pack_fee_pesewas, 0),
         case when r.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = r.id)
              else 0::bigint end,
         coalesce(r.pack_fee_pesewas, 0) > 0,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         r.vendor_completed_at,
         (r.vendor_completed_at is null and r.order_status = 'READY'
            and (r.delivery_status = 'ASSIGNED' or r.delivery_status = 'NONE')),
         r.cancellation_reason
    from r
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when r.bucket = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;

-- vendor_daily_sales() is unchanged: the index above is what it was missing.


-- ---------------------------------------------------------------------------
-- 5. vendor_delete_menu_item ASKS WHETHER, NOT HOW MANY
-- ---------------------------------------------------------------------------
-- It only needs to know whether anybody has ever ordered the item. Counting
-- every order line for a popular dish to compare the total with zero is the
-- same answer, later.
CREATE OR REPLACE FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item   public.menu_items%rowtype;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    return false;
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.order_items where menu_item_id = p_menu_item_id) then
    raise exception
      'somebody has ordered this before, so it cannot be deleted. Take it off the menu instead.'
      using errcode = 'foreign_key_violation';
  end if;

  perform 1 from public.vendors where id = v_item.vendor_id for update;
  delete from public.menu_items where id = p_menu_item_id;
  perform public.vendor_apply_menu_state(v_item.vendor_id);

  return true;
end;
$$;
