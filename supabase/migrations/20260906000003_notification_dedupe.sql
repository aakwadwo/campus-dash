-- ============================================================================
-- Notification deduplication
-- ============================================================================
-- Server actions retry. Pages revalidate. A vendor taps ACCEPT twice on a bad
-- connection. Until now every one of those could put a second identical SMS in
-- somebody's pocket — which in Ghana costs real money and reads, to the
-- recipient, like the system is broken.
--
-- A notification is identified by what it IS: this event, for this order, to
-- this recipient. Sending the same one twice is a duplicate regardless of how
-- many times the code path ran.
-- ============================================================================

alter table public.notification_events
  add column if not exists dedupe_key text;

-- Successful sends are unique. Failures are deliberately NOT covered: a failed
-- send must be retryable, and each attempt is worth recording.
create unique index if not exists notification_events_dedupe_unique
  on public.notification_events (dedupe_key)
  where dedupe_key is not null and succeeded;

create or replace function public.record_notification(
  p_event    text,
  p_audience text,
  p_channel  text,
  p_recipient text,
  p_succeeded boolean,
  p_provider text default null,
  p_provider_message_id text default null,
  p_error    text default null,
  p_order_id uuid default null,
  p_user_id  uuid default null,
  p_dedupe_key text default null
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
    succeeded, provider, provider_message_id, error, dedupe_key
  )
  values (
    p_event, p_audience, coalesce(p_channel, 'SMS'), p_user_id, p_order_id, p_recipient,
    p_succeeded, p_provider, p_provider_message_id, p_error, p_dedupe_key
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;  -- null when it was a duplicate
end;
$$;

-- ---------------------------------------------------------------------------
-- Asked BEFORE sending, not after
-- ---------------------------------------------------------------------------
-- Logging a duplicate after the fact is useless: the money is spent and the
-- phone has buzzed. This is what the sender checks first.
create or replace function public.notification_already_sent(p_dedupe_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.notification_events
     where dedupe_key = p_dedupe_key and succeeded
  );
$$;

-- Failed sends still worth retrying, for an operator or a retry job.
create or replace function public.admin_failed_notifications(p_limit integer default 100)
returns table (
  id          bigint,
  event       text,
  audience    text,
  recipient   text,
  order_id    uuid,
  error       text,
  attempts    bigint,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.event, n.audience, n.recipient, n.order_id, n.error,
         (select count(*) from public.notification_events a
           where a.dedupe_key is not distinct from n.dedupe_key),
         n.created_at
    from public.notification_events n
   where public.is_admin()
     and not n.succeeded
     -- Nothing to chase if a later attempt got through.
     and not exists (
       select 1 from public.notification_events s
        where s.dedupe_key = n.dedupe_key and s.succeeded
     )
   order by n.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

revoke execute on function public.record_notification(
  text, text, text, text, boolean, text, text, text, uuid, uuid, text
) from public, anon, authenticated;
revoke execute on function public.notification_already_sent(text) from public, anon, authenticated;
revoke execute on function public.admin_failed_notifications(integer) from public, anon;
grant execute on function public.admin_failed_notifications(integer) to authenticated;
