-- ============================================================================
-- Terms acceptance, and a record of what we actually sent
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Terms
-- ---------------------------------------------------------------------------
-- Versioned documents, and an acceptance records WHICH version. A bare checkbox
-- proves nothing later: the question is always "what did they agree to, and
-- when", and only a version answers it.
create type public.terms_audience as enum ('CUSTOMER', 'VENDOR', 'PARTNER');

create table public.terms_documents (
  id           uuid primary key default gen_random_uuid(),
  audience     public.terms_audience not null,
  version      integer not null check (version > 0),
  title        text not null,
  body         text not null,
  -- Null until published; published documents are never edited, only superseded.
  published_at timestamptz,
  created_at   timestamptz not null default now()
);

create unique index terms_documents_audience_version_unique
  on public.terms_documents (audience, version);

-- One current document per audience.
create unique index terms_documents_one_current
  on public.terms_documents (audience)
  where published_at is not null and version is not null;

drop index if exists terms_documents_one_current;

create table public.terms_acceptances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  terms_id     uuid not null references public.terms_documents (id) on delete restrict,
  audience     public.terms_audience not null,
  version      integer not null,
  accepted_at  timestamptz not null default now()
);

-- Accepting the same version twice is one fact, not two.
create unique index terms_acceptances_user_version_unique
  on public.terms_acceptances (user_id, audience, version);

create index terms_acceptances_user_idx on public.terms_acceptances (user_id, audience);

-- The document a user must currently have accepted for a given role.
create or replace function public.current_terms(p_audience public.terms_audience)
returns table (terms_id uuid, audience public.terms_audience, version integer, title text, body text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.audience, t.version, t.title, t.body
    from public.terms_documents t
   where t.audience = p_audience and t.published_at is not null
   order by t.version desc
   limit 1;
$$;

-- Which roles the signed-in user still owes an acceptance for. Empty means
-- nothing to do — the point being that a user is NOT asked on every login,
-- only when a version they have not accepted is published.
create or replace function public.my_outstanding_terms()
returns table (audience public.terms_audience, version integer, title text)
language sql
stable
security definer
set search_path = ''
as $$
  with required as (
    select 'CUSTOMER'::public.terms_audience as audience
     where auth.uid() is not null
    union all
    select 'VENDOR'::public.terms_audience
     where exists (select 1 from public.vendor_users vu where vu.user_id = auth.uid())
    union all
    select 'PARTNER'::public.terms_audience
     where exists (
       select 1 from public.partner_profiles p
        where p.user_id = auth.uid() and p.status = 'APPROVED'
     )
  ),
  current_docs as (
    select distinct on (t.audience) t.audience, t.version, t.title
      from public.terms_documents t
     where t.published_at is not null
     order by t.audience, t.version desc
  )
  select c.audience, c.version, c.title
    from required r
    join current_docs c on c.audience = r.audience
   where not exists (
     select 1 from public.terms_acceptances a
      where a.user_id = auth.uid() and a.audience = c.audience and a.version = c.version
   );
$$;

create or replace function public.accept_terms(p_terms_id uuid)
returns public.terms_acceptances
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc        public.terms_documents%rowtype;
  v_acceptance public.terms_acceptances%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null then
    raise exception 'those terms are not available to accept' using errcode = 'no_data_found';
  end if;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (auth.uid(), v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version) do update set accepted_at = public.terms_acceptances.accepted_at
  returning * into v_acceptance;

  return v_acceptance;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notification log
-- ---------------------------------------------------------------------------
-- Answers: what was sent, to whom, when, and did it work. Enough to chase "I
-- never got a code" without becoming an analytics product.
--
-- The recipient is stored as the phone number because that IS the address, and
-- an SMS log without it cannot answer the only question anyone asks of it.
create table public.notification_events (
  id            bigserial primary key,
  event         text not null,
  audience      text not null,
  channel       text not null default 'SMS',

  user_id       uuid references public.users (id) on delete set null,
  order_id      uuid references public.orders (id) on delete set null,
  recipient     text,

  succeeded     boolean not null,
  provider      text,
  provider_message_id text,
  error         text,

  created_at    timestamptz not null default now()
);

create index notification_events_order_idx on public.notification_events (order_id, created_at desc);
create index notification_events_failed_idx on public.notification_events (created_at desc)
  where not succeeded;
create index notification_events_recipient_idx on public.notification_events (recipient, created_at desc);

-- Append-only: a delivery record you can edit is not a record.
create trigger notification_events_append_only
  before update or delete on public.notification_events
  for each row execute function public.forbid_mutation();

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
  p_user_id  uuid default null
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
    succeeded, provider, provider_message_id, error
  )
  values (
    p_event, p_audience, coalesce(p_channel, 'SMS'), p_user_id, p_order_id, p_recipient,
    p_succeeded, p_provider, p_provider_message_id, p_error
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.admin_notification_log(p_limit integer default 100)
returns setof public.notification_events
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.notification_events
   where public.is_admin()
   order by created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.terms_documents     enable row level security;
alter table public.terms_acceptances   enable row level security;
alter table public.notification_events enable row level security;

-- Terms are meant to be read before you agree to them.
grant select on public.terms_documents to anon, authenticated;
create policy terms_documents_read_published on public.terms_documents
  for select to anon, authenticated using (published_at is not null or public.is_admin());

grant select on public.terms_acceptances to authenticated;
create policy terms_acceptances_read_own on public.terms_acceptances
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- notification_events: no grant at all. It contains phone numbers and message
-- content, and is read through admin_notification_log().

revoke execute on function public.record_notification(text, text, text, text, boolean, text, text, text, uuid, uuid)
  from public, anon, authenticated;

revoke execute on function public.current_terms(public.terms_audience) from public;
revoke execute on function public.my_outstanding_terms() from public, anon;
revoke execute on function public.accept_terms(uuid) from public, anon;
revoke execute on function public.admin_notification_log(integer) from public, anon;

grant execute on function public.current_terms(public.terms_audience) to anon, authenticated;
grant execute on function public.my_outstanding_terms()   to authenticated;
grant execute on function public.accept_terms(uuid)       to authenticated;
grant execute on function public.admin_notification_log(integer) to authenticated;
