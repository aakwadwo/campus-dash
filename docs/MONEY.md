# Money

Every amount is an **integer number of pesewas**. No floats, anywhere — not in
the database, not in transit, not in a price input box.

## The path a cedi takes

```
customer pays TOTAL
      │
      ├── VENDOR    = food subtotal          → settled DAILY
      ├── PLATFORM  = service fee (+ delivery fee until a Partner earns it)
      └── PARTNER   = delivery fee           → settled WEEKLY
                       carved out of PLATFORM at the moment of delivery
```

Worked example — 2 × GH₵35 jollof, GH₵3 water, delivered:

|                     |                       |
| ------------------- | --------------------- |
| Food                | GH₵73.00 → vendor     |
| Service fee (10%)   | GH₵7.30 → Campus Dash |
| Delivery fee (flat) | GH₵5.00 → Partner     |
| **Customer pays**   | **GH₵85.30**          |

The service fee is a percentage of the food (`pricing_config.service_fee_bps`,
1000 bps = 10%), rounded half-up in integer pesewas. The delivery fee is flat.
Both are snapshotted onto the order at submission, so a later fee change never
moves an order that was already quoted.

## Why the Partner allocation arrives late

At payment time **no Partner exists** — dispatch has not even opened. So payment
writes two rows (`VENDOR`, `PLATFORM`), and `settle_partner_earnings()` carves
the Partner's share out of the platform row when a real Partner has actually
earned it. Both writes are one transaction, so the deferred
`allocations_must_balance` trigger never sees a torn state.

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
