-- ============================================================================
-- PARTNER RATINGS
-- ============================================================================
-- One rating per completed delivery, from the customer who received it, about
-- the Partner who brought it. Five stars, an optional line of text, and nothing
-- else — no categories, no tags, no weighted score.
--
-- THE PRIMARY KEY IS THE ORDER. That is the whole duplicate rule: a second
-- rating for the same delivery cannot exist, so there is no window in which two
-- taps become two rows and no counter to keep in step.
--
-- WHO MAY RATE WHOM is decided in the database, not by which screen was shown.
-- The customer must be the order's customer, the order must be COMPLETED, and
-- the Partner rated is read FROM THE ORDER — it is not a parameter, so there is
-- nothing for a hand-built request to point at somebody else.

create table if not exists public.partner_ratings (
  order_id    uuid primary key references public.orders(id) on delete cascade,
  partner_id  uuid not null references public.users(id),
  customer_id uuid not null references public.users(id),
  stars       smallint not null,
  comment     text,
  created_at  timestamptz not null default now(),
  constraint partner_ratings_stars_check check (stars between 1 and 5),
  constraint partner_ratings_comment_length check (comment is null or length(comment) <= 500),
  constraint partner_ratings_not_self check (partner_id <> customer_id)
);

alter table public.partner_ratings owner to postgres;
alter table public.partner_ratings enable row level security;

comment on table public.partner_ratings is
  'One rating per completed delivery. The order is the primary key, so a duplicate is impossible rather than merely guarded against.';

create index if not exists partner_ratings_partner_idx
  on public.partner_ratings (partner_id, created_at desc);
create index if not exists partner_ratings_low_idx
  on public.partner_ratings (created_at desc) where stars <= 2;

-- A customer sees the rating they left. A PARTNER DOES NOT SEE INDIVIDUAL ROWS:
-- with two deliveries an hour, one row plus a timestamp names the customer who
-- left it, and a Partner who can identify a complainant is a Partner somebody
-- is afraid to rate honestly. They see their average, through a function.
create policy partner_ratings_read_customer on public.partner_ratings
  for select to authenticated using (customer_id = auth.uid());
create policy partner_ratings_read_admin on public.partner_ratings
  for select to authenticated using (public.is_admin());

grant select on public.partner_ratings to authenticated;

-- ---------------------------------------------------------------------------
-- Leaving one
-- ---------------------------------------------------------------------------

create or replace function public.customer_rate_partner(
  p_order_id uuid,
  p_stars    smallint,
  p_comment  text default null
) returns public.transition_result
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders
   where id = p_order_id and customer_id = auth.uid();

  -- AUTHORISATION failure: raise. A wrong order id and somebody else's order
  -- get the same message, so probing tells the caller nothing.
  if not found then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  if p_stars is null or p_stars < 1 or p_stars > 5 then
    raise exception 'choose between one and five stars' using errcode = 'check_violation';
  end if;

  -- STATE failures return, so the caller can be told which one it was without
  -- a rejected rating rolling back anything.
  if v_order.partner_id is null then
    return row(false, 'no Partner brought this order')::public.transition_result;
  end if;
  if v_order.order_status <> 'COMPLETED' or v_order.delivery_status <> 'DELIVERED' then
    return row(false, 'you can rate a delivery once it is complete')::public.transition_result;
  end if;

  -- The Partner comes from the ORDER. Nothing the caller sent decides who is
  -- being rated.
  insert into public.partner_ratings (order_id, partner_id, customer_id, stars, comment)
  values (p_order_id, v_order.partner_id, auth.uid(), p_stars,
          nullif(btrim(coalesce(p_comment, '')), ''))
  on conflict (order_id) do nothing;

  if not found then
    return row(false, 'you have already rated this delivery')::public.transition_result;
  end if;

  return row(true, null)::public.transition_result;
end;
$$;

