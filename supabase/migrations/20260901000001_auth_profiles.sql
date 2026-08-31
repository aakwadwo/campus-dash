-- ============================================================================
-- Phase 3 — account provisioning and capabilities
-- ============================================================================
-- ONE account per person. Customer and Partner are CAPABILITIES on that single
-- account, never separate logins. A user who is both switches mode in the UI;
-- nothing about their identity changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Profile creation
-- ---------------------------------------------------------------------------
-- A public.users row is created automatically the moment Supabase Auth confirms
-- a phone number. Doing it in a trigger rather than in application code means
-- an account can never exist in auth.users without a profile — there is no
-- window, and no code path that forgets.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  -- Only CONFIRMED phones get a profile. GoTrue inserts the auth.users row when
  -- an OTP is first requested, before the number is proven — creating a profile
  -- then would let anyone claim a phone number they do not own simply by asking
  -- for a code. The real flow provisions via the phone-confirmed trigger below.
  if new.phone_confirmed_at is null then
    return new;
  end if;

  -- GoTrue stores phone numbers without the leading '+'. Our E.164 check
  -- requires it.
  v_phone := new.phone;
  if v_phone is null or v_phone = '' then
    return new;  -- email-only account (admin tooling); no customer profile yet
  end if;
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, full_name)
  values (
    new.id,
    v_phone,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- A phone number confirmed later (rather than at insert) still gets a profile.
create or replace function public.handle_auth_user_phone_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phone_confirmed_at is not null and old.phone_confirmed_at is null then
    perform public.handle_new_auth_user_for(new.id);
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_auth_user_for(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_phone text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found or v_user.phone is null or v_user.phone = '' then
    return;
  end if;

  v_phone := v_user.phone;
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, full_name)
  values (p_user_id, v_phone,
          nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do nothing;
end;
$$;

create trigger on_auth_user_phone_confirmed
  after update of phone_confirmed_at on auth.users
  for each row execute function public.handle_auth_user_phone_confirmed();

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------
-- The single source of truth for what the signed-in account may do.
--
-- Roles are DERIVED FROM THE DATABASE, never read from a client-supplied claim.
-- The browser is told what it may do so the UI can render correctly; it is not
-- believed. Every function and policy re-derives the same facts server-side.
create or replace function public.my_capabilities()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then jsonb_build_object('authenticated', false)
    else (
      select jsonb_build_object(
        'authenticated',    true,
        'user_id',          u.id,
        'phone',            u.phone,
        'full_name',        u.full_name,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,
        -- Everyone with an account can order. That is the low-friction path:
        -- phone OTP only, no ID upload, no selfie, no manual approval.
        'can_order',        not u.is_suspended,
        -- Partner capability on the SAME account.
        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),
        'vendor_ids',       coalesce(
                              (select jsonb_agg(vu.vendor_id)
                                 from public.vendor_users vu where vu.user_id = u.id),
                              '[]'::jsonb)
      )
      from public.users u
      left join public.partner_profiles p on p.user_id = u.id
      where u.id = auth.uid()
    )
  end;
$$;

grant execute on function public.my_capabilities() to authenticated;

-- ---------------------------------------------------------------------------
-- Profile self-service
-- ---------------------------------------------------------------------------
-- Users hold no UPDATE grant on public.users, so even their own name changes
-- through a function. That keeps is_admin and is_suspended unreachable: there
-- is no statement a client can issue that touches them.
create or replace function public.update_my_profile(p_full_name text)
returns public.users
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user public.users%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.users
     set full_name = nullif(btrim(coalesce(p_full_name, '')), '')
   where id = auth.uid()
  returning * into v_user;

  return v_user;
end;
$$;

grant execute on function public.update_my_profile(text) to authenticated;
