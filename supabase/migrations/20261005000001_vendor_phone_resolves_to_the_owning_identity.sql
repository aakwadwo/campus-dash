-- ---------------------------------------------------------------------------
-- THE VENDOR DOOR MUST ASK ABOUT THE IDENTITY THAT WILL ACTUALLY SIGN IN
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG IN PRODUCTION. A store owner signed in at /login/vendor with
-- the number their store trades on, the code arrived, the code was accepted —
-- and the application then behaved as though they had never signed up: no
-- store, no customer profile, a sign-up screen. Hiding that screen would have
-- hidden the only true thing on it. The session really did belong to an account
-- that owned nothing.
--
-- HOW TWO IDENTITIES END UP HOLDING ONE NUMBER. It is the tail of the phone
-- collision documented in 20260927000001. A customer signs in by EMAIL and puts
-- their phone on their profile, so public.users.phone holds it while
-- auth.users.phone is NULL. Something then asked GoTrue for a phone OTP on that
-- number — vendor sign-up used to, before the application-level fix — and
-- GoTrue, finding no identity, MADE one. handle_new_auth_user_for() provisions
-- that second identity DELIBERATELY WITHOUT the contested number, because a
-- contact detail somebody else already holds is not this identity's to take.
--
-- So the database is left in a state that is correct and still misleading:
--
--   auth.users    the number is CONFIRMED on the second, empty identity
--   public.users  the number is on the store owner's row
--
-- phone_can_sign_in_as_vendor() asked public.users. GoTrue asks auth.users.
-- They answered about two different people, so the gate said yes and the
-- session came back as the empty identity. The gate was reading the wrong
-- table, and no amount of front-end work could have fixed that.
--
-- WHAT THIS CHANGES. The question is no longer "does a store owner's profile
-- carry this number" but "will a phone code land on an account that owns a
-- store" — which is the only question the caller actually has, and the only one
-- auth.users can answer. Three outcomes rather than a boolean, because the two
-- refusals want completely different sentences: one person has no store and
-- should register, the other HAS a store and needs their other credential.
--
-- IT MERGES NOTHING AND DELETES NOTHING. Two identities holding one number is a
-- mess for an administrator to clean up with the facts in front of them, not
-- for a sign-in function to resolve by guessing which one somebody meant.
-- ---------------------------------------------------------------------------

drop function if exists public.phone_can_sign_in_as_vendor(text);

create or replace function public.vendor_phone_sign_in_status(p_phone text)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select case
    -- A CODE TO THIS NUMBER WILL SIGN IN AN ACCOUNT THAT OWNS A STORE.
    -- auth.users is the table GoTrue resolves against, and it stores numbers
    -- without the leading '+' that our E.164 columns carry.
    --
    -- Owns a store in ANY state: a rejected or pending applicant still has to
    -- get in to read why.
    when exists (
      select 1
        from auth.users au
        join public.vendors v on v.owner_user_id = au.id
       where au.phone_confirmed_at is not null
         and nullif(au.phone, '') is not null
         and '+' || ltrim(au.phone, '+') = p_phone
    ) then 'VENDOR'

    -- THE STORE EXISTS AND THE CODE WOULD NOT REACH IT. The number is on a
    -- store owner's profile, but it is not a sign-in credential on that
    -- account — either the account signs in by school email and has never
    -- proven the number to GoTrue, or the number is confirmed on a DIFFERENT
    -- identity, which is the collision above. Either way sending a code here
    -- would sign somebody into the wrong account, or into no account at all.
    when exists (
      select 1
        from public.users u
        join public.vendors v on v.owner_user_id = u.id
       where u.phone = p_phone
    ) then 'EMAIL_ACCOUNT'

    else 'NONE'
  end;
$$;

comment on function public.vendor_phone_sign_in_status(text) is
  'Whether a vendor sign-in code may be sent to this number, answered against auth.users — the table GoTrue itself resolves a phone OTP against. VENDOR: a confirmed phone identity that owns a store, so send the code. EMAIL_ACCOUNT: a store owner carries this number on their profile but a code would not reach that account, so point them at their other credential rather than signing them into an empty identity. NONE: nothing. Returns one of three words and nothing else — no name, no store, no account id.';

revoke all on function public.vendor_phone_sign_in_status(text) from public;
grant execute on function public.vendor_phone_sign_in_status(text) to anon, authenticated;
