-- ============================================================================
-- PAYSTACK SUBACCOUNTS AND SPLIT SETTLEMENT
-- ============================================================================
-- WHAT PAYSTACK ACTUALLY SUPPORTS, checked against their current documentation
-- rather than assumed:
--
--   * A SUBACCOUNT is a settlement destination registered once. For Ghana it
--     takes a mobile money network as `settlement_bank` (MTN / VOD / ATL — the
--     same codes transfer recipients use) and a 0XXXXXXXXX number.
--   * A TRANSACTION SPLIT divides one charge between the main account and one
--     or more subaccounts. `type` is 'percentage' or 'flat'; a FLAT share is an
--     amount in the minor unit, which for GHS is the pesewa — the unit this
--     codebase already uses everywhere, so nothing is converted.
--   * A DYNAMIC SPLIT is that same object passed inline on
--     /transaction/initialize, so a split can be built per order without
--     registering a split group first. That is what makes a per-order vendor
--     share possible at all.
--   * `bearer_type: 'account'` leaves Paystack's fee on the main account. That
--     is the requirement — Campus Dash absorbs processing fees — and it is a
--     supported value, not a workaround.
--
-- WHAT PAYSTACK CANNOT DO, and why the Partner is not in the split:
--
--   The split is fixed when the charge is created. At that moment the order has
--   been accepted and priced, and NO PARTNER EXISTS: dispatch does not open
--   until the vendor marks the food READY, which is after payment. There is no
--   supported way to add a subaccount to a transaction that has already been
--   charged, and inventing one by delaying payment until after assignment would
--   break the order architecture — the customer pays before the kitchen starts.
--
--   So the split carries the VENDOR only. The Partner's GH₵5 stays in the
--   Campus Dash balance at charge time, is carved out of the platform
--   allocation when a Partner actually completes the delivery, and is settled
--   through the existing settlement-run and Paystack Transfers path, which is
--   itself an officially supported mechanism and stays gated behind
--   PAYSTACK_TRANSFERS_ENABLED. Nothing speculative is switched on.
--
-- REFUNDS. Money already released to a subaccount cannot be pulled back. A
-- refund therefore comes out of the Campus Dash balance, and admin_order_money
-- now says so on the order it applies to rather than leaving somebody to
-- discover it during a reconciliation.

-- ---------------------------------------------------------------------------
-- The destination gains a second provider identity
-- ---------------------------------------------------------------------------
-- A recipient code (money pushed out by transfer) and a subaccount code (money
-- routed at collection) are different objects at Paystack describing the SAME
-- mobile money account. Both live on the destination row, because the row is
-- "the account somebody checked" and neither code outlives it.

alter table public.payout_destinations
  add column if not exists provider_subaccount_code text,
  add column if not exists subaccount_synced_at     timestamptz,
  add column if not exists subaccount_error         text;

alter table public.payout_destinations drop constraint if exists payout_destinations_subaccount_needs_provider;
alter table public.payout_destinations
  add constraint payout_destinations_subaccount_needs_provider
  check (provider_subaccount_code is null or provider is not null);

comment on column public.payout_destinations.provider_subaccount_code is
  'Paystack subaccount code (ACCT_…) for this mobile money account. Present means the vendor''s share can be split off the charge itself; absent means their money is settled by the payout run instead. Never returned to a client.';
comment on column public.payout_destinations.subaccount_error is
  'Why the last attempt to register a subaccount failed. Read by administrators; the vendor is told only that setup is incomplete.';

create unique index if not exists payout_destinations_subaccount_unique
  on public.payout_destinations (provider, provider_subaccount_code)
  where provider_subaccount_code is not null;

-- ---------------------------------------------------------------------------
-- A vendor sets their own
-- ---------------------------------------------------------------------------
-- There was no vendor-facing writer at all: a vendor's destination could only
-- be set by an administrator. That is the gap the split architecture closes,
-- because a split needs a subaccount and a subaccount needs details only the
-- vendor has.

create or replace function public.vendor_set_payout_destination(
  p_vendor_id      uuid,
  p_momo_network   text,
  p_account_number text,
  p_account_name   text
) returns public.payout_destinations
  language plpgsql security definer
  set search_path to ''
