# Database Design

Postgres 17 via Supabase. Migrations in `supabase/migrations/`, applied in order
by `npm run db:reset`. Nothing is ever changed by hand.

## The one architectural decision everything else follows from

**Clients get SELECT only. Every write goes through a SECURITY DEFINER function.**

There is not a single INSERT, UPDATE or DELETE grant for `anon` or
`authenticated` on any table. That is not belt-and-braces on top of RLS — it is
the primary control. It means "a customer cannot mark their own order PAID" is
not a rule the application has to remember to check: there is no grant under
which the statement could succeed, even with a valid session and a request sent
straight to PostgREST.

Each write function re-derives who the caller is from `auth.uid()`, checks the
current state, and performs a **conditional UPDATE**. Zero rows affected means
the transition failed.

```sql
UPDATE orders SET order_status = 'ACCEPTED', accepted_at = now()
WHERE id = $1 AND order_status = 'SUBMITTED' AND accept_deadline_at > now();
```

## Why transitions return a failure instead of raising one

A rejected transition must be logged. But `RAISE EXCEPTION` aborts the whole
transaction — including the very log row that recorded the rejection. Logging
then raising silently records nothing.

So the rule is:

| Failure                                                                            | Behaviour                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **State / contention** — lost the race, wrong current state, wrong code            | Returns `(success=false, reason)`. The rejection is logged and the log commits. |
| **Authorisation** — not this vendor's order, not an approved Partner, not an admin | Raises. Not routine: it means a bug or an attack, and it should be loud.        |

`lib/orders/transitions.js` turns a `success=false` envelope into a message for
the user, and lets authorisation errors propagate.

## Tables

| Table              | Purpose                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`            | Profile per `auth.users` row. One account per person; unique phone. `is_admin` is a column here, never a client-supplied claim.                                              |
| `partner_profiles` | Exists only once someone applies. Holds private Storage paths for the student ID and live face photograph, review decision, availability, and a document retention deadline. |
| `vendors`          | Hand-recruited, admin-created. `status` plus a vendor-controlled `is_accepting_orders` switch.                                                                               |
| `vendor_users`     | Vendor staff. Real stalls have more than one person on the counter, and this keeps vendor RLS honest without a shared login.                                                 |
| `locations`        | Self-referencing campus tree: Campus → Block → Floor → Room. `is_deliverable` marks actual destinations. No GPS anywhere.                                                    |
| `menu_items`       | Vendor catalogue. Disabled rather than deleted, so historical orders keep a valid foreign key.                                                                               |
| `pricing_config`   | Single row. Service fee, flat delivery fee, the Partner's share in basis points, and the two timeout windows. Snapshotted onto each order.                                   |
| `orders`           | The three independent state dimensions, the destination, and every server-calculated amount.                                                                                 |
| `order_items`      | **Price snapshot.** `name_snapshot` and `unit_price_pesewas` are copied at submit time.                                                                                      |
| `order_secrets`    | Pickup and delivery codes. **No policy and no grant for anyone.**                                                                                                            |
| `order_events`     | Append-only log of every attempted transition, accepted and rejected.                                                                                                        |
| `payments`         | One row per collection attempt. Keyed by idempotency key.                                                                                                                    |
| `allocations`      | The internal ledger: who each part of a paid order belongs to.                                                                                                               |
| `settlement_runs`  | Vendors daily, Partners weekly.                                                                                                                                              |
| `payouts`          | Money actually leaving the platform.                                                                                                                                         |
| `webhook_events`   | Provider events, deduplicated on `(provider, event_id)`.                                                                                                                     |
| `idempotency_keys` | General request-replay protection, with a request hash so a key reused with different parameters is rejected rather than replayed.                                           |
| `admin_actions`    | Append-only audit of every manual override.                                                                                                                                  |

## The constraints that carry the money

| Constraint                               | What it prevents                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders_one_active_delivery_per_partner` | Partial unique index on `partner_id WHERE delivery_status IN ('ASSIGNED','PICKED_UP')`. A Partner cannot hold two deliveries — even if the function's predicate were bypassed. |
| `payments_one_pending_per_order`         | Two live payment intents on one order.                                                                                                                                         |
| `payments_one_succeeded_per_order`       | Charging an order twice.                                                                                                                                                       |
| `payments_idempotency_key_unique`        | A retried payment request becoming a second charge.                                                                                                                            |
| `payouts_run_payee_unique`               | Paying a payee twice in one settlement run.                                                                                                                                    |
| `payouts_idempotency_key_unique`         | A retried payout becoming a second transfer.                                                                                                                                   |
| `webhook_events_provider_event_unique`   | A provider's retry moving money twice.                                                                                                                                         |
| `settlement_runs_period_unique`          | Re-running a day's settlement and paying everyone again.                                                                                                                       |
| `allocations_must_balance`               | Deferred constraint trigger: allocations for an order must sum to the order total, or the transaction will not commit.                                                         |
| `orders_total_is_sum`                    | The server's own arithmetic, checked by the database.                                                                                                                          |
| `orders_partner_earnings_within_fee`     | A Partner earning more than the delivery fee collected.                                                                                                                        |
| `orders_pickup_has_no_delivery`          | A pickup order carrying delivery money or entering dispatch.                                                                                                                   |
| `orders_partner_matches_delivery_state`  | A Partner attached without a live delivery, or a live delivery with no Partner.                                                                                                |
| `order_items_line_total_is_product`      | A line total that is not price × quantity.                                                                                                                                     |
| `users_phone_key`                        | Two accounts on one phone number.                                                                                                                                              |
| `partner_profiles_student_id_unique`     | One student ID backing several approved Partner identities.                                                                                                                    |
| `admin_actions_reason_check`             | An override recorded without a stated reason.                                                                                                                                  |

