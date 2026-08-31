# Authentication

Phone OTP, for everyone. One account per person; Customer and Partner are
capabilities on that same account, never separate logins.

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
and an admin decision, and arrives in Phase 8.

Users hold no `UPDATE` grant on `public.users`, so even a name change goes
through `update_my_profile()`. `is_admin` and `is_suspended` are therefore
unreachable from a client: there is no statement that touches them.

## Guards

`lib/auth/session.js` provides `requireUser`, `requireAdmin`, `requirePartner`
and `requireVendorStaff`. These stop a page forgetting to check — they are
**not** the security boundary. A user who bypassed one would reach a page
rendering nothing they are entitled to, because every query underneath still
filters by `auth.uid()`.

## Not built yet

**Terms acceptance.** `terms_acceptances` — recording which version a user
agreed to, and when — is not implemented. Registration is where it belongs, but
it was outside the scope set for this phase and needs the actual terms text and
a versioning decision first.
