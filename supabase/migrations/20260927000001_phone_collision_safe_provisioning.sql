-- Provisioning must never turn a phone collision into an opaque GoTrue 500.
--
-- WHAT HAPPENED. A customer signs in by email and puts their phone on their
-- profile, so public.users.phone holds it while auth.users.phone is NULL. Vendor
-- sign-up then asked Supabase for a phone OTP, which created a SECOND auth
-- identity for the same number. Confirming it fired on_auth_user_confirmed →
-- handle_new_auth_user_for(), whose insert carried the same phone and hit
-- users_phone_key. `on conflict (id) do nothing` does not absorb a conflict on
-- PHONE, so 23505 escaped the trigger, aborted GoTrue's transaction, and came
-- back as `500 Error confirming user` — a message that names neither the
-- constraint nor the column.
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT.
--
-- It does NOT relax users_phone_key, and it does NOT move a phone number or an
-- address from one identity to another. A contact detail already carried by
-- somebody else is not this identity's to take, and silently reassigning it
-- would be an account takeover dressed up as a convenience.
--
-- What it does is provision the profile row WITHOUT the contested detail, and
-- say so in the log. The identity still exists, confirmation still succeeds, and
-- the application decides what to do about the collision with a sentence a
-- person can act on — which is exactly what a 500 could never do.
--
-- The application-level fix is the real cure: vendor sign-up no longer creates a
-- second identity for a number Campus Dash already knows. This is the floor
-- under it, so the same mistake can never again present as an auth outage.
create or replace function public.handle_new_auth_user_for("p_user_id" "uuid")
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user  auth.users%rowtype;
  v_phone text;
  v_email text;
  v_name  text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found then
    return;
  end if;

  -- Only a CONFIRMED contact detail provisions anything. GoTrue inserts the
  -- auth.users row when a code is first requested, before anything is proven.
  if v_user.phone_confirmed_at is null and v_user.email_confirmed_at is null then
    return;
  end if;

  -- GoTrue stores phone numbers without the leading '+'. Our E.164 check wants it.
  v_phone := nullif(v_user.phone, '');
  if v_phone is not null and left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;
  if v_user.phone_confirmed_at is null then
    v_phone := null;
  end if;

  v_email := case
               when v_user.email_confirmed_at is not null
               then lower(nullif(v_user.email, ''))
             end;
  v_name := nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), '');

  -- Already carried by ANOTHER identity, so not ours to take. Dropped from this
  -- insert rather than fought over, and reported so it is findable.
  if v_phone is not null and exists (
    select 1 from public.users u where u.phone = v_phone and u.id <> p_user_id
  ) then
    raise warning 'handle_new_auth_user_for: phone % already belongs to another identity; provisioning % without it', v_phone, p_user_id;
    v_phone := null;
  end if;

  if v_email is not null and exists (
    select 1 from public.users u where lower(u.email) = v_email and u.id <> p_user_id
  ) then
    raise warning 'handle_new_auth_user_for: email already belongs to another identity; provisioning % without it', p_user_id;
    v_email := null;
  end if;

  insert into public.users (id, phone, email, full_name)
  values (p_user_id, v_phone, v_email, v_name)
  on conflict (id) do nothing;

exception
  -- BELT AND BRACES. The checks above are not atomic against a concurrent
  -- insert, and a lost race must still not reach GoTrue as a 500. Provision the
  -- bare identity so confirmation completes; the contact details are the
  -- application's problem, not auth's.
  when unique_violation then
    raise warning 'handle_new_auth_user_for: lost a race on a contact detail for %; provisioning without phone or email (%)', p_user_id, sqlerrm;
    insert into public.users (id, full_name)
    values (p_user_id, v_name)
    on conflict (id) do nothing;
end;
$$;

comment on function public.handle_new_auth_user_for("uuid") is
  'Provisions public.users when a contact detail is CONFIRMED. A phone or address already held by another identity is DROPPED from the insert rather than contested — never reassigned, never allowed to raise. An escaping unique_violation here aborts GoTrue''s confirmation transaction and surfaces as an opaque 500 "Error confirming user".';

-- The INSERT-side twin, which carried the same defect for the same reason. It
-- now delegates rather than keeping a second copy of the rules: one place to
-- decide what a contested contact detail means, so the two cannot drift.
--
-- Reached when an account is created ALREADY confirmed — the admin bootstrap
-- does this — where an email collision would otherwise raise inside the insert
-- and take the whole creation with it.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.phone_confirmed_at is null and new.email_confirmed_at is null then
    return new;
  end if;

  perform public.handle_new_auth_user_for(new.id);
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Provisions public.users for an account created already confirmed. Delegates to handle_new_auth_user_for() so the handling of a contested phone or address lives in exactly one place.';
