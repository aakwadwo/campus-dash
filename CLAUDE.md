# Campus Dash

Campus-only ordering and delivery for Academic City University, Ghana. Customers
order from approved vendors and either collect the order themselves or have a
verified student **Partner** bring it to a predefined campus destination.

Read `docs/ARCHITECTURE.md` first, then `docs/DATABASE.md` — the schema is where
most of the safety lives. `docs/HOSTED-SUPABASE.md` covers running against a
real hosted project. `docs/AUTH.md` covers phone OTP and the Send SMS Hook,
`docs/VENDOR.md` the vendor module, `docs/CUSTOMER.md` customer ordering,
`docs/PARTNER.md` the Partner system, `docs/SCAN.md` scan delivery,
`docs/MONEY.md` allocation and settlement,
`docs/PAYMENTS.md` the Paystack integration,
`docs/SECURITY.md` the security model, `docs/NOTIFICATIONS.md` messaging and
`docs/SMS.md` the Arkesel integration,
`docs/OPERATIONS.md` running the pilot, `docs/SETUP.md` local setup and
`docs/TESTING.md` the suite and `docs/MANUAL-TESTING.md` the development
accounts for a manual walkthrough. `docs/STATE-MACHINE.md` covers order state.
`docs/PILOT-QUESTIONS.md` lists what is genuinely still undecided — do not code
around those as if they were settled.

## Vocabulary

- Delivery people are **Partners**. Never "runners", never "drivers", never
  "deliverers". A Partner helps the campus community and earns for it; nothing
  in the copy may make them read as subordinate to a customer.
- A vendor runs a **store**, not a "stall".
- A **vendor** is an identity that owns a business. There are no "vendor staff":
  `vendors.owner_user_id` is the whole model, and it is one account per store.
- Money is **integer pesewas**. 1 GHS = 100 pesewas. Never floats, anywhere.
- A **scan** is a student's prepaid campus meal entitlement. A **scan delivery**
  is the errand of redeeming one — Campus Dash sells the errand, never the food.
  See `docs/SCAN.md`.

## Hard rules

1. **The server is authoritative** for prices, fees, order state, payment state,
   Partner assignment, permissions and settlement. Never trust the client for
   any of them — including "the payment succeeded".

   Corollary: **pickup or delivery is chosen AT THE CHECKOUT, and the order is
   PAID FOR before any store sees it.** There is no vendor acceptance step:
   `submit_order()` takes the fulfilment and the destination, prices the whole
   thing including the GH₵5, and creates the order ACCEPTED — a state that now
   means "priced and payable", not "a vendor said yes". `confirm_payment()` is
   what reaches the kitchen (ACCEPTED → PREPARING) and what opens dispatch
   (delivery_status NONE → SEARCHING). A store's only order button is **Ready
   for pickup**, never "Done".

   `customer_choose_fulfilment()` survives as the CHANGE path, usable only
   while the order is unpaid. Every fee it recomputes comes from the order's own
   price snapshot; the 5% service fee is never recomputed there.

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
11. **All three handoff codes are FOUR DIGITS, and they travel from one rule:
    the person who holds the secret is never the person who performs the act.**
    The STORE holds the handoff code and reads it out; whoever is taking the
    food types it in — a PARTNER collecting a delivery, or a CUSTOMER collecting
    their own order. The CUSTOMER holds the delivery code and reads it out; the
    PARTNER types it in. One function returns a handoff code —
    `vendor_handoff_code()`, behind `is_vendor_staff` — and there is none that
    shows it to a Partner or to a collecting customer. Adding one would put the
    secret and the act on the same side of the counter and the code would prove
    nothing. Four digits is ten thousand guesses, so each side counts its
    failures and locks out — see `check_handoff_code()` and
    `pricing_config.code_attempt_limit`. The lockout refuses the CORRECT code
    too, because a lockout that let it through would be an oracle.

    The COLLECTION handoff used to run the other way, with the customer holding
    the code and the vendor typing it. The invariant is unchanged; which side of
    the counter holds it is not, because the person collecting is the one with a
    screen in their hand and a queue behind them.

