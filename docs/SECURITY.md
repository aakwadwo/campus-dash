# Security Model

The database is the security boundary. Everything else is convenience.

## The one decision everything follows from

**Clients hold SELECT grants only.** There is no INSERT, UPDATE, DELETE or
TRUNCATE grant for `anon` or `authenticated` on any table. Every write goes
through a SECURITY DEFINER function that re-derives who the caller is from
`auth.uid()` and performs a conditional UPDATE.

That makes "a customer cannot mark their order PAID" a structural fact rather
than a rule someone remembered to check: there is no statement they could issue
that would succeed, even with a valid session and a request sent straight to
PostgREST.

## The default-grant trap, twice

Supabase ships default ACLs granting `anon` and `authenticated` broad access to
new objects in `public`. A one-time `REVOKE` only covers what exists when it
runs, so **every object added afterwards comes back exposed**.

This bit twice:

- **Functions** (Phase 5) — three auth provisioning helpers became
  anon-callable. Revoking from `PUBLIC` was not enough; the Supabase defaults
  name `anon` and `authenticated` explicitly.
- **Tables** (operational build) — all three new tables came back writable, and
  `anon` briefly held TRUNCATE on the notification audit log.

Both are now closed by `ALTER DEFAULT PRIVILEGES` **plus** invariant tests that
assert the complete client-callable surface. A third instance was caught later:
`DROP` + `CREATE` discards explicit grants, so a function recreated to change
its return shape silently reverted to the default.

**If you add a table or function, the allowlist test will fail until you decide
who may reach it.** That is the point.

`supabase/schema.sql` closes the trap from the other end: the
`ALTER DEFAULT PRIVILEGES … REVOKE` statements run **before the first CREATE**,
so on a fresh project no object ever exists in the permissive state, even
momentarily. The file then asserts that at the end of the install and refuses to
report success otherwise.

## Invariants, asserted by tests

- RLS enabled on every table in `public`
- no client role holds any write privilege on any table
- the exact set of `anon`- and `authenticated`-callable functions matches an explicit list
- default privileges grant nothing to `PUBLIC`, `anon` or `authenticated`
- every SECURITY DEFINER function pins an empty `search_path`
- every `admin_*` function checks `is_admin()` in its own body
- every admin mutation writes an `admin_actions` row in the same transaction
- every money column is an integer type
- the Postgres enums match `lib/orders/state.js`

## Who sees what

|                           | Customer       | Vendor         | Partner       | Admin      |
| ------------------------- | -------------- | -------------- | ------------- | ---------- |
| Their own orders          | ✓              | their vendor's | assigned only | ✓          |
| Item names and prices     | ✓              | ✓              | count only    | ✓          |
| Destination **room**      | own            | ✗ **never**    | once assigned | ✓          |
| Destination zone          | own            | ✓              | ✓ (in offers) | ✓          |
| Customer phone            | own            | ✗ **never**    | once assigned | ✓          |
| Partner phone             | while assigned | ✗              | own           | ✓          |
| **Pickup** code           | own collection | **✓ theirs**   | ✗ **never**   | ✗          |
| **Delivery** code         | own            | ✗              | ✗ **never**   | ✗          |
| Partner ID / selfie       | ✗              | ✗              | ✗             | signed URL |
| Payment provider payloads | ✗              | ✗              | ✗             | ✓          |
| Notification log          | ✗              | ✗              | ✗             | ✓          |
| `admin_actions`           | ✗              | ✗              | ✗             | read-only  |

**Phone numbers exist in a window, not a record.** The assigned Partner sees the
customer's number from the moment the job is theirs until the delivery ends —
they may have to ring before they are holding food that is going cold. Before
assignment the offer list shows a zone and nothing about a person; afterwards
the number is gone from the active view and never enters history. The customer
sees the Partner's number over the same window. Vendors never see either.

Enforced in **two independent places**, neither of which is a page:

- the RLS policy `users_read_customer_during_active_delivery`, which admits the
  row only for `partner_id = auth.uid()` while ASSIGNED or PICKED_UP;
- `partner_active_delivery()`, which selects those columns under the same
  condition and returns nothing once the delivery is DELIVERED.

The number is also **never in an SMS**. It was, once, in the PARTNER_PICKED_UP
message — an SMS is forwardable, screenshottable and permanent, and it outlives
the delivery it was sent for.

## Codes

