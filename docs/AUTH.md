# Authentication

**Three sign-ins, three proofs, one identity table.**

| Who      | Proves                             | Where           | Phone number                          |
| -------- | ---------------------------------- | --------------- | ------------------------------------- |
| CUSTOMER | a verified `@acity.edu.gh` address | `/login`        | a profile field, collected at sign-up |
| VENDOR   | a phone number, by SMS code        | `/login/vendor` | **is** the credential                 |
| ADMIN    | an email address and a password    | `/login/admin`  | **none at all**                       |

They are separate because the PROOF is separate, not because the people are.
The same `auth.users.id` may hold all three capabilities, and which door
somebody came through has no bearing on what they may then do — that is derived
from the database on every request by `my_capabilities()`.

## Why each door is the way it is

**A customer proves a school address.** Campus Dash is for Academic City
students, and the university already issues every student an identity we can
verify for free. Asking for a phone code instead would prove somebody owns a
SIM, which is not the fact we need. It also means the ID photograph that used to
be part of signing up is gone: no reviewer ever looked at one for an ordinary
customer, so collecting it was cost without a control.

**A vendor proves a phone number.** A stall owner has a number. They may well
not have a school address, and asking for one would exclude exactly the
businesses the pilot exists to sign up. They are never asked for an email, at
sign-up or afterwards.

**An administrator has no phone number at all.** Not "does not sign in with
one" — `users.phone` is NULL on the row. Operational access must not depend on
an SMS arriving, least of all when messaging is the thing that has broken, and
the person who has to intervene at 11pm when an order is stuck should not be
locked out by a delivery failure in the channel they are trying to fix. If a
support number exists anywhere in the product it is configuration, not a
credential.

`/admin` is not linked from any public page. That is not the security control —
`is_admin()` inside every `admin_*` function is — but there is no reason to put
the door on the map.

## Six digits, and where that is actually decided

Every Campus Dash verification code is **six digits** — the email code and the
SMS code alike. `isOtpShape()` accepts exactly six, the inputs accept exactly
six, and `app/otp-input.js` is the single component all four screens use.

**The length is a PROJECT setting, not a code setting.** `supabase/config.toml`
carries `otp_length = 6` under both `[auth.email]` and `[auth.sms]`, which
governs the local stack. A hosted project has its own, under Authentication →
Providers → Email (and SMS), and it is set independently of anything in this
repository. A project set to eight sends eight-digit codes into a six-digit box
and every sign-in fails — which is exactly what happened, and it went unnoticed
for a while because the shape check used to tolerate four to eight "in case the
setting changed". It no longer does, on purpose: a mismatch should fail loudly
on the first attempt rather than quietly for weeks.

**NOT the handoff codes.** Those are FOUR digits, they are generated and checked
by Campus Dash rather than Supabase, and hard rule 11 is about them. Nothing
here touches them.

## Who verifies what

Supabase Auth generates and validates every code. **We never generate, store or
check one ourselves** — that whole surface stays in one audited place.

What we own is _delivery_. For SMS, Supabase calls our **Send SMS Hook** with
the message and we hand it to the `SmsProvider` abstraction, so the same seam
that carries order notifications carries the login code. For email, Supabase
sends it directly over SMTP; what we own there is the TEMPLATE.

### The customer email OTP

A numeric code, typed into the tab that is already open. **No magic link, no
`emailRedirectTo`, and no callback route** — a link opens in whichever browser
the mail app picks, which on a phone is routinely not the one holding the
half-filled sign-up form.

```
signInWithOtp({ email, options: { shouldCreateUser } })
        │                              true on /signup, false on /login
        ▼
  Supabase Auth generates the code and sends ONE OF TWO TEMPLATES
        │
        ├── first time for this address  ──▶  Confirm signup
        └── every time after that        ──▶  Magic Link
        │
        ▼
verifyOtp({ email, token, type: 'email' })
        │
        ▼
session cookies ──▶ complete_customer_onboarding() grants CUSTOMER
```

**TWO TEMPLATES, ONE CODE, AND BOTH NEED `{{ .Token }}`.** This is the part that
breaks silently. Supabase sends Confirm signup when `signInWithOtp()` creates an
address and Magic Link on every sign-in afterwards; wiring only the second means
sign-IN works perfectly and first-time sign-UP is dead, which is the half nobody
notices until a real student tries it.