as $_$
declare
  v_row    public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- OWNERSHIP, not membership. vendors.owner_user_id is the whole model.
  if not exists (
    select 1 from public.vendors v
     where v.id = p_vendor_id and v.owner_user_id = auth.uid()
  ) then
    raise exception 'you do not own that store' using errcode = 'insufficient_privilege';
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
  values ('VENDOR', p_vendor_id, p_momo_network, v_number, btrim(p_account_name))
  -- CHANGING THE NUMBER INVALIDATES BOTH PROVIDER IDENTITIES. A subaccount code
  -- points at the old account; keeping it would route the next order's food
  -- money to a number the vendor has just told us is wrong.
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         provider                 = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider end,
         provider_recipient_code  = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at       = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_synced_at end,
         provider_subaccount_code = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_subaccount_code end,
         subaccount_synced_at     = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.subaccount_synced_at end,
         subaccount_error         = null
  returning * into v_row;

  return v_row;
end;
$_$;

alter function public.vendor_set_payout_destination(uuid, text, text, text) owner to postgres;
revoke all on function public.vendor_set_payout_destination(uuid, text, text, text) from public;
grant execute on function public.vendor_set_payout_destination(uuid, text, text, text) to authenticated;

-- A Partner changing their number must lose the subaccount code too, for the
-- same reason. The existing writer is recreated with that one clause added.
create or replace function public.partner_set_payout_destination(
  p_momo_network text, p_account_number text, p_account_name text
) returns public.payout_destinations
  language plpgsql security definer
  set search_path to ''
as $_$
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
         provider                 = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider end,
         provider_recipient_code  = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at       = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_synced_at end,
         provider_subaccount_code = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_subaccount_code end,
         subaccount_synced_at     = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.subaccount_synced_at end,
         subaccount_error         = null
  returning * into v_row;

  return v_row;
end;
$_$;

alter function public.partner_set_payout_destination(text, text, text) owner to postgres;

-- ---------------------------------------------------------------------------
-- Reading a destination back
-- ---------------------------------------------------------------------------
-- Two callers, two audiences. Neither returns an account NUMBER: the person who
-- typed it does not need to be shown it again to know it is set, and a screen
-- that echoes it is a screen that leaks it over somebody's shoulder. The last
-- three digits are enough to recognise your own number.

drop function if exists public.my_payout_destination();

