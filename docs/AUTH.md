# Authentication

Phone OTP for customers, vendors and Partners. Email and password for
administrators. One account per person; Customer and Partner are capabilities on
that same account, never separate logins.

## Who verifies what

Supabase Auth generates and validates the OTP. **We never generate, store or
check a code ourselves** — that whole surface stays in one audited place.

What we own is _delivery_. Supabase calls our **Send SMS Hook** with the message
to send, and we hand it to the `SmsProvider` abstraction. So the same seam that
carries order notifications carries the login code: `FakeSmsProvider` prints it
to the server console in development, and a Ghana provider drops in later
without touching auth at all.

```
signInWithOtp(phone)
        │
        ▼
  Supabase Auth ──── POST (HMAC-signed) ───▶ /api/auth/hooks/send-sms
   generates OTP                                      │
                                                      ▼
                                              getSmsProvider().send()
                                                      │
                                     FakeSmsProvider ──┴── (later) Ghana provider
        ┌─────────────────────────────────────────────┘
        ▼
verifyOtp(phone, code) ──▶ session cookies ──▶ trigger provisions public.users
```

## The hook is an SMS-sending endpoint

That is the whole security problem. Anyone who learned the URL could otherwise
drive it — sending messages at our cost, to numbers of their choosing.

Every request is verified with a **Standard Webhooks HMAC** before the body is
even parsed (`lib/auth/webhook-signature.js`):

- the signature covers `id.timestamp.body`, over the **raw bytes** received;
- the secret is base64-decoded after its `whsec_` prefix;
- comparison is constant-time;
- requests more than five minutes old or in the future are rejected, so a
  captured request cannot be replayed;
- during a rotation, several space-separated signatures are accepted.

A failure returns a deliberately vague 401; the reason stays in our logs.

If delivery fails we return a non-2xx, which makes Supabase fail the sign-in
rather than leaving someone waiting for a message that will never arrive.

## Administrators sign in with a password

Everyone else signs in by phone. Administrators do not, for a practical reason
and a safety one: operational access must not depend on an SMS arriving, and the
person who has to intervene when an order is stuck should not be locked out by a
failure in the very channel they are trying to fix.

`/login/admin` → `signInWithPassword`, then `my_capabilities()` is asked whether
this account is an administrator. If it is not, the session is thrown away
immediately. That check is a courtesy, not the boundary: `is_admin` is a column
on `public.users` that no client statement can reach, and every `admin_*`
function re-checks `is_admin()` in its own body. A password proves who someone
is; the database decides what they may do.

Failures return one message for every cause. Distinguishing "no such account"
from "wrong password" would confirm which email addresses are administrators.