| Template       | When          | File                                     | `config.toml`                        |
| -------------- | ------------- | ---------------------------------------- | ------------------------------------ |
| Confirm signup | first time    | `supabase/templates/confirm-signup.html` | `[auth.email.template.confirmation]` |
| Magic Link     | every sign-in | `supabase/templates/magic-link.html`     | `[auth.email.template.magic_link]`   |

**A hosted project needs the same content pasted into both**, under
Authentication → Email Templates. Nothing in Campus Dash generates or checks a
code, so the templates are the whole integration.

`enable_confirmations = true` is what decides which template a new address gets.
With it off, `signInWithOtp()` marks the address confirmed the moment it creates
it — before anybody has proved they can read that mailbox — and sends Magic
Link. Campus Dash wants the opposite: the school address IS the proof of being a
student, so it must not count as verified until a code has been read out of it.
`tests/customer-otp-e2e.test.js` asserts that `email_confirmed_at` is null
before verification and set after it.

Locally the mail lands in Mailpit at <http://127.0.0.1:54324>.

### Sending it again

Both screens offer a new code behind a 45-second cooldown. The cooldown is a
courtesy, not the limit: **issuing a code invalidates the previous one**, so
without it somebody eagerly pressing resend kills the code they are halfway
through typing. Supabase's own rate limit is the real defence, and its 429 is
surfaced as "Too many codes requested" rather than swallowed.

### When verification succeeds and the account still cannot be created

A student ID that is already registered is the case that matters. By then the
code is spent and the session is real, so showing the code box again would ask
for a code that cannot exist.

`finishSignUpAction` therefore returns a third step, `complete`, which keeps the
session and asks only for the details. `completeSignUpAction` re-checks
`getUser()` before trying again — a session is not a capability, and
`complete_customer_onboarding()` writes against `auth.uid()` regardless.

The uniqueness rules themselves are indexes, not checks in JavaScript:
`users_email_unique`, `users_phone_key` and
`customer_profiles_student_id_unique`. Each raises a sentence that
`lib/errors.js` maps back to the field that broke, because "something went wrong
on our side" is useless to somebody whose student ID is already taken.

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

### The vendor door is for accounts that exist

`/login/vendor` asks `vendor_phone_sign_in_status()` **before** it sends
anything, and that function answers about `auth.users` — the table GoTrue itself
resolves a phone OTP against. It returns one word and nothing else: no name, no
store, no account id.

| Answer          | Means                                                                      | The screen                                                   |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `VENDOR`        | a confirmed phone identity that owns a store                               | send the code                                                |
| `EMAIL_ACCOUNT` | a store owner carries this number, but a code would not reach that account | sign in with your school email and open the store from there |
| `NONE`          | nothing                                                                    | register your store first                                    |

**It used to read `public.users.phone`, and that was a real bug.** A phone
number lives in two places — `auth.users`, where it is a credential, and
`public.users`, where it is a profile field — and they genuinely disagree after
a phone collision. `handle_new_auth_user_for()` provisions a second identity
_without_ a number somebody else already holds, deliberately, because a contact
detail another identity carries is not this one's to take. So the database ends
up correct and still misleading:

```
auth.users     the number is CONFIRMED on a second, empty identity
public.users   the number is on the store owner's row
```

The old check asked the profile and said yes. GoTrue asked auth and signed in
the empty identity. A store owner with a working account, a working store and a
correct code landed on the sign-up screen — and the screen was not lying: that
session really did own nothing. Hiding the message would have hidden the only
true thing on it.

Two identities holding one number is still a mess, and it is an
**administrator's** mess to clean up with the facts in front of them. Nothing
here merges or deletes an identity to resolve it.

Enumeration is not worth guarding here: the customer sign-in screen already says
"no account uses that address", the alternative is a store owner waiting for an
SMS that is never coming, and anybody probing learns only whether a number they
already typed runs a shop on one campus.

**Registration is a different door and is untouched.** `/vendor/signup` verifies
a number in order to CREATE a store, which is precisely when a code should go to
a number with nothing behind it.

### Becoming a vendor always costs one code

A customer opening a store keeps the account they have — `PARTNER ⇒ CUSTOMER`
is a foreign key and a vendor is the same idea — and their name, their
affiliation and their phone are read off the profile rather than asked again.

But the number is **always** verified, including when they leave it exactly as
it was. A customer's profile phone was typed at sign-up and never proven, and
it is about to become how a store signs in; a credential resting on an
unverified field is not a credential.

Two requests serve one screen, and which one was made rides back with the code
so verification cannot guess wrong:

