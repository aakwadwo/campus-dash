-- The Campus Dash service fee becomes 6.95% of the food subtotal.
--
-- 695 basis points. Same column, same rounding, same one place — there is no
-- second pricing system and this migration does not create one. The rate stays
-- operator-tunable at /admin/pilot afterwards; this sets what the pilot runs on.
--
-- NOTHING ALREADY QUOTED MOVES. price_order() snapshots the fee onto the order
-- at submit_order(), and allocations are written from that snapshot rather than
-- re-read from pricing_config. So an order already quoted keeps the fee it was
-- quoted at, and an allocation already written keeps its amount. This migration
-- cannot reach them, and must not: re-pricing an order somebody has already
-- paid for would change what they owe after the fact.
--
-- Worked example at the new rate:
--
--   food GH₵25.00 -> subtotal 2500, service fee 174, delivery 500
--   customer pays 3174;  vendor 2500,  partner 500,  platform 174
--
-- (2500 * 695 + 5000) / 10000 = 173.75 -> 174, the same half-up rounding in
-- integer pesewas that price_order() has always used. No floats, anywhere.

alter table public.pricing_config
  alter column service_fee_bps set default 695;

comment on column public.pricing_config.service_fee_bps is
  'Campus Dash service fee, in basis points of the food subtotal. 695 = 6.95%.';

-- The live value.
update public.pricing_config set service_fee_bps = 695 where id;
