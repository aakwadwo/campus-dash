# Database Design

Postgres 17 via Supabase. Nothing is ever changed by hand.

## Two files, two jobs

**`supabase/migrations/`** is the history, and the place every schema change is
written. Forty-odd files applied in order by `npm run db:reset`. It records how
each rule came to exist — including the column a later phase dropped, the
function a later phase replaced, and the grant a later phase took back.

**`supabase/schema.sql`** is the canonical final state, installable from empty
in one pass. It is what a new environment is bootstrapped from, the hosted
project included: `npm run db:install`.

It is **not** the migrations concatenated. Replaying the history would install
the mistakes alongside the corrections. Instead it is generated from a database
that has actually applied every migration in order, so every drop, replacement,
altered policy and tightened grant is already resolved:

```bash
npm run db:reset      # apply every migration, in order
npm run db:schema     # regenerate supabase/schema.sql from the result
```

Two things `pg_dump` cannot get right are written by hand into
`supabase/schema/00-preamble.sql` and `99-epilogue.sql`:

- **Default privileges must be revoked before anything is created.** `pg_dump`
  renders the final ACL in positive form (`GRANT ALL ON FUNCTIONS TO postgres,
service_role`), and replaying that onto a fresh Supabase project does not
  reproduce our state — Supabase's own defaults name `anon` and `authenticated`
  explicitly, and a GRANT does not remove them. So the revokes run first, and
  no object ever exists in the permissive state, even momentarily.
- **Objects outside `public`**: the `auth.users` provisioning triggers, the
  private storage bucket, the `pg_cron` schedules, and the reference data the
  product cannot start without.

`schema.sql` ends with assertions that check its own work — RLS on every table,
no client DML, deny-by-default privileges — so a partial install cannot report
success.

To prove the two agree, snapshot both and diff:

```bash
npm run db:snapshot > /tmp/from-migrations.json
# ...install schema.sql into an empty database...
npm run db:snapshot > /tmp/from-schema.json
diff /tmp/from-migrations.json /tmp/from-schema.json
```

`scripts/schema-snapshot.mjs` covers tables, columns, enums, constraints,
indexes, triggers, RLS, policies, functions, grants, default privileges,
extensions, cron jobs, storage buckets and reference data. A difference is
either a bug in the canonical schema or a decision — never something unnoticed.

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
UPDATE orders SET order_status = 'READY', ready_at = now()
WHERE id = $1 AND order_status = 'PREPARING' AND payment_status = 'PAID';
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