create or replace function public.my_payout_destination()
  returns table(
    payee_type public.payee_type, payee_id uuid,
    momo_network text, account_last3 text, account_name text,
    transfers_ready boolean, split_ready boolean, setup_error text,
    updated_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select d.payee_type, d.payee_id,
         d.momo_network, right(d.account_number, 3), d.account_name,
         d.provider_recipient_code is not null,
         d.provider_subaccount_code is not null,
         d.subaccount_error,
         d.updated_at
    from public.payout_destinations d
   where (d.payee_type = 'PARTNER' and d.payee_id = auth.uid())
      or (d.payee_type = 'VENDOR'
          and exists (select 1 from public.vendors v
                       where v.id = d.payee_id and v.owner_user_id = auth.uid()))
   order by d.payee_type;
$$;

alter function public.my_payout_destination() owner to postgres;
revoke all on function public.my_payout_destination() from public;
grant execute on function public.my_payout_destination() to authenticated;

-- Server-side resolution, used by the payment path to build a split and by
-- settlement to build a transfer. Service-only: it returns a whole account.
create or replace function public.payout_destination_for(
  p_payee_type public.payee_type, p_payee_id uuid
) returns public.payout_destinations
  language plpgsql stable security definer
  set search_path to ''
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

alter function public.payout_destination_for(public.payee_type, uuid) owner to postgres;

-- Written back after Paystack confirms a subaccount. Separate from
-- attach_payout_recipient because the two codes are created at different
-- moments for different reasons, and a failure to make one must not wipe the
-- other.
create or replace function public.attach_payout_subaccount(
  p_payee_type public.payee_type,
  p_payee_id   uuid,
  p_provider   text,
  p_subaccount_code text,
  p_error      text default null
) returns public.payout_destinations
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();

  update public.payout_destinations
     set provider = coalesce(p_provider, provider),
         provider_subaccount_code = coalesce(nullif(btrim(coalesce(p_subaccount_code, '')), ''),
                                             provider_subaccount_code),
         subaccount_synced_at = case when nullif(btrim(coalesce(p_subaccount_code, '')), '') is not null
                                     then now() else subaccount_synced_at end,
         subaccount_error = nullif(btrim(coalesce(p_error, '')), '')
   where payee_type = p_payee_type and payee_id = p_payee_id
  returning * into v_row;

  if not found then
    raise exception 'no payout destination for that payee' using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

alter function public.attach_payout_subaccount(public.payee_type, uuid, text, text, text) owner to postgres;
revoke all on function public.attach_payout_subaccount(public.payee_type, uuid, text, text, text) from public;
grant execute on function public.attach_payout_subaccount(public.payee_type, uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The charge records what it split
-- ---------------------------------------------------------------------------

alter table public.payments
  add column if not exists split_subaccount_code text,
  add column if not exists split_vendor_pesewas  bigint not null default 0;

alter table public.payments drop constraint if exists payments_split_amount_check;
alter table public.payments
  add constraint payments_split_amount_check
  check (split_vendor_pesewas >= 0 and split_vendor_pesewas <= amount_pesewas);

alter table public.payments drop constraint if exists payments_split_pair;
alter table public.payments
  add constraint payments_split_pair
  check ((split_subaccount_code is null) = (split_vendor_pesewas = 0));

comment on column public.payments.split_subaccount_code is
  'The Paystack subaccount this charge was split to, or NULL when it was not split. Recorded at initialisation, so the ledger can say afterwards which orders settled themselves and which need a payout run.';
comment on column public.payments.split_vendor_pesewas is
  'How much of this charge Paystack routed straight to the vendor. Zero when there was no split — including when the split was attempted and refused, because what matters to the ledger is what actually happened.';

-- Set by the payment path once the provider has accepted the split. A separate
-- writer, not a widened attach_payment_transaction, because a split is a fact
-- about MONEY and belongs behind its own audited call.
create or replace function public.attach_payment_split(
  p_payment_id uuid,
  p_subaccount_code text,
  p_vendor_pesewas bigint
) returns public.payments
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  -- A split is decided before the customer is sent to the checkout and never
  -- afterwards. Rewriting it on a settled payment would rewrite history.
  if v_payment.status <> 'PENDING' then
    raise exception 'a split can only be recorded while the payment is pending'
      using errcode = 'check_violation';
  end if;

  update public.payments
     set split_subaccount_code = nullif(btrim(coalesce(p_subaccount_code, '')), ''),
         split_vendor_pesewas  = case
           when nullif(btrim(coalesce(p_subaccount_code, '')), '') is null then 0
           else coalesce(p_vendor_pesewas, 0) end
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

alter function public.attach_payment_split(uuid, text, bigint) owner to postgres;
revoke all on function public.attach_payment_split(uuid, text, bigint) from public;
grant execute on function public.attach_payment_split(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- The ledger learns that some money never passed through us
-- ---------------------------------------------------------------------------
-- A vendor allocation is still written for every food order — the ledger has to
-- show what the vendor earned whether or not Campus Dash was the one who moved
-- it. What changes is HOW it is settled:
--
--   SPLIT    Paystack routed it to the vendor's subaccount as part of the
--            charge. The allocation is born SETTLED, so no payout run can claim
--            it and nobody can be paid the same money twice.
--   TRANSFER Nobody had a subaccount, so the money is in the Campus Dash
--            balance and the existing settlement run moves it. Unchanged.
--
-- The old rows have no channel recorded and must not be guessed at, so the
-- column is nullable and NULL reads as "before this existed".

alter table public.allocations
  add column if not exists settlement_channel text;

alter table public.allocations drop constraint if exists allocations_settlement_channel_check;
alter table public.allocations
  add constraint allocations_settlement_channel_check
  check (settlement_channel is null or settlement_channel in ('SPLIT', 'TRANSFER'));

comment on column public.allocations.settlement_channel is
  'How this money reaches the payee. SPLIT means Paystack routed it at the moment of the charge and it was never in the Campus Dash balance; TRANSFER means a settlement run moves it. NULL on rows written before split settlement existed — historical, and deliberately not backfilled with a guess.';

create index if not exists allocations_channel_idx
  on public.allocations (payee_type, settlement_channel, status);

create or replace function public.create_order_allocations(p_order_id uuid) returns integer
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_order    public.orders%rowtype;
  v_platform bigint;
  v_count    integer := 0;
  v_split    bigint := 0;
  v_code     text;
begin
  perform public.assert_service_or_admin();

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Already allocated: idempotent no-op, not a duplicate ledger entry.
  if exists (select 1 from public.allocations where order_id = p_order_id) then
    return 0;
  end if;

  -- WHAT THE PROVIDER ACTUALLY SPLIT, read from the payment that succeeded —
  -- not from what we intended, and not from the vendor's current setup. A
  -- vendor who registered a subaccount after this order was charged is still
  -- owed this order's money through a payout run.
  select p.split_vendor_pesewas, p.split_subaccount_code
    into v_split, v_code
    from public.payments p
   where p.order_id = p_order_id and p.status = 'SUCCEEDED'
   order by p.created_at desc
   limit 1;

  v_split := coalesce(v_split, 0);

  -- At payment time NO PARTNER EXISTS YET — dispatch has not even opened. So we
  -- allocate in two rows now, and the Partner's share is carved out of the
  -- platform row later, at the moment a Partner actually earns it
  -- (see settle_partner_earnings). The rows always sum to the total, so the
  -- balance constraint holds at every step.
  v_platform := v_order.total_pesewas - v_order.subtotal_pesewas;

  -- The vendor cooked the food; their money is eligible on payment, regardless
  -- of how the delivery later turns out.
  --
  -- SCAN ORDERS GET NO SUCH ROW. Campus Dash did not sell their food and owes
  -- them nothing for it.
  if v_order.order_type <> 'SCAN' then
    insert into public.allocations (
      order_id, payee_type, payee_id, amount_pesewas, status,
      settlement_channel, settled_at
    )
    values (
      p_order_id, 'VENDOR', v_order.vendor_id, v_order.subtotal_pesewas,
      -- A PARTIAL split would leave a remainder nobody was ever going to send,
      -- so only a split that covers the whole subtotal settles the row. In
      -- practice the split IS the subtotal; this is the guard, not a case.
      (case when v_code is not null and v_split >= v_order.subtotal_pesewas
            then 'SETTLED' else 'ELIGIBLE' end)::public.allocation_status,
      case when v_code is not null and v_split >= v_order.subtotal_pesewas
           then 'SPLIT' else 'TRANSFER' end,
      case when v_code is not null and v_split >= v_order.subtotal_pesewas
           then now() end
    );
    v_count := v_count + 1;
  end if;

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status, settlement_channel)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE', 'TRANSFER');
  v_count := v_count + 1;

  return v_count;
end;
$$;

alter function public.create_order_allocations(uuid) owner to postgres;

-- The Partner's share is always a transfer: see the header. Recorded explicitly
-- so a reader of the ledger never has to infer it.
create or replace function public.settle_partner_earnings(p_order_id uuid) returns integer
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_order    public.orders%rowtype;
  v_earnings bigint;
begin
  select * into v_order from public.orders where id = p_order_id;

  if v_order.partner_id is null or v_order.partner_earnings_pesewas = 0 then
    return 0;
  end if;

  -- Idempotent: a Partner allocation already exists for this order.
  if exists (
    select 1 from public.allocations where order_id = p_order_id and payee_type = 'PARTNER'
  ) then
    return 0;
  end if;

  v_earnings := v_order.partner_earnings_pesewas;

  update public.allocations
     set amount_pesewas = amount_pesewas - v_earnings
   where order_id = p_order_id and payee_type = 'PLATFORM';

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status, settlement_channel)
  values (p_order_id, 'PARTNER', v_order.partner_id, v_earnings, 'ELIGIBLE', 'TRANSFER');

  return 1;
end;
$$;

alter function public.settle_partner_earnings(uuid) owner to postgres;

-- ---------------------------------------------------------------------------
-- What an administrator can see
-- ---------------------------------------------------------------------------

drop function if exists public.admin_payout_destinations();

create or replace function public.admin_payout_destinations()
  returns table(
    payee_type public.payee_type, payee_id uuid, payee_name text,
    momo_network text, account_number text, account_name text,
    provider text, provider_recipient_code text, provider_synced_at timestamptz,
    provider_subaccount_code text, subaccount_synced_at timestamptz,
    subaccount_error text, updated_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select d.payee_type, d.payee_id,
         coalesce(v.name, u.full_name, u.phone),
         d.momo_network, d.account_number, d.account_name,
         d.provider, d.provider_recipient_code, d.provider_synced_at,
         d.provider_subaccount_code, d.subaccount_synced_at, d.subaccount_error,
         d.updated_at
    from public.payout_destinations d
    left join public.vendors v on d.payee_type = 'VENDOR'  and v.id = d.payee_id
    left join public.users   u on d.payee_type = 'PARTNER' and u.id = d.payee_id
   where public.is_admin()
   order by d.payee_type, coalesce(v.name, u.full_name, u.phone);
$$;

alter function public.admin_payout_destinations() owner to postgres;
revoke all on function public.admin_payout_destinations() from public;
grant execute on function public.admin_payout_destinations() to authenticated;

-- "Who has NOT finished setting up" is the question an administrator actually
-- has, and a list of the destinations that exist cannot answer it. This lists
-- every vendor and every approved Partner, whether or not they have a row.
create or replace function public.admin_payout_readiness()
  returns table(
    payee_type public.payee_type, payee_id uuid, payee_name text,
    has_destination boolean, momo_network text, account_last3 text,
    split_ready boolean, transfers_ready boolean, setup_error text,
    owed_pesewas bigint
  )
  language sql stable security definer
  set search_path to ''
as $$
  with payees as (
    select 'VENDOR'::public.payee_type as payee_type, v.id as payee_id, v.name as payee_name
      from public.vendors v
     where v.status = 'ACTIVE' and v.owner_user_id is not null
    union all
    select 'PARTNER'::public.payee_type, p.user_id, u.full_name
      from public.partner_profiles p
      join public.users u on u.id = p.user_id
     where p.status = 'APPROVED'
  )
  select k.payee_type, k.payee_id, k.payee_name,
         d.payee_id is not null,
         d.momo_network,
         right(d.account_number, 3),
         d.provider_subaccount_code is not null,
         d.provider_recipient_code is not null,
         d.subaccount_error,
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.payee_type = k.payee_type and a.payee_id = k.payee_id
                      and a.status in ('PENDING', 'ELIGIBLE', 'SETTLING')), 0)::bigint
    from payees k
    left join public.payout_destinations d
      on d.payee_type = k.payee_type and d.payee_id = k.payee_id
   where public.is_admin()
   order by k.payee_type, (d.payee_id is not null), k.payee_name;
