# Hosted Supabase

Local development runs against Supabase's Docker stack. This is how the same
application runs against a real hosted project — with real persistence, real
Auth, and a database you can hand to somebody else.

Everything below is the **development** configuration of a hosted project:
still the fake payment adapter, still the fake SMS adapter. Nothing here
connects Paystack or Arkesel.

## What changes, and what does not

|                    | Local stack             | Hosted project                  |
| ------------------ | ----------------------- | ------------------------------- |
| Database           | recreated by `db:reset` | persistent                      |
| Schema applied by  | `supabase/migrations/`  | `supabase/schema.sql`           |
| Reference data     | migrations + `seed.sql` | migrations' reference data only |
| Development actors | seeded                  | **none — you create them**      |
| Phone OTP delivery | HTTPS Send SMS Hook     | Postgres Send SMS Hook          |
| Admin account      | seeded (`0200000001`)   | `npm run admin:create`          |
| Payments           | fake                    | fake                            |

The application code is identical. Only environment variables and the Supabase
project's own Auth settings differ.

---

## 1. Environment

Take the values from the dashboard, Project Settings → API Keys, into
`.env.local`:

```bash
# The ORIGIN. Not the REST endpoint — the client libraries append /rest/v1,
# /auth/v1 and /storage/v1 themselves.
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
SUPABASE_SERVICE_ROLE_KEY=…

SMS_PROVIDER=fake
PAYMENT_PROVIDER=fake
```

Pasting `…supabase.co/rest/v1/` in the URL is the most common mistake and the
most annoying to diagnose, because every request fails from a URL that looks
right. `lib/config.js` trims a trailing `/rest/v1` defensively, but set it
correctly anyway.

The service-role key **bypasses Row Level Security completely**. It is read
only through `config.supabaseServiceRoleKey()`, which throws if it is ever
touched in browser code, and `lib/supabase/admin.js` is marked `server-only` so
importing it into a client component fails the build. Never give it a
`NEXT_PUBLIC_` prefix.

Optionally add the database connection string too, from the dashboard's
**Connect** → **Session pooler**. Only the maintenance scripts use it; the
application never does, and it is not required to run Campus Dash. It contains
the database password, so treat it exactly like the service-role key:

```bash
SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-…pooler.supabase.com:5432/postgres
```

`.env.local` is gitignored. Nothing in this repository ever reads a credential
outside `lib/config.js` and the scripts named below.

## 2. Enable pg_cron

Dashboard → Database → Extensions → enable **pg_cron**.

Three sweeps depend on it: expiring orders a vendor never answered, giving up on
a Partner search, and clearing payments the provider never confirmed. They run
inside the database on purpose — there is no HTTP call to miss and no deploy
that silently drops the schedule. Without pg_cron the schema installs but
nothing expires, and an ignored order sits SUBMITTED for ever.

## 3. Install the schema

`supabase/schema.sql` is the canonical, from-empty state of the database — see
[`DATABASE.md`](./DATABASE.md) for what it is and why it is not the migrations
concatenated. Any one of these applies it:

```bash
# a. psql, if you have it. The credential never leaves your shell.
psql "postgresql://postgres.<ref>:<password>@aws-…pooler.supabase.com:5432/postgres" \
     -v ON_ERROR_STOP=1 -f supabase/schema.sql

# b. the script, which does the same thing with node-postgres
SUPABASE_DB_URL=… npm run db:install

# c. the dashboard SQL editor — paste the file and run it
```

Whichever route, it is **one statement batch and therefore one transaction**:
either the whole schema installs or nothing does. A half-installed schema is the
outcome worth ruling out, because the missing half is usually the grants.

Order matters inside the file and is the reason it must be run whole rather than
in pieces: the `ALTER DEFAULT PRIVILEGES … REVOKE` statements run **before the
first CREATE**, so no table or function ever exists in the state where Supabase's
own default ACLs would have made it reachable by `anon`.

It ends with assertions that check its own work — RLS on every table, no client
DML, deny-by-default privileges — and raises rather than reporting success if any
of them fail. On success it prints:

