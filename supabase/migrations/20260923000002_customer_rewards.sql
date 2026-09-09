-- ============================================================================
-- CUSTOMER REWARDS
-- ============================================================================
-- An order count with three marks on it, and nothing else. Not points, not a
-- wallet, not tiers — those all need rules about expiry, transfer and value,
-- and Campus Dash has none of those questions answered. What it has is a number
-- that goes up when somebody actually receives an order.
--
-- COMPLETED ONLY. The count is a COUNT over orders in order_status COMPLETED,
-- which is the one state that means the customer got their food. Cancelled,
-- rejected and expired orders are not in it because they are not that state —
-- there is no separate ledger to keep in step, and therefore nothing that can
-- drift, double-count or need repair.
--
-- The reward row is the only thing that is written, and it exists so that
-- reaching 50 is a fact with a timestamp somebody can act on rather than a
-- number that happened to be shown on a screen once.

create or replace function public.customer_reward_milestones() returns integer[]
  language sql immutable
as $$ select array[25, 40, 50]::integer[]; $$;

alter function public.customer_reward_milestones() owner to postgres;
comment on function public.customer_reward_milestones() is
  'The marks on the progress bar, ascending. The LAST one is the goal — reaching it is what creates a customer_rewards row.';
revoke all on function public.customer_reward_milestones() from public;
grant execute on function public.customer_reward_milestones() to authenticated, service_role;

create table if not exists public.customer_rewards (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  -- Which run of the goal this is. The first 50 completed orders make cycle 1,
  -- the next 50 make cycle 2. Unique per user, which is the whole duplicate
  -- guard: the 51st order computes cycle 1 again and the insert does nothing.
  cycle        integer not null,
  goal_orders  integer not null,
  completed_orders_at_unlock integer not null,
  status       text not null default 'UNLOCKED',
  unlocked_at  timestamptz not null default now(),
  fulfilled_at timestamptz,
  fulfilled_by uuid references public.users(id),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint customer_rewards_cycle_check  check (cycle > 0),
  constraint customer_rewards_goal_check   check (goal_orders > 0),
  constraint customer_rewards_status_check check (status in ('UNLOCKED', 'FULFILLED', 'CANCELLED')),
  constraint customer_rewards_fulfilled_pair
    check ((status = 'FULFILLED') = (fulfilled_at is not null)),
  constraint customer_rewards_user_cycle_unique unique (user_id, cycle)
);

alter table public.customer_rewards owner to postgres;
alter table public.customer_rewards enable row level security;

comment on table public.customer_rewards is
  'One row per customer per completed run of the order goal. Reaching the goal writes it once; every order after that finds the row already there. Campus Dash decides what the reward actually is — this records only that somebody qualified.';

create index if not exists customer_rewards_user_idx
  on public.customer_rewards (user_id, unlocked_at desc);
create index if not exists customer_rewards_open_idx
  on public.customer_rewards (unlocked_at desc) where status = 'UNLOCKED';

drop trigger if exists set_updated_at on public.customer_rewards;
create trigger set_updated_at before update on public.customer_rewards
  for each row execute function public.set_updated_at();

-- A customer reads their own; an administrator reads all. Nobody writes: the
-- row is created by a trigger and changed only through an admin function.
create policy customer_rewards_read_self on public.customer_rewards
  for select to authenticated using (user_id = auth.uid());
create policy customer_rewards_read_admin on public.customer_rewards
  for select to authenticated using (public.is_admin());

grant select on public.customer_rewards to authenticated;

-- ---------------------------------------------------------------------------
-- The award
-- ---------------------------------------------------------------------------
-- A trigger, not a call inside each completion function. There are three ways
-- an order reaches COMPLETED — partner_complete_delivery, the vendor's
-- self-collection, and an administrator's override — and a fourth will arrive
-- eventually. The trigger cannot be forgotten by any of them.

create or replace function public.orders_award_customer_reward() returns trigger
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_goal      integer;
  v_completed integer;
  v_cycle     integer;