`order_secrets` has **no RLS policy and no grant for anyone** — not the vendor,
not the Partner, not an admin. Nobody SELECTs the table. Each code is reachable
only through one entitlement-checked function, and each function serves exactly
one side.

**The rule is one sentence: the person who holds the secret is never the person
who performs the act.**

All three are **exactly four digits**.

| Code     | Read by                                | Typed in by                                |
| -------- | -------------------------------------- | ------------------------------------------ |
| Handoff  | the STORE, `vendor_handoff_code()`     | the PARTNER, `partner_confirm_pickup()`    |
| Handoff  | the STORE, `vendor_handoff_code()`     | the CUSTOMER, `customer_complete_pickup()` |
| Delivery | the CUSTOMER, `get_my_delivery_code()` | the PARTNER, `partner_complete_delivery()` |

**One function returns a handoff code, and it is behind `is_vendor_staff`.**
There is none that returns it to a Partner or to a collecting customer, and the
claim does not hand one back either. Whoever could read it could confirm a
handoff that never happened, which is the entire point of the code —
symmetrically, a store that could read the delivery code could record a delivery
that never happened.

`vendor_handoff_code()` additionally returns nothing unless somebody is actually
due to collect — a Partner assigned to the order, or a collection whose food is
made — so a code is never sitting on a screen between jobs.

The COLLECTION handoff used to run the other way, with the customer holding a
code and the vendor typing it. The invariant is identical; what changed is which
side of the counter holds the secret, so the person walking away with the food
is the one performing the act.

Codes come from pgcrypto's CSPRNG, never `random()`. A handoff code rotates on
every reassignment and on every cancellation, so a superseded code is gone
rather than merely unused — `pickup_code_version` only moves forward.

### Four digits, and what makes four digits safe

Four digits is ten thousand possibilities, which is minutes of scripted requests
by itself. What makes it acceptable is that each side of each handoff counts its
consecutive failures and locks out.

`check_handoff_code()` is the only place a code is ever compared. It is SECURITY
DEFINER, granted to nobody but `service_role`, and it WRITES: a counter that
only counted when a caller remembered to would count nothing. `order_secrets`
gained `pickup_attempts` / `pickup_locked_until` and their delivery-side twins,
on the table no client role can read.

| Behaviour                                      | Why                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lockout is checked BEFORE the comparison       | A lockout that let the correct code through would tell an attacker they had finally guessed it |
| A correct code resets the count to zero        | Somebody mishearing a digit twice is normal, not an attack                                     |
| A new assignment resets the count and the lock | A Partner does not inherit the previous one's failures                                         |
| An expired lockout starts again from one       | The genuine Partner is not locked out forever                                                  |

`pricing_config.code_attempt_limit` (5) and `code_lockout_seconds` (300) are
admin-editable, like every other operational number.

**Only somebody already authorised to attempt can spend an attempt.** Every
comparison is preceded by an authorisation check that RAISES: a Partner who is
not carrying the delivery is refused before a code is compared, so they cannot
lock a delivery out from under the Partner who is. That ordering is asserted in
`tests/handoff-codes.test.js`.

## Verification documents

**One document, not two.** A Partner application carries a photograph of the
student ID and nothing else. The live face photograph was removed: reaching the
application at all requires the CUSTOMER capability, which requires a verified
`@acity.edu.gh` address, so the school had already established the identity. A
second, weaker check is not worth being the custodian of the most sensitive
image on the platform. `face_image_path` survives, nullable and never written,
so a past decision can still be audited against what it was made on.

The document lives in a private bucket with **no storage policies at all**, so
RLS denies every client read and write. A customer holds no verification
document, so there is nothing in that bucket belonging to somebody who is not a
Partner.

Storefront photographs are the one **public** bucket, deliberately: an
unauthenticated visitor browsing the marketplace has to see them, and a picture
of a plate of jollof is advertising. It takes no client writes either — every
object in it went through a server that checked who was asking. An admin sees an image through a signed
URL valid for a configurable two minutes. Deleting the object invalidates
outstanding URLs immediately — they resolve to a 404.

Nobody ever receives a storage path for their own document:
`my_partner_application()` and `my_customer_profile()` return booleans.

