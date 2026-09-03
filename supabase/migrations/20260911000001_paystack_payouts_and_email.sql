-- ============================================================================
-- Paystack — customer email, MoMo payout destinations, payout lifecycle
-- ============================================================================
-- Three things the fake provider never needed and a real one does.
--
-- 1. EMAIL. Paystack's /transaction/initialize requires an email address. Our
--    customers sign in by phone OTP and many have never given us one, so it is
--    collected, stored and REAL. A synthesised address would silently break
--    every receipt Paystack sends and would be a lie in our own records.
--
-- 2. PAYOUT DESTINATIONS. A phone number is not enough to send mobile money.
--    Paystack needs a network (its "bank code"), an account number and a name,
--    and it issues a recipient_code that later transfers refer to. Those live
--    in their own SERVER-ONLY table rather than on `vendors`, because
--    vendors_read_active lets ANY anonymous visitor select every column of an
--    active vendor — a payout account number on that table would be public.
--
-- 3. PAYOUT LIFECYCLE. Provider acceptance is not delivery (hard rule 11). A
--    transfer Paystack has accepted is PROCESSING; only transfer.success makes
--    it PAID. transfer.failed releases the allocation claim so the money is
--    swept into the next run rather than stranded on a dead payout.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Customer email
-- ---------------------------------------------------------------------------
-- public.users.email already exists (partner applications collect one). This
-- opens it to every account, because a customer now needs one to pay.
--
-- Deliberately NOT a student-verification change: no institutional domain is
-- required, no document, no photograph. Partner applications keep their own,
-- stricter requirements untouched.
create or replace function public.set_my_email(p_email text)
returns public.users
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user  public.users%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if v_email = '' then
    raise exception 'an email address is required' using errcode = 'check_violation';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address does not look like an address'
      using errcode = 'check_violation';
  end if;

  update public.users set email = v_email where id = auth.uid()
  returning * into v_user;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  return v_user;
end;
$$;

revoke execute on function public.set_my_email(text) from public, anon;
grant  execute on function public.set_my_email(text) to authenticated;

-- The browser needs to know whether an email is on file so it can ask for one
-- BEFORE sending someone to a checkout that would reject them. It is the
-- caller's own address, and it already comes back from users_read_self.
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
        'email',            u.email,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,
        'can_order',        not u.is_suspended,
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

-- ---------------------------------------------------------------------------
-- 2. Payout destinations — SERVER-ONLY
-- ---------------------------------------------------------------------------
-- No grants, no policies. Reached only through the SECURITY DEFINER functions
-- below, exactly like order_secrets. An account number is the one field that
-- lets somebody redirect a settlement.
create table public.payout_destinations (
  payee_type      public.payee_type not null,
  payee_id        uuid not null,

  -- Our vocabulary, not Paystack's. lib/payments/paystack.js maps these onto
  -- Paystack's Ghana mobile-money bank codes (MTN / VOD / ATL), so a provider
  -- change is an adapter change and not a data migration.
  momo_network    text not null check (momo_network in ('MTN', 'VODAFONE', 'AIRTELTIGO')),

  -- Local Ghana form, which is what Paystack's mobile_money recipients take.
  -- Stored separately from users.phone / vendors.phone on purpose: where the
  -- money goes is not always the number we call.
  account_number  text not null check (account_number ~ '^0[0-9]{9}$'),
  account_name    text not null check (btrim(account_name) <> ''),

  -- Issued by the provider for this destination. Cleared whenever the
  -- destination changes, so a stale code can never point a transfer at an old
  -- number.
  provider                text,
  provider_recipient_code text,
  provider_synced_at      timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (payee_type, payee_id),

  -- PLATFORM is Campus Dash's own revenue. Nothing is ever transferred to it.
  constraint payout_destinations_not_platform check (payee_type <> 'PLATFORM'),
  constraint payout_destinations_code_needs_provider
    check (provider_recipient_code is null or provider is not null)
);

alter table public.payout_destinations enable row level security;

create unique index payout_destinations_provider_code_unique
  on public.payout_destinations (provider, provider_recipient_code)
  where provider_recipient_code is not null;

create trigger payout_destinations_set_updated_at
  before update on public.payout_destinations
  for each row execute function public.set_updated_at();

