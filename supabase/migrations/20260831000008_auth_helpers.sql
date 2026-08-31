-- ============================================================================
-- Authorisation helpers and code generation
-- ============================================================================
-- Every helper is SECURITY DEFINER with a pinned empty search_path. SECURITY
-- DEFINER also breaks the RLS recursion that would otherwise occur when a
-- policy on public.users needs to ask whether the caller is an admin.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users u
     where u.id = auth.uid() and u.is_admin and not u.is_suspended
  );
$$;

-- True for a trusted server-side context: the service-role key (route handlers,
-- webhook processing), a direct database connection (migrations, scheduled
-- jobs), or a signed-in admin.
--
-- NOTE ON current_user: it is useless here. Inside a SECURITY DEFINER function
-- current_user is the function OWNER (postgres) no matter who called, so a
-- current_user check would return true for every caller. The two signals that
-- survive a definer context are:
--   * request.jwt.claims -> role, which PostgREST sets per request and a client
--     cannot forge, and
--   * session_user, which SET ROLE does not change — PostgREST logs in as
--     'authenticator' for every web request, so session_user can never be
--     'postgres' for anything arriving over the API.
create or replace function public.is_service_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'role')
      = 'service_role'
    or session_user in ('postgres', 'supabase_admin')
    or public.is_admin();
$$;

create or replace function public.assert_service_or_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_service_or_admin() then
    raise exception 'this operation is server-side only'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create or replace function public.is_approved_partner(p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.partner_profiles p
      join public.users u on u.id = p.user_id
     where p.user_id = coalesce(p_user_id, auth.uid())
       and p.status = 'APPROVED'
       and not u.is_suspended
  );
$$;

-- Vendors the caller works for. Drives every vendor-scoped RLS policy.
create or replace function public.my_vendor_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select vu.vendor_id
    from public.vendor_users vu
    join public.users u on u.id = vu.user_id
   where vu.user_id = auth.uid() and not u.is_suspended;
$$;

create or replace function public.is_vendor_staff(p_vendor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.my_vendor_ids() v where v = p_vendor_id);
$$;

-- ---------------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------------
-- Digits only: these are read aloud across a noisy counter, so no ambiguous
-- letters. Generated from pgcrypto's CSPRNG, never random() — a guessable
-- pickup code hands someone else's food to the wrong Partner.
create or replace function public.generate_numeric_code(p_digits integer default 4)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bytes bytea := extensions.gen_random_bytes(4);
  v_num   bigint;
begin
  v_num := (get_byte(v_bytes, 0)::bigint << 24)
         | (get_byte(v_bytes, 1)::bigint << 16)
         | (get_byte(v_bytes, 2)::bigint << 8)
         |  get_byte(v_bytes, 3)::bigint;
  return lpad((v_num % power(10, p_digits)::bigint)::text, p_digits, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Transition logging
-- ---------------------------------------------------------------------------
-- Called for accepted AND rejected transitions. A rejected transition is
-- evidence: a lost race, a replayed request, or a client trying something it
-- should not be able to.
create or replace function public.log_order_event(
  p_order_id   uuid,
  p_event      text,
  p_accepted   boolean,
  p_actor_role text default 'SYSTEM',
  p_dimension  text default null,
  p_from       text default null,
  p_to         text default null,
  p_reason     text default null,
  p_details    jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.order_events (
    order_id, actor_id, actor_role, event, dimension,
    from_state, to_state, accepted, reason, details
  )
  values (
    p_order_id, auth.uid(), p_actor_role, p_event, p_dimension,
    p_from, p_to, p_accepted, p_reason, p_details
  );
$$;