12. **The order number a person is shown is a DAILY, PER-STORE QUEUE NUMBER.**
    001, 002, 003, restarting every calendar day, unique per store —
    `orders.vendor_order_no`, allocated by `next_vendor_order_no()` whose
    upsert locks the counter row, and guarded a second time by
    `orders_vendor_day_no_unique`. `orders.order_number` (`CD-01043`) survives
    underneath as the internal reference every payment, allocation and payout
    keys off; it is never what a customer or a store is asked to read out. A
    SCAN errand takes no queue number, because no store ever sees one.

13. **Partner capacity is CONFIGURABLE, and the limit is an index.**
    `pricing_config.max_active_deliveries_per_partner` (default 2) decides how
    many slots exist; `orders.partner_slot`, unique per Partner while the
    delivery is live, decides that two claims never get the same one — see
    `orders_partner_active_slot_unique`. The count in the claim's WHERE is belt;
    the index is braces. Reading a number from a table is not an atomicity
    primitive and must never be asked to be one. Lowering the maximum never
    takes an order off a Partner already carrying it.
14. **The assigned Partner sees the customer's phone number from ASSIGNMENT
    until the delivery ends, and never afterwards.** Enforced twice over: the
    RLS policy on `users`, and `partner_active_delivery()`. It is never in an
    SMS. Never hide it with CSS; never widen it to history.
15. **Provider acceptance is not delivery.** A 200 from Arkesel means the
    message was taken, not that it arrived. The outcome comes back later on the
    delivery webhook and lands on the same `notification_events` row. The same
    rule governs money out: a transfer Paystack accepted is a PROCESSING payout,
    and only `transfer.success` makes it PAID.
16. **A browser returning from a hosted checkout proves nothing.** Payment moves
    on a signature-verified webhook or a server-to-server verify — never because
    someone arrived at a URL.
17. **The vendor's share is SPLIT at the charge; everything else is a transfer.**
    A Paystack dynamic split (`type: 'flat'`, `bearer_type: 'account'`) routes
    the food subtotal to the vendor's subaccount as the customer pays, and
    `allocations.settlement_channel` records which channel each row used. THE
    PARTNER CANNOT BE IN THE SPLIT: it is fixed when the charge is created, and
    at that moment the food is not cooked and no Partner exists. Their GH₵5 is
    carved out at completion and settled by the payout run. See `docs/MONEY.md`.
18. **A Partner earns GH₵5 a delivery and is paid weekly at GH₵20.**
    `pricing_config.partner_min_payout_pesewas` is the policy, separate from the
    general `min_payout_pesewas` because vendors settle by split. A balance under
    the threshold is RELEASED by the run in the same transaction that claimed
    it, so it is owed again immediately and swept by the next run. Never tell a
    Partner about a provider minimum: the dashboard states a weekly payout
    policy and `my_partner_payouts()` returns no provider failure text.
19. **`users.full_name` is DERIVED from `first_name` and `last_name`.** A
    trigger keeps them in step, so it is still the one column a read model
    selects for a display name and it can no longer drift. A customer is told a
    Partner's FIRST name and a Partner is told a customer's FIRST name; neither
    is ever told a surname, and a name never goes into a broadcast SMS.

## Not in V1

Reviews, coupons, promotions, AI recommendations, Google Maps, GPS, live
tracking, automatic penalties, analytics, microservices, native apps, push
notifications, multi-vendor carts, automatic Paystack transfers, dark mode.

Moved OFF this list, and each was on it:

- A Partner carrying more than one delivery at once. The maximum is now an
  admin setting, defaulting to 2.
- Partner ratings. One to five stars on a completed delivery, one per order.
- Customer rewards. A count of completed orders with marks at 25, 40 and 50.
  Not points, not tiers, not a wallet — and the reward itself is deliberately
  undefined in software, because Campus Dash has not decided what it is.
- Automatic per-order VENDOR settlement, through Paystack split payments.
  Partner settlement is still a payout run; see hard rule 17.

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
npm run admin:password # set a new password on an EXISTING administrator
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
- **Identity is not capability.** The identity is `auth.users.id` and nothing
  else is ever the key. Capabilities are additive rows on top of it — CUSTOMER
  is a `customer_profiles` row, PARTNER an APPROVED `partner_profiles` row,
  VENDOR a `vendors.owner_user_id` pointing at the account, ADMIN the
  `users.is_admin` column. There is no account TYPE, and
  `Admin + Customer + Partner + Vendor` is valid. Holding one capability never
  confers another: admin does not imply customer, and a vendor account is not a
  shopper.
