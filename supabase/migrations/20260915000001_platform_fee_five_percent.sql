-- ============================================================================
-- Campus Dash platform revenue: 10% -> 5% of the food subtotal
-- ============================================================================
-- A commercial decision, not a mechanical one. Nothing about HOW the fee is
-- computed changes, and that is the point of this migration being three
-- statements long: 20260907000001 already made the fee a percentage of the food
-- subtotal, in basis points, rounded half-up in integer pesewas. Only the rate
-- moves.
--
-- WHAT 5% MEANS HERE, precisely, because the arithmetic has a shape people get
-- wrong:
--
--   service fee   = round_half_up(food subtotal * 500 / 10000)   -- FOOD only
--   vendor gets   = the food subtotal, in full, untouched
--   partner gets  = the flat delivery fee, in full, untouched
--   platform gets = the service fee, and nothing else
--   customer pays = subtotal + service fee + delivery fee
--
-- The fee is a percentage of FOOD, never of the delivery fee and never of the
-- total. Halving it takes money from Campus Dash and from nobody else: the
-- vendor's entitlement and the Partner's entitlement are computed from the
-- subtotal and the delivery fee respectively, and neither expression mentions
-- the rate. Provider transaction fees remain a platform expense; they have
-- never been deducted from an allocation and still are not.
--
-- HISTORICAL ORDERS ARE NOT AFFECTED, structurally rather than by convention.
-- price_order snapshots service_fee_pesewas onto the order at submission, and
-- create_order_allocations derives the ledger from that snapshot
-- (subtotal_pesewas and total_pesewas on the ORDER row), never from
-- pricing_config. So an order already quoted keeps the fee it was quoted at,
-- and an allocation already written keeps its amount. This migration cannot
-- reach them, and must not.
--
-- Worked example at the new rate:
--
--   food GH₵25.00 -> subtotal 2500, service fee 125, delivery 500
--   customer pays 3125;  vendor 2500,  partner 500,  platform 125
-- ============================================================================

alter table public.pricing_config
  alter column service_fee_bps set default 500;

comment on column public.pricing_config.service_fee_bps is
  'Campus Dash service fee, in basis points of the food subtotal. 500 = 5%.';

-- The live value. Still operator-tunable at /admin/pilot afterwards — this sets
-- the rate the pilot starts from, exactly as 20260907000001 set the old one.
update public.pricing_config set service_fee_bps = 500 where id;
