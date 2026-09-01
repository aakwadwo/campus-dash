# Local Setup

Clone to a working system in about five minutes, most of which is Docker
pulling Supabase images the first time.

For a **hosted** Supabase project — real persistence, no Docker, an admin
account you create yourself — see [`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md).
The application code is the same either way; only environment variables and the
project's own Auth settings differ.

## What you need

|        |                                           |
| ------ | ----------------------------------------- |
| Node   | 20.9+ (developed on 25.x)                 |
| Docker | running — Supabase's local stack needs it |
| npm    | 10+                                       |

The Supabase CLI is a dev dependency, so there is nothing to install globally
and every machine runs the same version.

## Steps

```bash
npm install

# Two secrets the Supabase CLI must resolve from `.env` specifically.
printf 'SEND_SMS_HOOK_SECRET=v1,whsec_%s\n' "$(openssl rand -base64 32)" > .env
echo 'SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN=unused-hook-handles-delivery' >> .env

npm run db:start        # first run pulls images; several minutes
```

`db:start` prints a `PUBLISHABLE_KEY` and a `SERVICE_ROLE_KEY`. Put them in
`.env.local`:

```bash
cp .env.example .env.local
# then paste the two keys in as
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
#   SUPABASE_SERVICE_ROLE_KEY
```

`NEXT_PUBLIC_SUPABASE_URL` is the project ORIGIN — `http://127.0.0.1:54321`
locally — not the REST endpoint. The client libraries append `/rest/v1`,
`/auth/v1` and `/storage/v1` themselves.

```bash
npm run dev             # http://127.0.0.1:3000
```

## Why two env files

The Supabase CLI reads only `.env` from the project root and has no
`--env-file` flag. Next.js reads both `.env` and `.env.local`. So anything
`supabase/config.toml` needs via `env()` has to be in `.env`; everything else
belongs in `.env.local`. Both are gitignored.

## Signing in

Customers, vendors and Partners sign in by phone; there are no passwords for
them. The fake SMS provider prints the OTP to the `npm run dev` console and to
http://localhost:3000/dev/inbox.

Seeded accounts (all fictional, all `+2332000000xx`):

| Phone        | Who                                                  |
| ------------ | ---------------------------------------------------- |
| `0200000001` | Admin (also reachable at `/login/admin` — see below) |
| `0200000011` | Vendor staff — Test Kitchen One                      |
| `0200000012` | Vendor staff — Test Grill Two                        |
| `0200000021` | Customer                                             |
| `0200000031` | Approved Partner                                     |
| `0200000033` | Partner applicant, awaiting review                   |

Type the local part (`0200000001`); it is normalised to E.164.

Administrators can also sign in with an email and password at `/login/admin`,
which is how a real deployment works — operational access should not depend on
an SMS arriving. The local seed has no password on the admin account; create one
with `npm run admin:create` if you want to exercise that path.

## Placing test orders

```bash
npm run seed:orders            # one delivery order
npm run seed:orders 3 PICKUP   # three pickup orders
```

It goes through the real submit path, so prices are snapshotted and fees are
server-calculated exactly as for a real customer.

## Everyday commands

```bash
npm run dev          # dev server
npm test             # the whole suite (needs the local stack up)
npm run lint
npm run build
npm run db:reset     # re-apply every migration + seed. Destroys local data.
npm run db:status    # URLs and keys
npm run db:schema    # regenerate supabase/schema.sql from the migrations
npm run db:snapshot  # print the full schema state, for comparison
npm run admin:create # create or promote an administrator
npm run verify:hosted # check a project over HTTPS, with the API keys only
```

Supabase Studio is at http://127.0.0.1:54323.

## Tests

`npm test` runs against the local database and shares it, so files run
serially. Client-facing tests connect as `authenticator` — the role PostgREST
itself uses — so RLS and grants are exercised exactly as a browser request hits
them.

A few tests need `npm run dev` running as well; they skip themselves with a
clear message when it is not.

## If something is wrong

**`supabase start` fails** — Docker is not running, or ports 54321–54324 are
taken by another project's stack.

**"Database error finding user" on sign-in** — the local stack drifted from the
migrations. `npm run db:reset`.

**No OTP appears** — check the `npm run dev` terminal or
http://localhost:3000/dev/inbox, not the browser you are signing in from.
Confirm `SMS_PROVIDER=fake` and that `.env` has `SEND_SMS_HOOK_SECRET`.

**Session dies after `db:reset`** — expected. The reset wipes `auth.sessions`;
sign in again.