| Table                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                 | **IDENTITY**, one row per `auth.users` row: phone, email, name, suspension, `is_admin`. Unique phone AND unique email — `email` is real and supplied by the person, never synthesised. `is_admin` is a column here, never a client-supplied claim. Carries no capability evidence. `first_name` and `last_name` are the facts; `full_name` is DERIVED from them by `users_sync_full_name()`, so the forty read models that select it keep working and it can no longer drift from the parts. |
| `customer_profiles`     | **The CUSTOMER capability.** A row here IS the capability — there is no flag. Level, written only by `complete_customer_onboarding()`. `student_id_number` is HISTORICAL: nullable, unique when present, still holding what accounts created before the change declared, and never written by anything new. No document either — no review ever consumed one. Admin and vendor accounts do not get one automatically.                                                                        |
| `partner_profiles`      | **The PARTNER capability.** Exists only once someone applies, and only on top of a `customer_profiles` row. Holds the private Storage path to the student ID photograph, the review decision, availability, and a document retention deadline. `face_image_path` is nullable and never written — Campus Dash stopped asking for one; the column survives so an old decision can be audited.                                                                                                  |
| `vendors`               | Applied for by the owner, approved by an admin. `status` plus an owner-controlled `is_accepting_orders` switch — and reopening clears every sold-out mark on that store's menu.                                                                                                                                                                                                                                                                                                              |
| `vendor_categories`     | What kind of business a vendor is. Admin-managed ROWS, not an enum: the person who knows a new kind of stall has opened is an operator with a browser. Disabling one hides it and detaches nothing.                                                                                                                                                                                                                                                                                          |
| `vendor_images`         | The storefront gallery. Objects live in the PUBLIC `vendor-images` bucket, which takes no client writes; this row is what authorises one being there.                                                                                                                                                                                                                                                                                                                                        |
| `locations`             | Self-referencing campus tree: Campus → Block → Floor → Room. `is_deliverable` marks actual destinations. No GPS anywhere.                                                                                                                                                                                                                                                                                                                                                                    |
| `menu_items`            | Vendor catalogue. Disabled rather than deleted, so historical orders keep a valid foreign key.                                                                                                                                                                                                                                                                                                                                                                                               |
| `pricing_config`        | Single row, and the whole of "what the pilot may retune without a deploy": fees, `scan_pack_fee_pesewas`, `partner_delivery_enabled`, timeout windows, poll cadences, retention, `max_active_deliveries_per_partner`, and the handoff-code attempt limit and lockout. Fees are snapshotted onto each order; the operational limits are read on every attempt they govern.                                                                                                                    |
| `orders`                | The three independent state dimensions, the destination, and every server-calculated amount. `vendor_order_no` + `order_day` are the DAILY QUEUE NUMBER a person is shown — 001, 002, 003, unique per store per day; `order_number` (`CD-01043`) stays underneath as the internal reference payments and payouts key off. `pack_fee_pesewas` is charged on SCAN errands only, and a CHECK constraint says so.                                                                                |
| `vendor_order_counters` | One row per store per day, holding the last queue number issued. The allocating upsert takes that row's lock, so simultaneous orders serialise instead of sharing a number. **No policy and no grant for anyone** — it is read only inside `next_vendor_order_no()`.                                                                                                                                                                                                                         |
| `order_items`           | **Price snapshot.** `name_snapshot` and `unit_price_pesewas` are copied at submit time.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `order_secrets`         | The handoff and delivery codes, four digits each, plus the failed-attempt counters and lockouts that make four digits safe. **No policy and no grant for anyone** — the handoff code reaches a store only through `vendor_handoff_code()`, and reaches the person collecting never.                                                                                                                                                                                                          |
| `order_events`          | Append-only log of every attempted transition, accepted and rejected.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `payments`              | One row per collection attempt. Keyed by idempotency key. Records what the provider ACTUALLY split (`split_subaccount_code`, `split_vendor_pesewas`), not what was intended.                                                                                                                                                                                                                                                                                                                 |
| `allocations`           | The internal ledger: who each part of a paid order belongs to. `settlement_channel` says HOW — `SPLIT` means Paystack routed it at the charge and it was never in the Campus Dash balance; `TRANSFER` means a run moves it.                                                                                                                                                                                                                                                                  |
| `settlement_runs`       | Vendors daily, Partners weekly.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `payouts`               | Money actually leaving the platform. `PROCESSING` means the provider accepted a transfer; only its transfer event makes one `PAID`.                                                                                                                                                                                                                                                                                                                                                          |
| `payout_destinations`   | Mobile money account per vendor and Partner, plus BOTH provider identities for it: a recipient code (money pushed out) and a subaccount code (money routed at collection). **No policy and no grant for anyone** — an account number is what lets somebody redirect a settlement, and `vendors` is anon-readable.                                                                                                                                                                            |
| `partner_ratings`       | One to five stars on a completed delivery. **The order is the primary key**, which is the whole duplicate rule. A Partner cannot read individual rows.                                                                                                                                                                                                                                                                                                                                       |
| `customer_rewards`      | One row per customer per completed run of the order goal, unique on `(user_id, cycle)` — which is why the 51st order creates nothing. Written by a trigger on `orders`, never by a client.                                                                                                                                                                                                                                                                                                   |
| `webhook_events`        | Provider events, deduplicated on `(provider, event_id)`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `idempotency_keys`      | General request-replay protection, with a request hash so a key reused with different parameters is rejected rather than replayed.                                                                                                                                                                                                                                                                                                                                                           |
| `admin_actions`         | Append-only audit of every manual override.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## The constraints that carry the money

