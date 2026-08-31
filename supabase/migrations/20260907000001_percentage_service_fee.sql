-- ============================================================================
-- Campus Dash service fee becomes a PERCENTAGE
-- ============================================================================
-- The intended commercial model is 10% of the food subtotal, not a flat amount.
-- The configuration held a flat GH₵2.00, so the two disagreed — the fee never
-- moved with basket size.
--
-- Basis points, like the Partner's share of the delivery fee, so the two
-- percentage settings in the system read the same way. 1000 bps = 10%.
--
-- Rounding is half-up in INTEGER arithmetic: (subtotal * bps + 5000) / 10000.
-- No numeric, no float — a fee is money, and money here has never been allowed
-- to touch a floating point type.
--
-- The delivery fee stays a flat GH₵5.00. That is a locked V1 decision.
-- ============================================================================

alter table public.pricing_config
  add column if not exists service_fee_bps integer not null default 1000
    check (service_fee_bps between 0 and 10000);

comment on column public.pricing_config.service_fee_bps is
  'Campus Dash service fee, in basis points of the food subtotal. 1000 = 10%.';

-- The flat column is dropped rather than left in place. A setting that no
-- longer affects anything is worse than no setting: someone will change it and
-- believe it worked.
alter table public.pricing_config drop column if exists service_fee_pesewas;

update public.pricing_config set service_fee_bps = 1000 where id;

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------
create or replace function public.price_order(
  p_vendor_id               uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_items                   jsonb,
  p_destination_location_id uuid default null
)
returns table (
  subtotal_pesewas         bigint,
  service_fee_pesewas      bigint,
  delivery_fee_pesewas     bigint,
  partner_earnings_pesewas bigint,
  total_pesewas            bigint,
  destination_zone_id      uuid,
  lines                    jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location' using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Integer division floors, so the Partner's share can never exceed the fee.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_menu.price_pesewas,
      'quantity',           v_qty,
      'line_total_pesewas', v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- 10% of the food, rounded half-up, in whole pesewas.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;

  return query select
    v_subtotal, v_service, v_delivery, v_earnings,
    v_subtotal + v_service + v_delivery,
    v_zone, v_lines;
end;
$$;

-- ---------------------------------------------------------------------------
-- Config editing follows the model change
-- ---------------------------------------------------------------------------
drop function if exists public.admin_update_config(
  text, bigint, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer
);

create or replace function public.admin_update_config(
  p_reason text,
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
  p_customer_poll_seconds           integer default null
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
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds)
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

revoke execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer
) from public, anon;
grant execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- Order submission follows the same rule
-- ---------------------------------------------------------------------------
-- Unchanged from 20260903000002 except that the fee is derived from the
-- subtotal after the item loop, instead of copied from a flat config column.
create or replace function public.submit_order_for(
  p_customer_id             uuid,
  p_vendor_id               uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_items                   jsonb,
  p_destination_location_id uuid default null,
  p_destination_note        text default null
)
returns table (order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_total    bigint;
  v_service  bigint := 0;
  v_zone     uuid;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Placing an order AS someone else is a server-only capability.
  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location' using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accept_deadline_at
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'SUBMITTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    p_destination_note,
    v_zone,
    0, 0, v_delivery,
    v_earnings, v_delivery,
    'NONE', now(), now() + make_interval(secs => v_cfg.vendor_response_seconds)
  )
  returning id, orders.order_number into v_order_id, v_number;

  -- --- PRICE SNAPSHOT ------------------------------------------------------
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- The service fee is a percentage of the food, so it cannot be known until
  -- the item loop above has a subtotal. Half-up, integer arithmetic only.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_total, 'item_count', jsonb_array_length(p_items))
  );

  return query select v_order_id, v_number, v_total;
end;
$$;
