-- ============================================================================
-- Admin audit log — APPEND ONLY
-- ============================================================================
-- Every manual administrative override lands here. The table is append-only at
-- the database level: even a compromised admin session cannot rewrite history,
-- because UPDATE and DELETE are blocked by a trigger regardless of privilege.
-- ============================================================================

create table public.admin_actions (
  id            bigserial primary key,

  admin_user_id uuid not null references public.users (id) on delete restrict,
  action        text not null,

  target_type   text not null,
  target_id     uuid,

  -- Required. An override without a stated reason is not auditable, so the
  -- database refuses it.
  reason        text not null check (length(btrim(reason)) >= 3),

  -- Before/after snapshot of whatever changed.
  before_state  jsonb,
  after_state   jsonb,
  details       jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now()
);

create index admin_actions_admin_idx  on public.admin_actions (admin_user_id, created_at desc);
create index admin_actions_target_idx on public.admin_actions (target_type, target_id, created_at desc);
create index admin_actions_created_idx on public.admin_actions (created_at desc);

create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger admin_actions_append_only
  before update or delete on public.admin_actions
  for each row execute function public.forbid_mutation();

-- The transition log is evidence too. Rejected transitions especially.
create trigger order_events_append_only
  before update or delete on public.order_events
  for each row execute function public.forbid_mutation();
