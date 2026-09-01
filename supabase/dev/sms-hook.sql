-- ============================================================================
-- DEVELOPMENT ONLY — Send SMS Hook for a hosted Supabase project
-- ============================================================================
--                *** NEVER INSTALL THIS IN PRODUCTION ***
--
-- This file is not a migration and is not part of supabase/schema.sql. It is
-- installed by hand, into a development project, and nowhere else. Production
-- simply never runs it, which is the strongest guarantee available that it
-- cannot work there — stronger than any flag someone could forget to set.
--
-- WHY IT EXISTS
-- -------------
-- Phone OTP delivery goes through our own SmsProvider abstraction: Supabase
-- Auth generates and validates the code, then calls a Send SMS Hook to have us
-- deliver it. Locally that hook is an HTTPS route
-- (app/api/auth/hooks/send-sms), reachable from the Supabase containers at
-- host.docker.internal — and that is the production design too.
--
-- A HOSTED project cannot reach http://localhost:3000. So during development
-- against hosted Supabase, the hook is a Postgres function instead: Supabase
-- calls it in-database, and it parks the message where /dev/inbox can read it.
-- No tunnel, no public URL, no third-party SMS account.
--
-- WHAT KEEPS THE PASSCODES CONTAINED
-- ----------------------------------
--   1. This file is never installed in production, so there is nothing to leak.
--   2. dev_sms_outbox has RLS enabled and NO policies, and no grants to `anon`
--      or `authenticated`. There is no query any browser can issue that reads
--      it — /dev/inbox reads it with the service-role key, server-side.
--   3. Nothing is retained. Every insert prunes to the newest 25 rows and drops
--      anything older than fifteen minutes, so a passcode outlives its own
--      validity window by nothing worth having.
--   4. /dev/inbox itself returns 404 in a production build and whenever
--      SMS_PROVIDER is not `fake` — see tests/dev-inbox.test.js.
--
-- INSTALL
--   Paste into the SQL editor of your DEVELOPMENT project, then set
--   Authentication → Hooks → Send SMS Hook to:
--
--       pg-functions://postgres/public/dev_send_sms_hook
--
-- UNINSTALL
--   drop function if exists public.dev_send_sms_hook(jsonb);
--   drop table if exists public.dev_sms_outbox;
-- ============================================================================

create table if not exists public.dev_sms_outbox (
  id         bigint generated always as identity primary key,
  phone      text        not null,
  message    text        not null,
  tag        text,
  created_at timestamptz not null default now()
);

comment on table public.dev_sms_outbox is
  'DEVELOPMENT ONLY. Holds recent fake SMS bodies, including phone OTPs, so /dev/inbox can show them. Auto-pruned. Never install in production.';

alter table public.dev_sms_outbox enable row level security;

-- No policies, on purpose: with RLS on and no policy, every client read is
-- denied. Only the service role (which bypasses RLS) can see these rows.
revoke all on table public.dev_sms_outbox from anon, authenticated;

create index if not exists dev_sms_outbox_created_at_idx
  on public.dev_sms_outbox (created_at desc);


-- ---------------------------------------------------------------------------
-- The hook itself
-- ---------------------------------------------------------------------------
-- Supabase Auth calls this with { "user": { "phone": … }, "sms": { "otp": … } }
-- and expects a jsonb result. Returning an "error" object makes GoTrue fail the
-- sign-in, which is the correct outcome when delivery did not happen: better a
-- clear failure than a user waiting for a message that is never coming.
create or replace function public.dev_send_sms_hook(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_phone text := event #>> '{user,phone}';
  v_otp   text := event #>> '{sms,otp}';
begin
  if v_phone is null or v_otp is null then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 400, 'message', 'missing phone or otp')
    );
  end if;

  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.dev_sms_outbox (phone, message, tag)
  values (
    v_phone,
    'Campus Dash: your verification code is ' || v_otp ||
    '. It expires shortly. Do not share it with anyone.',
    'AUTH_OTP'
  );

  -- Retain nothing. A passcode is useful for minutes and dangerous for longer.
  delete from public.dev_sms_outbox
   where created_at < now() - interval '15 minutes'
      or id <= (
        select id from public.dev_sms_outbox order by id desc offset 25 limit 1
      );

  return '{}'::jsonb;
end;
$$;

-- Callable by Supabase Auth and by nobody else. `authenticated` and `anon` are
-- revoked explicitly: revoking PUBLIC alone does not remove a grant made to a
-- named role, and Supabase's default ACLs name both.
revoke execute on function public.dev_send_sms_hook(jsonb) from public, anon, authenticated;
grant  execute on function public.dev_send_sms_hook(jsonb) to supabase_auth_admin;
