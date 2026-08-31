-- ============================================================================
-- Campus Dash — enums, shared helpers, audit scaffolding
-- ============================================================================
-- Design rule for the whole schema:
--   Clients get SELECT only, filtered by RLS. EVERY write goes through a
--   SECURITY DEFINER function that re-derives authorisation from auth.uid().
--   That makes "never trust the client" structural rather than aspirational —
--   a customer literally cannot UPDATE orders SET payment_status = 'PAID'.
-- ============================================================================

-- --- Order state: three INDEPENDENT dimensions -------------------------------
create type public.order_status as enum (
  'DRAFT', 'SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED',
  'REJECTED', 'EXPIRED', 'CANCELLED', 'CANCELLED_BY_VENDOR'
);

create type public.payment_status as enum (
  'UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED'
);

create type public.delivery_status as enum (
  'NONE', 'SEARCHING', 'ASSIGNED', 'PICKED_UP', 'DELIVERED',
  'FAILED_NO_PARTNER', 'FAILED_CUSTOMER_ABSENT'
);

create type public.fulfilment_type as enum ('PICKUP', 'DELIVERY');

-- --- Identity ---------------------------------------------------------------
create type public.partner_application_status as enum (
  'NOT_APPLIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'
);

create type public.vendor_status as enum ('DRAFT', 'ACTIVE', 'SUSPENDED');

-- --- Locations --------------------------------------------------------------
create type public.location_kind as enum (
  'CAMPUS', 'BLOCK', 'FLOOR', 'ROOM', 'FIELD', 'COMMON_AREA'
);

-- --- Money ------------------------------------------------------------------
-- Provider-level transaction state. Deliberately a SEPARATE vocabulary from
-- orders.payment_status: a provider's states are not our order's states.
create type public.payment_txn_status as enum (
  'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);

create type public.payee_type as enum ('VENDOR', 'PLATFORM', 'PARTNER');

create type public.allocation_status as enum (
  'PENDING', 'ELIGIBLE', 'SETTLING', 'SETTLED', 'CANCELLED'
);

create type public.settlement_run_status as enum (
  'OPEN', 'PROCESSING', 'COMPLETED', 'FAILED'
);

create type public.payout_status as enum (
  'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'
);

create type public.webhook_event_status as enum (
  'RECEIVED', 'PROCESSED', 'IGNORED', 'INVALID_SIGNATURE', 'FAILED'
);

-- ============================================================================
-- Shared helpers
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Human-readable order reference. Vendors read these aloud across a counter, so
-- it is short and unambiguous — never the UUID.
create sequence public.order_number_seq start 1000;

create or replace function public.next_order_number()
returns text
language sql
volatile
as $$
  select 'CD-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;

-- ============================================================================
-- Transition results
-- ============================================================================
-- Why transitions RETURN a failure instead of raising one:
--
-- A rejected transition must be logged. But `raise exception` aborts the whole
-- transaction, which rolls back the very log row that recorded the rejection —
-- so logging-then-raising silently records nothing. Returning a result keeps
-- the log committed, which makes "rejected transitions are logged" true by
-- construction rather than dependent on the caller remembering to do it.
--
-- The rule:
--   * STATE and CONTENTION failures (lost the race, wrong current state, bad
--     code) return success = false, and the rejection is logged.
--   * AUTHORISATION failures still raise. Those are not routine — they mean a
--     bug or an attack — and they should be loud and abort everything.
create type public.transition_result as (
  success boolean,
  reason  text
);