comment on table public.payout_destinations is
  'Where settlement money goes. Server-only: no client role holds any grant.';

-- --- Reads and writes, all through functions --------------------------------

-- Service-side read, used when building a transfer.
create or replace function public.payout_destination_for(
  p_payee_type public.payee_type,
  p_payee_id   uuid
)
returns public.payout_destinations
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();
  select * into v_row from public.payout_destinations
   where payee_type = p_payee_type and payee_id = p_payee_id;
  return v_row;
end;
$$;

-- Records the recipient the provider issued for a destination. Service-side:
-- it is written straight after a provider call, never by a person.
create or replace function public.attach_payout_recipient(
  p_payee_type     public.payee_type,
  p_payee_id       uuid,
  p_provider       text,
  p_recipient_code text
)
returns public.payout_destinations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();

  if nullif(btrim(coalesce(p_recipient_code, '')), '') is null then
    raise exception 'a recipient code is required' using errcode = 'check_violation';
  end if;

  update public.payout_destinations
     set provider = p_provider,
         provider_recipient_code = p_recipient_code,
         provider_synced_at = now()
   where payee_type = p_payee_type and payee_id = p_payee_id
  returning * into v_row;

  if not found then
    raise exception 'no payout destination for % %', p_payee_type, p_payee_id
      using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

-- Admin: set or change where a vendor's or Partner's money goes.
create or replace function public.admin_set_payout_destination(
  p_payee_type     public.payee_type,
  p_payee_id       uuid,
  p_momo_network   text,
  p_account_number text,
  p_account_name   text,
  p_reason         text
)
returns public.payout_destinations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.payout_destinations%rowtype;
  v_after  public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Accept the E.164 form people paste out of a phone book and store the local
  -- one Paystack wants. Rejecting +233… here would just move the conversion
  -- into whoever is typing.
  if left(v_number, 4) = '+233' then
    v_number := '0' || substring(v_number from 5);
  elsif left(v_number, 3) = '233' then
    v_number := '0' || substring(v_number from 4);
  end if;

  if v_number !~ '^0[0-9]{9}$' then
    raise exception 'a Ghanaian mobile money number is required, e.g. 0551234567'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_account_name, '')), '') is null then
    raise exception 'the name on the mobile money account is required'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.payout_destinations
   where payee_type = p_payee_type and payee_id = p_payee_id;

  insert into public.payout_destinations (
    payee_type, payee_id, momo_network, account_number, account_name
  )
  values (p_payee_type, p_payee_id, p_momo_network, v_number, btrim(p_account_name))
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         -- A changed destination invalidates the provider's recipient. Keeping
         -- it would send the next transfer to the OLD number.
         provider                = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider end,
         provider_recipient_code = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at      = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_synced_at end
  returning * into v_after;

  perform public.log_admin_action(
    'PAYOUT_DESTINATION_SET', lower(p_payee_type::text), p_payee_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

create or replace function public.admin_payout_destinations()
returns table (
  payee_type              public.payee_type,
  payee_id                uuid,
  payee_name              text,
  momo_network            text,
  account_number          text,
  account_name            text,
  provider                text,
  provider_recipient_code text,
  provider_synced_at      timestamptz,
  updated_at              timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.payee_type, d.payee_id,
         coalesce(v.name, u.full_name, u.phone),
         d.momo_network, d.account_number, d.account_name,
         d.provider, d.provider_recipient_code, d.provider_synced_at, d.updated_at
    from public.payout_destinations d
    left join public.vendors v on d.payee_type = 'VENDOR'  and v.id = d.payee_id
    left join public.users   u on d.payee_type = 'PARTNER' and u.id = d.payee_id
   where public.is_admin()
   order by d.payee_type, coalesce(v.name, u.full_name, u.phone);
$$;

-- A Partner keeps their own destination current. They can only ever reach
-- their own row: the payee id is auth.uid(), not an argument.
create or replace function public.partner_set_payout_destination(
  p_momo_network   text,
  p_account_number text,
  p_account_name   text
)
returns public.payout_destinations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row    public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.partner_profiles
     where user_id = auth.uid() and status = 'APPROVED'
  ) then
    raise exception 'only an approved Partner has a payout destination'
      using errcode = 'insufficient_privilege';
  end if;

  if left(v_number, 4) = '+233' then
    v_number := '0' || substring(v_number from 5);
  elsif left(v_number, 3) = '233' then
    v_number := '0' || substring(v_number from 4);
  end if;

  if v_number !~ '^0[0-9]{9}$' then
    raise exception 'a Ghanaian mobile money number is required, e.g. 0551234567'
      using errcode = 'check_violation';
  end if;
  if p_momo_network not in ('MTN', 'VODAFONE', 'AIRTELTIGO') then
    raise exception 'choose MTN, VODAFONE or AIRTELTIGO' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_account_name, '')), '') is null then
    raise exception 'the name on the mobile money account is required'
      using errcode = 'check_violation';
  end if;

  insert into public.payout_destinations (
    payee_type, payee_id, momo_network, account_number, account_name
  )
  values ('PARTNER', auth.uid(), p_momo_network, v_number, btrim(p_account_name))
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         provider                = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider end,
         provider_recipient_code = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at      = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_synced_at end
  returning * into v_row;

  return v_row;
