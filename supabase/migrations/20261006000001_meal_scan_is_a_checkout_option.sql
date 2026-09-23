-- ---------------------------------------------------------------------------
-- A MEAL SCAN IS A WAY OF PAYING AT A CHECKOUT, NOT A PLACE TO GO
-- ---------------------------------------------------------------------------
-- The model was right and the doorway was wrong. "Use a meal scan" was a second
-- way to browse — its own landing page, its own store list, its own menu, its
-- own builder — for something that is one question at one checkout: is this
-- meal being paid for with your campus entitlement? A student who did not know
-- the feature existed never found it, and one who did had to decide which of
-- two front doors to walk through before they had chosen what to eat.
--
-- So the browsing half goes. What is left is a switch on the store's ordinary
-- checkout, off by default, offered only where the store accepts one.
--
-- THREE THINGS CHANGE UNDERNEATH, and each of them is a rule the front end must
-- not be the only thing enforcing:
--
--   1. APPROVAL COMES BEFORE FULFILMENT. The store looks at the scan first.
--      Dispatch no longer opens at payment for a scan order; vendor_redeem_scan()
--      opens it, in the same statement that approves the scan.
--
--   2. AN INVALID SCAN ENDS THE ORDER. It used to set scan_status = REFUSED and
--      leave the order PREPARING, which meant a store could still press Ready
--      on food it had just said it would not hand over, and a Partner could
--      still be carrying it. The order is cancelled now, in the same statement.
--
--   3. THE PARTNER NEVER SEES THE SCAN. They used to, because they used to be
--      the one who carried it to a counter that had never seen the order. The
--      store verifies it before a Partner is even looked for, so the Partner's
--      read right is not a reduced exposure — it is an unnecessary one, and it
--      is removed rather than narrowed.
--
-- WHAT DOES NOT CHANGE. The pricing model, which is hard rule 12 and the whole
-- of docs/SCAN.md: a scan order pays a FLAT scan_service_fee_pesewas and never
-- the food percentage, the pack is the store's money, and the entitlement
-- itself is settled between the student and the university. Nothing here reads
-- service_fee_bps, and no second payment is introduced.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. THE BROWSING MODE IS GONE
-- ---------------------------------------------------------------------------
-- scan_restaurants() listed stores for a page that no longer exists, and
-- scan_menu() served the eligible half of one store's menu to a builder that no
-- longer exists. The ordinary storefront serves both now: menu_items carries
-- scan_eligible, and the checkout reads it through the same RLS policy every
-- other customer read goes through.

drop function if exists public.scan_restaurants();
drop function if exists public.scan_menu(uuid);

-- ---------------------------------------------------------------------------
-- 2. THE PARTNER NEVER READS A MEAL SCAN
-- ---------------------------------------------------------------------------
-- Release existed for the old errand model: Campus Dash sold the errand, no
-- store ever saw the order, and the Partner carried the entitlement to a
-- counter that had to be shown it. The store is the redemption point now and
-- verifies the scan BEFORE a Partner is looked for, so by the time anybody is
-- carrying anything the scan has already been judged by the only party that
-- can judge it. A Partner holding a link to somebody's meal entitlement is
-- exposure with nothing on the other side of it.
--
-- RELEASED stays in the enum and stays readable in the guards below. Removing a
-- value from an enum is a rewrite of every column that uses it, and the point
-- is that nothing writes it any more — not that no row ever held it.

drop trigger if exists orders_release_scan_on_assignment on public.orders;
drop trigger if exists release_scan_on_assignment on public.orders;
drop function if exists public.release_scan_on_assignment();

-- Any scan sitting in RELEASED goes back to UPLOADED, and the read right it
-- carried goes with it. This is a right being withdrawn, not history being
-- rewritten: redeemed_at, refused_at and their reasons are untouched.
update public.orders
   set scan_status = 'UPLOADED'
 where order_type = 'SCAN' and scan_status = 'RELEASED';

update public.order_scans
   set released_to = null, released_at = null
 where released_to is not null;