begin
  v_goal := (public.customer_reward_milestones())[array_length(public.customer_reward_milestones(), 1)];

  select count(*) into v_completed
    from public.orders
   where customer_id = new.customer_id
     and order_status = 'COMPLETED';

  v_cycle := v_completed / v_goal;
  if v_cycle < 1 then
    return null;
  end if;

  -- ON CONFLICT DO NOTHING is the duplicate guard, and it is the unique index
  -- doing the work rather than a read-then-write that two concurrent
  -- completions could both pass.
  insert into public.customer_rewards (user_id, cycle, goal_orders, completed_orders_at_unlock)
  values (new.customer_id, v_cycle, v_goal, v_completed)
  on conflict (user_id, cycle) do nothing;

  return null;
end;
$$;

alter function public.orders_award_customer_reward() owner to postgres;
revoke all on function public.orders_award_customer_reward() from public;

drop trigger if exists orders_award_customer_reward on public.orders;
create trigger orders_award_customer_reward
  after update of order_status on public.orders
  for each row
  when (new.order_status = 'COMPLETED' and old.order_status is distinct from 'COMPLETED')
  execute function public.orders_award_customer_reward();

-- ---------------------------------------------------------------------------
-- Reading it
-- ---------------------------------------------------------------------------

create or replace function public.my_reward_progress()
  returns table(
    completed_orders integer,
    goal_orders integer,
    milestones integer[],
    milestones_reached integer[],
    next_milestone integer,
    orders_to_next integer,
    reward_unlocked boolean,
    reward_unlocked_at timestamptz,
    reward_status text
  )
  language sql stable security definer
  set search_path to ''
as $$
  with counted as (
    select (select count(*)::integer from public.orders o
             where o.customer_id = auth.uid() and o.order_status = 'COMPLETED') as done,
           public.customer_reward_milestones() as marks
  ),
  shaped as (
    select done, marks,
           marks[array_length(marks, 1)] as goal,
           array(select m from unnest(marks) m where m <= done order by m) as reached,
           (select min(m) from unnest(marks) m where m > done) as next
      from counted
  ),
  latest as (
    select r.unlocked_at, r.status
      from public.customer_rewards r
     where r.user_id = auth.uid()
     order by r.cycle desc
     limit 1
  )
  select s.done, s.goal, s.marks, s.reached, s.next,
         case when s.next is not null then s.next - s.done end,
         l.unlocked_at is not null,
         l.unlocked_at,
         l.status
    from shaped s
    left join latest l on true
   where auth.uid() is not null;
$$;

alter function public.my_reward_progress() owner to postgres;
comment on function public.my_reward_progress() is
  'The customer''s own progress towards the order goal. Counts COMPLETED orders and nothing else, so there is no second number that can disagree with the order list.';
revoke all on function public.my_reward_progress() from public;
grant execute on function public.my_reward_progress() to authenticated;

-- ---------------------------------------------------------------------------
-- What an administrator sees
-- ---------------------------------------------------------------------------

create or replace function public.admin_customer_rewards(p_status text default 'UNLOCKED', p_limit integer default 100)
  returns table(
    reward_id uuid, user_id uuid, customer_name text, email text, phone text,
    cycle integer, goal_orders integer, completed_orders integer,
    status text, unlocked_at timestamptz, fulfilled_at timestamptz, notes text
  )
  language sql stable security definer
  set search_path to ''
as $$
  select r.id, r.user_id, u.full_name, u.email, u.phone,
         r.cycle, r.goal_orders,
         (select count(*)::integer from public.orders o
           where o.customer_id = r.user_id and o.order_status = 'COMPLETED'),
         r.status, r.unlocked_at, r.fulfilled_at, r.notes
    from public.customer_rewards r
    join public.users u on u.id = r.user_id
   where public.is_admin()
     and (p_status is null or r.status = p_status)
   order by r.unlocked_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

alter function public.admin_customer_rewards(text, integer) owner to postgres;
revoke all on function public.admin_customer_rewards(text, integer) from public;
grant execute on function public.admin_customer_rewards(text, integer) to authenticated;

create or replace function public.admin_settle_customer_reward(p_reward_id uuid, p_notes text)
  returns public.customer_rewards
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_row public.customer_rewards%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'say what was given' using errcode = 'check_violation';
  end if;

  update public.customer_rewards
     set status = 'FULFILLED', fulfilled_at = now(), fulfilled_by = auth.uid(),
         notes = btrim(p_notes)
   where id = p_reward_id and status = 'UNLOCKED'
  returning * into v_row;

  if not found then
    raise exception 'that reward is not open' using errcode = 'check_violation';
  end if;

  perform public.log_admin_action('SETTLE_CUSTOMER_REWARD', 'customer_reward', p_reward_id,
    btrim(p_notes), jsonb_build_object('user_id', v_row.user_id, 'cycle', v_row.cycle));

  return v_row;
