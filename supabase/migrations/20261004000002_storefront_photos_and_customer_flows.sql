-- ============================================================================
-- Store photos, the order history, abandoning an unpaid order, and one phone
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Store photos: four at most, and the first one leads
-- ---------------------------------------------------------------------------
-- A store's photos are the store: its counter, its food, whatever it sells.
-- FOUR, because a storefront needs a picture that says what the place is and a
-- few that say what it has, and a fifth is a gallery nobody scrolls. Nothing
-- already uploaded is deleted: a store over the limit keeps what it has and
-- simply cannot add more until it is under.
--
-- THE PRIMARY PHOTO IS THE FIRST IN sort_order, and a new photo goes to the
-- END, so the first one ever uploaded leads by default. vendor_set_primary_image
-- moves another to the front when a store or an administrator prefers it.

create or replace function public.vendor_add_image(
  p_vendor_id    uuid,
  p_storage_path text,
  p_content_type text,
  p_byte_size    bigint,
  p_caption      text default null
)
returns public.vendor_images
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image public.vendor_images%rowtype;
  v_count integer;
  v_next  integer;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'no image was received' using errcode = 'check_violation';
  end if;

  -- Serialised per store, so two uploads racing each other cannot both see
  -- three photos and leave five.
  perform 1 from public.vendors where id = p_vendor_id for update;

  select count(*), coalesce(max(sort_order) + 1, 0)
    into v_count, v_next
    from public.vendor_images where vendor_id = p_vendor_id;

  if v_count >= 4 then
    raise exception 'a store may have at most 4 photos; remove one first'
      using errcode = 'check_violation';
  end if;

  insert into public.vendor_images (
    vendor_id, storage_path, content_type, byte_size, caption, sort_order, uploaded_by
  )
  values (
    p_vendor_id, btrim(p_storage_path), p_content_type, p_byte_size,
    nullif(btrim(coalesce(p_caption, '')), ''), v_next, auth.uid()
  )
  returning * into v_image;

  return v_image;
end;
$$;

comment on function public.vendor_add_image(uuid, text, text, bigint, text) is
  'Records one store photo, at the END of the order, so the first photo a store uploads is its primary one. At most four per store, checked under a lock on the store row. Owner or admin, enforced in the body.';

create or replace function public.vendor_set_primary_image(p_image_id uuid)
returns public.vendor_images
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image public.vendor_images%rowtype;
  v_first integer;
begin
  select * into v_image from public.vendor_images where id = p_image_id;
  if not found then
    raise exception 'no such image' using errcode = 'no_data_found';
  end if;
  if not public.is_vendor_staff(v_image.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  select min(sort_order) into v_first
    from public.vendor_images where vendor_id = v_image.vendor_id;

  -- Already first: nothing to do, and nothing to renumber.
  if v_image.sort_order = v_first then
    return v_image;
  end if;

  -- In front of everything else, and everything else keeps its own order.
  update public.vendor_images
     set sort_order = v_first - 1
   where id = p_image_id
  returning * into v_image;

  return v_image;
end;
$$;

comment on function public.vendor_set_primary_image(uuid) is
  'Moves one store photo to the front, making it the photo used wherever a single picture of the store is shown. The rest keep their order. Owner or admin, enforced in the body.';

revoke all on function public.vendor_set_primary_image(uuid) from public, anon;
grant execute on function public.vendor_set_primary_image(uuid) to authenticated, service_role;

-- The storefront shows the store's four, in order. A store that had more before
-- the limit existed shows its first four rather than all of them.
create or replace function public.storefront_vendor(p_vendor_id uuid)
returns table (
  vendor_id uuid,
  name text,
  description text,
  category_id uuid,
  category_name text,
  category_slug text,
  location_path text,
  location_note text,
  walk_minutes_to_campus integer,
  is_accepting_orders boolean,
  can_accept_scans boolean,
  images jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.location_note, v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', i.id, 'storage_path', i.storage_path, 'caption', i.caption
                   ) order by i.sort_order, i.created_at)
                     from (select * from public.vendor_images i2
                            where i2.vendor_id = v.id
                            order by i2.sort_order, i2.created_at
                            limit 4) i), '[]'::jsonb)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.id = p_vendor_id and v.status = 'ACTIVE';
$$;

-- ---------------------------------------------------------------------------
-- 2. The order history: a picture and what was in it
-- ---------------------------------------------------------------------------
-- A history row answers "which one was that?" at a glance: the store's
-- picture, the store, what was ordered, what it cost. The instructions for what
-- to do next belong on the order itself, not repeated down the list.