end;
$$;

-- A Partner reads back their own destination. Same row, no argument.
create or replace function public.my_payout_destination()
returns table (
  momo_network   text,
  account_number text,
  account_name   text,
  is_ready       boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.momo_network, d.account_number, d.account_name,
         d.provider_recipient_code is not null
    from public.payout_destinations d
   where d.payee_type = 'PARTNER' and d.payee_id = auth.uid();
$$;

revoke execute on function public.payout_destination_for(public.payee_type, uuid)
  from public, anon, authenticated;
revoke execute on function public.attach_payout_recipient(public.payee_type, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.admin_set_payout_destination(public.payee_type, uuid, text, text, text, text)
  from public, anon;
revoke execute on function public.admin_payout_destinations() from public, anon;
revoke execute on function public.partner_set_payout_destination(text, text, text) from public, anon;
revoke execute on function public.my_payout_destination() from public, anon;

grant execute on function public.admin_set_payout_destination(public.payee_type, uuid, text, text, text, text)
  to authenticated;
grant execute on function public.admin_payout_destinations() to authenticated;
grant execute on function public.partner_set_payout_destination(text, text, text) to authenticated;
grant execute on function public.my_payout_destination() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Payout lifecycle
-- ---------------------------------------------------------------------------
-- PENDING -> PROCESSING (the provider accepted it)
--         -> PAID       (transfer.success)
--         -> FAILED     (transfer.failed, or we never got it out of the door)
create or replace function public.mark_payout_processing(
  p_payout_id            uuid,
  p_provider             text,
  p_provider_transfer_id text
)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- A webhook can beat the HTTP response that started the transfer. Winning
  -- that race must not drag a PAID payout backwards.
  if v_payout.status in ('PAID', 'PROCESSING') then
    return v_payout;
  end if;

  update public.payouts
     set status = 'PROCESSING', provider = p_provider,
         provider_transfer_id = p_provider_transfer_id
   where id = p_payout_id and status = 'PENDING'
  returning * into v_payout;

  if not found then
    raise exception 'payout was not PENDING' using errcode = 'check_violation';
  end if;

  return v_payout;
end;
$$;

-- A failed transfer must not strand the money. The allocations this payout was
-- built from go back to ELIGIBLE and unclaimed, so the next run sweeps them up
-- — and the payout row stays FAILED, for a person to look at.
create or replace function public.fail_payout(p_payout_id uuid, p_reason text default null)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- Money already out of the door is not un-sent by a late failure event.
  if v_payout.status = 'PAID' then
    return v_payout;
  end if;
  if v_payout.status = 'FAILED' then
    return v_payout;  -- idempotent replay
  end if;

  update public.payouts
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not failable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'ELIGIBLE', settlement_run_id = null, settled_at = null
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id
     and status = 'SETTLING';

  return v_payout;
end;
$$;

-- Manual retry. Never automatic: a transfer that failed once needs a person to
-- decide, and an automatic loop against a payments API is how you send the same
-- money twice.
--
-- Re-claims the allocations fail_payout released. If a LATER run has already
-- swept them, it refuses rather than paying an amount that no longer matches
-- what is owed.
create or replace function public.retry_payout(p_payout_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
  v_run    public.settlement_runs%rowtype;
  v_sum    bigint;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    return (false, 'payout not found')::public.transition_result;
  end if;
  if v_payout.status = 'PAID' then
    return (false, 'this payout is already paid')::public.transition_result;
  end if;
  if v_payout.status <> 'FAILED' then
    return (false, 'only a failed payout is retried')::public.transition_result;
  end if;

  select * into v_run from public.settlement_runs where id = v_payout.settlement_run_id;

  -- Take back exactly what this run was built from, and only what is still free.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = v_payout.payee_type
     and a.payee_id   = v_payout.payee_id
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at >= v_run.period_start
     and o.created_at <  v_run.period_end;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where settlement_run_id = v_run.id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id;

  if v_sum <> v_payout.amount_pesewas then
    -- Put back whatever we just took, so a refused retry changes nothing.
    update public.allocations
       set settlement_run_id = null, status = 'ELIGIBLE'
     where settlement_run_id = v_run.id
       and payee_type = v_payout.payee_type
       and payee_id   = v_payout.payee_id
       and status = 'SETTLING';
    return (false,
      'the allocations behind this payout have moved to another run; settle it there')
      ::public.transition_result;
  end if;

  update public.payouts
     set status = 'PENDING', failure_reason = null,
         provider_transfer_id = null
   where id = p_payout_id and status = 'FAILED';

  return (true, null)::public.transition_result;
end;
$$;

-- Which payout a transfer webhook is about. Matching on the provider's own
-- transfer id, or on the reference we handed them, which is the payout id.
create or replace function public.payout_for_transfer(
  p_provider             text,
  p_provider_transfer_id text,
  p_reference            text default null
)
returns public.payouts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  if p_provider_transfer_id is not null then
    select * into v_payout from public.payouts
     where provider = p_provider and provider_transfer_id = p_provider_transfer_id;
    if found then
      return v_payout;
    end if;
  end if;

  -- The reference is our own payout id, echoed back. Cast defensively: a
  -- provider can send anything at all in that field.
  if p_reference is not null and p_reference ~ '^[0-9a-fA-F-]{36}$' then
    select * into v_payout from public.payouts where id = p_reference::uuid;
  end if;

  return v_payout;
end;
$$;

revoke execute on function public.mark_payout_processing(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.fail_payout(uuid, text) from public, anon, authenticated;
revoke execute on function public.retry_payout(uuid) from public, anon, authenticated;
revoke execute on function public.payout_for_transfer(text, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The checkout URL has to survive a reload
-- ---------------------------------------------------------------------------
-- Hosted checkout hands us an authorization_url. A customer who backgrounds the
-- tab and comes back needs the SAME one — re-initialising would either create a
-- second Paystack transaction for one order or be refused as a duplicate
-- reference. So the provider's response is kept on the payment row.
--
-- Replaces the two-argument form rather than sitting beside it: two overloads
-- of the function that attaches a provider transaction is how one of them
-- quietly keeps being called.
drop function if exists public.attach_payment_transaction(uuid, text);

create or replace function public.attach_payment_transaction(
  p_payment_id              uuid,
  p_provider_transaction_id text,
  p_raw                     jsonb default null
)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  if v_payment.provider_transaction_id is not null then
    if v_payment.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'payment % is already attached to transaction %',
        p_payment_id, v_payment.provider_transaction_id using errcode = 'check_violation';
    end if;

    -- Same transaction, possibly a fresher checkout URL. Merge, never detach.
    update public.payments
       set raw = public.payments.raw || coalesce(p_raw, '{}'::jsonb)
     where id = p_payment_id
    returning * into v_payment;
    return v_payment;
  end if;

  update public.payments
     set provider_transaction_id = p_provider_transaction_id,
         raw = public.payments.raw || coalesce(p_raw, '{}'::jsonb)
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

revoke execute on function public.attach_payment_transaction(uuid, text, jsonb)
  from public, anon, authenticated;

-- The checkout URL, for resuming a payment already in flight. Service-side:
-- payments.raw holds whole provider payloads and is not client-readable.
create or replace function public.payment_checkout_url(p_payment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  perform public.assert_service_or_admin();
  select raw ->> 'authorization_url' into v_url from public.payments where id = p_payment_id;
  return v_url;
end;
$$;

revoke execute on function public.payment_checkout_url(uuid) from public, anon, authenticated;
