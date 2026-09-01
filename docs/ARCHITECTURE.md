# Campus Dash — Architecture

Campus-only ordering and delivery for Academic City University, Ghana.
A customer orders from an approved vendor and either collects the order or has a
verified student **Partner** bring it to a predefined campus destination.

Not Uber. No Google Maps, no GPS, no live tracking, no turn-by-turn navigation.

## Stack

| Layer        | Choice                                                         |
| ------------ | -------------------------------------------------------------- |
| Framework    | Next.js 16, App Router, **JavaScript** (no TypeScript)         |
| UI           | React 19, Tailwind CSS 4 — white, black, one yellow accent     |
| Data         | Supabase — Postgres, Auth, private Storage, Row Level Security |
| Server logic | Route Handlers + Server Actions                                |
| Deploy       | Vercel (later)                                                 |

## Non-negotiable rules

**The server is authoritative** for prices, fees, order state, payment state,
Partner assignment, permissions and settlement. The client is never trusted for
any of them — not prices, not roles, not "payment succeeded", not order
ownership.

**Money is integer pesewas.** 1 GHS = 100 pesewas. Floats never touch an amount.
See `lib/util/money.js`.

**Race-sensitive state moves in the database**, via conditional updates and
constraints — not in JavaScript:

```sql
UPDATE orders SET order_status = 'ACCEPTED'
WHERE id = $1 AND order_status = 'SUBMITTED';
```

Zero rows affected means the transition failed. Rejected transitions are logged,
never retried by overwriting.

**Every money-related operation is idempotent.** Payment creation, webhook
processing and payout creation all key off an idempotency key or a
provider-issued event id, backed by a unique constraint.

**Administrative overrides are auditable.** Every manual intervention appends to
`admin_actions` — who, what changed, which order/user/vendor, when, and why.

## Adapter seams

Two external dependencies are unresolved, so both sit behind interfaces that the
rest of the application talks to and nothing else:

| Seam     | Interface                                                                                       | V1 implementation                                                  |
| -------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Payments | `lib/payments/provider.js` — `initiateCollection`, `getStatus`, `handleWebhook`, `sendTransfer` | `FakePaymentProvider` — async, ~2s to settle, fake transaction ids |
| SMS      | `lib/sms/provider.js` — `send(phone, message)`                                                  | `FakeSmsProvider` (dev) · `ArkeselSmsProvider` (production)        |

Adding `HubtelPaymentProvider` means one new file plus a case in the factory. No
order, allocation or settlement code changes. Arkesel arrived exactly that way —
`lib/sms/arkesel.js` plus a case — and nothing outside `lib/sms` knows its name.

SMS acceptance and SMS delivery are separate facts. Arkesel returning `ok` means
it took the message; whether a handset received it comes back minutes later on a
signed delivery webhook and lands on the same `notification_events` row. See
`docs/SMS.md`.

Notifications sit one level above SMS: business logic emits a domain event
(`ORDER_ACCEPTED`, `PARTNER_ASSIGNED`, …) via `lib/notifications`, which renders
copy and picks channels. V1 is SMS-only; in-app alerts and (much later) push are
added as channels, not as edits to order logic.

## Order state — three independent dimensions

Never collapsed into one status field, and delivery state is never used as a
proxy for order state. **A failed delivery does not mean the food order failed.**

- `order_status` — DRAFT · SUBMITTED · ACCEPTED · PREPARING · READY · COMPLETED ·
  REJECTED · EXPIRED · CANCELLED · CANCELLED_BY_VENDOR
- `payment_status` — UNPAID · PENDING · PAID · FAILED · REFUND_PENDING · REFUNDED
- `delivery_status` — NONE · SEARCHING · ASSIGNED · PICKED_UP · DELIVERED ·
  FAILED_NO_PARTNER · FAILED_CUSTOMER_ABSENT

Transition tables live in `lib/orders/state.js` and mirror the Postgres enums —
a test asserts the two have not drifted. The database is authoritative.

## Core flow

```
Vendor → Items → Destination → Pickup or Delivery → Submit
   ↓
Vendor has 60s to ACCEPT or REJECT; no response → auto-EXPIRED, no charge
   ↓
Customer pays → PREPARING → vendor marks READY
   ↓
Pickup:   delivery_status stays NONE, customer collects
Delivery: dispatch starts HERE (never at order time — a Partner should never
          wait at the vendor for food) → broadcast to eligible Partners →
          first valid acceptance wins, atomically → pickup code → vendor
          confirms handoff → destination + customer phone revealed to Partner →
          delivery code confirms completion
```

