# Testing

```bash
npm test          # everything
npm test 2>&1 | grep -E "^✔|^✖"   # suite summary only
node --test --env-file-if-exists=.env --env-file-if-exists=.env.local tests/partner.test.js
```

Needs the local Supabase stack up (`npm run db:start`). A few tests also need
`npm run dev`; they skip themselves with a clear message when it is not there.

The suite always talks to the **local** database on `127.0.0.1:54322`, whatever
`.env.local` says. Pointing the application at a hosted project therefore does
not move the tests — keep the local stack running for them. The two `auth-e2e`
tests that drive Supabase Auth and then read `auth.users` skip themselves when
`NEXT_PUBLIC_SUPABASE_URL` is not the local stack, because otherwise they would
be looking in a different database.

## How the tests connect

Two identities, and the difference is the point:

- **`postgres`** — superuser. Setup, scheduled jobs, and anything the
  service-role key would do. RLS does not apply.
- **`authenticator`** — the role PostgREST itself logs in as before switching to
  `authenticated` or `anon`. Every client-facing test goes through it, so grants
  and policies are exercised exactly as a browser request hits them, including
  `session_user`, which `SET ROLE` does not change.

Test files share one database, so they run serially. `resetTransactionalState()`
restores the seeded catalogue between tests — not just its flags. That exists
because a cleanup once matched on name and deleted a seeded vendor a test had
renamed.

## The suites

| Suite                                    | Covers                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                 | The invariants everything else rests on                                                                                                                                       |
| `rls`                                    | Who can read what, attempted directly                                                                                                                                         |
| `transitions`                            | Every legal move, and the illegal ones                                                                                                                                        |
| `concurrency`                            | Races and idempotency                                                                                                                                                         |
| `money`, `payment-webhook`, `settlement` | Allocation, dedup, payouts, reconciliation                                                                                                                                    |
| `vendor`, `customer`, `partner`          | Each actor, including what they must not do                                                                                                                                   |
| `auth`, `terms`, `notifications`         | Identity, versioned acceptance, message wiring                                                                                                                                |
| `account-model`                          | Identity vs capability: onboarding, the Customer→Partner upgrade on one auth user, admin ⇏ customer, vendor ⇏ customer, email uniqueness, and the two delivery conflict rules |
| `multi-capability`, `auth-landing`       | Several capabilities on one account, and where such an account is routed                                                                                                      |
| `hardening`                              | Stuck payments, dedup, config, metrics, provider reconciliation                                                                                                               |
| `dev-sms-hook`                           | The hosted-development Postgres Send SMS Hook, installed and dropped in-suite                                                                                                 |
| `sms-arkesel`                            | The Arkesel adapter, against a mocked fetch. Never spends credit                                                                                                              |
| `paystack`                               | The Paystack adapter, against a stub fetch. Real HMAC. Never calls Paystack                                                                                                   |
| `paystack-payouts`                       | Payout lifecycle, customer email, mobile money destinations                                                                                                                   |
| `paystack`                               | The Paystack adapter, against a stub fetch. Real HMAC. Never calls Paystack                                                                                                   |
| `paystack-payouts`                       | Payout lifecycle, customer email, mobile money destinations                                                                                                                   |
| `sms-webhook-signature`                  | Signature, replay window, tampering, status mapping                                                                                                                           |
| `notifications-delivery`                 | notify() at runtime: dedup, retry, delivery reports                                                                                                                           |
| `secrets`                                | Credentials that must never reach a browser                                                                                                                                   |
| `e2e`                                    | One complete order, plus nine failure variants                                                                                                                                |
| `scheduler`                              | The sweeps, including one that waits for real cron                                                                                                                            |

## Why the runner has a loader

`npm test` runs with `--import ./tests/helpers/alias.mjs --conditions=react-server`.
Next.js resolves `@/lib/...` and extensionless imports; plain Node does not, and
`server-only` throws outside a React Server Component. That gap had a cost: the
notification service could not be imported by a test at all, so its runtime was
never executed, and two ReferenceErrors sat in it — a call to a helper that did
not exist and a variable read out of scope. Every order-scoped notification threw
and the caller swallowed it. Templates were covered; the code that sends was not.

The loader closes that. `tests/helpers/local-supabase.js` additionally pins the
service-role client at the local stack, so a suite can never write to a hosted
project because `.env.local` happens to name one.

**No test spends SMS credit.** The Arkesel adapter is tested against a mocked
fetch. `npm run sms:test` is the only thing that sends a real message, and it is
run by hand.

## One thing the tests deliberately do NOT claim

The Partner face photograph must be captured live. **The server cannot prove
that** — it receives bytes, and bytes carry no evidence of a camera. So there is
no test asserting "a gallery upload is rejected", because such a test would
either pass by accident or encode a guarantee the architecture does not make.

What `account-model` asserts instead is what actually holds: the upload route
accepts only image MIME types into a private bucket, `partner_apply()` refuses
without a face path, neither the applicant nor the customer is ever handed a
storage path back, and only an administrator can read one. The browser form
offering no file input is a deterrent; manual review is the control.

## What the tests are for

**Security tests attempt the thing.** They do not check that a button is
hidden; they issue the UPDATE and assert `permission denied`.

**The schema suite fails when you add anything.** New table or function? The
allowlist test goes red until you say who may reach it. That is deliberate —
it is what caught `anon` holding TRUNCATE on the audit log.

**Bugs become regression tests.** Every one found so far has: the accept-race
message that named the wrong state, the constraint that made customer-absence
impossible to commit, the vendor pickup-code pattern that matched a literal
backslash, the notification wiring that silently stopped, the metrics function
that leaked to non-admins.

**Some tests need real time.** The cron test waits ~30 seconds for pg_cron. It
is slow on purpose: asserting a job is _registered_ is not the same as asserting
it _fires_.

## Writing one

Use the flow helpers (`tests/helpers/flow.js`) — they walk an order through the
same RPCs the application calls. Never hand-write an UPDATE to force a state:
if a transition is reachable in a test it should be reachable in production, and
if it is not, the test is lying.

Transitions return `{ success, reason }` for state and contention failures and
**raise** for authorisation failures. Assert the right one.

## Testing it by hand

For development accounts, OTP codes and a lifecycle checklist, see
[`MANUAL-TESTING.md`](./MANUAL-TESTING.md).
