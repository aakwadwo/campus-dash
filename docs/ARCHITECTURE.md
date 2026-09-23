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
UPDATE orders SET order_status = 'READY', ready_at = now()
WHERE id = $1 AND order_status = 'PREPARING' AND payment_status = 'PAID';
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

- `order_status` — ACCEPTED · PREPARING · READY · COMPLETED · CANCELLED ·
  CANCELLED_BY_VENDOR. (DRAFT, SUBMITTED, REJECTED and EXPIRED are historical:
  they belong to the vendor-acceptance flow that no longer exists. The values
  stay because real orders point at them.)
- `payment_status` — UNPAID · PENDING · PAID · FAILED · REFUND_PENDING · REFUNDED
- `delivery_status` — NONE · SEARCHING · ASSIGNED · PICKED_UP · DELIVERED ·
  FAILED_NO_PARTNER · FAILED_CUSTOMER_ABSENT

Transition tables live in `lib/orders/state.js` and mirror the Postgres enums —
a test asserts the two have not drifted. The database is authoritative.

## Core flow

```
Store → Items → COLLECT or DELIVER → final price → PAY    ONE order, ONE store.
   ↓
   │  (no store has seen it yet: nothing has been paid)
   ↓
confirm_payment()  →  ACCEPTED → PREPARING, and for a delivery
   ↓                  delivery_status NONE → SEARCHING
   │
   ├─ the store receives a PAID order and a queue number (001, 002, 003…)
   │
   ├─ delivery: broadcast to eligible Partners → first valid acceptance wins,
   │            atomically → the assigned Partner gets the room and the
   │            customer's phone immediately, WHILE the food is still cooking
   ↓
store presses READY FOR PICKUP  →  a four-digit code appears on the order
   ↓
Collection: the store reads the code out; the CUSTOMER types it in → complete
Delivery:   the store reads the code out; the PARTNER types it in → the CUSTOMER
            reads out their delivery code; the PARTNER types it in → complete
```

**There is no vendor acceptance step, and the order is paid for before a store
sees it.** A store answering a doorbell put a 60-second countdown on a phone
next to a hot plate, produced orders that expired for nobody's fault, and made
the customer wait to find out what lunch would cost. The fulfilment choice moved
to the checkout with it, because there is nothing left to ask it after.

**Dispatch opens at PAYMENT, not at READY.** A Partner claimed while the kitchen
works is one who is not hunted for at the last minute. Nobody is sent to stand at
a counter either: the offer carries `food_is_ready`, and
`partner_confirm_pickup()` refuses before the order is READY — checked before the
code, so an eager attempt costs no attempt.

**Both handoff codes follow one rule** — the person who holds the secret is
never the person who performs the act. The store holds the handoff code and
whoever takes the food types it in; the customer holds the delivery code and the
Partner types that in. See `docs/PARTNER.md`.

A Partner may carry **two deliveries at once**. The limit is a partial unique
index on a slot column, not a predicate somebody could race past.

Partner cancellation before handoff keeps **the same order**: assignment is
removed, the slot is released, delivery returns to SEARCHING, the handoff code
rotates and the old one dies immediately. Payment and preparation are untouched,
another Partner can take it straight away, and no administrator is involved.

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
- Customer: sign-up — first and last name, verified school address, level, phone
  number and terms acceptance, all in one transaction. No student ID number and
  no document: the verified address is the school's own record. No admin
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

No GPS, no live location. A database-backed campus tree the admin can manage,
holding the real Academic City places (written by
`20261007000001_campus_places_and_additional_information.sql`):

```
Academic City → Hostel A → Hostel A Entrance
                         → C Floor → C17
              → Academic Block → First Floor → Library
              → Sports & recreation → Football Field
```

Any node can be a destination. A floor is a complete answer and a room is
optional, so an order stores exactly the precision the customer chose —
`location_path()` renders it as people say it: "Hostel A Entrance",
"Hostel A · C Floor · C17", "Football Field". The checkout's picker
(`app/destination-picker.js`, fed by `destination_places()`) shows
recognisable places first; opening a hostel selects its entrance.

The destination is fixed once the order is paid. A customer who moves rings
their Partner, whose number they have from assignment — nothing rewrites a
location after the fact. Before accepting, a Partner sees the block and floor;
the exact place arrives with the assignment.

The customer can write two optional notes, each for ONE reader, and they are
never one field:

- **Order information** is about the food ("no pepper") and is for the STORE.
  It lives in `order_notes`, written by `submit_order_for()` /
  `submit_scan_order()` in the transaction that creates the order, so it exists
  before payment and before any store sees the order. The store reads it only
  through `vendor_order_detail().order_information`; a Partner cannot read it.
- **Additional information** is for the PARTNER ("near the stairs, call when
  you arrive"). It is `orders.destination_note`, kept only on a Partner order,
  and reaches the Partner through `partner_active_delivery()` from assignment.
  The store never sees it.

Both are optional and at most 280 characters. The structured destination is a
third thing and is not text: there is no free-form location field.

## Where the safety actually lives

Not in the UI, and not in route handlers. Clients hold **SELECT grants only**;
every write is a SECURITY DEFINER function performing a conditional UPDATE, and
race-sensitive rules are additionally backed by partial unique indexes. See
`docs/DATABASE.md` for the full constraint list.

## What is cached, and what is asked

**Cached across requests** (`lib/customer/catalogue.js`): the storefront list,
each store and its menu, categories, the searchable item list, the campus
places and `pricing_config`. All are read as the anon role, so a cached answer
can never hold anything one person alone may see. Every write that changes one
of them expires its tag the moment it succeeds (`invalidateAfter()`, called by
the RPC helpers in `lib/vendor`, `lib/admin` and `lib/orders/transitions`); the
60s TTL only catches writes made outside the app. Submission re-checks the
store, every item and every price, so a stale page can never charge anyone
the wrong amount.

**Never cached:** orders, payments, dispatch, capabilities, anything with a
person in it.

**Polling asks a small question.** A customer's order screen polls
`/api/orders/[id]/status` (`customer_order_signal()`, an opaque signature) and
re-renders only when it changes; a store's order screen does the same through
`/api/vendor/orders/[id]/status`. Payment confirmation backs off (2s → 13s)
because each check is a Paystack verify. Every poll pauses while the screen is
hidden and fires at once when it comes back (`app/use-status-watch.js`).

**Sessions.** The proxy and `getCapabilities()` use `getClaims()`, verified
locally against the project's ES256 key set; the only network call on an
ordinary page is `my_capabilities()`, which PostgREST authorises with the same
JWT.

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
