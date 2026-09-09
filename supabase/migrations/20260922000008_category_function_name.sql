-- ============================================================================
-- A function and a table cannot share a name
-- ============================================================================
-- `vendor_categories` was both, and PostgREST refuses the ambiguity: the RPC
-- simply never appears in its schema cache, and every call comes back as
-- "Could not find the function public.vendor_categories without parameters".
-- Nothing is wrong in the database — psql resolves it fine — which is what
-- makes the failure mode nasty: the SQL tests pass and the browser 500s.
--
-- The table keeps the name, because that is what the rows ARE. The reader is
-- renamed to say what it returns.
-- ============================================================================

drop function if exists public.vendor_categories();

create or replace function public.active_vendor_categories()
returns table (id uuid, slug text, name text, sort_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.slug, k.name, k.sort_order
    from public.vendor_categories k
   where k.is_active
   order by k.sort_order, k.name;
$$;

revoke all on function public.active_vendor_categories() from public;
grant execute on function public.active_vendor_categories() to anon, authenticated;
