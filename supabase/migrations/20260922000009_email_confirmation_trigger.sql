-- ============================================================================
-- The provisioning trigger has to watch BOTH proofs
-- ============================================================================
-- 20260922000001 taught handle_auth_user_phone_confirmed() to recognise an
-- email confirmation as well as a phone one. It did not change the TRIGGER,
-- which was declared:
--
--     AFTER UPDATE OF phone_confirmed_at ON auth.users
--
-- A column list on a trigger is not documentation — it is the firing condition.
-- GoTrue confirms an email address by updating `email_confirmed_at`, so the
-- trigger never fired, no public.users row was ever created, and every customer
-- sign-up died at "no profile for this account" one step after the code was
-- accepted.
--
-- Not caught by the suite, and worth saying why: every test fixture inserts an
-- auth user with the confirmation timestamp ALREADY SET, which fires the INSERT
-- trigger instead. The UPDATE path — the only one a real sign-in takes — had no
-- coverage at all. tests/auth.test.js now walks it.
--
-- The trigger is renamed to say what it actually watches.
-- ============================================================================

drop trigger if exists on_auth_user_phone_confirmed on auth.users;
drop trigger if exists on_auth_user_confirmed on auth.users;

create trigger on_auth_user_confirmed
  after update of phone_confirmed_at, email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user_phone_confirmed();

comment on function public.handle_auth_user_phone_confirmed() is
  'Provisions public.users when a contact detail is CONFIRMED — a phone for a '
  'vendor, an address for a customer. Named for the phone case it was written '
  'for; it has handled both since email sign-in arrived. Only confirmation '
  'provisions: GoTrue inserts the auth.users row when a code is first '
  'requested, and creating a profile then would let anyone claim an address or '
  'a number they do not own simply by asking for a code.';

-- Anything already stranded by the window in which the trigger was wrong. This
-- is a no-op on a database that never ran the broken version.
insert into public.users (id, phone, email, full_name)
select u.id,
       case when u.phone_confirmed_at is not null and nullif(u.phone, '') is not null
            then case when left(u.phone, 1) = '+' then u.phone else '+' || u.phone end end,
       case when u.email_confirmed_at is not null then lower(nullif(u.email, '')) end,
       nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
  from auth.users u
 where (u.phone_confirmed_at is not null or u.email_confirmed_at is not null)
   and not exists (select 1 from public.users p where p.id = u.id)
on conflict (id) do nothing;
