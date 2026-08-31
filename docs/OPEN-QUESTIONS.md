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

### ~~Supabase CLI version~~ — RESOLVED in Phase 3

The CLI is now pinned in the repo as a dev dependency (v2.116.0) rather than
installed globally, so every machine and CI run uses the same one. The hook
secret is configured and verified; the field is `secrets` (plural), not
`secret`.

## Surfaced during Phase 3

### Terms & Conditions — not built

`terms_acceptances` does not exist. Users must eventually agree to
version-stamped terms (Customer, Vendor, Partner), with the version, user and
timestamp recorded — a bare checkbox is not enough. Registration is where this
belongs, but it needs the actual terms text and a versioning decision first.
Blocked on legal, not on engineering.

### Stub SMS provider in config.toml

GoTrue gates phone login behind `GOTRUE_EXTERNAL_PHONE_ENABLED`, which the CLI
only sets when an SMS _provider_ block is enabled — the Send SMS Hook alone is
not enough. `[auth.sms.twilio]` is therefore enabled with non-functional
placeholder credentials purely to switch phone login on; verified locally that
GoTrue delivers through the hook and never contacts the provider.

**Check this again when configuring the hosted project.** If the same trick is
needed in production, the placeholder must stay obviously non-functional so a
misconfiguration cannot silently start sending real Twilio messages.

### OTP rate limits are Supabase defaults

30 SMS per hour and 30 verification attempts per five minutes, unchanged from
the CLI defaults. Nobody has decided whether those suit a campus at lunchtime,
when a burst of students all order at once.

## Surfaced during Phase 5

### ~~The vendor never sees the customer's phone number~~ — DECIDED

V1 keeps the customer's number hidden from vendors, and the Phase 2 RLS policy
that permitted it has been dropped. Support handles those conversations.

Original note follows.

### The vendor never sees the customer's phone number

The vendor screens deliberately show no customer identity at all. RLS still
permits a vendor to read the customer's row for a LIVE order (added in Phase 2,
for "phone someone about a wrong order"), but nothing surfaces it.

**Decide before launch:** should a vendor be able to call a customer about a
missing item, or should every such conversation go through Campus Dash support?
If the former, the vendor detail screen needs a reveal, and it should be
audited. If the latter, that RLS policy should be dropped.

### Partner handoff belongs to which module?

`vendor_confirm_pickup()` is built and tested, but the screen is not. The vendor
types in the code the Partner reads aloud. Phase 8 needs to decide whether that
lands on the vendor board or in a dedicated handoff view.

### ~~Vendors cannot edit their own menu~~ — PARTLY DECIDED

Vendors can now toggle item AVAILABILITY through
`vendor_set_menu_item_available()`. Prices remain admin-only. Still open: should
a vendor be able to add or rename their own items?

Original note follows.

### Vendors cannot edit their own menu

Phase 4 kept menu and price control entirely with the admin. That is safe, but
it means a stall cannot mark themselves out of jollof without calling someone.

**Decide:** should a vendor be able to toggle item availability (not price) for
their own stall? Toggling availability is low-risk and would remove a lot of
phone calls; changing prices is not, since it affects what customers are quoted.

## Surfaced during Phase 6

### A customer cannot cancel their own order

Not built, deliberately. Before the vendor accepts, an order costs nothing and
expires by itself in 60 seconds. After acceptance it is a commitment on both
sides, and unwinding it means a refund — which depends on the unresolved
provider question.

**Decide:** should there be a customer-facing cancel while the order is still
AWAITING_VENDOR? It is cheap to add and costs nobody anything.

### The service fee is charged even on a rejected order? No — but check the intent

Nothing is charged until the vendor accepts, so a rejected or expired order
costs the customer nothing at all. Confirm that is the commercial intent: some
platforms charge a fee for the attempt. Campus Dash currently does not.

### Vendor-facing SMS volume

A vendor now receives an SMS on submission and another on payment. At lunchtime
peak that could be two messages per order per stall, which costs real money.

**Decide before launch:** is the payment-confirmed SMS to the vendor worth it,
given the in-app board already updates and beeps?


## Surfaced during the operational build

### Terms text is placeholder, and that is a launch blocker
`terms_documents` holds three PLACEHOLDER documents so the acceptance mechanism
could be built and tested. They are clearly marked and are **not legal terms**.

Real text is needed before anyone outside the team uses Campus Dash, covering at
minimum: the Partner contractor relationship, what Campus Dash is and is not
liable for on a wrong or missing order, and the data-protection basis for
holding student ID photographs. **Blocked on a lawyer, not on engineering.**

### Who pays when the customer is absent?
Implemented: the Partner is paid, because they collected the order and
travelled. What is NOT decided is what happens to the food, and whether the
customer is refunded the food amount, the delivery fee, both or neither. The
system records the event and hands it to an admin.

**Decide before launch** — it will happen in the first week.

### The delivery fee is not refunded when a customer collects instead
`customer_collect_instead()` deliberately does not refund. A partial refund
depends entirely on what the payment provider supports, and inventing one the
provider cannot perform is worse than not offering it. The screen says so
plainly and points at support.

### Partner document retention has a deadline but no sweeper
`documents_purge_after` is set on review (90 days approved, 30 rejected), and
`admin_partner_documents_due_for_purge()` lists what is due. Nothing deletes
them automatically — an admin must act. That is a Data Protection Commission
question as much as an engineering one: what retention period is actually
defensible for a government-ID photograph?

### Settlement is manual
There are buttons, not a schedule. `pg_cron` already runs the timeout sweeps, so
adding daily and weekly settlement jobs is small — but running money on a timer
before anyone has watched it run by hand seemed like the wrong order.

### SMS volume and cost
Every party is now notified at several points. At lunchtime peak that is real
money in Ghana. `notification_events` records every send, so the first week of
real use will show exactly which messages are worth keeping.

**Decide after pilot data**, not before.
