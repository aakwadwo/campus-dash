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
Vendor → Items → Submit                       ONE order is ONE vendor.
   ↓
Vendor has 60s to ACCEPT or REJECT; no response → auto-EXPIRED, no charge
   ↓
Customer chooses PICKUP or DELIVERY           ← the price is fixed here
   ↓                                            (fulfilment_type is NULL until
Customer pays → PREPARING → vendor marks READY   this happens, and payment
   ↓                                             refuses an order still in it)
Pickup:   delivery_status stays NONE; the customer shows a collection code and
          the vendor types it in
Delivery: dispatch starts HERE (never at order time — a Partner should never
          wait at the vendor for food) → broadcast to eligible Partners →
          first valid acceptance wins, atomically → the assigned Partner gets
          the room and the customer's phone immediately → the VENDOR reads out
          the pickup code and the Partner types it in → the CUSTOMER reads out
          the delivery code and the Partner types it in → complete
```

**The fulfilment choice sits between acceptance and payment** because that is
where the information is. Asked at the basket, it put "do I walk there, or pay
someone GH₵5" before the one fact that decides it: whether there is going to be
an order at all.

**Both handoff codes follow one rule** — the person who holds the secret is
never the person who performs the act. See `docs/PARTNER.md`.

A Partner may carry **two deliveries at once**. The limit is a partial unique
index on a slot column, not a predicate somebody could race past.

Partner cancellation before handoff keeps **the same order**: assignment is
removed, the slot is released, delivery returns to SEARCHING, the pickup code
rotates and the old one dies immediately. Payment and vendor preparation are
untouched. The vendor is never asked to recreate an order.

## Identity and capability

**IDENTITY IS NOT CAPABILITY.** One person has one authenticated identity, and
capabilities sit on top of it. They are additive and independently granted:
holding one never confers another, and never takes another away.

```
AUTH IDENTITY  ── auth.users.id, and nothing else is ever the key
      │
      ├── CUSTOMER   a customer_profiles row, from customer sign-up
      ├── PARTNER    an APPROVED partner_profiles row — REQUIRES Customer
      ├── VENDOR     vendors.owner_user_id pointing at this account
      └── ADMIN      users.is_admin
```

Three sign-ins reach that one identity, and the difference is the PROOF, not the
person:

| Capability | Proves                             | Phone number                           |
| ---------- | ---------------------------------- | -------------------------------------- |
| CUSTOMER   | a verified `@acity.edu.gh` address | a profile field — how a Partner rings  |
| VENDOR     | a phone number, by SMS code        | **is** the credential                  |
| ADMIN      | a password                         | **none at all**; `users.phone` is NULL |

There is no account TYPE anywhere in the schema. No enum, no column and no table
expresses `CUSTOMER | PARTNER | VENDOR | ADMIN` as one exclusive choice, and
`Admin + Customer + Partner + Vendor` is a valid account.

The rules, and where each is enforced:

| Rule                                    | Enforced by                                        |
| --------------------------------------- | -------------------------------------------------- |
| **PARTNER ⇒ CUSTOMER**, always          | `partner_requires_customer`, a foreign key         |
| **CUSTOMER ⇏ PARTNER** without approval | `is_approved_partner()`                            |
| **ADMIN ⇏ CUSTOMER / PARTNER / VENDOR** | by construction — none creates the other's row     |
| **VENDOR ⇏ CUSTOMER / PARTNER**         | by construction, likewise                          |
| **one email → one identity**            | GoTrue, and `users_email_unique` on `lower(email)` |
| **one phone → one identity**            | `users_phone_key`, unique where present            |
| **one account → at most one store**     | `vendors_owner_unique`, partial unique             |

- Identity: a confirmed contact detail. It proves **who** somebody is and grants
  nothing on its own. Supabase Auth owns every code; our Send SMS Hook delivers
  the SMS ones through the same `SmsProvider` seam as every other notification,
  and an email template carries the rest. Anyone may browse the marketplace with
  no account at all.
- Customer: sign-up — full name, verified school address, student ID number,
  level, phone number and terms acceptance, all in one transaction. No admin
  review: completing it **is** the grant. Nobody can place an order without it,
  including administrators and vendor accounts. No document is collected: no
  review ever consumed one.
- Partner: an **upgrade to an existing Customer**, on the same `auth.users.id`.
  It adds ONE document, a photograph of the student ID. No face photograph:
  holding the Customer capability already means a verified `@acity.edu.gh`
  address, so the school has established the identity and a selfie added a
  weaker second check while making Campus Dash custodian of its most sensitive
  image. There is no second login, no second address and no second identity.
  Approval is manual in V1, and an approved Partner keeps full Customer
  functionality.
- Vendor: a business, owned by an identity. **Registration is open**: a stall
  fills in a form, verifies its phone number, and waits for an administrator to
  approve or reject with a reason it can act on. `vendors.owner_user_id` says
  who may operate it, and NULL means a catalogue entry that operates nothing. A
  vendor account is not a shopper: owning a stall grants no ordering and no
  delivering.
- Admin: email and password, at `/login/admin`. Not phone OTP — operational
  access must not depend on an SMS arriving, least of all when messaging is the
  thing that is broken. `is_admin` is a database column no client statement can
  reach, and every `admin_*` function re-checks it in its own body. The first
  administrator is created out-of-band with `npm run admin:create`. Admin is an
  elevated **authorisation** capability and is deliberately kept separate from
  the ordinary ones: it does not make an account a customer, and it does not
  stop one being a customer either.

Sign-in derives ONE destination from precedence (`lib/auth/landing.js`), and
every area carries an `AreaSwitcher` listing the others the account holds — so
landing on `/admin` never reads as having lost `/order`.

### Adding OAuth later

Not built, and not needed for any of the above. What makes it clean when it
comes: the stable key is already `auth.users.id`, no capability is keyed on
email, phone or student ID, and email is already unique — so a Google identity
resolving to an existing auth user inherits every capability with no migration
and no risk of merging two people who were never the same.

## Privacy

Verification documents live in a **private** Supabase Storage bucket, reachable
only through short-lived signed URLs generated server-side for an admin.

The student ID is deleted after the approval retention period, together with any
face photograph left over from an application made before Campus Dash stopped
asking for one. Both columns are cleared in the same statement, so purging one
and leaving the other would strand an object in storage with nothing left to
find it by. A customer holds no verification document at all, so there is
nothing on that clock belonging to somebody who is not a Partner.

Storefront photographs are the one PUBLIC bucket, because an unauthenticated
visitor browsing the marketplace has to see them and a picture of a plate of
jollof is advertising. It takes no client writes.

Phone numbers are exposed only during an active delivery — from assignment until
the delivery ends, never in public lists, never in completed order history, and
never in an SMS.

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
  (auth)/ login, signup, vendor/signup   the three doors
  order/ orders/ vendor/ partner/ admin/
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
  notifications/dispatch.js the non-order ones: approvals, offers, payouts
  auth/session.js           session + capabilities, derived from the database
  auth/school-email.js      the @acity.edu.gh rule, as a pure function
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