```
NOTICE: Campus Dash schema installed: RLS on every table, no client DML, deny-by-default.
```

## 3a. Verify it, from outside

```bash
npm run verify:hosted
```

This needs no database password. It talks to the project over HTTPS with the two
API keys and checks what actually matters: that every table and core function
exists, that the reference data is right (10% service fee, GH₵5 delivery, terms
published for all three audiences), and — the part worth having — that a request
sent **with the publishable key, exactly as a browser would send it** is refused
where it must be. It does not read a grant and believe it; it issues the INSERT,
the SELECT on `order_secrets`, the call to `confirm_payment()`, and asserts the
refusal.

For a full structural comparison, if you have the connection string:

```bash
npm run db:snapshot > /tmp/hosted.json                       # with SUPABASE_DB_URL set
SUPABASE_DB_URL= npm run db:snapshot > /tmp/local.json       # the local stack
diff /tmp/local.json /tmp/hosted.json
```

That covers tables, columns, enums, constraints, indexes, triggers, RLS,
policies, functions, grants, default privileges, cron jobs, storage buckets and
reference data. The only expected difference is `reference_pricing_config`,
because the local seed widens the timeout windows for manual testing.

## 4. Turn on phone sign-in

Dashboard → Authentication → Sign In / Providers → **Phone** → enable.

A new project has phone auth off. Until it is on, every phone sign-in fails at
the first step with:

```json
{ "code": 400, "error_code": "phone_provider_disabled", "msg": "Unsupported phone provider" }
```

Confirm the current state with:

```bash
curl -s https://<project-ref>.supabase.co/auth/v1/settings \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" | grep -o '"phone":[a-z]*'
```

### The dashboard will ask for an SMS provider. Give it a placeholder.

This is the confusing part, and it is not a reason to go and get a Twilio
account.

GoTrue gates phone login behind `GOTRUE_EXTERNAL_PHONE_ENABLED`, and it refuses
to set that flag unless an SMS **provider block** is configured. Having a Send
SMS Hook is not enough for the config validator, even though the hook is what
actually delivers. So the provider fields have to be non-empty, and their
contents are never used.

This is exactly what `supabase/config.toml` already does locally, and has done
since phone auth was built — see the comment on `[auth.sms.twilio]` there, and
`docs/AUTH.md`. Select Twilio, type anything into the three fields (for example
`unused-hook-handles-delivery` for the SID and token and `+10000000000` for the
number), and save. **No Twilio account is created, no credential is real, and
GoTrue never contacts them** — once the Send SMS Hook in step 5 is enabled, it
takes delivery and the provider is bypassed entirely.

Verify that claim rather than trusting it: request a code, and confirm it
appears at `/dev/inbox`. If it arrives, delivery went through our own
`SmsProvider` seam. When Arkesel is added later it becomes one new file under
`lib/sms` plus a case in the factory, and this placeholder is deleted.

Also set Authentication → URL Configuration → **Site URL** to
`http://localhost:3000` while developing.

## 5. Deliver the OTP

Supabase Auth generates and validates the code. We only deliver it — which is
what routes phone OTP through the same `SmsProvider` seam as every order
notification. See [`AUTH.md`](./AUTH.md).

Locally the hook is our HTTPS route, reachable from the Supabase containers at
`host.docker.internal`. **A hosted project cannot reach `localhost:3000`**, so
during hosted development the hook is a Postgres function instead:

1. Paste `supabase/dev/sms-hook.sql` into the SQL editor and run it.
2. Authentication → Hooks → **Send SMS Hook** → enable → Postgres function →
   `dev_send_sms_hook` (URI `pg-functions://postgres/public/dev_send_sms_hook`).

Codes then appear at **http://localhost:3000/dev/inbox**.

That file is **development only and must never be installed in production**. It
is deliberately not a migration and not part of `schema.sql`, so production
simply never has it — a stronger guarantee than any flag someone could forget.
Its own defences: the table has RLS enabled with no policies and no client
grants, so no browser query can reach it; every write prunes to the newest 25
messages and fifteen minutes; and `/dev/inbox` returns 404 in a production build
or with any non-fake provider. `tests/dev-sms-hook.test.js` asserts all of it,
including that the file has not leaked into the canonical schema.

