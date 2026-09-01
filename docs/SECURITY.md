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

|                           | Customer          | Vendor         | Partner         | Admin      |
| ------------------------- | ----------------- | -------------- | --------------- | ---------- |
| Their own orders          | ✓                 | their vendor's | assigned only   | ✓          |
| Item names and prices     | ✓                 | ✓              | count only      | ✓          |
| Destination **room**      | own               | ✗ **never**    | after handoff   | ✓          |
| Destination zone          | own               | ✓              | ✓               | ✓          |
| Customer phone            | own               | ✗ **never**    | while carrying  | ✓          |
| Partner phone             | while assigned    | ✗              | own             | ✓          |
| Pickup / delivery code    | own delivery code | ✗              | own pickup code | ✗          |
| Partner ID / selfie       | ✗                 | ✗              | ✗               | signed URL |
| Payment provider payloads | ✗                 | ✗              | ✗               | ✓          |
| Notification log          | ✗                 | ✗              | ✗               | ✓          |
| `admin_actions`           | ✗                 | ✗              | ✗               | read-only  |

**Phone numbers exist in a window, not a record.** A Partner sees the
customer's number between vendor handoff and delivery. Before that they see a
zone; after it, the number is gone from the active view and never enters
history. The customer sees the Partner's number over the same window. Vendors
never see either.

This is enforced in `partner_active_delivery()` and `customer_order_detail()`,
not in a page — the number does not cross the wire early whatever a screen
decides to render.

## Codes

`order_secrets` has **no RLS policy and no grant for anyone** — not the vendor,
not the Partner, not an admin. Nobody SELECTs a code.

That matters most for the vendor: one who could read `pickup_code` could
confirm a handoff that never happened, which is the entire point of the code.
The Partner reads it aloud, the vendor types what they hear, and the server
compares.

Codes come from pgcrypto's CSPRNG, never `random()`. A pickup code rotates on
every reassignment, so a superseded code is gone rather than merely unused.

## Partner documents

A private bucket with **no storage policies at all**, so RLS denies every
client read and write. An admin sees an image through a signed URL valid for a
configurable two minutes. Deleting the object invalidates outstanding URLs
immediately — they resolve to a 404.

The applicant never receives a storage path.

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
- `tests/secrets.test.js` asserts all of this mechanically: no `NEXT_PUBLIC_`
  name, every read through `serverOnly()`, `process.env` touched in one module,
  no client component importing the adapter, and neither the names nor the
  values present in a built client bundle.
- No credential is committed. `.env` and `.env.local` are gitignored,
  `.env.example` carries names and never values, and `/api/health` reports
  whether each variable is present without echoing any of them.
- Administrator passwords are never a command-line argument, never echoed, and
  never stored anywhere in this repository — `scripts/create-admin.mjs` reads
  one from a hidden prompt and hands it straight to Supabase Auth.

## Money

- Only a **signature-verified, deduplicated** provider event can move a payment
  to PAID. `confirm_payment` is not granted to any client role.
- Webhook signatures are HMAC-verified before the body is parsed, with a
  five-minute replay window.
- A deferred constraint trigger refuses to commit allocations that do not sum
  to the order total.
- Partial unique indexes enforce one live payment intent per order, one active
  delivery per Partner, and one payout per payee per settlement run.

## Errors

`lib/errors.js` maps every failure to a sentence a person can act on. Anything
unrecognised becomes a generic message, because an unmapped error's text has
not been checked for constraint names, table names or ids. Full detail goes to
the server log only.

A lost race returns 409 and reads as routine, because it is.
