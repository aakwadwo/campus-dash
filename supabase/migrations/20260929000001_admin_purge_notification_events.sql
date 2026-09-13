-- A controlled, administrator-only way to purge delivery-log rows.
--
-- WHY THIS HAS TO EXIST AT ALL. notification_events is append-only, and that is
-- right: a delivery log you can quietly delete from is not evidence of anything.
-- But the protection is absolute, and its FKs to users and orders are SET NULL —
-- which is itself an UPDATE the trigger rejects. So a single logged message
-- pins the account and the order it names, permanently. Clearing pilot test data
-- was impossible without either disabling the trigger or truncating, and both of
-- those trade a real safety property for a one-off convenience.
--
-- WHAT THIS DOES INSTEAD. The trigger keeps refusing every DELETE except one it
-- can positively identify as an audited administrative purge, marked by a
-- TRANSACTION-LOCAL flag that only the function below sets. Outside that
-- function the table behaves exactly as it did.
--
-- WHY THE FLAG IS NOT A BACK DOOR:
--
--   * `anon` and `authenticated` hold NO privileges on notification_events at
--     all — not even SELECT — so no client can reach a DELETE to exploit the
--     flag with. The only roles that can are the ones that already bypass
--     everything.
--   * The flag is set with `set_config(..., true)` — transaction-local. It
--     cannot leak into a later statement, a later request, or a pooled session.
--   * The function re-checks is_admin() in its own body, which reads
--     public.users on every call. Holding EXECUTE is not authority.
--   * It is SCOPED. It takes the exact users and orders to forget and refuses
--     an empty call, so there is no "delete everything" shape to reach for.
--   * It is AUDITED to admin_actions, which is itself append-only. A purge
--     leaves a record of who did it and why, naming the counts.

create or replace function public.notification_events_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- The one permitted exception: an audited administrative purge, in progress
    -- in THIS transaction. See admin_purge_notification_events().
    if coalesce(current_setting('campus_dash.notification_purge', true), '') = 'on' then
      return old;
    end if;
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

comment on function public.notification_events_append_only() is
  'Keeps notification_events append-only. DELETE is refused unless an audited administrative purge is in progress in the same transaction — a transaction-local flag only admin_purge_notification_events() sets. UPDATE remains limited to provider delivery fields, with no exception at all.';

-- order_events carries the same protection through the SHARED forbid_mutation()
-- trigger, which also guards admin_actions. Giving order_events its own guard
-- lets a pilot reset clear order history while leaving the ADMINISTRATOR'S
-- AUDIT TRAIL absolutely immutable — admin_actions keeps forbid_mutation() and
-- gains no exception whatsoever, which is the point of having one.
create or replace function public.order_events_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('campus_dash.notification_purge', true), '') = 'on' then
      return old;
    end if;
  end if;
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.order_events_append_only() is
  'Keeps order_events append-only. DELETE is refused unless an audited administrative purge is in progress in the same transaction. UPDATE and INSERT-over are refused unconditionally. admin_actions deliberately does NOT share this exception.';

-- A trigger function is not an API. Postgres grants EXECUTE to PUBLIC on new
-- functions by default, and the allowlist test in tests/schema.test.js exists to
-- catch exactly that — the other two guards are revoked the same way.
revoke execute on function public.order_events_append_only() from public, anon, authenticated;

drop trigger if exists order_events_append_only on public.order_events;
drop trigger if exists forbid_order_events_mutation on public.order_events;
create trigger order_events_append_only
  before update or delete on public.order_events
  for each row execute function public.order_events_append_only();

/**
 * Forget the delivery log and order history for specific accounts and orders.
 *
 * Scoped on purpose: it takes the ids to forget rather than a date or a
 * predicate, so it cannot become "clear the log". An empty call is refused
 * rather than treated as "everything".
 */
create or replace function public.admin_purge_test_history(
  p_user_ids  uuid[] default '{}',
  p_order_ids uuid[] default '{}',
  p_reason    text   default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_users  uuid[] := coalesce(p_user_ids, '{}');
  v_orders uuid[] := coalesce(p_order_ids, '{}');
  v_reason text   := nullif(btrim(coalesce(p_reason, '')), '');
  v_count  integer;
  v_events integer := 0;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = 'insufficient_privilege';
  end if;

  -- No ids is not "all rows". A purge has to name what it is forgetting.
  if array_length(v_users, 1) is null and array_length(v_orders, 1) is null then
    raise exception 'name the accounts or orders to purge' using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  -- Transaction-local, and the only thing that opens the trigger's one door.
  perform set_config('campus_dash.notification_purge', 'on', true);

  delete from public.notification_events
   where (user_id  = any(v_users))
      or (order_id = any(v_orders));
  get diagnostics v_count = row_count;

  -- The order's own history, so the order itself can then be removed. Scoped to
  -- the named orders; an account with no orders named clears nothing here.
  delete from public.order_events where order_id = any(v_orders);
  get diagnostics v_events = row_count;

  -- Shut it again immediately. The flag would die with the transaction anyway;
  -- closing it here means the rest of this transaction cannot delete more.
  perform set_config('campus_dash.notification_purge', 'off', true);

  perform public.log_admin_action(
    'TEST_HISTORY_PURGED',
    'notification_events',
    null,
    v_reason,
    null,
    null,
    jsonb_build_object(
      'notification_rows_deleted', v_count,
      'order_event_rows_deleted', v_events,
      'user_ids', to_jsonb(v_users),
      'order_ids', to_jsonb(v_orders)
    )
  );

  return v_count;
end;
$$;

comment on function public.admin_purge_test_history(uuid[], uuid[], text) is
  'Deletes delivery-log and order-history rows for the named accounts and orders. Administrator only, re-checked in the body; refuses an empty target list and a missing reason; audited to admin_actions. The only thing that may delete from notification_events or order_events. admin_actions itself has no such escape.';

revoke execute on function public.admin_purge_test_history(uuid[], uuid[], text) from public, anon;
grant  execute on function public.admin_purge_test_history(uuid[], uuid[], text) to authenticated;

drop function if exists public.admin_purge_notification_events(uuid[], uuid[], text);
