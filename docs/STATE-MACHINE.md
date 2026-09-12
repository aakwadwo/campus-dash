# Order State Machine

Three **independent** dimensions. Never collapsed into one status field.
Delivery state is never a proxy for order state.

Source of truth: Postgres enums + `CHECK` constraints.
Mirrored for application code in `lib/orders/state.js`.

## What changed, and why the diagrams look shorter

An order used to be offered to a store before anybody paid for it. The store had
sixty seconds to accept, the customer then chose pickup or delivery, and only
then was there a price to charge. That produced three states nothing reaches any
more — SUBMITTED, EXPIRED, REJECTED — and a 60-second countdown on a phone next
to a hot plate.

**An order is now priced in full at the checkout and paid for before a store sees
it.** The store's whole job is to make it and press one button. The enum values
survive because real orders in the database point at them; nothing new arrives
there.

## order_status — the food

```
ACCEPTED ──▶ PREPARING ──▶ READY ──▶ COMPLETED
    │            │            │
    └────────────┴────────────┴──▶ CANCELLED / CANCELLED_BY_VENDOR
```

- **ACCEPTED** means "priced and payable". It is the state `submit_order()`
  creates, and the name is inherited: there is nobody left to accept anything.
- **ACCEPTED → PREPARING is done by `confirm_payment()`**, not by a person.
  Paying is what reaches a kitchen.
- **READY** is the store's only button, and it is called _Ready for pickup_ —
  never _Done_, which would be a lie: nobody has the food yet and the handoff
  still has to be proved.
- `accept_deadline_at` is now the **pay-by** deadline, read from
  `pricing_config.payment_pending_timeout_seconds`. An order nobody pays for is
  CANCELLED by `expire_stale_orders()`, with the reason "the order was not paid
  for". Nothing is ever charged for one.
- Terminal: COMPLETED, CANCELLED, CANCELLED_BY_VENDOR. (SUBMITTED, EXPIRED and
  REJECTED are historical — see above.)

## payment_status — the money

```
UNPAID ──▶ PENDING ──▶ PAID ──▶ REFUND_PENDING ──▶ REFUNDED
              │                        │
              ▼                        └──▶ PAID   (refund failed/reversed)
            FAILED ──▶ PENDING         (retry)
```

- Only **one live payment intent per order**, enforced by a partial unique index.
- The server calculates the amount. A client-supplied amount is never
  authoritative and is never even read.
- Every transition is driven by a provider webhook or an authoritative
  `getStatus()` read — never by the browser reporting success.

## delivery_status — the Partner

```
NONE  (collection orders stay here forever)

SEARCHING ──▶ ASSIGNED ──▶ PICKED_UP ──▶ DELIVERED
    │             │             │
    │             │             └──▶ FAILED_CUSTOMER_ABSENT
    │             └──▶ SEARCHING  (Partner cancelled before handoff)
    └──▶ FAILED_NO_PARTNER ──▶ SEARCHING  (retry)
```

- **Dispatch begins at PAYMENT**, not at READY. A Partner claims the job while
  the kitchen works, so nobody is found at the last minute and nobody stands at
  a counter waiting for a search that has not started. The offer carries
  `food_is_ready` so a Partner knows whether to set off or wait, and
  `partner_confirm_pickup()` refuses until `order_status = 'READY'` — checked
  before the code, so an early attempt costs no attempt.
- `ASSIGNED → SEARCHING` is Partner cancellation. **Same order.** Assignment
  cleared, handoff code rotated, old code dead. Payment and preparation
  untouched. The store is never asked to recreate anything.
- `FAILED_NO_PARTNER` does **not** move `order_status`. The food exists. The
  customer is offered: collect it yourself, keep waiting, or seek resolution.

## Legal combinations worth stating plainly

| order_status | payment_status | delivery_status   | Meaning                                     |
| ------------ | -------------- | ----------------- | ------------------------------------------- |
| ACCEPTED     | UNPAID         | NONE              | Priced. The customer is at the pay button   |
| ACCEPTED     | PENDING        | NONE              | A charge is in flight                       |
| PREPARING    | PAID           | NONE              | Paid, cooking, collection order             |
| PREPARING    | PAID           | SEARCHING         | Paid, cooking, looking for a Partner        |
| PREPARING    | PAID           | ASSIGNED          | Somebody is bringing it; it is not made yet |
| READY        | PAID           | NONE              | On the counter, waiting for the customer    |
| READY        | PAID           | FAILED_NO_PARTNER | **Food is fine.** Nobody took it            |
| COMPLETED    | PAID           | NONE              | The customer collected it themselves        |
| COMPLETED    | PAID           | DELIVERED         | A Partner delivered it                      |

## Concurrency

Every transition is a conditional UPDATE guarded on the current state:

```sql
UPDATE orders
   SET order_status = 'READY', ready_at = now()
 WHERE id = $1 AND order_status = 'PREPARING' AND payment_status = 'PAID';
```

Zero rows affected means the transition lost the race — it is **logged and
reported**, never retried by overwriting.

Partner assignment is the sharpest case. Two Partners tapping Accept in the same
millisecond must produce exactly one winner:

```sql
UPDATE orders
   SET partner_id = $2, delivery_status = 'ASSIGNED', partner_slot = $3
 WHERE id = $1 AND delivery_status = 'SEARCHING' AND partner_id IS NULL;
```

The loser is told "This delivery has already been taken." A partial unique index
on `(partner_id, partner_slot) WHERE delivery_status IN ('ASSIGNED','PICKED_UP')`
enforces the **capacity limit** at the database level, not in JavaScript.
`pricing_config.max_active_deliveries_per_partner` (default 2, admin-editable)
decides how many slots exist; the index decides two claims never share one.

The **queue number** is the other race worth naming. `next_vendor_order_no()`
upserts a `(vendor_id, order_day)` counter row, so simultaneous orders serialise
on that row's lock rather than sharing a number, and
`orders_vendor_day_no_unique` says the same thing a second time.

## Codes

Four digits each, and they all obey one rule: **the person who holds the secret
is never the person who performs the act.**

- **Handoff code** — minted when the food is. The STORE holds it and reads it
  out; whoever is taking the food types it in. A Partner collecting a delivery
  types it into `partner_confirm_pickup()`; a customer collecting their own
  order types it into `customer_complete_pickup()`. One function returns it —
  `vendor_handoff_code()`, behind `is_vendor_staff` — and there is none that
  shows it to the person collecting. It rotates on every reassignment; the old
  value is invalid instantly.
- **Delivery code** — issued to the customer at assignment. The Partner enters
  it; the server validates. Only then does delivery become DELIVERED and the
  Partner's earning become eligible for settlement.
- The Partner sees the customer's full destination and phone **from
  assignment** — before they are holding food that is going cold — and never
  after the delivery ends.
