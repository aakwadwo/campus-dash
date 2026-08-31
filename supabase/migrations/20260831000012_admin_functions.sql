-- ============================================================================
-- Admin overrides
-- ============================================================================
-- EVERY override writes an admin_actions row in the same transaction as the
-- change it makes. There is no path that alters an order administratively
-- without leaving a record — the audit entry is not a courtesy, it is part of
-- the operation.
-- ============================================================================

create or replace function public.log_admin_action(
  p_action       text,
  p_target_type  text,
  p_target_id    uuid,
  p_reason       text,
  p_before       jsonb default null,
  p_after        jsonb default null,
  p_details      jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id    bigint;
  v_admin uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.admin_actions (
    admin_user_id, action, target_type, target_id, reason, before_state, after_state, details
  )
  values (v_admin, p_action, p_target_type, p_target_id, p_reason, p_before, p_after, p_details)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Partner approval
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_partner(
  p_user_id uuid,
  p_status  public.partner_application_status,
  p_reason  text,
  p_notes   text default null
)
returns public.partner_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('APPROVED', 'REJECTED', 'SUSPENDED') then
    raise exception 'review status must be APPROVED, REJECTED or SUSPENDED'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner application for this user' using errcode = 'no_data_found';
  end if;

  update public.partner_profiles
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_notes = p_notes,
         -- A rejected or suspended Partner stops receiving offers immediately.
         is_available = case when p_status = 'APPROVED' then is_available else false end,
         -- Retention clock for the ID photo and live face photograph.
         documents_purge_after = case
           when p_status = 'APPROVED' then now() + interval '90 days'
           else now() + interval '30 days' end
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_' || p_status::text, 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vendor management
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_vendor_status(
  p_vendor_id uuid,
  p_status    public.vendor_status,
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

  update public.vendors
     set status = p_status,
         -- A suspended vendor cannot be left silently taking orders.
         is_accepting_orders = case when p_status = 'ACTIVE' then is_accepting_orders else false end
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_STATUS_' || p_status::text, 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- The vendor's own AVAILABLE / NOT AVAILABLE switch. Not an admin action.
create or replace function public.vendor_set_accepting_orders(p_vendor_id uuid, p_accepting boolean)
returns public.vendors
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  update public.vendors set is_accepting_orders = p_accepting
   where id = p_vendor_id and status = 'ACTIVE'
  returning * into v_vendor;

  if not found then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;
  return v_vendor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Order overrides
-- ---------------------------------------------------------------------------
create or replace function public.admin_cancel_order(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;
  if v_before.order_status in ('COMPLETED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED') then
    raise exception 'order is already in terminal state %', v_before.order_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set order_status = 'CANCELLED',
         cancelled_at = now(),
         cancellation_reason = p_reason,
         -- Release any Partner so they are free to take other work.
         partner_id = null,
         delivery_status = case
           when delivery_status = 'NONE' then 'NONE'::public.delivery_status
           else 'SEARCHING'::public.delivery_status end
   where id = p_order_id
  returning * into v_after;

  -- Money already collected is marked for refund, never silently kept.
  if v_before.payment_status = 'PAID' then
    update public.orders set payment_status = 'REFUND_PENDING' where id = p_order_id;
    update public.allocations set status = 'CANCELLED'
     where order_id = p_order_id and status in ('PENDING', 'ELIGIBLE');
  end if;

  perform public.log_order_event(p_order_id, 'ADMIN_CANCEL', true, 'ADMIN',
    'order_status', v_before.order_status::text, 'CANCELLED', p_reason);
  perform public.log_admin_action('ORDER_CANCEL', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- Unstick a delivery: pull the current Partner off and return the order to the
-- pool. Rotates the pickup code, so the removed Partner's code is dead.
create or replace function public.admin_reassign_delivery(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  update public.orders
     set partner_id = null, delivery_status = 'SEARCHING', assigned_at = null, picked_up_at = null
   where id = p_order_id
     and fulfilment_type = 'DELIVERY'
     and delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER', 'FAILED_CUSTOMER_ABSENT')
  returning * into v_after;

  if not found then
    raise exception 'order has no reassignable delivery' using errcode = 'check_violation';
  end if;

  update public.order_secrets
     set pickup_code = null,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = null
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'ADMIN_REASSIGN', true, 'ADMIN',
    'delivery_status', v_before.delivery_status::text, 'SEARCHING', p_reason,
    jsonb_build_object('previous_partner_id', v_before.partner_id, 'pickup_code_rotated', true));
  perform public.log_admin_action('DELIVERY_REASSIGN', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- The dispute path: the customer will not or cannot give the delivery code, but
-- the food did arrive. Requires an admin and a stated reason.
create or replace function public.admin_complete_order(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  -- delivery_status only becomes DELIVERED when a Partner actually carried it.
  -- An order completed after dispatch failed (the customer collected it, or the
  -- admin resolved it another way) has no Partner, and claiming DELIVERED would
  -- both be untrue and violate orders_partner_matches_delivery_state.
  update public.orders
     set order_status = 'COMPLETED',
         completed_at = now(),
         delivery_status = case
           when fulfilment_type = 'DELIVERY' and partner_id is not null
             then 'DELIVERED'::public.delivery_status
           else delivery_status end,
         delivered_at = case
           when fulfilment_type = 'DELIVERY' and partner_id is not null then now()
           else delivered_at end
   where id = p_order_id and order_status not in ('COMPLETED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED')
  returning * into v_after;

  if not found then
    raise exception 'order cannot be completed from its current state' using errcode = 'check_violation';
  end if;

  -- Only pay a Partner who exists.
  if v_after.fulfilment_type = 'DELIVERY' and v_after.partner_id is not null then
    perform public.settle_partner_earnings(p_order_id);
  end if;

  perform public.log_order_event(p_order_id, 'ADMIN_COMPLETE', true, 'ADMIN',
    'order_status', v_before.order_status::text, 'COMPLETED', p_reason);
  perform public.log_admin_action('ORDER_COMPLETE', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------
-- Deliberately records intent and state only. The actual reversal goes through
-- the PaymentProvider adapter, whose refund capabilities are still an open
-- question with Hubtel/Paystack.
create or replace function public.admin_mark_refunded(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  update public.orders set payment_status = 'REFUNDED'
   where id = p_order_id and payment_status = 'REFUND_PENDING'
  returning * into v_after;

  if not found then
    raise exception 'order payment is not REFUND_PENDING' using errcode = 'check_violation';
  end if;

  update public.allocations set status = 'CANCELLED'
   where order_id = p_order_id and status <> 'SETTLED';

  perform public.log_order_event(p_order_id, 'REFUND_COMPLETED', true, 'ADMIN',
    'payment_status', 'REFUND_PENDING', 'REFUNDED', p_reason);
  perform public.log_admin_action('ORDER_REFUND', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;
