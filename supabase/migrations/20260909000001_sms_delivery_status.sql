-- ============================================================================
-- SMS delivery status, from the provider's own callback
-- ============================================================================
-- Until now a notification recorded whether the PROVIDER ACCEPTED the message,
-- which is not the same claim as "it arrived". An accepted SMS can still be
-- rejected by the network, expire undelivered, or land on a dead number, and
-- the difference is exactly what you want to know when a customer says they
-- never got their code.
--
-- Arkesel reports the outcome later, over a webhook. This is the smallest
-- extension that lets that outcome land on the notification it belongs to.
-- There is no second notification system: the same notification_events row
-- gains a delivery status, and nothing else changes.
--
-- CORRELATION
-- -----------
-- The Arkesel v1 send response does not carry a message id, so there is nothing
-- to correlate on at send time. What it does support is a per-request
-- callback_url, which it calls back with its own sms_id and status. So we put
-- OUR reference into that URL when we send, and Arkesel hands it back to us.
-- That reference is correlation_id, generated before the send and unique.
--
-- provider_message_id then holds Arkesel's own sms_id once the callback tells
-- us what it is, which is what an operator needs to quote in a support ticket.
-- ============================================================================

alter table public.notification_events
  add column if not exists correlation_id      text,
  add column if not exists delivery_status     text,
  add column if not exists delivery_updated_at timestamptz;

comment on column public.notification_events.correlation_id is
  'Our reference, generated before the send and handed to the provider so its delivery callback can be matched back to this row.';
comment on column public.notification_events.delivery_status is
  'Normalised final outcome from the provider: DELIVERED, FAILED, EXPIRED, REJECTED or UNKNOWN. Null until the provider says.';

-- One notification per reference. A provider that calls back twice must update
-- one row, not create ambiguity about which one it meant.
create unique index if not exists notification_events_correlation_unique
  on public.notification_events (correlation_id)
  where correlation_id is not null;

-- The callback quotes the provider's id; support quotes it back.
create index if not exists notification_events_provider_message_idx
  on public.notification_events (provider_message_id)
  where provider_message_id is not null;

create index if not exists notification_events_delivery_status_idx
  on public.notification_events (delivery_status, delivery_updated_at desc)
  where delivery_status is not null;


-- ---------------------------------------------------------------------------
-- Recording a send, now with the correlation reference
-- ---------------------------------------------------------------------------
-- Adding a parameter to a plpgsql function with defaults creates an OVERLOAD,
-- it does not replace anything. Two earlier signatures were already sitting
-- here, and a third would leave PostgREST choosing between them by argument
-- name — which resolves fine until the day it does not. Nothing calls the old
-- ones, so they go.
drop function if exists public.record_notification(
  text, text, text, text, boolean, text, text, text, uuid, uuid
);
drop function if exists public.record_notification(
  text, text, text, text, boolean, text, text, text, uuid, uuid, text
);