-- The row, for the three readers who are left.
drop policy if exists "order_scans_read_authorised" on public.order_scans;
create policy "order_scans_read_authorised" on public.order_scans
  for select to authenticated
  using (
    customer_id = auth.uid()
    or public.vendor_may_read_scan(order_id)
    or public.is_admin()
  );

-- And the image.
create or replace function public.scan_image_path(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and (s.customer_id = auth.uid() or public.is_admin());
$$;

comment on function public.scan_image_path(uuid) is
  'The Meal Scan image path for the customer who uploaded it, or an administrator. The store has its own door, vendor_scan_image_path(), open only while the order is live on its board. A PARTNER HAS NO DOOR: the store verifies the scan before dispatch is even opened, so there is nothing a Partner could do with it.';

drop function if exists public.partner_scan_brief(uuid);
drop function if exists public.partner_may_read_scan(uuid);

-- ---------------------------------------------------------------------------
-- 3. APPROVAL IS THE GATE
-- ---------------------------------------------------------------------------
-- vendor_redeem_scan() is where a scan order's search opens. The store presses
-- "Scan is good", and the same statement that records the approval starts the
-- hunt for somebody to carry it — so a Partner is looked for during the
-- preparation, exactly as on a food order, but never before a human has looked
-- at the entitlement paying for it.

create or replace function public.vendor_redeem_scan(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order  public.orders%rowtype;
  v_after  public.orders%rowtype;
  v_search integer;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- AUTHORISATION failures raise; state failures return. Hard rule 9.
  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  select partner_search_seconds into v_search from public.pricing_config where id;

  update public.orders o
     set scan_status = 'REDEEMED',
         -- DISPATCH OPENS HERE, and only here, for a scan order. A Partner may
         -- now be looked for; nothing before this moment could have started
         -- that search, which is what makes "no Partner before approval" a
         -- fact about the database rather than about a button.
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() else o.search_started_at end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() + make_interval(secs => v_search)
           else o.search_deadline_at end
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.payment_status = 'PAID'
     -- RELEASED is still read, for a row that held it before release was
     -- removed. Nothing writes it any more.
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING')
  returning * into v_after;

  if not found then
    perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', false, 'VENDOR',
      'scan_status', v_order.scan_status::text, 'REDEEMED',
      'scan was already settled, or the order is not a paid order being prepared');
    return row(false, 'this Meal Scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set redeemed_at = now(), redeemed_by = auth.uid()
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REDEEMED', 'verified at the counter');

  if v_after.fulfilment_type = 'DELIVERY' and v_order.delivery_status = 'NONE' then
    perform public.log_order_event(p_order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
      'delivery_status', 'NONE', 'SEARCHING', 'the store approved the Meal Scan');
  end if;

  return row(true, null)::public.transition_result;
end;
$$;

comment on function public.vendor_redeem_scan(uuid) is
  'The store says the Meal Scan is good. Approval is the gate: on a Partner order this is the statement that opens the search, so no Partner can be assigned to a scan order nobody has verified. Refuses a scan already settled, so a second tap cannot redeem twice.';

-- ---------------------------------------------------------------------------
-- 4. AN INVALID MEAL SCAN ENDS THE ORDER
-- ---------------------------------------------------------------------------
-- It used to set scan_status = REFUSED and stop there, leaving order_status at
-- PREPARING. That is a state where the store has said it will not honour the
-- entitlement and can still press Ready, and where a Partner already carrying
-- it goes on carrying it. The refusal is the end of this order.
--
-- THE CUSTOMER PLACES A NEW ONE. There is no replace-the-scan path and there
-- deliberately is not going to be: the image is fixed at submission, and a
-- second attempt on a paid order would be a second entitlement against one
-- payment. The money is NOT refunded automatically — no refund policy has been
-- decided, and inventing one in a database function would be the wrong place to
-- invent it. A refused scan appears in admin_exceptions() for a person.

create or replace function public.vendor_refuse_scan(p_order_id uuid, p_reason text)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order  public.orders%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    return row(false, 'say why the Meal Scan could not be honoured')::public.transition_result;
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  update public.orders o
     set scan_status = 'REFUSED',
         -- THE ORDER STOPS. Not a separate decision a screen might forget to
         -- make: a store that will not honour the entitlement is not going to
         -- hand the food over, so there is nothing left to prepare, nothing to
         -- mark ready and nobody to send.
         order_status = 'CANCELLED_BY_VENDOR',
         cancelled_at = now(),
         cancellation_reason = 'The store could not accept this Meal Scan: ' || v_reason,
         -- A search that was open is closed. On a scan order there will not be
         -- one — dispatch opens at approval and this is the other branch — but
         -- an order carried over from before that rule must not be left with
         -- Partners being offered a cancelled job.
         delivery_status = case
           when o.delivery_status = 'SEARCHING' then 'NONE'::public.delivery_status
           else o.delivery_status end,
         search_deadline_at = case
           when o.delivery_status = 'SEARCHING' then null
           else o.search_deadline_at end
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING');

  if not found then
    return row(false, 'this Meal Scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set refused_at = now(), refusal_reason = v_reason
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REFUSED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REFUSED', v_reason);
  perform public.log_order_event(p_order_id, 'ORDER_CANCELLED', true, 'VENDOR',
    'order_status', v_order.order_status::text, 'CANCELLED_BY_VENDOR',
    'the Meal Scan was not valid');

  return row(true, null)::public.transition_result;
end;
$$;

comment on function public.vendor_refuse_scan(uuid, text) is
  'The store says the Meal Scan is not valid. IRREVERSIBLE AND TERMINAL: the order is cancelled in the same statement, so nothing can be prepared, marked ready or dispatched against it afterwards, and there is no path that attaches a second scan to it. No money moves — no refund policy has been decided, and a refused scan appears in admin_exceptions() for a person to resolve.';

-- ---------------------------------------------------------------------------
-- 5. THE CUSTOMER CAN SEE WHERE THE MEAL SCAN HAS GOT TO
-- ---------------------------------------------------------------------------
-- Verification is a real step with a real wait in it — somebody at a counter
-- has to look at the image — and the tracking page used to say "Being
-- prepared" through all of it. Worse, a refused scan read as a plain
-- "Cancelled", which is true and tells the customer nothing about what to do.
--
-- So the stage function learns two facts it did not have: what kind of order
-- this is, and where its scan stands. It still decides only WHICH state the
-- order is in; the screen decides the wording.
--
-- The new signature is created BEFORE the old one is dropped, because the two
-- readers below are SQL functions and therefore genuinely depend on it.

create or replace function public.customer_order_stage(
  p_order_status   public.order_status,
  p_payment_status public.payment_status,
  p_delivery_status public.delivery_status default 'NONE',
  p_fulfilment_type public.fulfilment_type default null,
  p_order_type     public.order_type default 'FOOD',
  p_scan_status    public.scan_status default null
)
returns text
language sql
immutable
as $$
  select case
    -- Kept so an order placed before paid-first ordering still reads sensibly
    -- in somebody's history. Nothing new ever reaches it.
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'

    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'

    -- --- THE MEAL SCAN, BEFORE ANYTHING ELSE IT WOULD BE READ AS -----------
    -- A refused scan cancels the order, so without this line it would read
    -- "Cancelled" — accurate, and useless to somebody who needs to know that
    -- the scan was the problem and that ordering again is the answer.
    when p_order_type = 'SCAN' and p_scan_status = 'REFUSED'           then 'SCAN_INVALID'

    -- Paid, with the store yet to look at it. This is the whole wait between
    -- paying and the kitchen starting, and it used to be invisible.
    when p_order_type = 'SCAN'
     and p_payment_status = 'PAID'
     and p_scan_status in ('UPLOADED', 'RELEASED')
     and p_order_status in ('ACCEPTED', 'PREPARING')                   then 'SCAN_AWAITING_CHECK'

    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'

    when p_order_status = 'PREPARING' and p_delivery_status = 'ASSIGNED' then 'PREPARING_PARTNER_ASSIGNED'
    -- BEING MADE, AND BEING LOOKED FOR. Both at once, and the screen says both.
    when p_order_status = 'PREPARING' and p_delivery_status = 'SEARCHING' then 'PREPARING_SEARCHING'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

    when p_order_status = 'READY' and p_delivery_status = 'SEARCHING'         then 'SEARCHING_PARTNER'
    when p_order_status = 'READY' and p_delivery_status = 'ASSIGNED'          then 'PARTNER_ASSIGNED'
    when p_order_status = 'READY' and p_delivery_status = 'PICKED_UP'         then 'ON_THE_WAY'
    when p_order_status = 'READY' and p_delivery_status = 'FAILED_NO_PARTNER' then 'NO_PARTNER'
    when p_order_status = 'READY'                                            then 'READY'

    -- THE STORE'S PART CAN END BEFORE THE ORDER DOES. A Partner who has
    -- collected leaves order_status at READY, but an administrator completing
    -- an order by hand moves it to COMPLETED while the delivery is still in
    -- flight. Reading the delivery first keeps the customer's screen on the
    -- journey they are actually watching.
    when p_delivery_status = 'PICKED_UP'                              then 'ON_THE_WAY'
    when p_delivery_status = 'FAILED_CUSTOMER_ABSENT'                 then 'CUSTOMER_ABSENT'
    when p_order_status = 'COMPLETED'                                 then 'COMPLETED'
    when p_order_status = 'REJECTED'                                  then 'REJECTED'
    when p_order_status = 'EXPIRED'                                   then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;

comment on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type, public.order_type, public.scan_status) is
  'The one stage a customer is shown, computed from all four state dimensions together. The screen decides wording; this decides which state the order is in. SCAN_AWAITING_CHECK and SCAN_INVALID are read before the states they would otherwise hide behind — "Being prepared" and "Cancelled" — because neither of those tells somebody what is actually happening to their Meal Scan.';

revoke all on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type, public.order_type, public.scan_status) from public, anon;
grant execute on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type, public.order_type, public.scan_status) to authenticated;