end;
$$;

alter function public.admin_settle_customer_reward(uuid, text) owner to postgres;
revoke all on function public.admin_settle_customer_reward(uuid, text) from public;
grant execute on function public.admin_settle_customer_reward(uuid, text) to authenticated;

-- The customer screens an administrator already uses, now carrying the same
-- number the customer sees. Nothing new to reconcile: both count COMPLETED.
drop function if exists public.admin_customer_detail(uuid);

create or replace function public.admin_customer_detail(p_user_id uuid)
  returns table(
    user_id uuid, full_name text, first_name text, last_name text,
    phone text, email text,
    student_id_number text, level text, is_suspended boolean, is_admin boolean,
    onboarded_at timestamptz, created_at timestamptz,
    partner_status text, partner_applied_at timestamptz,
    vendor_names text[], order_count bigint, completed_count bigint,
    spent_pesewas bigint,
    reward_goal integer, reward_status text, reward_unlocked_at timestamptz,
    recent_orders jsonb
  )
  language sql stable security definer
  set search_path to ''
as $$
  select u.id, u.full_name, u.first_name, u.last_name, u.phone, u.email,
         c.student_id_number, c.level,
         u.is_suspended, u.is_admin, c.onboarded_at, u.created_at,
         coalesce(p.status::text, 'NOT_APPLIED'), p.applied_at,
         coalesce((select array_agg(v.name order by v.name)
                     from public.vendors v where v.owner_user_id = u.id), '{}'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select coalesce(sum(pay.amount_pesewas),0)::bigint
            from public.payments pay
            join public.orders o on o.id = pay.order_id
           where o.customer_id = u.id and pay.status = 'SUCCEEDED'),
         (public.customer_reward_milestones())[array_length(public.customer_reward_milestones(), 1)],
         (select r.status from public.customer_rewards r
           where r.user_id = u.id order by r.cycle desc limit 1),
         (select r.unlocked_at from public.customer_rewards r
           where r.user_id = u.id order by r.cycle desc limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'order_status', o.order_status,
                     'payment_status', o.payment_status, 'delivery_status', o.delivery_status,
                     'total_pesewas', o.total_pesewas, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2
                    where o2.customer_id = u.id and o2.order_status <> 'DRAFT'
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.customer_profiles c on c.user_id = u.id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin() and u.id = p_user_id;
$$;

alter function public.admin_customer_detail(uuid) owner to postgres;
revoke all on function public.admin_customer_detail(uuid) from public;
grant execute on function public.admin_customer_detail(uuid) to authenticated;

drop function if exists public.admin_customers(text, integer);

create or replace function public.admin_customers(p_search text default null, p_limit integer default 100)
  returns table(
    user_id uuid, full_name text, phone text, email text,
    student_id_number text, level text, is_suspended boolean, is_admin boolean,
    partner_status text, order_count bigint, completed_count bigint,
    reward_status text, last_order_at timestamptz, onboarded_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.level,
         u.is_suspended, u.is_admin,
         coalesce(p.status::text, 'NOT_APPLIED'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select r.status from public.customer_rewards r
           where r.user_id = u.id order by r.cycle desc limit 1),
         (select max(o.created_at) from public.orders o where o.customer_id = u.id),
         c.onboarded_at
    from public.customer_profiles c
    join public.users u on u.id = c.user_id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin()
     and (p_search is null or btrim(p_search) = ''
          or u.full_name ilike '%' || btrim(p_search) || '%'
          or coalesce(u.phone,'') ilike '%' || btrim(p_search) || '%'
          or coalesce(u.email,'') ilike '%' || btrim(p_search) || '%'
          or c.student_id_number ilike '%' || btrim(p_search) || '%')
   order by c.onboarded_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

alter function public.admin_customers(text, integer) owner to postgres;
revoke all on function public.admin_customers(text, integer) from public;
grant execute on function public.admin_customers(text, integer) to authenticated;