**Both Partner documents are purged together**, after the review retention
window recorded in `documents_purge_after`:
`admin_partner_documents_due_for_purge()` lists them,
`admin_clear_partner_documents()` clears both columns, and
`purgePartnerDocuments()` re-reads the deletable paths **server-side** and
discards anything else it was handed — the form posts no path at all, so a
tampered field cannot aim a deletion at somebody else's image.

Purging one and leaving the other would be worse than purging neither: the
columns are cleared in the same statement, so a missed object would sit in
storage with nothing left to find it by.

## Credentials

- `NEXT_PUBLIC_SUPABASE_URL` and the publishable key are the only values that
  reach the browser. Every query the publishable key makes is subject to RLS,
  and clients hold SELECT only.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely. It is read only through
  `config.supabaseServiceRoleKey()`, which throws if touched in browser code,
  and `lib/supabase/admin.js` is marked `server-only` so importing it into a
  client component fails the build.
- `SUPABASE_DB_URL` contains the database password and is used only by the
  maintenance scripts. The application never reads it.
- `ARKESEL_API_KEY` is a bearer credential for an account with real money in it.
  Arkesel's v1 API takes it in the query string, which makes the request URL
  itself a secret — so `lib/sms/arkesel.js` never logs a URL, never puts one in
  an error message and never returns one.
- `ARKESEL_WEBHOOK_SECRET` is what stops anyone who finds the callback URL
  writing into the notification log.
- `PAYSTACK_SECRET_KEY` is the most dangerous credential in the deployment. It
  charges cards, it sends transfers, and Paystack signs webhooks with it — so
  anyone holding it can forge an event that marks an order paid. There is no
  separate webhook secret to compromise instead.
- `PAYSTACK_PUBLIC_KEY` is server-only too. It is not a secret, but hosted
  redirect checkout means the browser never talks to Paystack, so no Paystack
  credential has any reason to exist client-side. A `NEXT_PUBLIC_` copy would
  only invite an inline flow that skips the server.
- `tests/secrets.test.js` asserts all of this mechanically: no `NEXT_PUBLIC_`
  name, every read through `serverOnly()`, `process.env` touched in one module,
  no client component importing an adapter or the admin client, and neither the
  names nor the values present in a built client bundle.
- No credential is committed. `.env` and `.env.local` are gitignored,
  `.env.example` carries names and never values, and `/api/health` reports
  whether each variable is present without echoing any of them.
- Administrator passwords are never a command-line argument, never echoed, and
  never stored anywhere in this repository — `scripts/create-admin.mjs` and
  `scripts/reset-admin-password.mjs` each read one from a hidden prompt and hand
  it straight to Supabase Auth.
- Administrator password recovery never widens who may hold a password. The
  in-app flow at `/login/admin/forgot` checks `is_admin` BEFORE Supabase is
  asked to send anything, so only an administrator is ever emailed a link, and
  it answers identically either way so the form cannot be used to discover which
  addresses are administrators. The session the link produces is spent on the
  password and signed out, so following a link never grants console access, and
  `is_admin` is re-read from the database at every step rather than trusted from
  the link or the session.
- `scripts/reset-admin-password.mjs` is the same operation from a terminal, for
  when the mailbox itself is unreachable. It sets a password and nothing else,
  and refuses any address that is not already an administrator.

## Money

- A browser returning from the provider's hosted checkout proves nothing. The
  return handler asks the provider server-to-server what happened; the verified
  answer moves the payment, never the arrival.
- Payout account numbers live in `payout_destinations`, a server-only table with
  no grants for any client role. They are deliberately not on `vendors`, where
  an anonymous visitor can read every column of an active vendor.
- Only a **signature-verified, deduplicated** provider event can move a payment
  to PAID. `confirm_payment` is not granted to any client role.
- Webhook signatures are HMAC-verified before the body is parsed, with a
  five-minute replay window.
- A deferred constraint trigger refuses to commit allocations that do not sum
  to the order total.
- Partial unique indexes enforce one live payment intent per order, **the
  configured Partner capacity** (via a unique `(partner_id, partner_slot)` while
  the delivery is live), one store per owning account, and one payout per payee
  per settlement run. `partner_ratings` uses the ORDER as its primary key, so a
  duplicate rating is impossible rather than merely guarded against.

## Errors

`lib/errors.js` maps every failure to a sentence a person can act on. Anything
unrecognised becomes a generic message, because an unmapped error's text has
not been checked for constraint names, table names or ids. Full detail goes to
the server log only.

A lost race returns 409 and reads as routine, because it is.
