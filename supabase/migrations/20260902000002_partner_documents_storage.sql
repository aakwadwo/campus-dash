-- ============================================================================
-- Phase 4 — private storage for Partner verification documents
-- ============================================================================
-- Holds the student ID photograph and the live face photograph an admin
-- compares during approval.
--
-- The bucket is PRIVATE and has NO storage policies for anon or authenticated.
-- Nobody reads these through the API. An admin sees them only through a
-- short-lived signed URL minted server-side (lib/admin/documents.js), which is
-- the only mechanism by which an image is ever exposed — and only for the
-- minutes it takes to look at it.
--
-- Uploads arrive in Phase 8 with the Partner application. This exists now so
-- the approval screen has somewhere real to read from.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'partner-documents',
  'partner-documents',
  false,                                   -- never publicly readable
  5 * 1024 * 1024,                         -- 5 MB: a phone photo, not a scan
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
   set public             = false,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Deliberately no policies on storage.objects for this bucket. Without a
-- policy, RLS denies every client read and write — which is exactly right for
-- a government-ID photograph. The service role bypasses RLS and is the only
-- thing that touches these files.

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- Verification documents are deleted after the approval retention period.
-- This reports what is due; the actual object deletion happens through the
-- Storage API, which SQL cannot call.
create or replace function public.admin_partner_documents_due_for_purge()
returns table (
  user_id               uuid,
  student_id_image_path text,
  face_image_path       text,
  status                public.partner_application_status,
  documents_purge_after timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.student_id_image_path, p.face_image_path,
         p.status, p.documents_purge_after
    from public.partner_profiles p
   where public.is_admin()
     and p.documents_purge_after is not null
     and p.documents_purge_after <= now()
     and (p.student_id_image_path is not null or p.face_image_path is not null)
   order by p.documents_purge_after asc;
$$;

-- Clears the paths once the objects are actually gone, so the record does not
-- keep pointing at files that no longer exist.
create or replace function public.admin_clear_partner_documents(p_user_id uuid, p_reason text)
returns public.partner_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner profile for this user' using errcode = 'no_data_found';
  end if;

  update public.partner_profiles
     set student_id_image_path = null,
         face_image_path = null,
         documents_purge_after = null
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_DOCUMENTS_PURGED', 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

grant execute on function public.admin_partner_documents_due_for_purge() to authenticated;
grant execute on function public.admin_clear_partner_documents(uuid, text) to authenticated;