create or replace function public.record_notification(
  p_event               text,
  p_audience            text,
  p_channel             text,
  p_recipient           text,
  p_succeeded           boolean,
  p_provider            text default null,
  p_provider_message_id text default null,
  p_error               text default null,
  p_order_id            uuid default null,
  p_user_id             uuid default null,
  p_dedupe_key          text default null,
  p_correlation_id      text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform public.assert_service_or_admin();

  insert into public.notification_events (
    event, audience, channel, user_id, order_id, recipient,
    succeeded, provider, provider_message_id, error, dedupe_key, correlation_id
  )
  values (
    p_event, p_audience, coalesce(p_channel, 'SMS'), p_user_id, p_order_id, p_recipient,
    p_succeeded, p_provider, p_provider_message_id, p_error, p_dedupe_key, p_correlation_id
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;  -- null when it was a duplicate
end;
$$;

revoke execute on function public.record_notification(
  text, text, text, text, boolean, text, text, text, uuid, uuid, text, text
) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The append-only guard, narrowed rather than removed
-- ---------------------------------------------------------------------------
-- notification_events is append-only, and it should stay that way: it is the
-- record of who was told what, and when, and it is what support reads when a
-- customer says a code never arrived. Nobody gets to rewrite that.
--
-- But a delivery report is not a rewrite. It is new information about a row
-- that already exists, arriving minutes later from the provider, and the blanket
-- BEFORE UPDATE trigger blocks it along with everything else.
--
-- So the guard is narrowed to exactly what it was protecting. DELETE stays
-- forbidden. UPDATE is permitted only when the ONLY columns that changed are
-- the three the provider's report fills in — and provider_message_id may be
-- filled in once, never changed to something else. Every other column, and the
-- history they represent, remains immutable.
create or replace function public.notification_events_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notification_events is append-only; DELETE is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if (to_jsonb(new) - 'delivery_status' - 'delivery_updated_at' - 'provider_message_id')
     is distinct from
     (to_jsonb(old) - 'delivery_status' - 'delivery_updated_at' - 'provider_message_id')
  then
    raise exception
      'notification_events is append-only; only a provider delivery report may be added'
      using errcode = 'insufficient_privilege';
  end if;

  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id
  then
    raise exception
      'notification_events is append-only; provider_message_id cannot be rewritten'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

revoke execute on function public.notification_events_append_only() from public, anon, authenticated;

drop trigger if exists notification_events_append_only on public.notification_events;
create trigger notification_events_append_only
  before delete or update on public.notification_events
  for each row execute function public.notification_events_append_only();


-- ---------------------------------------------------------------------------
-- Applying a delivery report
-- ---------------------------------------------------------------------------
-- Idempotent by construction: it is a conditional UPDATE keyed on the
-- correlation reference, so the same callback delivered five times sets the
-- same row to the same value five times and reports the same answer.
--
-- An unmatched reference is NOT an error. A provider may call back about a
-- message this deployment never sent — a stale reference after a database
-- reset, or someone else's traffic pointed at our URL. Saying "no match" lets
-- the caller log it and return 200 rather than inviting an infinite retry loop
-- over a message that will never exist.
create or replace function public.record_sms_delivery_status(
  p_provider            text,
  p_correlation_id      text,
  p_status              text,
  p_provider_message_id text default null
)
returns table (matched boolean, notification_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform public.assert_service_or_admin();

  if p_correlation_id is null or p_status is null then
    return query select false, null::bigint;
    return;
  end if;

  -- Matched on the correlation reference ALONE. It is a UUID we generated and
  -- handed to exactly one provider, so it identifies the message on its own;
  -- and the caller has already proved which provider it is by signature.
  --
  -- It deliberately does NOT also filter on provider name. That looked like a
  -- sensible extra guard and was a bug: a message sent through one provider and
  -- reported while another is configured — which is every development run,
  -- where sends go through the fake provider — silently matched nothing and
  -- reported success.
  update public.notification_events
     set delivery_status     = p_status,
         delivery_updated_at = now(),
         -- Write-once, and the EXISTING value wins. The append-only guard
         -- refuses to let a recorded provider id be changed to a different one,
         -- so the coalesce has to agree with it: a report fills this in when
         -- the send did not record one (Arkesel v1 returns no id), and leaves
         -- it alone when the send did. Written the other way round, every
         -- report for a message that already had an id raised and came back a
         -- 500 — which is exactly how this was found.
         provider_message_id = coalesce(provider_message_id, p_provider_message_id)
   where correlation_id = p_correlation_id
  returning id into v_id;

  return query select v_id is not null, v_id;
end;
$$;

revoke execute on function public.record_sms_delivery_status(text, text, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Operational visibility
-- ---------------------------------------------------------------------------
-- The admin notification log already exists; this adds the one question the
-- delivery report makes answerable — what actually failed to arrive.
create or replace function public.admin_undelivered_notifications(p_limit integer default 100)
returns table (
  id                  bigint,
  event               text,
  audience            text,
  recipient           text,
  order_id            uuid,
  provider            text,
  provider_message_id text,
  delivery_status     text,
  delivery_updated_at timestamptz,
  created_at          timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.event, n.audience, n.recipient, n.order_id, n.provider,
         n.provider_message_id, n.delivery_status, n.delivery_updated_at, n.created_at
    from public.notification_events n
   where public.is_admin()
     and n.channel = 'SMS'
     and n.succeeded
     and n.delivery_status is not null
     and n.delivery_status <> 'DELIVERED'
   order by n.delivery_updated_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke execute on function public.admin_undelivered_notifications(integer) from public, anon;
grant  execute on function public.admin_undelivered_notifications(integer) to authenticated;
