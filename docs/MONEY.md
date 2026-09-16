# Money

Every amount is an **integer number of pesewas**. No floats, anywhere — not in
the database, not in transit, not in a price input box.

## The path a cedi takes

```
customer pays TOTAL
      │
      ├── VENDOR    = food subtotal    → SPLIT at the charge, or settled DAILY
      ├── PLATFORM  = service fee (+ delivery fee until a Partner earns it)
      └── PARTNER   = delivery fee     → settled WEEKLY, by transfer
                       carved out of PLATFORM at the moment of delivery
```

**Two channels, and `allocations.settlement_channel` says which one a row used.**
A vendor with a registered Paystack subaccount is paid by Paystack as the
customer pays: their share is split off the charge and never enters the Campus
Dash balance, so their allocation is born `SETTLED` and no payout run can claim
it. A vendor without one is settled by the daily run, exactly as before. Both are
on the ledger at the same amount; only the route differs. See `docs/PAYMENTS.md`.

The Partner is always a transfer, and cannot be otherwise — see below.

Worked example — 2 × GH₵35 jollof, GH₵3 water, delivered:

|                     |                       |
| ------------------- | --------------------- |
| Food                | GH₵73.00 → vendor     |
| Service fee (6.95%) | GH₵5.07 → Campus Dash |
| Delivery fee (flat) | GH₵5.00 → Partner     |
| **Customer pays**   | **GH₵83.07**          |

The service fee is a percentage of the food (`pricing_config.service_fee_bps`,
695 bps = 6.95%), rounded half-up in integer pesewas. The delivery fee is flat.
Both are snapshotted onto the order at submission, so a later fee change never
moves an order that was already quoted.

**The fee is charged ON TOP of the food, never taken out of it.** The vendor is
entitled to the whole subtotal and the Partner to the whole delivery fee, and
neither expression mentions the rate — so changing it moves Campus Dash's own
revenue and nothing else. Provider transaction fees are likewise a platform
expense and are never deducted from an allocation.

The rounding rule earns its keep at this rate in a way it did not at 10%, where
a basket priced in whole cedis could never produce a fraction of a pesewa. At
6.95% it can: a subtotal that is an odd multiple of GH₵10.00 lands exactly on
half a pesewa — GH₵30.00 of food is GH₵2.085 of fee — and half-up resolves it
to GH₵2.09, so the customer pays a pesewa more rather than Campus Dash quietly
eating it. Which subtotals land there is a property of the RATE, so the rule is
stated once and the fixtures are recomputed whenever the rate moves. See
`tests/service-fee.test.js`.

## Two pricing systems, and they never meet

Everything above is a **food order**: Campus Dash sold the food, there is a real
subtotal, and the service fee is a percentage of it.

A **scan order** is not that. The student's campus meal entitlement pays the
store for the food; Campus Dash sold no food, `orders.subtotal_pesewas` is zero
and no VENDOR allocation is written at all. So the fee cannot be a percentage of
anything — there is nothing of ours to take a percentage of.

|             | Food order                        | Scan order                        |
| ----------- | --------------------------------- | --------------------------------- |
| Subtotal    | the store's prices                | **GH₵0.00**                       |
| Service fee | `service_fee_bps` of the subtotal | `scan_service_fee_pesewas` FLAT   |
|             | 6.95%                             | GH₵2.00, whatever is in it        |
| Pack fee    | never (CHECK constraint)          | GH₵4.00, optional on a collection |
| Partner fee | `delivery_fee_pesewas`, GH₵5.00   | `delivery_fee_pesewas`, GH₵5.00   |
| VENDOR row  | the subtotal                      | **none is written**               |

`price_order()` reads `service_fee_bps`; `price_scan_order()` does not read it at
all. Taking a percentage of the value a scan covered would be charging a
commission on a transaction between the student and the university, and it would
make the fee move with a number the customer is not paying. See `docs/SCAN.md`
for the full table, including the pack rules.

## Why the Partner allocation arrives late, and why it cannot be split

At payment time **no Partner exists** — dispatch has not even opened. So payment
writes two rows (`VENDOR`, `PLATFORM`), and `settle_partner_earnings()` carves
the Partner's share out of the platform row when a real Partner has actually
earned it.

That is also the whole reason the Partner is absent from every Paystack split. A
split is fixed when the charge is created, and at that moment there is nobody to
name. The alternatives are both worse than a weekly transfer: charging after
assignment would mean the kitchen starts before anyone has paid, and there is no
supported way to add a subaccount to a transaction Paystack has already
processed.

Both writes are one transaction, so the deferred `allocations_must_balance`
trigger never sees a torn state.

That trigger is the money invariant: **allocations for an order must sum to the
order total, or the transaction does not commit.** It works well enough that the
reconciliation tests have to disable it to simulate the corruption they exist to
catch.

## Settlement

A run gathers eligible allocations for a period, claims them, and creates **one
payout per payee**. Idempotent in four places, because the alternative is paying
somebody twice:

1. a run for an existing period is **returned**, not recreated;
2. claimed allocations are gone, so a second run finds nothing;
3. `payouts_run_payee_unique` refuses a duplicate payout;
4. the transfer carries the payout's own idempotency key.

A run claims only `ELIGIBLE` allocations, which is what keeps split settlement
and payout settlement from ever paying the same money twice: an allocation
Paystack already routed is written `SETTLED`, and `SETTLED` is not `ELIGIBLE`.