-- The two readers, pointed at the new signature.
--
-- DROPPED AND RECREATED, not replaced: the detail gains a column, and a
-- function's OUT row type cannot be changed in place.
drop function if exists public.customer_order_detail(uuid);

CREATE OR REPLACE FUNCTION public.customer_order_detail(p_order_id uuid)
 RETURNS TABLE(order_id uuid, order_number text, vendor_order_no integer, vendor_id uuid, vendor_name text, vendor_location text, stage text, order_status order_status, payment_status payment_status, delivery_status delivery_status, fulfilment_type fulfilment_type, order_type order_type, subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint, pack_fee_pesewas bigint, total_pesewas bigint, destination text, destination_note text, submitted_at timestamp with time zone, seconds_to_deadline integer, seconds_until_partner_search_expires integer, server_now timestamp with time zone, accepted_at timestamp with time zone, preparing_at timestamp with time zone, ready_at timestamp with time zone, assigned_at timestamp with time zone, picked_up_at timestamp with time zone, completed_at timestamp with time zone, cancellation_reason text, payment_id uuid, payment_txn_status payment_txn_status, partner_name text, partner_phone text, delivery_code text, disputed boolean, dispute_reason text, can_rate_partner boolean, rated_stars smallint, items jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- THE STORE'S ID, so a customer whose Meal Scan was not accepted can be
  -- offered the one thing left to do: order the same thing again from the same
  -- store. It is their own order; the id is no more than the page they came
  -- from already knew.
  select o.id, o.order_number, o.vendor_order_no, o.vendor_id, v.name,
         public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status,
                                     o.fulfilment_type, o.order_type, o.scan_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas,
         coalesce(o.pack_fee_pesewas, 0), o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- THE PARTNER SEARCH COUNTDOWN, as a number of seconds from a clock
         -- the customer's device does not own. Paired with server_now below so
         -- a screen can anchor a local countdown against the server's idea of
         -- the time rather than its own — a phone with a wrong clock, a tab
         -- that was backgrounded and a refresh all land in the same place.
         case when o.delivery_status = 'SEARCHING' and o.search_deadline_at is not null
              then greatest(0, extract(epoch from (o.search_deadline_at - now()))::integer) end,
         now(),
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- THE PARTNER'S FIRST NAME, AND IT SURVIVES THE DELIVERY NOW. It used
         -- to be nulled the moment the delivery ended, so the rating prompt
         -- said "your Partner" and the order history named nobody — which made
         -- rating somebody an oddly anonymous act. A first name is what one
         -- person tells another; the PHONE NUMBER is the thing that closes with
         -- the delivery, and it still does on the line below.
         public.given_name(pu.first_name, pu.full_name),
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         -- THE COLLECTION CODE IS NOT HERE. The vendor holds it and reads it
         -- out; the customer types it in. Returning it to the customer would
         -- put holder and performer on the same side of the counter.
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         o.order_status = 'COMPLETED'
           and o.delivery_status = 'DELIVERED'
           and o.partner_id is not null
           and rt.order_id is null,
         rt.stars,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
    left join public.partner_ratings rt on rt.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$function$;


CREATE OR REPLACE FUNCTION public.customer_order_list(p_limit integer DEFAULT 30)
 RETURNS TABLE(order_id uuid, order_number text, vendor_order_no integer, vendor_name text, vendor_image_path text, order_type order_type, stage text, order_status order_status, payment_status payment_status, delivery_status delivery_status, fulfilment_type fulfilment_type, item_count bigint, items_summary text, total_pesewas bigint, submitted_at timestamp with time zone, completed_at timestamp with time zone, seconds_to_deadline integer, partner_first_name text, cancellation_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select o.id, o.order_number, o.vendor_order_no, v.name,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         o.order_type,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status,
                                     o.fulfilment_type, o.order_type, o.scan_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         -- "2× Jollof, Water". The names as they were when ordered, so a store
         -- renaming a dish does not rewrite somebody's history.
         (select string_agg(
                   case when oi.quantity > 1
                        then oi.quantity::text || '× ' || oi.name_snapshot
                        else oi.name_snapshot end,
                   ', ' order by oi.created_at)
            from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at, o.completed_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- First name only, and it stays after the delivery. The PHONE NUMBER
         -- is what ends with the delivery, and this list never carried one.
         public.given_name(pu.first_name, pu.full_name),
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$function$;


revoke all on function public.customer_order_detail(uuid) from public, anon;
grant execute on function public.customer_order_detail(uuid) to authenticated;

-- And the old four-argument version goes, now that nothing calls it.
drop function if exists public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type);

-- ---------------------------------------------------------------------------
-- 6. PAYMENT, AND WHO MAY BE SENT FOR
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_payment(p_payment_id uuid, p_provider_transaction_id text, p_amount_pesewas bigint)
 RETURNS payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  select partner_search_seconds into v_search from public.pricing_config where id;

  -- ONE PATH FOR BOTH ORDER TYPES. A paid order reaches the store the moment
  -- it is paid for — there is no accept and no separate "start preparing". For
  -- a scan the store's work is verifying the scan and packing it rather than
  -- cooking, but it is work on a board either way.
  --
  -- DISPATCH OPENS HERE for a Partner order. A Partner found while the order is
  -- being put together is a Partner who is not standing at a counter waiting,
  -- and the offer carries food_is_ready so nobody sets off too early.
  --
  -- EXCEPT ON A MEAL SCAN, WHERE APPROVAL COMES FIRST. The store has to look at
  -- the scan before anything else happens, and a scan it will not honour ends
  -- the order — so opening a search at payment would put Partners on a job that
  -- may be about to be cancelled, and would expose an order to dispatch before
  -- anybody had verified the entitlement paying for it. vendor_redeem_scan()
  -- opens the search instead, in the same statement that approves the scan.
  --
  -- Guarded on the current state, so a replayed confirmation cannot restart a
  -- search that has already found somebody.
  update public.orders o
     set order_status   = 'PREPARING',
         preparing_at   = now(),
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' and o.order_type <> 'SCAN'
           then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case
           when o.fulfilment_type = 'DELIVERY' and o.order_type <> 'SCAN'
           then now() end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY' and o.order_type <> 'SCAN'
           then now() + make_interval(secs => v_search) end
   where o.id = v_payment.order_id
     and o.order_status = 'ACCEPTED'
  returning * into v_order;

  if found then
    perform public.log_order_event(v_payment.order_id, 'VENDOR_PREPARING', true, 'SYSTEM',
      'order_status', 'ACCEPTED', 'PREPARING', 'payment confirmed');

    if v_order.fulfilment_type = 'DELIVERY' and v_order.order_type <> 'SCAN' then
      perform public.log_order_event(v_payment.order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
        'delivery_status', 'NONE', 'SEARCHING');
    end if;
  end if;

  return v_payment;
end;
$function$;


CREATE OR REPLACE FUNCTION public.partner_accept_delivery(p_order_id uuid)
 RETURNS TABLE(success boolean, reason text, order_number text, vendor_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_slot    smallint;
  v_max     smallint;
  v_full    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
      join public.vendors v on v.id = o.vendor_id
     where o.id = p_order_id and v.owner_user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a store you own'
      using errcode = 'insufficient_privilege';
  end if;

  select max_active_deliveries_per_partner into v_max from public.pricing_config where id;
  v_max := coalesce(v_max, 2);

  v_full := case
    when v_max = 1 then 'You already have an active delivery. Finish it first.'
    else 'You already have ' || v_max || ' active deliveries. Finish one first.'
  end;

  select s into v_slot
    from generate_series(1, v_max) s
   where not exists (
     select 1 from public.orders a
      where a.partner_id = v_partner
        and a.partner_slot = s
        and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
   )
   order by s
   limit 1;

  if v_slot is null then
    return query select false, v_full, null::text, null::text;
    return;
  end if;

  begin
    update public.orders o
       set partner_id = v_partner,
           partner_slot = v_slot,
           delivery_status = 'ASSIGNED',
           assigned_at = now()
     where o.id = p_order_id
       and o.delivery_status = 'SEARCHING'
       -- PREPARING as well as READY. The offer pool opens at payment now, so
       -- the winner is often decided while the food is still on the stove.
       and o.order_status in ('PREPARING', 'READY')
       and o.payment_status = 'PAID'
       -- BELT. A scan order's search is opened by vendor_redeem_scan() and by
       -- nothing else, so SEARCHING already implies an approved scan. This says
       -- so in the statement that does the assigning, where a future change to
       -- who may open a search cannot quietly get round it.
       and (o.order_type <> 'SCAN' or o.scan_status = 'REDEEMED')
       and o.partner_id is null
       and exists (
         select 1 from public.partner_profiles p
          where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
       )
       and (
         select count(*) from public.orders a
          where a.partner_id = v_partner
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < v_max
       and o.customer_id <> v_partner
       and not exists (
         select 1 from public.vendors v
          where v.id = o.vendor_id and v.owner_user_id = v_partner
       )
    returning * into v_order;
  exception
    when unique_violation then
      perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
        'delivery_status', null, 'ASSIGNED', 'partner delivery slot already taken');
      return query select false, v_full, null::text, null::text;
      return;
  end;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text;
    return;
  end if;

  -- Fresh codes, and a fresh attempt counter with them. A Partner who inherits
  -- an order somebody else fumbled starts at zero failures, and the previous
  -- Partner's lockout does not follow the order around.
  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         pickup_attempts = 0,
         pickup_locked_until = null,
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now()),
         delivery_attempts = 0,
         delivery_locked_until = null
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED', null,
    jsonb_build_object('partner_slot', v_slot));

  return query
    select true, null::text, v_order.order_number, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$function$;