alter function public.customer_rate_partner(uuid, smallint, text) owner to postgres;
revoke all on function public.customer_rate_partner(uuid, smallint, text) from public;
grant execute on function public.customer_rate_partner(uuid, smallint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading them back
-- ---------------------------------------------------------------------------

create or replace function public.my_partner_rating()
  returns table(rating_count bigint, average_stars numeric, last_rated_at timestamptz)
  language sql stable security definer
  set search_path to ''
as $$
  select count(*), round(avg(r.stars), 2), max(r.created_at)
    from public.partner_ratings r
   where r.partner_id = auth.uid();
$$;

alter function public.my_partner_rating() owner to postgres;
comment on function public.my_partner_rating() is
  'A Partner''s own average. An aggregate on purpose: a Partner who could read individual rows could work out who left which one.';
revoke all on function public.my_partner_rating() from public;
grant execute on function public.my_partner_rating() to authenticated;

create or replace function public.admin_partner_ratings(
  p_partner_id uuid default null,
  p_max_stars  smallint default null,
  p_limit      integer default 100
) returns table(
    order_id uuid, order_number text,
    partner_id uuid, partner_name text,
    customer_id uuid, customer_name text,
    stars smallint, comment text, created_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select r.order_id, o.order_number,
         r.partner_id, pu.full_name,
         r.customer_id, cu.full_name,
         r.stars, r.comment, r.created_at
    from public.partner_ratings r
    join public.orders o on o.id = r.order_id
    join public.users pu on pu.id = r.partner_id
    join public.users cu on cu.id = r.customer_id
   where public.is_admin()
     and (p_partner_id is null or r.partner_id = p_partner_id)
     and (p_max_stars is null or r.stars <= p_max_stars)
   order by r.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

alter function public.admin_partner_ratings(uuid, smallint, integer) owner to postgres;
revoke all on function public.admin_partner_ratings(uuid, smallint, integer) from public;
grant execute on function public.admin_partner_ratings(uuid, smallint, integer) to authenticated;

-- The customer's order screen decides when to show the prompt. It is a display
-- fact — customer_rate_partner re-checks all of it — but it is what keeps the
-- prompt from appearing on an order nobody delivered.
drop function if exists public.customer_order_detail(uuid);

create or replace function public.customer_order_detail(p_order_id uuid)
  returns table(
    order_id uuid, order_number text, vendor_name text, vendor_location text,
    stage text, order_status public.order_status, payment_status public.payment_status,
    delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
    order_type public.order_type,
    subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint,
    total_pesewas bigint, destination text, destination_note text,
    submitted_at timestamptz, seconds_to_deadline integer,
    accepted_at timestamptz, preparing_at timestamptz, ready_at timestamptz,
    assigned_at timestamptz, picked_up_at timestamptz, completed_at timestamptz,
    cancellation_reason text, payment_id uuid, payment_txn_status public.payment_txn_status,
    partner_name text, partner_phone text, delivery_code text, pickup_code text,
    disputed boolean, dispute_reason text,
    can_rate_partner boolean, rated_stars smallint,
    items jsonb
  )
  language sql stable security definer
  set search_path to ''
as $$
  select o.id, o.order_number, v.name, public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas, o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- THE PARTNER'S FIRST NAME, and only while they are carrying it. Once
         -- the rating prompt is up the name is gone: the prompt says "your
         -- Partner", because who it was is no longer the customer's business.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP')
              then public.given_name(pu.first_name, pu.full_name) end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         case when o.fulfilment_type = 'PICKUP' and o.payment_status = 'PAID'
                   and o.order_status in ('PREPARING', 'READY')
              then s.pickup_code end,
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         o.order_status = 'COMPLETED'
           and o.delivery_status = 'DELIVERED'
           and o.partner_id is not null
           and rt.order_id is null,
         rt.stars,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
    left join public.partner_ratings rt on rt.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;

alter function public.customer_order_detail(uuid) owner to postgres;
revoke all on function public.customer_order_detail(uuid) from public;
grant execute on function public.customer_order_detail(uuid) to authenticated;

-- The Partner's own summary carries their standing with it, so the dashboard
-- has one call rather than two.
drop function if exists public.partner_earnings_summary();

create or replace function public.partner_earnings_summary()
  returns table(
    delivered_count bigint, earned_pesewas bigint,
    awaiting_pesewas bigint, settled_pesewas bigint,
    rating_count bigint, average_stars numeric
  )
  language sql stable security definer
  set search_path to ''
as $$
  select count(*) filter (where a.status is not null),
         coalesce(sum(a.amount_pesewas), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status <> 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint,
         (select count(*) from public.partner_ratings r where r.partner_id = auth.uid()),
         (select round(avg(r.stars), 2) from public.partner_ratings r where r.partner_id = auth.uid())
    from public.allocations a
   where a.payee_type = 'PARTNER' and a.payee_id = auth.uid()
     and a.status <> 'CANCELLED';
$$;

alter function public.partner_earnings_summary() owner to postgres;
revoke all on function public.partner_earnings_summary() from public;
grant execute on function public.partner_earnings_summary() to authenticated;

-- The administrator's Partner list carries the standing too, because "who is
-- struggling" is the question the list exists to answer.
drop function if exists public.admin_partners(text);

create or replace function public.admin_partners(p_status text default null)
  returns table(
    user_id uuid, full_name text, phone text, level text,
    status public.partner_application_status, is_available boolean, is_suspended boolean,
    applied_at timestamptz, reviewed_at timestamptz,
    deliveries bigint, owed_pesewas bigint,
    rating_count bigint, average_stars numeric,
    payout_ready boolean
  )
  language sql stable security definer
  set search_path to ''
as $$
  select u.id, u.full_name, u.phone, c.level, p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at,
         (select count(*) from public.orders o where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE')),
         (select count(*) from public.partner_ratings r where r.partner_id = u.id),
         (select round(avg(r.stars), 2) from public.partner_ratings r where r.partner_id = u.id),
         exists (select 1 from public.payout_destinations d
                  where d.payee_type = 'PARTNER' and d.payee_id = u.id)
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.customer_profiles c on c.user_id = u.id
   where public.is_admin()
     and (p_status is null or p.status::text = p_status)
   order by
     case p.status when 'PENDING_REVIEW' then 0 when 'APPROVED' then 1 else 2 end,
     p.applied_at desc nulls last;
$$;

alter function public.admin_partners(text) owner to postgres;
revoke all on function public.admin_partners(text) from public;
grant execute on function public.admin_partners(text) to authenticated;
