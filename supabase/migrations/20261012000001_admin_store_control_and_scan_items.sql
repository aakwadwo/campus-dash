-- ============================================================================
-- ADMIN STORE CONTROL, AND MEAL-SCAN ITEMS ONLY AT A MEAL-SCAN STORE
-- ============================================================================
-- Three small changes. No table, column or enum is added: every state here
-- already existed.
--
-- 1. A MENU ITEM CAN ONLY BE MADE SCAN-ELIGIBLE AT A STORE CAMPUS DASH HAS
--    TURNED MEAL SCANS ON FOR. submit_scan_order() has always refused a scan
--    at such a store; the flag itself could still be set, from the store's own
--    menu editor, where it read as an option the store had. It is now refused
--    where it is written. Nothing is cleared: a flag set while scans were on
--    stays set when an administrator turns them off, and counts again when
--    they come back, exactly as the column's comment has always said.
--
-- 2. AN ADMINISTRATOR CAN CLOSE AND REOPEN A STORE, AUDITED. "Open" has one
--    meaning, derived from the ACTIVE MENU (vendor_apply_menu_state), and this
--    does not add a second. Closing is the store's own close — the active menu
--    is turned off, the catalogue is untouched — reached through the same
--    function, and recorded in admin_actions with the items it turned off.
--    Reopening undoes THAT close: it turns those same items back on, and only
--    if nobody has changed the menu since. An administrator never chooses what
--    a store is cooking; when the menu has moved on, the store opens itself by
--    turning an item on, as it always has.
--
-- 3. REINSTATING A SUSPENDED STORE RESTORES IT. Suspension closes a store and
--    leaves its menu alone. Returning it to ACTIVE now re-applies the menu
--    state, so a store that had items on is open again, and one that had none
--    stays closed. Approving a DRAFT or PENDING store is unchanged: approval
--    still never opens a store on its owner's behalf.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. SCAN-ELIGIBLE ONLY WHERE THE STORE TAKES SCANS
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER like every scan function (tests/scan-delivery.test.js), so
-- the store's setting is read the same way whoever is writing the item.
create or replace function public.menu_item_scan_needs_scan_store()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- Only the MOVE to eligible is checked. An item already eligible keeps its
  -- flag through every other edit, whatever the store's setting is today.
  if new.scan_eligible
     and (tg_op = 'INSERT' or not old.scan_eligible)
     and not exists (
       select 1 from public.vendors v
        where v.id = new.vendor_id and v.can_accept_scans
     ) then
    raise exception 'meal scans are not turned on for this store'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.menu_item_scan_needs_scan_store() from public, anon, authenticated;

drop trigger if exists menu_items_scan_needs_scan_store on public.menu_items;
create trigger menu_items_scan_needs_scan_store
  before insert or update of scan_eligible on public.menu_items
  for each row execute function public.menu_item_scan_needs_scan_store();


-- ---------------------------------------------------------------------------
-- 2. ADMIN CLOSE AND REOPEN
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_vendor_open(
  p_vendor_id uuid,
  p_open      boolean,
  p_reason    text
)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
  v_items  uuid[] := '{}';
  v_close  public.admin_actions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_open is null then
    raise exception 'say whether the store should be open' using errcode = 'check_violation';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id for update;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  -- Open and closed are states of a TRADING store. A suspended one is closed
  -- by its status, and is reinstated through admin_set_vendor_status().
  if v_before.status <> 'ACTIVE' then
    raise exception 'only an ACTIVE store can be opened or closed'
      using errcode = 'check_violation';
  end if;

  if not p_open then
    if not v_before.is_accepting_orders then
      raise exception 'this store is already closed' using errcode = 'check_violation';
    end if;

    -- WHAT THIS CLOSE TURNS OFF, recorded so that reopening can put back
    -- exactly this and nothing else.
    select coalesce(array_agg(m.id order by m.id), '{}') into v_items
      from public.menu_items m
     where m.vendor_id = p_vendor_id and m.is_active;

    -- The store's own close: the active menu off, the catalogue untouched.
    perform public.vendor_set_accepting_orders(p_vendor_id, false);
  else
    if v_before.is_accepting_orders then
      raise exception 'this store is already open' using errcode = 'check_violation';
    end if;

    select * into v_close
      from public.admin_actions a
     where a.target_type = 'vendor' and a.target_id = p_vendor_id
       and a.action = 'VENDOR_CLOSED_BY_ADMIN'
     order by a.id desc
     limit 1;

    -- ONLY AN UNTOUCHED ADMIN CLOSE IS UNDONE. The close stamped the items it
    -- turned off with its own transaction time; any later edit to this store's
    -- menu, by anybody, means the menu is no longer the one that was closed.
    if v_close.id is null
       or exists (
         select 1 from public.menu_items m
          where m.vendor_id = p_vendor_id and m.updated_at > v_close.created_at
       ) then
      raise exception 'the store has nothing on its menu. It opens when the store turns an item on'
        using errcode = 'check_violation';
    end if;

    select coalesce(array_agg(m.id order by m.id), '{}') into v_items
      from public.menu_items m
     where m.vendor_id = p_vendor_id
       and not m.is_active
       and m.id in (
         select (jsonb_array_elements_text(coalesce(v_close.details -> 'turned_off', '[]'::jsonb)))::uuid
       );

    update public.menu_items
       set is_active = true, updated_at = now()
     where id = any(v_items);

    -- The store's own open, with its own rule: refused unless an item a
    -- customer can actually order is now on.
    perform public.vendor_set_accepting_orders(p_vendor_id, true);
  end if;

  select * into v_after from public.vendors where id = p_vendor_id;

  perform public.log_admin_action(
    case when p_open then 'VENDOR_OPENED_BY_ADMIN' else 'VENDOR_CLOSED_BY_ADMIN' end,
    'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after),
    jsonb_build_object(case when p_open then 'turned_on' else 'turned_off' end, to_jsonb(v_items))
  );

  return v_after;
end;
$$;

comment on function public.admin_set_vendor_open(uuid, boolean, text) is
  'An administrator closing or reopening an ACTIVE store, audited. Closing is the store''s own close through vendor_set_accepting_orders(): the active menu off, the catalogue untouched, and the items it turned off recorded in admin_actions.details. Reopening turns exactly those items back on and opens the store, and is refused if the menu has been edited since, because an administrator does not choose what a store is cooking.';

revoke all on function public.admin_set_vendor_open(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_vendor_open(uuid, boolean, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. REINSTATING A SUSPENDED STORE
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_vendor_status(
  p_vendor_id uuid,
  p_status    public.vendor_status,
  p_reason    text
)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;

  update public.vendors
     set status = p_status,
         -- A suspended vendor cannot be left silently taking orders.
         is_accepting_orders = case when p_status = 'ACTIVE' then is_accepting_orders else false end
   where id = p_vendor_id
  returning * into v_after;

  -- REINSTATED, NOT APPROVED. Suspension closed the store and left its menu
  -- alone, so the menu decides again: open if an orderable item is on. Only
  -- from SUSPENDED — approval never opens a store on its owner's behalf.
  if v_before.status = 'SUSPENDED' and p_status = 'ACTIVE' then
    perform public.vendor_apply_menu_state(p_vendor_id);
    select * into v_after from public.vendors where id = p_vendor_id;
  end if;

  perform public.log_admin_action(
    'VENDOR_STATUS_' || p_status::text, 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;
