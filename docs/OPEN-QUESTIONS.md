# Open Questions

These are **unresolved**. Nothing in the codebase may assume an answer, and none
of them block development — the fake payment and fake SMS providers exist
precisely so they don't.

Last reviewed: 2026-08-31 (end of Phase 2)

## Payment provider (blocking Phase 9, not before)

Hubtel has been contacted about split settlement. No answer yet.

- Does Hubtel support one collection with automatic allocation/split settlement,
  or must we collect to a platform account and transfer out afterwards?
- Does Paystack support the Ghana MoMo collection **and** transfer model we need?
- Can vendor money move immediately, or only on a daily schedule?
- What are the fees, per collection and per transfer?
- What refund capabilities exist? Partial refunds? Time limits?
- What are the webhook security requirements (signature scheme, IP allow-list,
  replay window)?
- What idempotency mechanisms does the provider offer on collections and
  transfers?

**How the code stays neutral:** everything goes through `PaymentProvider`
(`lib/payments/provider.js`). The database models `payments`, `allocations`,
`settlement_runs` and `payouts` as separate concepts, so either architecture —
split settlement or collect-then-transfer — can be expressed without a schema
rewrite.

## Pricing

- What service fee will Academic City students actually accept?
- What delivery fee will Partners accept for a campus walk?
- **What share of the delivery fee does the Partner keep?** The V1 default is
  100% (`partner_share_of_delivery_bps = 10000`), matching the worked example in
  the spec: GH₵2 delivery fee → GH₵2 to the Partner. If Campus Dash is meant to
  take a cut of delivery as well as the service fee, this number changes and
  nothing else does.
- Do vendors pay a commission, and at what rate? Nothing in the schema deducts
  one today — the vendor allocation is the full food subtotal.

**Placeholder:** all of these live in the `pricing_config` table (one row,
admin-editable) and are SNAPSHOTTED onto each order at submit time, so changing
them never rewrites the history of an order already placed. V1 is a flat
delivery fee, as decided; zone-based pricing later means a new lookup at quote
time, not a change to `orders`.

## Operations

- How long does a vendor realistically take to respond? (60s is an assumption,
  see `VENDOR_RESPONSE_WINDOW_SECONDS`.)
- How many Partners are available at peak?
- **What is offered when no Partner accepts?** This is the one product decision
  Phase 2 hit and deliberately did NOT invent. "Collect it yourself" means
  refunding the delivery portion of an already-captured payment, and the refund
  mechanics depend on the provider question above.

  What IS built: `FAILED_NO_PARTNER` touches delivery state only — the order
  stays READY and PAID, the food still exists, and an admin can return it to
  SEARCHING with `admin_reassign_delivery()` without recreating anything. What
  is NOT built: the customer-facing choice, and any partial refund.

- Are room-level deliveries allowed everywhere, or only to common areas in some
  blocks?
- Who pays for incorrect or missing food?
- Vendor settlement schedule? (Daily is an assumption.)
- Partner payout schedule? (Weekly is an assumption.)

## Legal

- Is the payment/settlement structure sound under Ghanaian law?
- Data Protection Commission registration and requirements — we store student ID
  images and live face photographs.
- Terms & Conditions for Customers, Vendors and Partners; each versioned and
  recorded in `terms_acceptances`.
- Partner contractor arrangement.
- Vendor agreements.

## Surfaced during Phase 2

### Walking estimates

The Partner offer shows a walk estimate as `vendors.walk_minutes_to_campus +
locations.walk_minutes`. Both are admin-supplied integers, and when either is
NULL the estimate is **omitted rather than guessed**. Nobody has measured these
numbers for Academic City yet, and the seed values are illustrative.

### Auto-completion after a delivery timeout

The spec anticipates eventually auto-completing a delivery when the customer
does not supply the code but there is no dispute. Not built. The schema supports
it (`FAILED_CUSTOMER_ABSENT` → `DELIVERED` is a legal transition, and
`admin_complete_order()` already does it manually with a recorded reason), but
what timeout is fair, and who absorbs the loss if the food never arrived, are
unanswered.

### Campus location data

The seeded tree (Hostel Block A/B, Academic Block, Sports Complex, and their
rooms) is **illustrative development data**. Real block, floor and room names
must come from the university before this is used with real students. Related:
are room-level deliveries acceptable to the university everywhere, or only to
common areas in some blocks?

### Supabase CLI version

The installed CLI (v2.72.7) rejects a `secret` key under
`[auth.hook.send_sms]`. The Send SMS Hook needs that shared secret to
authenticate Supabase as the caller — an unauthenticated hook endpoint is an
open SMS-sending door. Upgrade (`brew upgrade supabase`, v2.116.0 is current)
before Phase 3 wires phone OTP.
