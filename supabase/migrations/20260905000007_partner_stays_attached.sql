-- ============================================================================
-- A Partner who collected the food stays attached to the order
-- ============================================================================
-- The original constraint required partner_id to be set for exactly
-- ASSIGNED, PICKED_UP and DELIVERED. That misses the case where a Partner
-- collected the food, travelled, and could not find the customer.
--
-- FAILED_CUSTOMER_ABSENT is not a delivery that never happened. Someone picked
-- the order up and did the work, and they must be paid for it — which means the
-- order has to remember who they were. Detaching them to satisfy a CHECK would
-- lose the only link between the money and the person owed it.
--
-- Found by the absence test: partner_confirm_customer_absent() could not commit
-- at all, so this path had never actually run.
-- ============================================================================

alter table public.orders
  drop constraint orders_partner_matches_delivery_state;

alter table public.orders
  add constraint orders_partner_matches_delivery_state check (
    (partner_id is not null) = (
      delivery_status in ('ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED_CUSTOMER_ABSENT')
    )
  );

-- admin_reassign_delivery() clears partner_id, so it must not be offered for an
-- absence outcome — that would erase who is owed the money. Reassigning a
-- FAILED_CUSTOMER_ABSENT order is not a rescue, it is data loss.
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
     -- FAILED_CUSTOMER_ABSENT deliberately excluded: that Partner is owed money.
     and delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER')
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

revoke execute on function public.admin_reassign_delivery(uuid, text) from public, anon;
grant execute on function public.admin_reassign_delivery(uuid, text) to authenticated;