Transfers go through `PaymentProvider.sendTransfer()`.

**A transfer the provider accepted is not a payout that arrived.** Acceptance
puts the payout at `PROCESSING`; only the provider's transfer event makes it
`PAID`. A failed transfer marks it `FAILED` and **releases the allocation
claim**, so the money is swept into the next run rather than stranded behind a
dead payout row. A `REVERSED` transfer does the same, from `PAID`. Retry is
manual — see `docs/PAYMENTS.md`.

### The minimum payout

`pricing_config.min_payout_pesewas` is the point below which a transfer costs
more in fees than it moves. A payee under it is **deferred**, and deferral is
applied inside `create_settlement_run`, before a payout row exists:

- no payout is created — there is nothing to send, so nothing pretends to be on
  its way;
- the claim on their allocations is released in the same transaction, so they
  are `ELIGIBLE` and unclaimed again the moment the run returns;
- `admin_pending_settlement` therefore still shows the money as owed, and it
  keeps accumulating until some later run finds enough of it to clear the bar;
- the run records `deferred_payee_count` and `deferred_pesewas`, so "moved
  nothing, correctly" is distinguishable from "found nothing".

That deferral only works because **a run sweeps forward**. The claim is bounded
above by `period_end` — a run for a past period must not take money that came in
afterwards — but has no lower bound. Anything older is either already claimed by
the run that took it or was deliberately put back (deferred, failed, reversed),
and putting it back is meaningless if no later run can reach it. `retry_payout`
reclaims over the same window, and refuses unless it takes back exactly what its
payout was worth.

`PLATFORM` is not a payee. Its allocations carry no `payee_id`, so a `PLATFORM`
run could only move the platform's own ledger rows to `SETTLING` and strand
them; `create_settlement_run` refuses it outright.

**Campus Dash does not run a vendor wallet.** A vendor sees earned / awaiting /
settled and their past settlements — never a stored balance implying we are
holding their money.

## The Partner weekly payout policy

A Partner earns **GH₵5** per completed delivery and is paid **weekly**, once
their available earnings reach **GH₵20**
(`pricing_config.partner_min_payout_pesewas`, editable at `/admin/pilot`).

| Balance at the run | What happens                                       |
| ------------------ | -------------------------------------------------- |
| GH₵5 / 10 / 15     | Held. Carried forward to the next weekly cycle.    |
| GH₵20              | Paid.                                              |
| GH₵35              | **All GH₵35** is paid, not GH₵20 with a remainder. |

**"Carried forward" has to mean owed and reachable.** `create_settlement_run()`
claims the allocations, then RELEASES the claim for any payee under the
threshold _inside the same transaction_ — so the money is owed again the moment
the run returns and the next run sweeps it. The failure this prevents is the one
where a run claims money, declines to send it, and leaves it attached to a
payout nothing will ever process: owed to nobody, invisible to every later run.
`tests/partner-payouts.test.js` asks "where is the money now" after every
scenario for exactly that reason.

**Two thresholds, deliberately.** Vendors settle by Paystack split at the moment
of the charge; the vendor run is a fallback for stores with no subaccount, and
holding a small store's food money for a week would be wrong. So
`partner_min_payout_pesewas` is a Partner policy and `min_payout_pesewas` is the
general floor. `payout_threshold_for()` is the one function that decides which
applies, so a dashboard and a run can never disagree.

**What a Partner is told, and what they are not.** The dashboard states the
policy: earnings accumulate, payouts run weekly, a balance under GH₵20 carries
forward. It never mentions a payment provider or a provider minimum. Those are
Campus Dash's constraints to work within, not an explanation owed to somebody
who has done the work — and `my_partner_payouts()` deliberately returns no
provider failure text, mapping FAILED to "processing" because a failed transfer
puts the money straight back into the next run.

## Reconciliation

`admin_reconciliation()` returns **only discrepancies**. A list of everything
that is fine is not a report, it is a distraction. It looks for:

- `NO_ALLOCATIONS` — paid, but the ledger never wrote
- `ALLOCATION_MISMATCH` — the parts do not sum to the whole
- `PROVIDER_MISMATCH` — we say PAID, no succeeded payment exists
- `AMOUNT_MISMATCH` — the provider captured a different amount
- `PARTNER_UNPAID` — delivered, but nobody was allocated the fee

On a healthy system it returns nothing.

## Payment is provider-agnostic

The provider is **Paystack** (`docs/PAYMENTS.md`), reached only through
`lib/payments`. `PAYMENT_PROVIDER=fake` still runs the whole flow with no
account and no credit.

The shape was chosen so the answer would not matter, and it did not: collect
centrally and transfer later produces exactly the `payments`, `allocations`,
`settlement_runs` and `payouts` rows a split-at-source provider would. Only
which adapter fills in `provider_transaction_id` and `provider_transfer_id`
changes. **No splits and no subaccounts are used** — Campus Dash's own
allocations are the source of truth for what a vendor and a Partner are owed.

Paystack's transaction fee is absorbed by Campus Dash. It does not reduce the
vendor's food entitlement or the Partner's delivery entitlement: allocations are
computed from the order, not from what net amount happened to land.

## Only a provider can say "paid"

`confirm_payment` is not granted to any client role. Payment state moves when a
**signature-verified, deduplicated** provider event arrives — never because a
browser said so. Webhooks deduplicate on the provider's own event id, so a
provider retrying five times moves money once.