- a number being moved onto this identity is a **`phone_change`** —
  `updateUser({ phone })`, which writes it onto the account they already have
  rather than minting a second one;
- a number already confirmed on this identity is an ordinary **`sms`** sign-in
  code, because GoTrue sends nothing for a "change" to the number it is already
  on.

Once confirmed, `sync_my_verified_phone()` copies it onto the profile, so the
number a Partner rings and the number the store signs in with are one number.

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

There is no admin registration page. The first administrator is created
out-of-band with `npm run admin:create`, which needs the service-role key and
therefore a server — see [`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md). The
account is created from a confirmed email address alone: `public.users` is
provisioned on EITHER confirmation, so no phone number is asked for and none is
attached.

### The admin session is operational, not persistent

Customer and vendor sessions persist: `@supabase/ssr` writes the auth cookie with
a 400-day Max-Age and the proxy renews it on every request. The console is the
opposite case, and `lib/auth/admin-session.js` holds both limits:

- **Session-only cookies.** `adminSignIn` creates its client with
  `{ sessionOnly: true }` and sets the `cd-admin-session` marker (httpOnly, the
  administrator's user id). While the marker names the signed-in user,
  `lib/supabase/server.js` and `lib/supabase/middleware.js` write the auth
  cookies with no Max-Age. `@supabase/ssr` forces Max-Age whatever options it is
  given, so this has to happen in our own `setAll`. A marker that names somebody
  else is deleted by the proxy and that session gets its persistent cookie back.
  The marker is never read as authority; forging it only shortens your own
  cookie.
- **Eight hours, server-side.** `requireAdmin()` and every action in
  `app/admin/actions.js` (through `authoriseAdminAction()`) read the verified JWT
  with `getClaims()` and require an `amr` entry with method `password` no older
  than `ADMIN_SESSION_MAX_SECONDS`. That timestamp is the original sign-in and
  survives refresh, so activity does not extend it. It is a code constant, not a
  `pricing_config` value.

The second limit is the boundary. Browsers that restore tabs keep session-only
cookies alive, and an administrator who also holds the Customer capability can
sign in by emailed code: that session's method is `otp`, so it reaches the rest
of the app and is sent back to `/login/admin?reason=password` from the console.
Sign-out is global and also deletes the marker.

Admin server actions are public POST endpoints. Settlement and payout retries use
the service-role client, which bypasses `is_admin()`, so the action guard is the
check there, not a duplicate of one. `tests/admin-action-auth.test.js` fails if
an export is added without it.

### Forgetting the password

Administrators are the one account with a password, so they are the only one
that can be locked out of a credential rather than a channel. There are two
ways back in, and they are for different situations.

**The everyday one — `/login/admin` → "Forgot your password?"**

| Step                   | What happens                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `/login/admin/forgot`  | The address is checked against `is_admin` FIRST. Only an administrator is emailed anything.      |
| the email              | A link, not a code — see `supabase/templates/reset-password.html` for why this one is different. |
| `/login/admin/recover` | Spends the token and establishes the session — in a SERVER ACTION, see below.                    |
| `/login/admin/reset`   | The new password. `is_admin` is re-checked here and again in the action.                         |
| back to `/login/admin` | The recovery session is SIGNED OUT. The new password still has to be proved.                     |

Four things keep it from being a way in:

1. **A link is only ever sent to an administrator.** The address is checked
   against `public.users.is_admin` with the service-role client before Supabase
   is asked for anything, so a customer or a vendor can never be handed a
   password — a credential their account is not supposed to have at all.
2. **The answer is the same either way.** One sentence whether a link was sent
   or not, for the same reason `adminSignIn` returns one message for every
   failure: telling them apart would confirm which addresses are administrators.
3. **The recovery session is spent on the password and thrown away.** Following
   a link never lands anybody in the console.
4. **`is_admin` is re-derived from the database at every step** — never carried
   in the link or trusted from the session.

Supabase Auth issues and validates the recovery token. We never generate, store
or check one, which keeps that surface in the same audited place as every other
code.

#### Why the recovery page is shaped the way it is

Three things about it look over-engineered and are each load-bearing. All three
were bugs first, and every one of them presented identically: the link bounced
straight back to "enter your email".

**The token is spent in a Server Action, not in the page.** Cookies are
READ-ONLY in a Server Component, and `lib/supabase/server.js` swallows the write
(it has to — the same client renders pages). So a page that verified the token
succeeded, wrote no session, and redirected to a password form that then found
nobody signed in. The token was burnt for nothing.

**It handles three link shapes,** because which one arrives depends on the
project's email template and flow setting:

| Shape                             | Where it comes from                      | Spent by                               |
| --------------------------------- | ---------------------------------------- | -------------------------------------- |
| `?token_hash=…&type=recovery`     | `supabase/templates/reset-password.html` | `verifyOtp` on a plain client          |
| `#access_token=…&refresh_token=…` | Supabase's DEFAULT template              | read in the browser, set by the action |
| `?code=…`                         | the PKCE exchange                        | `exchangeCodeForSession`               |

A FRAGMENT NEVER REACHES A SERVER — the browser strips it before the request —
so that shape has to be read by client JavaScript and handed back. This is why
the entry point is a page with a small client component rather than a route
handler, and it is what makes the flow work on a project whose Reset Password
template has not been customised.

**The request is made on a non-PKCE client.** `@supabase/ssr` runs PKCE, which
makes Supabase issue a `pkce_` token redeemable only in the browser that ASKED
for it — and a reset email is, more often than not, opened on a phone. Asking on
a plain client produces a token any browser can redeem.

**The exchange runs exactly once per visit,** guarded by a ref. A recovery token
is single-use and React StrictMode runs effects twice in development, so the
first call spent the token and the second was told it had expired — a working
link reporting itself broken. For the same reason the effect has no `cancelled`
flag: StrictMode's cleanup would set it before the answer came back, and the
navigation would be dropped with a good session already in hand.

**The locked-out-of-everything one — `npm run admin:password`**

Sets a password on an existing administrator from a terminal with the
service-role key, and does nothing else: it cannot create an account, cannot
promote one, and refuses outright if the address is not already an
administrator. It is the answer when the mailbox itself is unreachable, and the
way the first administrator's password is set. It is not the everyday path.

**Two pieces of project configuration this depends on**, both of which fail
quietly if they are wrong:

- **Redirect URLs** must include this deployment's origin. GoTrue silently
  DISCARDS a `redirectTo` that is not on the list and falls back to `site_url`,
  which lands the recipient on the home page with a spent token.
- **Site URL** must match `PUBLIC_APP_URL`. The session cookie the link sets
  belongs to whichever origin served it, so a mismatch writes it on one origin
  and reads it on another, and a perfectly good link reports itself expired.

Locally both live in `supabase/config.toml`. On a hosted project they are under
Authentication → URL Configuration, and the Reset Password template goes under
Authentication → Email Templates.

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
  "first_name": "…",
  "last_name": "…",
  "email": "…",
  "is_admin": false,
  "is_suspended": false,
  "is_customer": true,
  "can_order": true,
  "customer_status": "ONBOARDED",
  "affiliation": "STUDENT",
  "graduation_year": 2028,
  "gender": "FEMALE",
  "student_id_number": "…",
  "level": null,
  "partner_status": "APPROVED",
  "is_partner": true,
  "partner_available": true,
  "vendor_ids": []
}
```

Each field answers a different question, and none implies another:

| Field                       | True when                                           |
| --------------------------- | --------------------------------------------------- |
| `authenticated`             | A contact detail has been confirmed. An IDENTITY.   |
| `can_order` / `is_customer` | A `customer_profiles` row exists                    |
| `is_partner`                | An APPROVED `partner_profiles` row exists           |
| `vendor_ids`                | ACTIVE stores this account owns — never inferred    |
| `vendor_status`             | Where a store application stands, for a pending one |
| `is_admin`                  | `users.is_admin`                                    |

`vendor_ids` lists only OPERABLE stores. An application still under review
grants nothing and appears there as `[]`; `vendor_status` is what tells the
applicant why their dashboard is a status page.

`can_order` used to be `not is_suspended` — true for every account that existed,
which meant "admin does not imply customer" could not be expressed because there
was no Customer capability to withhold. It is now the capability itself, and an
administrator or vendor account that has not completed customer sign-up
genuinely cannot place an order. `submit_order_for()` asserts it server-side, so
this is not a display decision.

Users hold no write grant on `customer_profiles` either, so the only way to
acquire the capability is `complete_customer_onboarding()`.

Users hold no `UPDATE` grant on `public.users`, so even a name change goes
through `update_my_profile()`. `is_admin` and `is_suspended` are therefore
unreachable from a client: there is no statement that touches them.

## Where a sign-in lands

One form serves four kinds of person, so the destination is derived rather than
chosen: `lib/auth/landing.js` reads `my_capabilities()` and returns

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| admin             | `/admin`                                                 |
| vendor            | `/vendor`                                                |
| vendor applicant  | `/vendor/application` — where their application stands   |
| customer          | `/order`                                                 |
| approved Partner  | `/partner`                                               |
| Partner applicant | `/partner/apply` — their own status, not the admin queue |
| no capability yet | `/signup` — the one thing that unlocks the rest          |
| suspended         | `/suspended`, whatever else is true                      |

**Vendor before customer, and customer before Partner.** Somebody who runs a
stall AND orders lunch signs in, overwhelmingly, to run the stall: there is
money and a 60-second answer window on that side and neither on the other.
Partner comes last for the mirror reason — carrying a delivery is something you
go and look for, not something you are doing when you happen to open the app.
And since PARTNER ⇒ CUSTOMER, every Partner is also a customer, so a rule that
put Partner first would send every one of them somewhere they did not ask for.

Precedence, not **exclusivity**, and this is the single most misread thing in
the application. An admin who also runs a stall lands on `/admin` because that
is the job they signed in to do. They have lost nothing: `areasFor()` returns
every area the account holds and each layout renders it as an `AreaSwitcher`, so
the other capabilities are one click away rather than invisible. A multi-capability
account never has to sign out to switch.

Note that sign-up never outranks a capability the account already has. An
administrator with no student profile still lands on `/admin` — their account is
complete for what it does.

A guard that redirected somebody to sign in supplies a `next`, and that wins —
they were already going somewhere specific. `next` is only ever honoured as a
path on this application; an absolute or protocol-relative URL is discarded,
because a sign-in that follows a caller-supplied URL is an open redirect, and a
convincing one: the victim really did just authenticate.

None of this is a security control. Every one of those routes re-checks on
arrival, and the data underneath is filtered by RLS regardless — the derivation
decides where somebody _useful_ lands, never what they may do.

## Guards

`lib/auth/session.js` provides `requireUser`, `requireCustomer`, `requireAdmin`,
`requirePartner` and `requireVendorStaff`. These stop a page forgetting to check
— they are **not** the security boundary.

`requireAdmin` is the one guard that does not go through `requireUser`. Everyone
else who is signed out is sent to `/login`, the customer screen, which asks for
an `@acity.edu.gh` address and emails a code; an administrator's credential is a
password and the row may hold no school address at all, so that door offered a
proof they could not give. It redirects to `/login/admin` instead, carrying the
destination in `next`.

`requireCustomer` is one of two that do not simply bounce to `landingFor()`: it
sends people to `/signup`, because "you wanted to order something" is answered
by acquiring the capability, not by being returned to `/admin`. The other is
`requireVendorStaff`, which sends an applicant to `/vendor/application` — for a
rejected store that page is the only place the reason exists.

A user who bypassed either would reach a page rendering nothing they are
entitled to, because every query underneath still filters by `auth.uid()`.

### Vendor-only accounts do not see customer screens

A vendor who does not hold the Customer capability is sent to their store from
`/`, `/order` and `/order/[vendorId]`, and from `/account`. The rule is
`vendorOnlyHome()` in `lib/auth/landing.js`, applied by
`redirectVendorOnlyAccount()`. "Student vendor" means `can_order`, not
`vendors.owner_is_student`, which is self-declared and confers nothing. A student
vendor browses the marketplace like any customer and reaches the store through
the account navigation. Sign-in routing is unchanged: `landingFor()` still sends
every vendor to `/vendor` first. The only destinations are `/vendor` and
`/vendor/application`, neither of which applies the rule, so it cannot loop.

## Terms acceptance

`terms_acceptances` records which version of which document an account agreed
to, and when. Customer terms are accepted **inside** the sign-up transaction,
so a customer who can order has always agreed to something; each audience is
asked only of accounts that hold the matching capability, so a vendor stall is
never asked to agree to terms about ordering lunch. The documents themselves are reference data installed by migration
and present in every environment, because a gate that silently opens — an empty
`terms_documents` table, nothing to accept, everything appearing to work — is
worse than no gate.

The text is still a placeholder and is not legal advice. See
[`PILOT-QUESTIONS.md`](./PILOT-QUESTIONS.md). Publishing real terms is an INSERT
of version 2, never an edit of version 1: an acceptance points at the exact row
the person agreed to.