| Constraint                              | What it prevents                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders_partner_active_slot_unique`     | Partial unique index on `(partner_id, partner_slot) WHERE delivery_status IN ('ASSIGNED','PICKED_UP')`. **The capacity limit.** "At most one" could be a unique index on `partner_id`; "at most N" cannot, so an active delivery holds a numbered slot and the slot is unique. `pricing_config.max_active_deliveries_per_partner` decides how many slots exist; this index decides two claims never share one. |
| `vendors_owner_unique`                  | Partial unique index on `owner_user_id WHERE NOT NULL`. One account, one store. NULL is a catalogue entry — orderable, never operable.                                                                                                                                                                                                                                                                         |
| `payments_one_pending_per_order`        | Two live payment intents on one order.                                                                                                                                                                                                                                                                                                                                                                         |
| `payments_one_succeeded_per_order`      | Charging an order twice.                                                                                                                                                                                                                                                                                                                                                                                       |
| `payments_idempotency_key_unique`       | A retried payment request becoming a second charge.                                                                                                                                                                                                                                                                                                                                                            |
| `payouts_run_payee_unique`              | Paying a payee twice in one settlement run.                                                                                                                                                                                                                                                                                                                                                                    |
| `payouts_idempotency_key_unique`        | A retried payout becoming a second transfer.                                                                                                                                                                                                                                                                                                                                                                   |
| `webhook_events_provider_event_unique`  | A provider's retry moving money twice.                                                                                                                                                                                                                                                                                                                                                                         |
| `settlement_runs_period_unique`         | Re-running a day's settlement and paying everyone again.                                                                                                                                                                                                                                                                                                                                                       |
| `allocations_must_balance`              | Deferred constraint trigger: allocations for an order must sum to the order total, or the transaction will not commit.                                                                                                                                                                                                                                                                                         |
| `orders_total_is_sum`                   | The server's own arithmetic, checked by the database.                                                                                                                                                                                                                                                                                                                                                          |
| `orders_partner_earnings_within_fee`    | A Partner earning more than the delivery fee collected.                                                                                                                                                                                                                                                                                                                                                        |
| `orders_pickup_has_no_delivery`         | A pickup order carrying delivery money or entering dispatch.                                                                                                                                                                                                                                                                                                                                                   |
| `orders_partner_matches_delivery_state` | A Partner attached without a live delivery, or a live delivery with no Partner.                                                                                                                                                                                                                                                                                                                                |
| `order_items_line_total_is_product`     | A line total that is not price × quantity.                                                                                                                                                                                                                                                                                                                                                                     |
| `users_phone_key`                       | Two accounts on one phone number.                                                                                                                                                                                                                                                                                                                                                                              |
| `users_email_unique`                    | One email address on two identities. Unique on `lower(email)`, because two cases of one address are one address. NOT an identity key — `auth.users.id` is — but it is what makes a future OAuth account-link unambiguous.                                                                                                                                                                                      |
| `customer_profiles_student_id_unique`   | One student ID backing several Customer identities.                                                                                                                                                                                                                                                                                                                                                            |
| `partner_requires_customer`             | A Partner without the Customer capability, or a Customer capability removed from under an approved Partner. `ON DELETE RESTRICT`. **PARTNER ⇒ CUSTOMER, as a constraint.**                                                                                                                                                                                                                                     |
| `admin_actions_reason_check`            | An override recorded without a stated reason.                                                                                                                                                                                                                                                                                                                                                                  |

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
`provider_transfer_id` changes.

That held. Paystack is Option B, and adding it changed no table that already
existed — see `docs/PAYMENTS.md`. What it did add is the honest payout
lifecycle: `mark_payout_processing()` for a transfer the provider accepted,
`fail_payout()`, which **releases the allocation claim** so the money falls into
the next run, and `retry_payout()`, which re-claims and refuses if a later run
already swept it. Nothing retries automatically.

## Codes and the handoff

`order_secrets` has **no RLS policy and no grant** — not for the vendor, not for
the Partner, not for an admin. Nobody SELECTs a code, ever.

All three codes are four digits. Which side reads and which side types is the
whole mechanism — see `docs/PARTNER.md` — and `check_handoff_code()` is the one
place any of them is compared. It is server-only and it writes the attempt
counter, because a counter that only counted when a caller remembered to would
count nothing.

A code reaches the entitled party through `vendor_handoff_code()` (the store, on
their own screen) or `get_my_delivery_code()` (the customer, on theirs). Both
check entitlement first, and NEITHER returns a code to the person who is going to
be asked for it. Nothing sends a handoff code by SMS: a message is a copy in a
second place that outlives the delivery it belonged to.
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
| `campus-dash-expire-stale-orders`   | every 30s    | An order priced and never paid for, past its pay-by deadline → `CANCELLED`. No payment was ever taken.             |
| `campus-dash-expire-partner-search` | every minute | `SEARCHING` past its deadline → `FAILED_NO_PARTNER`. **Delivery state only** — the order stays `READY` and `PAID`. |
| `campus-dash-expire-stale-payments` | every 15 min | A collection the provider never confirmed → `FAILED`, so the customer can retry instead of watching a spinner.     |

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
