# Order State Machine

Three **independent** dimensions. Never collapsed into one status field.
Delivery state is never a proxy for order state.

Source of truth: Postgres enums + `CHECK` constraints (Phase 2).
Mirrored for application code in `lib/orders/state.js`.

## order_status — the food

```
DRAFT ──▶ SUBMITTED ──▶ ACCEPTED ──▶ PREPARING ──▶ READY ──▶ COMPLETED
   │          │  │  │                    │            │
   │          │  │  └──▶ EXPIRED         │            │
   │          │  └─────▶ REJECTED        │            │
   │          │                          ▼            ▼
   └──────────┴──────────▶ CANCELLED   CANCELLED_BY_VENDOR
```

- **EXPIRED** is the 60-second auto-reject. The vendor did not answer. No
  payment is taken, and the customer is told.
- Terminal: COMPLETED, REJECTED, EXPIRED, CANCELLED, CANCELLED_BY_VENDOR.

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
NONE  (pickup orders stay here forever)

SEARCHING ──▶ ASSIGNED ──▶ PICKED_UP ──▶ DELIVERED
    │             │             │
    │             │             └──▶ FAILED_CUSTOMER_ABSENT
    │             └──▶ SEARCHING  (Partner cancelled before handoff)
    └──▶ FAILED_NO_PARTNER ──▶ SEARCHING  (retry)
```

- Dispatch begins at **READY**, never at order time. A Partner should never be
  waiting at the vendor for food to be cooked.
- `ASSIGNED → SEARCHING` is Partner cancellation. **Same order.** Assignment
  cleared, pickup code rotated, old code dead. Payment and vendor preparation
  untouched. The vendor is never asked to recreate the order.
- `FAILED_NO_PARTNER` does **not** move `order_status`. The food exists. The
  customer is offered: collect it yourself, keep waiting, or seek resolution.

## Legal combinations worth stating plainly

| order_status | payment_status | delivery_status   | Meaning                                |
| ------------ | -------------- | ----------------- | -------------------------------------- |
| SUBMITTED    | UNPAID         | NONE              | Waiting on the vendor's 60s window     |
| ACCEPTED     | UNPAID         | NONE              | Vendor said yes; customer must now pay |
| PREPARING    | PAID           | NONE              | Paid, cooking, pickup order            |
| READY        | PAID           | SEARCHING         | Cooked, looking for a Partner          |
| READY        | PAID           | FAILED_NO_PARTNER | **Food is fine.** Nobody accepted      |
| COMPLETED    | PAID           | NONE              | Customer collected it themselves       |
| COMPLETED    | PAID           | DELIVERED         | Partner delivered it                   |

## Concurrency

Every transition is a conditional UPDATE guarded on the current state:

```sql
UPDATE orders
   SET order_status = 'ACCEPTED', accepted_at = now()
 WHERE id = $1 AND order_status = 'SUBMITTED';
```

Zero rows affected means the transition lost the race — it is **logged and
reported**, never retried by overwriting.

Partner assignment is the sharpest case. Two Partners tapping Accept in the same
millisecond must produce exactly one winner:

```sql
UPDATE orders
   SET partner_id = $2, delivery_status = 'ASSIGNED', pickup_code = $3
 WHERE id = $1 AND delivery_status = 'SEARCHING' AND partner_id IS NULL;
```

The loser is told "This delivery has already been taken." A partial unique index
on `(partner_id) WHERE delivery_status IN ('ASSIGNED','PICKED_UP')` enforces the
**one active delivery per Partner** rule at the database level, not in
JavaScript.

## Codes

- **Pickup code** — issued at assignment, shown to the Partner. The vendor
  verifies it against the current order _and_ the current Partner before handing
  over food. Rotates on every reassignment; the old value is invalid instantly.
- **Delivery code** — issued to the customer at assignment. The Partner enters
  it; the server validates. Only then does delivery become DELIVERED and the
  Partner's earning become eligible for settlement.
- The Partner sees the customer's full destination and phone **only after** the
  vendor confirms handoff.