Partner cancellation before handoff keeps **the same order**: assignment is
removed, delivery returns to SEARCHING, the pickup code rotates and the old one
dies immediately. Payment and vendor preparation are untouched. The vendor is
never asked to recreate an order.

## Identity and roles

One account per person. Partner capability is a **role on the same account**, not
a second login — a user can be Customer and Partner and switch modes in the UI.

- Customer: phone OTP only. No ID upload, no selfie, no manual approval.
  Supabase Auth owns the code; our Send SMS Hook delivers it through the same
  `SmsProvider` seam as every other notification. See `docs/AUTH.md`.
- Partner: phone OTP **plus** student ID photo **plus** a live face photograph
  captured with the device camera. No gallery or file upload — the point is to
  let an admin compare the face to the ID. Approval is manual in V1.
- Vendor: hand-recruited; registration is closed. Admin creates and approves.
- Admin: email and password, at `/login/admin`. Not phone OTP — operational
  access must not depend on an SMS arriving, least of all when messaging is the
  thing that is broken. `is_admin` is a database column no client statement can
  reach, and every `admin_*` function re-checks it in its own body. The first
  administrator is created out-of-band with `npm run admin:create`.

## Privacy

Partner verification documents live in a **private** Supabase Storage bucket,
reachable only through short-lived signed URLs generated server-side for an
admin. They are deleted after the approval retention period.

Phone numbers are exposed only during an active delivery — never before Partner
assignment, never in public lists, never in completed order history.

## Locations

No GPS. A database-backed campus tree the admin can manage:

```
Academic City → Hostel Block A → Floor 2 → Room 204
```

The customer picks a destination; the Partner sees the destination zone.

## Where the safety actually lives

Not in the UI, and not in route handlers. Clients hold **SELECT grants only**;
every write is a SECURITY DEFINER function performing a conditional UPDATE, and
race-sensitive rules are additionally backed by partial unique indexes. See
`docs/DATABASE.md` for the full constraint list.

## Folder layout

```
app/
  (auth)/ (customer)/ vendor/ partner/ admin/
  api/…                     route handlers — all server authority lives here
lib/
  config.js                 the ONLY place process.env is read
  supabase/browser.js       publishable key, RLS applies
  supabase/server.js        acts as the signed-in user, RLS applies
  supabase/admin.js         service role, BYPASSES RLS, server-only
  supabase/middleware.js    session refresh
  payments/                 PaymentProvider + FakePaymentProvider
  sms/                      SmsProvider, Fake + Arkesel, delivery webhook
  notifications/            domain events → copy → channels
  auth/session.js           session + capabilities, derived from the database
  auth/webhook-signature.js Standard Webhooks HMAC for the Send SMS Hook
  orders/state.js           the three state machines
  orders/transitions.js     the ONLY way the app changes order state
  util/money.js             integer pesewas
  util/codes.js             pickup / delivery codes (CSPRNG)
supabase/migrations/        all schema changes, in order — the history
supabase/schema.sql         canonical final state, installable from empty
supabase/schema/            the hand-written head and tail of that file
supabase/seed.sql           development-only actors, vendors, menus, locations
supabase/dev/sms-hook.sql   DEVELOPMENT ONLY. Postgres Send SMS Hook, for when
                            the app runs against a hosted project
scripts/                    build-schema, install-schema, schema-snapshot,
                            create-admin, and the local seeding helpers
tests/                      database, RLS, concurrency and money tests
docs/
```

## Environments

Local development runs against Supabase's Docker stack, applied from
`supabase/migrations/` plus `supabase/seed.sql`. A hosted project is
bootstrapped from `supabase/schema.sql` and has no seed at all — its campus
tree, vendors and menus are created through `/admin`, because fictional
development data does not belong in a real database. See
[`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md) and [`DATABASE.md`](./DATABASE.md).

## Deliberately not built in V1

Ratings, reviews, loyalty, coupons, promotions, AI recommendations, Google Maps,
GPS, live tracking, multiple simultaneous Partner deliveries, Partner scoring,
automatic penalties, analytics, microservices, native mobile apps, push
notifications.