There is no admin registration page and no self-service password reset. The
first administrator is created out-of-band with `npm run admin:create`, which
needs the service-role key and therefore a server — see
[`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md). The account carries a phone number
as well, because `public.users` is provisioned on phone confirmation and its
`phone` column is unique and NOT NULL: the phone is the identity, the password
is the credential.

## Local configuration

The secret lives in **`.env`**, not `.env.local`. The Supabase CLI reads only
`.env` from the project root and has no `--env-file` flag, while Next.js reads
both — so `.env` is the single place a value can be shared with `config.toml`'s
`env()` substitution.

```toml
[auth.hook.send_sms]
enabled = true
uri     = "http://host.docker.internal:3000/api/auth/hooks/send-sms"
secrets = "env(SEND_SMS_HOOK_SECRET)"   # note: plural
```

**A stub SMS provider is declared on purpose.** GoTrue gates phone login behind
`GOTRUE_EXTERNAL_PHONE_ENABLED`, and the CLI only sets that when an SMS
_provider_ block is enabled — having the hook is not enough. So
`[auth.sms.twilio]` is enabled with non-functional placeholder credentials
purely to switch phone login on. Verified locally: with the hook enabled, GoTrue
delivers through the hook and never contacts the provider.

Regenerate the secret with:

```
echo "v1,whsec_$(openssl rand -base64 32)"
```

It must be base64 after the prefix — the verifier decodes it.

## Hosted configuration

A hosted Supabase project cannot reach `http://localhost:3000`, so the HTTPS
hook has nothing to call during development. There the hook is a **Postgres
function** instead — `supabase/dev/sms-hook.sql` — which Supabase Auth calls
in-database and which parks the message where `/dev/inbox` can read it. No
tunnel, no public URL, no SMS account.

That file is development-only and deliberately not a migration and not part of
`schema.sql`, so production never installs it. Its own defences: RLS with no
policies and no client grants on the table, pruning to the newest 25 messages
and fifteen minutes on every write, and `/dev/inbox` returning 404 in a
production build or with any non-fake provider. See
[`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md).

In production the hook is the HTTPS route at the deployed origin —
`https://<deployment>/api/auth/hooks/send-sms` — with the dashboard's generated
secret in `SEND_SMS_HOOK_SECRETS`, and `SMS_PROVIDER=arkesel` so delivery goes
to a real handset.

**No SMS provider is configured on the hosted project.** The hook replaces it.
Verified directly against gotrue v2.196.0: with phone enabled, the hook enabled
and no provider at all, `/settings` reports `sms_provider: ""` and an OTP is
delivered through the hook to Arkesel. The placeholder Twilio block in
`config.toml` exists only because the Supabase CLI has no other way to turn
local phone auth on.

Supabase's contract shapes the route: a five-second total budget including its
retries, `application/json` always, and 429/503 with a non-empty `retry-after`
as the only retried statuses. So the provider call is bounded at 3.5s, a
transient failure returns 503 and a permanent one returns 500. See
[`SMS.md`](./SMS.md) for the exact dashboard settings.

Phone sign-in is **off** on a new hosted project and must be enabled in the
dashboard before any of this works.

## Account provisioning

A `public.users` row is created by a database trigger the moment a phone number
is **confirmed** — not when a code is requested.

That distinction matters: GoTrue inserts the `auth.users` row as soon as someone
asks for a code, before the number is proven. Provisioning then would let anyone
claim a phone number they do not own simply by requesting an OTP for it.

Doing it in a trigger rather than in application code means an account can never
exist without a profile: there is no window, and no code path that forgets.

Phone numbers are unique at **both** layers — `auth.users` and `public.users`
each carry a unique index.

## Capabilities

`my_capabilities()` is the single source of truth for what the signed-in account
may do. Roles are **derived from the database on every request**, never read
from a client-supplied claim.

The browser is told what it may do so the UI renders correctly. It is not
believed: every RPC and RLS policy re-derives the same facts independently, so a
tampered client changes nothing but its own display.

```json
{
  "authenticated": true,
  "user_id": "…",
  "phone": "+233…",
  "full_name": "…",
  "is_admin": false,
  "is_suspended": false,
  "can_order": true,
  "partner_status": "APPROVED",
  "is_partner": true,
  "partner_available": true,
  "vendor_ids": []
}
```

Ordering is deliberately low-friction: a confirmed phone is enough. No ID
upload, no selfie, no manual approval. Partner capability requires all of that
plus an admin decision.

Users hold no `UPDATE` grant on `public.users`, so even a name change goes
through `update_my_profile()`. `is_admin` and `is_suspended` are therefore
unreachable from a client: there is no statement that touches them.

## Where a sign-in lands

One form serves four kinds of person, so the destination is derived rather than
chosen: `lib/auth/landing.js` reads `my_capabilities()` and returns

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| admin             | `/admin`                                                 |
| vendor staff      | `/vendor`                                                |
| approved Partner  | `/partner`                                               |
| Partner applicant | `/partner/apply` — their own status, not the admin queue |
| everyone else     | `/order`                                                 |
| suspended         | `/suspended`, whatever else is true                      |

Precedence, not preference: an admin who also staffs a stall lands on `/admin`
because that is the job they signed in to do, and can still walk to `/vendor`.

A guard that redirected somebody to sign in supplies a `next`, and that wins —
they were already going somewhere specific. `next` is only ever honoured as a
path on this application; an absolute or protocol-relative URL is discarded,
because a sign-in that follows a caller-supplied URL is an open redirect, and a
convincing one: the victim really did just authenticate.

None of this is a security control. Every one of those routes re-checks on
arrival, and the data underneath is filtered by RLS regardless — the derivation
decides where somebody _useful_ lands, never what they may do.

## Guards

`lib/auth/session.js` provides `requireUser`, `requireAdmin`, `requirePartner`
and `requireVendorStaff`. These stop a page forgetting to check — they are
**not** the security boundary. A user who bypassed one would reach a page
rendering nothing they are entitled to, because every query underneath still
filters by `auth.uid()`.

## Terms acceptance

`terms_acceptances` records which version of which document an account agreed
to, and when. The documents themselves are reference data installed by migration
and present in every environment, because a gate that silently opens — an empty
`terms_documents` table, nothing to accept, everything appearing to work — is
worse than no gate.

The text is still a placeholder and is not legal advice. See
[`PILOT-QUESTIONS.md`](./PILOT-QUESTIONS.md). Publishing real terms is an INSERT
of version 2, never an edit of version 1: an acceptance points at the exact row
the person agreed to.
