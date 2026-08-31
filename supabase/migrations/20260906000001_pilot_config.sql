-- ============================================================================
-- Pilot configuration
-- ============================================================================
-- Every number we expect to argue about during the pilot, in one row, editable
-- by an admin without a deploy.
--
-- The table is still called pricing_config because renaming it would touch a
-- dozen functions for no behavioural gain. It has not been only about pricing
-- since Phase 2; treat it as the platform configuration table.
-- ============================================================================

comment on table public.pricing_config is
  'Platform configuration. Legacy name — holds timeouts and operational limits '
  'as well as fees. One row, id = true.';

alter table public.pricing_config
  -- How long a payment may sit PENDING before we give up on the provider's
  -- callback. Without this an order whose webhook never arrives is stuck for
  -- ever: the customer cannot retry (one live intent per order) and the vendor
  -- cannot cook.
  add column if not exists payment_pending_timeout_seconds integer not null default 900
    check (payment_pending_timeout_seconds > 0),

  -- NOTE: there is deliberately no max_active_partner_deliveries knob. One
  -- active delivery per Partner is guaranteed by the partial unique index
  -- orders_one_active_delivery_per_partner, so a config value would not change
  -- the behaviour — it would just look as though it did. Allowing more than one
  -- is a migration (drop the index, widen the claim predicate), not a setting.

  -- Below this, a payout waits for the next run rather than costing a transfer
  -- fee to move a few pesewas. 0 disables the threshold.
  add column if not exists min_payout_pesewas bigint not null default 0
    check (min_payout_pesewas >= 0),

  -- Retention for the student ID and live face photograph, from the review
  -- decision. PLACEHOLDER VALUES — see docs/PILOT-QUESTIONS.md; the defensible
  -- period is a Data Protection Commission question, not an engineering one.
  add column if not exists approved_document_retention_days integer not null default 90
    check (approved_document_retention_days > 0),
  add column if not exists rejected_document_retention_days integer not null default 30
    check (rejected_document_retention_days > 0),

  -- How long an admin's view of a verification document stays valid.
  add column if not exists document_signed_url_seconds integer not null default 120
    check (document_signed_url_seconds between 30 and 900),

  -- How many times a failed notification may be retried before we stop.
  add column if not exists notification_retry_limit integer not null default 2
    check (notification_retry_limit between 0 and 10),

  -- Screen refresh cadences, so the pilot can trade responsiveness against load
  -- without a rebuild.
  add column if not exists vendor_poll_seconds integer not null default 8
    check (vendor_poll_seconds between 2 and 120),
  add column if not exists partner_poll_seconds integer not null default 10
    check (partner_poll_seconds between 2 and 120),
  add column if not exists customer_poll_seconds integer not null default 6
    check (customer_poll_seconds between 2 and 120);

-- ---------------------------------------------------------------------------
-- Reading it
-- ---------------------------------------------------------------------------
-- Fees and timeouts are not secret: a customer is entitled to know the service
-- fee and how long a vendor has to answer. Everything here is safe to publish.
create or replace function public.platform_config()
returns public.pricing_config
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.pricing_config where id;
$$;

-- ---------------------------------------------------------------------------
-- Changing it
-- ---------------------------------------------------------------------------
-- NULL means "leave alone", so a partial edit cannot blank a field it never
-- meant to touch. Every change is audited with a reason, like any other
-- administrative override — because changing the delivery fee IS one.
create or replace function public.admin_update_config(
  p_reason text,
  p_service_fee_pesewas             bigint  default null,
  p_delivery_fee_pesewas            bigint  default null,
  p_partner_share_of_delivery_bps   integer default null,
  p_vendor_response_seconds         integer default null,
  p_partner_search_seconds          integer default null,
  p_customer_absent_wait_seconds    integer default null,
  p_payment_pending_timeout_seconds integer default null,
  p_min_payout_pesewas              bigint  default null,
  p_notification_retry_limit        integer default null,
  p_vendor_poll_seconds             integer default null,
  p_partner_poll_seconds            integer default null,
  p_customer_poll_seconds           integer default null
)
returns public.pricing_config
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.pricing_config where id;

  update public.pricing_config
     set service_fee_pesewas             = coalesce(p_service_fee_pesewas, service_fee_pesewas),
         delivery_fee_pesewas            = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps   = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds         = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds          = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds    = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas              = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit        = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds             = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds            = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds)
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

revoke execute on function public.platform_config() from public;
grant execute on function public.platform_config() to anon, authenticated;

revoke execute on function public.admin_update_config(
  text, bigint, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer
) from public, anon;
grant execute on function public.admin_update_config(
  text, bigint, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- Honour the configured document retention on review
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_partner(
  p_user_id uuid,
  p_status  public.partner_application_status,
  p_reason  text,
  p_notes   text default null
)
returns public.partner_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
  v_cfg    public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('APPROVED', 'REJECTED', 'SUSPENDED') then
    raise exception 'review status must be APPROVED, REJECTED or SUSPENDED'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner application for this user' using errcode = 'no_data_found';
  end if;

  select * into v_cfg from public.pricing_config where id;

  update public.partner_profiles
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_notes = p_notes,
         is_available = case when p_status = 'APPROVED' then is_available else false end,
         documents_purge_after = case
           when p_status = 'APPROVED'
             then now() + make_interval(days => v_cfg.approved_document_retention_days)
           else now() + make_interval(days => v_cfg.rejected_document_retention_days) end
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_' || p_status::text, 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

revoke execute on function public.admin_review_partner(uuid, public.partner_application_status, text, text)
  from public, anon;
grant execute on function public.admin_review_partner(uuid, public.partner_application_status, text, text)
  to authenticated;
