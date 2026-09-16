-- ---------------------------------------------------------------------------
-- THE PARTNER'S SCAN WINDOW CLOSES WHEN THE DELIVERY DOES
-- ---------------------------------------------------------------------------
-- A Partner who finished a delivery could still fetch that order's scan image,
-- for ever.
--
-- HOW IT SURVIVED. order_scans.released_to is revoked by
-- release_scan_on_assignment(), which fires when partner_id goes null —
-- cancellation, reassignment, a reopened search. It does NOT fire at
-- completion, because partner_complete_delivery() deliberately KEEPS
-- partner_id: the earnings row, the payout and the Partner's own history all
-- hang off it. So released_to legitimately outlives the delivery, and every
-- reader that authorised on `released_to = auth.uid()` alone outlived it too.
--
-- That is not a reason to clear released_to at completion. The column records
-- who the scan was released to, which is a fact about what happened and worth
-- keeping. What has to change is the QUESTION the readers ask: not "was this
-- released to you" but "is it released to you AND are you still carrying it".
--
-- partner_scan_brief() already asked the second question and was right all
-- along; it is untouched here. The two that did not are fixed, and they are
-- fixed through ONE predicate rather than two copies of a WHERE clause,
-- exactly as vendor_may_read_scan() already does for the store side — because
-- the row and the image must never disagree about who may look.
--
-- NOTHING ELSE MOVES. No lifecycle state, no assignment, no payout, no storage
-- path, and no widening: a customer, an admin and a store see precisely what
-- they saw before.
-- ---------------------------------------------------------------------------

-- THE PREDICATE. SECURITY DEFINER for the same reason vendor_may_read_scan()
-- is: a policy evaluates as the caller, and a predicate that quietly depends on
-- the caller's own visibility of public.orders is a predicate that changes
-- meaning when an unrelated policy does. This one asks on its own authority.
--
-- ASSIGNED and PICKED_UP, and nothing else. Those are the two states in which
-- somebody is actually carrying the order — the same pair partner_scan_brief()
-- has always used, named here once so the three readers cannot drift apart.
create or replace function public.partner_may_read_scan(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
      from public.order_scans s
      join public.orders o on o.id = s.order_id
     where s.order_id = p_order_id
       and s.released_to is not null
       and s.released_to = auth.uid()
       and o.partner_id = auth.uid()
       and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
  );
$$;

comment on function public.partner_may_read_scan(uuid) is
  'Whether the caller is the Partner currently carrying this scan order: released to them AND still assigned, ASSIGNED or PICKED_UP. The one predicate behind both the order_scans policy and scan_image_path(), so the row and the image can never disagree. It closes at DELIVERED, where released_to alone does not — partner_id is kept after completion for earnings and history, so an authorisation keyed on it would outlive the errand it was granted for.';

-- ---------------------------------------------------------------------------
-- THE IMAGE
-- ---------------------------------------------------------------------------
-- The customer and admin arms are character-for-character what they were. Only
-- the Partner arm changes, from `released_to = auth.uid()` to the predicate.
create or replace function public.scan_image_path(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and (
       s.customer_id = auth.uid()
       or public.partner_may_read_scan(p_order_id)
       or public.is_admin()
     );
$$;

comment on function public.scan_image_path(uuid) is
  'The scan image path for the customer who uploaded it, the Partner CURRENTLY carrying it, or an administrator. The store has its own door, vendor_scan_image_path(). Every window here closes: the Partner''s at the end of the delivery, not merely when the assignment is taken away.';

-- ---------------------------------------------------------------------------
-- THE ROW
-- ---------------------------------------------------------------------------
-- Fixing the function alone would have been cosmetic. `authenticated` holds
-- SELECT on order_scans, so a finished Partner could read image_path straight
-- off the table through PostgREST and never call the function at all. The
-- policy carried the identical ungated clause and gets the identical fix.
--
-- The other three arms are unchanged, including vendor_may_read_scan().

drop policy if exists "order_scans_read_authorised" on public.order_scans;

create policy "order_scans_read_authorised" on public.order_scans
  for select to authenticated
  using (
    customer_id = auth.uid()
    or public.partner_may_read_scan(order_scans.order_id)
    or public.is_admin()
    or public.vendor_may_read_scan(order_scans.order_id)
  );

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- Supabase grants EXECUTE to PUBLIC by default, so a new function is
-- anon-callable until something takes that away. tests/schema.test.js asserts
-- the whole surface, which is what turns forgetting this into a red test.
--
-- authenticated needs EXECUTE because the policy above evaluates AS THE CALLER;
-- without it every read of order_scans would error rather than filter.
revoke all on function public.partner_may_read_scan(uuid) from public, anon;
grant execute on function public.partner_may_read_scan(uuid) to authenticated;