drop function if exists public.customer_order_list(integer);
create function public.customer_order_list(p_limit integer default 30)
returns table (
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  vendor_image_path text,
  order_type public.order_type,
  stage text,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  item_count bigint,
  items_summary text,
  total_pesewas bigint,
  submitted_at timestamptz,
  completed_at timestamptz,
  seconds_to_deadline integer,
  partner_first_name text,
  cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.vendor_order_no, v.name,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         o.order_type,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         -- "2× Jollof, Water". The names as they were when ordered, so a store
         -- renaming a dish does not rewrite somebody's history.
         (select string_agg(
                   case when oi.quantity > 1
                        then oi.quantity::text || '× ' || oi.name_snapshot
                        else oi.name_snapshot end,
                   ', ' order by oi.created_at)
            from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at, o.completed_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- First name only, and it stays after the delivery. The PHONE NUMBER
         -- is what ends with the delivery, and this list never carried one.
         public.given_name(pu.first_name, pu.full_name),
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

comment on function public.customer_order_list(integer) is
  'The caller''s own orders, newest first, as a history: the store and its primary photo, a one-line summary of the items, the total and the stage. No phone numbers, no codes. Scoped to auth.uid().';

revoke all on function public.customer_order_list(integer) from public, anon;
grant execute on function public.customer_order_list(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Abandoning an order nobody has paid for
-- ---------------------------------------------------------------------------
-- An order is priced and payable the moment it is submitted, and a customer who
-- comes back from the checkout without paying used to have no way to say "not
-- this one" — it sat on their list until expire_stale_orders() cancelled it for
-- them. This is that same transition, taken by the customer instead of the
-- clock: ACCEPTED + UNPAID (or a payment that FAILED) → CANCELLED.
--
-- NOT A CANCELLATION OF A PAID ORDER, and it cannot become one. The update is
-- guarded on the payment state, so a charge that has gone through, or is still
-- in flight (PENDING belongs to customer_abandon_stuck_payment, which asks the
-- provider first), matches zero rows and is refused with a sentence rather than
-- overwritten. No store has seen an unpaid order, so nobody has cooked anything.

create or replace function public.customer_abandon_unpaid_order(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.customer_id <> auth.uid() then
    raise exception 'not your order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders
     set order_status        = 'CANCELLED',
         cancelled_at        = now(),
         cancellation_reason = 'the customer abandoned the unpaid order'
   where id = p_order_id
     and customer_id = auth.uid()
     and order_status = 'ACCEPTED'
     and payment_status in ('UNPAID', 'FAILED');

  if not found then
    perform public.log_order_event(p_order_id, 'ORDER_ABANDONED', false, 'CUSTOMER',
      'order_status', v_order.order_status::text, 'CANCELLED',
      'only an order that has not been paid for can be abandoned');
    return row(
      false,
      case
        when v_order.payment_status = 'PENDING'
          then 'a payment on this order is still being confirmed'
        when v_order.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
          then 'this order has been paid for, so it cannot be abandoned'
        else 'this order can no longer be abandoned'
      end
    )::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'ORDER_ABANDONED', true, 'CUSTOMER',
    'order_status', 'ACCEPTED', 'CANCELLED', 'the customer abandoned the unpaid order');

  return row(true, null)::public.transition_result;
end;
$$;

comment on function public.customer_abandon_unpaid_order(uuid) is
  'The customer abandons their own order before paying for it: ACCEPTED with payment UNPAID or FAILED becomes CANCELLED. Guarded on the payment state, so a paid order or one with a payment in flight is refused and logged, never overwritten. The same end state expire_stale_orders() reaches on its own.';

revoke all on function public.customer_abandon_unpaid_order(uuid) from public, anon;
grant execute on function public.customer_abandon_unpaid_order(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. One phone, verified on the account that already exists
-- ---------------------------------------------------------------------------
-- A customer signs in by EMAIL and gives a phone number as a profile fact. A
-- vendor signs in by PHONE. When a customer opens a store, the number has to
-- become a credential on THE SAME auth identity — otherwise /login/vendor asks
-- GoTrue for a code, GoTrue finds no identity holding that number, and mints a
-- second one with no store and no customer profile behind it.
--
-- The app verifies the number on the signed-in account (GoTrue's phone change,
-- which sends a code to the new number and confirms it on this auth.users row).
-- This copies that VERIFIED number onto the profile, so the Partner's number,
-- the vendor's credential and the profile are one and the same.
--
-- It takes no parameter. The number comes from auth.users, where GoTrue wrote
-- it after checking the code, so "verified" means verified, not typed.

create or replace function public.sync_my_verified_phone()
returns public.users
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  public.users%rowtype;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select nullif(u.phone, '') into v_phone
    from auth.users u
   where u.id = auth.uid() and u.phone_confirmed_at is not null;

  if v_phone is null then
    raise exception 'verify the phone number first' using errcode = 'check_violation';
  end if;

  -- GoTrue stores numbers without the leading '+'. The profile wants E.164.
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  if exists (select 1 from public.users where phone = v_phone and id <> auth.uid()) then
    raise exception 'that phone number is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end if;

  update public.users set phone = v_phone where id = auth.uid()
  returning * into v_user;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  return v_user;
end;
$$;

comment on function public.sync_my_verified_phone() is
  'Copies the caller''s VERIFIED auth phone onto their profile. Takes no parameter: the number is read from auth.users, where GoTrue wrote it after checking the code. Used when a customer opens a store, so the number a Partner rings and the number the vendor signs in with are one number on one identity.';

revoke all on function public.sync_my_verified_phone() from public, anon;
grant execute on function public.sync_my_verified_phone() to authenticated, service_role;
