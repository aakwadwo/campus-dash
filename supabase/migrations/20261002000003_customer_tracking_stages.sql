-- ---------------------------------------------------------------------------
-- ONE STAGE THE CUSTOMER COULD NOT SEE
-- ---------------------------------------------------------------------------
-- Dispatch opens at PAYMENT, not at READY — a Partner claimed while the food is
-- still cooking is one who is not hunted for at the last minute. Which means
-- that for most of a Partner order's life, TWO things are happening at once:
-- the store is making it and Campus Dash is looking for somebody to carry it.
--
-- The customer was shown only the first. `PREPARING` swallowed the search
-- entirely, so the countdown had nowhere to live until the food was already
-- made — by which point most of the search window had usually gone, and a
-- customer who had been watching a screen for eight minutes was told for the
-- first time that a Partner was being looked for.
--
-- Splitting it costs one CASE arm and gives the tracking screen somewhere
-- honest to put the clock.

create or replace function public.customer_order_stage(
  p_order_status public.order_status,
  p_payment_status public.payment_status,
  p_delivery_status public.delivery_status default 'NONE',
  p_fulfilment_type public.fulfilment_type default null
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

comment on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type) is
  'The one stage a customer is shown, computed from all three state dimensions together. The screen decides wording; this decides which state the order is in.';