$$;

alter function public.admin_payout_readiness() owner to postgres;
comment on function public.admin_payout_readiness() is
  'Every payee who could be owed money, and whether they can actually be paid. Shows the last three digits of an account and never the whole number — an operations screen needs to confirm a number is set, not read it out.';
revoke all on function public.admin_payout_readiness() from public;
grant execute on function public.admin_payout_readiness() to authenticated;

-- The order-level money view says which channel each allocation used, so a
-- reconciliation can tell "Paystack sent it" from "we still owe it".
drop function if exists public.admin_order_money(uuid);

create or replace function public.admin_order_money(p_order_id uuid)
  returns table(
    order_id uuid, order_number text, total_pesewas bigint,
    payment_status public.payment_status, payment_id uuid, payment_provider text,
    payment_txn_status public.payment_txn_status, provider_transaction_id text,
    paid_pesewas bigint,
    split_subaccount_code text, split_vendor_pesewas bigint,
    vendor_name text, vendor_allocation bigint, vendor_channel text,
    platform_allocation bigint,
    partner_name text, partner_allocation bigint,
    allocated_pesewas bigint, balances boolean, allocations jsonb
  )
  language sql stable security definer
  set search_path to ''
as $$
  select o.id,
         o.order_number,
         o.total_pesewas,
         o.payment_status,
         pay.id,
         pay.provider,
         pay.status,
         pay.provider_transaction_id,
         coalesce(pay.amount_pesewas, 0),
         pay.split_subaccount_code,
         coalesce(pay.split_vendor_pesewas, 0),
         v.name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'VENDOR'
                      and a.status <> 'CANCELLED'), 0),
         (select a.settlement_channel from public.allocations a
           where a.order_id = o.id and a.payee_type = 'VENDOR'
             and a.status <> 'CANCELLED'),
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PLATFORM'
                      and a.status <> 'CANCELLED'), 0),
         pu.full_name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PARTNER'
                      and a.status <> 'CANCELLED'), 0),
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0)::bigint,
         -- The invariant, stated where an admin can see it fail.
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0) = o.total_pesewas
           or not exists (select 1 from public.allocations a where a.order_id = o.id),
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'payee_type', a.payee_type,
                     'amount_pesewas', a.amount_pesewas,
                     'status', a.status,
                     'settlement_channel', a.settlement_channel,
                     'settlement_run_id', a.settlement_run_id,
                     'settled_at', a.settled_at
                   ) order by a.payee_type)
              from public.allocations a where a.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join lateral (
      select p.* from public.payments p
       where p.order_id = o.id
       order by case p.status when 'SUCCEEDED' then 0 else 1 end, p.created_at desc
       limit 1
    ) pay on true
   where public.is_admin() and o.id = p_order_id;
$$;

alter function public.admin_order_money(uuid) owner to postgres;
revoke all on function public.admin_order_money(uuid) from public;
grant execute on function public.admin_order_money(uuid) to authenticated;
