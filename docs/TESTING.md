# Testing

```bash
npm test          # everything
npm test 2>&1 | grep -E "^✔|^✖"   # suite summary only
node --test --env-file-if-exists=.env --env-file-if-exists=.env.local tests/partner.test.js
```

Needs the local Supabase stack up (`npm run db:start`). A few tests also need
`npm run dev`; they skip themselves with a clear message when it is not there.

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

| Suite                                    | Covers                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| `schema`                                 | The invariants everything else rests on                         |
| `rls`                                    | Who can read what, attempted directly                           |
| `transitions`                            | Every legal move, and the illegal ones                          |
| `concurrency`                            | Races and idempotency                                           |
| `money`, `payment-webhook`, `settlement` | Allocation, dedup, payouts, reconciliation                      |
| `vendor`, `customer`, `partner`          | Each actor, including what they must not do                     |
| `auth`, `terms`, `notifications`         | Identity, versioned acceptance, message wiring                  |
| `hardening`                              | Stuck payments, dedup, config, metrics, provider reconciliation |
| `e2e`                                    | One complete order, plus nine failure variants                  |
| `scheduler`                              | The sweeps, including one that waits for real cron              |

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