- **Three sign-ins, three proofs, one identity table.** CUSTOMER proves a
  verified `@acity.edu.gh` address (email OTP). VENDOR proves a phone number
  (SMS OTP) and is never asked for an email. ADMIN proves a password and has
  **no phone number at all** — `users.phone` is NULL on that row, because
  operational access must not depend on an SMS arriving. Which door somebody
  came through has no bearing on what they may then do.
- **PARTNER ⇒ CUSTOMER** is a foreign key (`partner_requires_customer`,
  `ON DELETE RESTRICT`), not a convention. Becoming a Partner is an upgrade to
  the same account — never a second auth user, email or login. Which is also
  why an application asks for ONE document, the student ID: the verified
  `@acity.edu.gh` address has already established who the applicant is. Campus
  Dash no longer collects a face photograph; the column survives so a past
  decision can still be audited against what it was made on.
- Auth roles come from `my_capabilities()`, derived from the database on every
  request. Never trust a role sent by the client. `can_order` is the CUSTOMER
  capability, not "has a pulse".
- Customers sign in with a code emailed to their school address at `/login`;
  vendors with an SMS code at `/login/vendor`; administrators with a password at
  `/login/admin`, which is deliberately not linked from any public page.
  Ordering additionally requires customer sign-up at `/signup`.
- A customer's phone number is a PROFILE FIELD, not a credential: it is the
  number a Partner rings on arrival. A vendor's phone number IS the credential.
- The design system lives in `app/globals.css` (tokens) and `app/ui.js` (the
  component kit); the admin console's denser kit is `app/admin/ui.js` and draws
  from the same tokens. **The logo IS `info/logo2.PNG`** — the running Partner —
  and `app/brand.js` serves it from `public/brand/`, generated from that one
  file. Never redraw it. The square icon variation exists only because a wide
  transparent runner in a 16px browser tab is a smudge. Never write a raw hex,
  a `bg-white` or a `border-black/10` in a component — every colour is a
  semantic token so a palette change happens in one file.
- **ONE GROUND. There is no dark mode and no toggle.** Campus Dash is a
  light product on an off-white canvas. Never add a `dark:` variant or a
  `prefers-color-scheme` block.
- The brand colours are the ones in `info/colors`: deep orange `#FF5722` /
  `#E64A19`, navy `#0D1B2A` / `#1A237E`, off-white `#FAFAFA`.
  - `brand-500` (`#FF5722`) is the identity orange: the logo, progress fills,
    non-text marks. It is NOT legible under white text (3.2:1) and must never
    carry a button label.
  - `brand-700` (`#D93F10`) is the one that does the work: the primary button
    ground AND the link colour on white. It is 4.5:1 in BOTH directions, which
    is why one token serves both roles.
  - `ink` is navy, not black, so every heading carries brand at no cost.
  - Amber and red are the only other colours, for warning and failure; `good`
    is a green deliberately unlike the orange, so a success mark never reads as
    a call to action.
- Surfaces are `canvas` (page), `surface` (cards), `surface-2`/`surface-3`
  (inputs, muted fills, hover). Lines are `line` / `line-strong` hairlines.
  Radii are `input` / `card` / `panel` / `sheet`, and buttons are pills.
- **Copy is written, not generated.** No hyphen-heavy constructions where a
  full stop would do, no eyebrow labels as decoration, no badge on anything
  that is not a state, no card around a single sentence. If a line reads like
  it came out of a template, it did, and it should be rewritten.
- Sign-in destination is derived from capabilities in `lib/auth/landing.js`,
  never chosen by the client. Admin → /admin, vendor → /vendor, vendor applicant
  → /vendor/application, customer → /order, approved Partner → /partner, Partner
  applicant → /partner/apply, otherwise → /signup. That order is PRECEDENCE, not
  exclusivity: `areasFor()` lists every area the account holds and each layout
  renders it as an `AreaSwitcher`, so landing on /admin never means losing
  /order, and a Partner who is also a customer lands on ordering with the
  Partner area one tap away.