For production, the hook goes back to the HTTPS route at your deployed origin,
with `SEND_SMS_HOOK_SECRET` set in the dashboard — the route already verifies
the Standard Webhooks HMAC on the raw bytes and is unchanged.

## 6. Create the first administrator

```bash
npm run admin:create
```

It asks for an email address, a phone number, a name and a password (hidden,
confirmed, minimum twelve characters), then creates the Supabase Auth user and
sets `is_admin` on the profile.

There is no in-app path to the first administrator, by design: `is_admin` is a
column on `public.users`, `authenticated` holds SELECT and nothing else on that
table, and every admin function re-checks `is_admin()` in its own body. Making
one requires the service-role key, which only ever exists on a server.

The password is never a command-line argument (that would put it in shell
history and the process table), is never echoed, and is never written anywhere
in this repository. For non-interactive use, `CAMPUS_DASH_ADMIN_PASSWORD` is
read from the environment instead.

The account gets a phone number as well as a password because `public.users` is
provisioned by a trigger on phone confirmation and its `phone` column is unique
and NOT NULL — one account per person. The phone is the identity; the password
is the credential. Sign in at **`/login/admin`**.

That first promotion is not written to `admin_actions`, and that is deliberate:
there is no administrator yet to attribute it to. Everything the account does
afterwards is audited normally.

## 7. Fill the campus

A hosted project has no seed. `supabase/seed.sql` is local-only — its people,
vendors, menus and locations are fictional development data and do not belong in
a real database.

So, signed in at `/admin`:

1. **Locations** — `/admin/locations`. Build the real Academic City tree:
   campus → block → floor → room. Only rows marked deliverable can be chosen as
   a destination. Add the places you actually deliver to; do not invent a
   plausible-looking campus.
2. **Vendors** — `/admin/vendors`. Create the vendor, set its location and walk
   time, then add its menu items.
3. **Vendor staff** — the person must **sign in once at `/login` by phone
   first**, so an account exists; then add them by phone under the vendor.
   `admin_add_vendor_user` refuses an unknown number rather than inventing an
   account.
4. **Partners** — they apply at `/partner/apply` with a student ID photograph
   and a live selfie, and you approve them at `/admin/partners`.

## 8. Check the wiring

```bash
npm run dev
curl -s http://localhost:3000/api/health
```

`ready: true` means the environment is complete and Supabase answered. The
`project` field echoes the origin, which is the quickest way to confirm which
database you are actually talking to.

---

## Tests still run locally

`npm test` connects straight to Postgres on `127.0.0.1:54322` as `authenticator`,
because the point of the suite is to exercise grants and RLS the way PostgREST
does. It does not use `NEXT_PUBLIC_SUPABASE_URL`, so pointing the app at a
hosted project does not move the tests — keep the local stack up for them
(`npm run db:start`).

The two tests in `auth-e2e` that drive Supabase Auth and then read `auth.users`
skip themselves when `NEXT_PUBLIC_SUPABASE_URL` is not the local stack, since
those would otherwise be looking in a different database.

## When something is wrong

**`ready: false` from `/api/health`** — a variable is missing. The response says
which, without echoing any value.

**Sign-in fails with nothing useful** — phone provider still disabled (step 4),
or the Send SMS Hook is not configured (step 5).

**No code at `/dev/inbox`** — the hook is not pointed at `dev_send_sms_hook`, or
`supabase/dev/sms-hook.sql` was never run. Confirm the row landed:
`select phone, created_at from public.dev_sms_outbox order by id desc limit 5;`

**Orders never expire** — pg_cron is not enabled. Check `/admin/pilot`, which
shows each job's last run and last error.

**`permission denied` where the local stack was fine** — the default-privilege
revokes did not run before the objects were created. Reinstall from
`schema.sql`, which orders them correctly, rather than granting by hand.
