-- ============================================================================
-- Money: payments, allocations, settlement, payouts, idempotency
-- ============================================================================
-- Deliberately provider-agnostic. Whether the provider splits the money itself
-- (Option A) or we collect centrally and transfer out later (Option B), the
-- shape below is unchanged — only which rows get written, and when.
-- See docs/OPEN-QUESTIONS.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Payments — one row per collection attempt against the provider
-- ---------------------------------------------------------------------------
create table public.payments (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid not null references public.orders (id) on delete restrict,

  provider                text not null,
  provider_transaction_id text,

  amount_pesewas          bigint not null check (amount_pesewas > 0),
  currency                text not null default 'GHS' check (currency = 'GHS'),

  status                  public.payment_txn_status not null default 'PENDING',

  -- Retrying a payment request with the same key must never create a second
  -- charge. Enforced by the unique index below, not by application logic.
  idempotency_key         text not null,

  failure_reason          text,
  raw                     jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  succeeded_at            timestamptz
);

create unique index payments_idempotency_key_unique on public.payments (idempotency_key);

-- === CONSTRAINT: only one LIVE payment intent per order =====================
create unique index payments_one_pending_per_order
  on public.payments (order_id) where status = 'PENDING';

-- === CONSTRAINT: an order can only be paid once =============================
create unique index payments_one_succeeded_per_order
  on public.payments (order_id) where status = 'SUCCEEDED';

create unique index payments_provider_txn_unique
  on public.payments (provider, provider_transaction_id)
  where provider_transaction_id is not null;

create index payments_order_idx on public.payments (order_id, created_at desc);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Allocations — who the money belongs to
-- ---------------------------------------------------------------------------
-- This is the internal ledger, and it is SEPARATE from how the provider
-- actually moves funds. It answers "how much belongs to Vendor X?" regardless
-- of which settlement mechanism we end up with.
--
-- Campus Dash does NOT operate a vendor wallet. A vendor sees earned-today and
-- past settlements — never an open-ended stored balance.
create table public.allocations (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete restrict,

  payee_type     public.payee_type not null,
  -- NULL for PLATFORM, which is not a user or vendor row.
  payee_id       uuid,

  amount_pesewas bigint not null check (amount_pesewas >= 0),
  status         public.allocation_status not null default 'PENDING',

  settlement_run_id uuid,
  settled_at        timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint allocations_payee_id_presence check (
    (payee_type = 'PLATFORM' and payee_id is null)
    or (payee_type <> 'PLATFORM' and payee_id is not null)
  )
);

-- One allocation per payee per order. Re-running allocation is a no-op, not a
-- duplicate payout.
create unique index allocations_order_payee_unique
  on public.allocations (order_id, payee_type, coalesce(payee_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index allocations_payee_idx on public.allocations (payee_type, payee_id, status);
create index allocations_settlement_idx on public.allocations (settlement_run_id)
  where settlement_run_id is not null;

create trigger allocations_set_updated_at
  before update on public.allocations
  for each row execute function public.set_updated_at();

-- === MONEY SAFETY: allocations for an order must sum to the order total =====
-- Deferred so a multi-row allocation insert is checked once, at commit, rather
-- than transiently mid-statement.
create or replace function public.check_allocations_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_total    bigint;
  v_sum      bigint;
begin
  select total_pesewas into v_total from public.orders where id = v_order_id;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where order_id = v_order_id and status <> 'CANCELLED';

  -- Zero allocations is legal: the order simply has not been paid yet.
  if v_sum <> 0 and v_sum <> v_total then
    raise exception
      'allocations for order % sum to % but order total is %', v_order_id, v_sum, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger allocations_must_balance
  after insert or update or delete on public.allocations
  deferrable initially deferred
  for each row execute function public.check_allocations_balance();

-- ---------------------------------------------------------------------------
-- Settlement runs — vendors daily, Partners weekly
-- ---------------------------------------------------------------------------
create table public.settlement_runs (
  id            uuid primary key default gen_random_uuid(),
  payee_type    public.payee_type not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  status        public.settlement_run_status not null default 'OPEN',

  total_pesewas bigint not null default 0 check (total_pesewas >= 0),

  created_by    uuid references public.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,

  constraint settlement_runs_period_ordered check (period_end > period_start)
);

-- One run per payee type per period. Re-running a day's vendor settlement
-- cannot silently create a second run that pays everyone twice.
create unique index settlement_runs_period_unique
  on public.settlement_runs (payee_type, period_start, period_end);

create trigger settlement_runs_set_updated_at
  before update on public.settlement_runs
  for each row execute function public.set_updated_at();

alter table public.allocations
  add constraint allocations_settlement_run_fk
  foreign key (settlement_run_id) references public.settlement_runs (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Payouts — money actually leaving the platform
-- ---------------------------------------------------------------------------
create table public.payouts (
  id                   uuid primary key default gen_random_uuid(),
  settlement_run_id    uuid not null references public.settlement_runs (id) on delete restrict,

  payee_type           public.payee_type not null,
  payee_id             uuid not null,

  amount_pesewas       bigint not null check (amount_pesewas > 0),
  currency             text not null default 'GHS' check (currency = 'GHS'),

  status               public.payout_status not null default 'PENDING',

  provider             text,
  provider_transfer_id text,
  idempotency_key      text not null,
  failure_reason       text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  paid_at              timestamptz
);

-- === CONSTRAINT: a payee is paid at most once per settlement run =============
create unique index payouts_run_payee_unique
  on public.payouts (settlement_run_id, payee_type, payee_id);

-- === CONSTRAINT: repeated payout requests cannot duplicate a transfer ========
create unique index payouts_idempotency_key_unique on public.payouts (idempotency_key);

create unique index payouts_provider_transfer_unique
  on public.payouts (provider, provider_transfer_id)
  where provider_transfer_id is not null;

create index payouts_payee_idx on public.payouts (payee_type, payee_id, created_at desc);

create trigger payouts_set_updated_at
  before update on public.payouts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook events — deduplication
-- ---------------------------------------------------------------------------
-- Providers retry. A webhook delivered five times must move money once.
create table public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  -- The provider's own stable event id. This is the deduplication anchor.
  event_id     text not null,

  status       public.webhook_event_status not null default 'RECEIVED',
  signature_valid boolean not null default false,

  payload      jsonb not null,
  error        text,

  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

create unique index webhook_events_provider_event_unique
  on public.webhook_events (provider, event_id);

create index webhook_events_status_idx on public.webhook_events (status, received_at desc);

-- ---------------------------------------------------------------------------
-- Idempotency keys — general-purpose request replay protection
-- ---------------------------------------------------------------------------
create table public.idempotency_keys (
  key            text primary key,
  scope          text not null,
  user_id        uuid references public.users (id) on delete set null,

  -- Hash of the request body. A key reused with DIFFERENT parameters is a bug
  -- or an attack, not a retry, and must be rejected rather than replayed.
  request_hash   text not null,
  response       jsonb,
  status         text not null default 'IN_PROGRESS',

  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  expires_at     timestamptz not null default (now() + interval '24 hours')
);

create index idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);