## Allocations: why the Partner's share moves later

At payment time **no Partner exists** — dispatch has not even opened. So payment
creates two rows:

```
VENDOR    = subtotal            (ELIGIBLE — they cooked the food)
PLATFORM  = total - subtotal    (service fee + delivery fee, held together)
```

When a delivery is confirmed DELIVERED, `settle_partner_earnings()` carves the
Partner's share out of the platform row and inserts a PARTNER allocation naming
the person who actually did the work. Both writes happen in one transaction, so
the balance constraint never sees a torn state and the rows always sum to what
the customer paid.

This is also why there is no vendor wallet. A vendor sees allocations and
settlement records — what they earned and what has been paid — not a stored
balance implying Campus Dash is holding their money.

## Provider neutrality

Nothing in the schema assumes how money physically moves. Whether the provider
splits at source (Option A) or we collect centrally and transfer later
(Option B), the same `payments`, `allocations`, `settlement_runs` and `payouts`
rows are written. Only which adapter fills in `provider_transaction_id` and
`provider_transfer_id` changes. See `docs/PILOT-QUESTIONS.md`.

## Codes and the handoff

`order_secrets` has **no RLS policy and no grant** — not for the vendor, not for
the Partner, not for an admin. Nobody SELECTs a code, ever.

That matters most for the vendor. A vendor who could read `pickup_code` could
confirm a handoff that never happened, which is the entire point of the code.
The Partner reads it aloud; the vendor types in what they hear;
`vendor_confirm_pickup()` compares them server-side.

Codes reach the entitled party by SMS and through
`get_my_pickup_code()` / `get_my_delivery_code()`, which check entitlement first.
`pickup_code_version` increments on every issue, cancellation and reassignment,
so a superseded code is gone rather than merely unused.

## Phone number exposure

Governed entirely by RLS on `users`:

- Before assignment: a Partner sees a **zone**, never a person.
  `get_delivery_offers()` returns no customer identity at all.
- After assignment, before handoff: still nothing.
- Between vendor handoff and delivery: the assigned Partner can read the
  customer's row. The customer can read the Partner's.
- After completion: access ends. Phone numbers do not appear in order history.

## Scheduled jobs

Both timeout sweeps run under `pg_cron`, inside the database:

| Job                                 | Schedule     | Effect                                                                                                             |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `campus-dash-expire-stale-orders`   | every 30s    | `SUBMITTED` past its deadline → `EXPIRED`. No payment was ever taken.                                              |
| `campus-dash-expire-partner-search` | every minute | `SEARCHING` past its deadline → `FAILED_NO_PARTNER`. **Delivery state only** — the order stays `READY` and `PAID`. |

The vendor window is 60 seconds, so a 30-second sweep bounds the visible error
at half a window. They run in the database rather than from an application cron:
no HTTP call to miss, no deploy that silently drops the schedule, and no second
copy of the business rule.

`pg_cron` runs jobs as the database owner, so `session_user` is `postgres` and
`assert_service_or_admin()` passes — exactly the "direct database connection"
case it was written for. Neither function is callable by a signed-in user.

A scheduler that silently stops is worse than none, because the symptom (orders
stuck at `SUBMITTED`) looks like an application bug. `admin_scheduled_job_status()`
exposes each job's last run, status and error to admins.
