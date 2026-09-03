# Campus Dash

Campus-only ordering and delivery for Academic City University, Ghana. Customers
order from approved vendors and either collect the order themselves or have a
verified student **Partner** bring it to a predefined campus destination.

Read `docs/ARCHITECTURE.md` first, then `docs/DATABASE.md` — the schema is where
most of the safety lives. `docs/HOSTED-SUPABASE.md` covers running against a
real hosted project. `docs/AUTH.md` covers phone OTP and the Send SMS Hook,
`docs/VENDOR.md` the vendor module, `docs/CUSTOMER.md` customer ordering,
`docs/PARTNER.md` the Partner system, `docs/MONEY.md` allocation and settlement,
`docs/PAYMENTS.md` the Paystack integration,
`docs/SECURITY.md` the security model, `docs/NOTIFICATIONS.md` messaging and
`docs/SMS.md` the Arkesel integration,
`docs/OPERATIONS.md` running the pilot, `docs/SETUP.md` local setup and
`docs/TESTING.md` the suite and `docs/MANUAL-TESTING.md` the development
accounts for a manual walkthrough. `docs/STATE-MACHINE.md` covers order state.
`docs/PILOT-QUESTIONS.md` lists what is genuinely still undecided — do not code
around those as if they were settled.

## Vocabulary

- Delivery people are **Partners**. Never "runners", never "drivers".
- Money is **integer pesewas**. 1 GHS = 100 pesewas. Never floats, anywhere.

## Hard rules

1. **The server is authoritative** for prices, fees, order state, payment state,
   Partner assignment, permissions and settlement. Never trust the client for
   any of them — including "the payment succeeded".
2. **Three independent state dimensions** — `order_status`, `payment_status`,
   `delivery_status`. Never merge them. A failed delivery does not fail the food
   order.
3. **Race-sensitive transitions happen in SQL**, as conditional updates guarded
   on the current state. Zero rows affected = the transition failed; log it,
   never overwrite.
4. **Money operations are idempotent**, backed by unique constraints — payment
   creation, webhook processing, payout creation.
5. **Admin overrides append to `admin_actions`** — who, what, which entity, when,
   why.
6. **Clients get SELECT only.** There are no INSERT/UPDATE/DELETE grants for
   `anon` or `authenticated` on any table. Every write goes through a SECURITY
   DEFINER function in `supabase/migrations/`, reached from
   `lib/orders/transitions.js`. Do not add a write grant to make something
   easier.
7. **Never import `lib/supabase/admin.js` into client code.** It bypasses RLS.
   Service-role keys never reach the browser.
8. **RLS is not optional.** Frontend route protection is not access control.
9. **Transitions return `{ success, reason }` for state and contention failures**
   and RAISE for authorisation failures. Logging-then-raising would roll back
   the log, so rejections must not raise. See `docs/DATABASE.md`.
10. **External providers sit behind interfaces.** Payments and SMS are reached
    only through `lib/payments` and `lib/sms`. No provider-specific logic
    anywhere else. Arkesel lives entirely in `lib/sms/arkesel*.js`, Paystack
    entirely in `lib/payments/paystack.js`.
11. **Provider acceptance is not delivery.** A 200 from Arkesel means the
    message was taken, not that it arrived. The outcome comes back later on the
    delivery webhook and lands on the same `notification_events` row. The same
    rule governs money out: a transfer Paystack accepted is a PROCESSING payout,
    and only `transfer.success` makes it PAID.
12. **A browser returning from a hosted checkout proves nothing.** Payment moves
    on a signature-verified webhook or a server-to-server verify — never because
    someone arrived at a URL.

## Not in V1

Ratings, reviews, loyalty, coupons, promotions, AI recommendations, Google Maps,
GPS, live tracking, multiple simultaneous Partner deliveries, Partner scoring,
automatic penalties, analytics, microservices, native apps, push notifications.

## Commands

```
npm run dev          # Next.js dev server on :3000
npm run build        # production build
npm run lint         # eslint
npm run format       # prettier
npm test             # full suite (needs the local stack; auth e2e skips without `npm run dev`)
npm run db:start     # local Supabase (needs Docker running)
npm run db:reset     # re-apply all migrations + seed
npm run db:status    # local Supabase URLs and keys
npm run db:schema    # regenerate supabase/schema.sql from the migration-built DB
npm run db:install   # install supabase/schema.sql into SUPABASE_DB_URL (hosted)
npm run db:snapshot  # print full schema state, for comparing two databases
npm run admin:create # create or promote an administrator (email + password)
npm run verify:hosted # check a project over HTTPS, with the API keys only
npm run sms:test      # send ONE real SMS through Arkesel. Spends credit.
npm run sms:webhook   # replay a signed delivery report at a running server
npm run paystack:test # open ONE real Paystack TEST checkout. Refuses live keys.
```

Tests run against the local database and share it, so they run serially. They
connect as `authenticator` — the role PostgREST itself uses — so RLS and grants
are exercised exactly as a real browser request would hit them.

Environment: see `docs/SETUP.md`, or `docs/HOSTED-SUPABASE.md` for a hosted
project. The Supabase variables are `NEXT_PUBLIC_SUPABASE_URL` (the project
ORIGIN, never the `/rest/v1` endpoint), `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
and the server-only `SUPABASE_SERVICE_ROLE_KEY`. Fees and timeouts are NOT env
vars — they live in `pricing_config`, editable at `/admin/pilot`, so the pilot
can retune without a deploy. `SMS_PROVIDER=fake` prints SMS and phone OTPs to
the server console and to `/dev/inbox`; `SMS_PROVIDER=arkesel` sends real
messages and spends real credit. `PAYMENT_PROVIDER=fake` simulates a ~2s
asynchronous collection; `PAYMENT_PROVIDER=paystack` uses Paystack hosted
redirect checkout — see `docs/PAYMENTS.md`. Money OUT stays shut until
`PAYSTACK_TRANSFERS_ENABLED=true`.

## Conventions

- JavaScript only. No TypeScript.
- `@/` path alias maps to the project root.
- `process.env` is read only in `lib/config.js`.
- Schema changes go in `supabase/migrations/` — never applied by hand. Then
  regenerate `supabase/schema.sql` with `npm run db:reset && npm run db:schema`;
  it is the canonical from-empty state and is what a hosted project installs.
  Never hand-edit it, and never write it by concatenating migrations.
- Adding a table or function will fail the schema allowlist test until you
  decide who may reach it. That is the point: Supabase's default grants expose
  new objects to `anon`, and this has bitten three times.
- Operational numbers live in `pricing_config`, not in code. If you find
  yourself typing a timeout, put it there instead.
- The Supabase CLI is pinned as a dev dependency; `npm run db:*` uses it. Do not
  rely on a globally installed one.
- Auth roles come from `my_capabilities()`, derived from the database on every
  request. Never trust a role sent by the client.
- Customers, vendors and Partners sign in by phone OTP; administrators sign in
  with email and password at `/login/admin`.
- Brand colours are white, pastel yellow (`#F7E7A1`) and soft charcoal
  (`#242424`) — never pure black. `brand-500` is the pastel fill for primary
  buttons and always carries `text-ink`; `brand-700` is the darkened ochre for
  links, status text and small marks ON white. They are not interchangeable.
  Amber and red are the only other colours, and only for warning and failure.
- Sign-in destination is derived from capabilities in `lib/auth/landing.js`,
  never chosen by the client. Admin → /admin, vendor → /vendor, approved
  Partner → /partner, applicant → /partner/apply, otherwise → /order.
