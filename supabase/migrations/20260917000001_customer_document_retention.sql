-- ============================================================================
-- The student ID photograph is a CUSTOMER document
-- ============================================================================
-- Two verification images, two owners, two retention rules. Until now they were
-- treated as one thing because they lived on one table.
--
--   FACE PHOTOGRAPH   belongs to the PARTNER application. It exists so an
--                     administrator can compare a live face against an ID
--                     during a one-off review. Once that review is done and the
--                     retention window has elapsed, holding it serves nobody.
--                     Purged, exactly as before. Nothing about this changes.
--
--   STUDENT ID PHOTO  belongs to the CUSTOMER capability. It is the evidence
--                     that this account is an Academic City student, and that
--                     is a standing fact about a live account rather than a
--                     record of a past decision. Retained while the account
--                     holds the capability.
--
-- WHY THIS MIGRATION EXISTS AT ALL, given the behaviour is already correct:
-- admin_partner_documents_due_for_purge() still RETURNED the customer's ID path
-- alongside the face path. Nothing consumed it — but the whole purpose of that
-- function is to hand an administrator a list of objects to delete, so a column
-- naming a file that must NOT be deleted is a trap with a fuse on it. The next
-- person to wire up a bulk purge would have deleted every customer's ID
-- photograph and pointed a NOT NULL column at nothing.
--
-- The fix is to stop returning it. A function that lists what to delete should
-- name only things that may be deleted.
--
-- NOT AUTOMATED, DELIBERATELY. There is no customer retention clock, no sweep
-- and no new scheduled job. "Retained while the account is active" needs no
-- machinery — it is what already happens — and inventing a deletion schedule
-- would be answering a policy question that has not been decided. When account
-- deletion is built, these objects are deleted with the account, like every
-- other thing it owns. Recorded as an open policy item in
-- docs/PILOT-QUESTIONS.md rather than settled here by a default.
--
-- NOTHING IS DELETED BY THIS MIGRATION. It changes one function's return
-- columns and adds two comments.
-- ============================================================================

comment on column public.customer_profiles.student_id_image_path is
  'CUSTOMER verification document, in the private partner-documents bucket. '
  'Retained while the account holds the CUSTOMER capability — it is evidence '
  'for a standing capability, not a record of a past review. NOT purged by the '
  'Partner document retention job. Subject to the account deletion policy when '
  'that exists. See docs/PILOT-QUESTIONS.md.';

comment on column public.partner_profiles.face_image_path is
  'PARTNER verification document, in the private partner-documents bucket. '
  'Purged after the review retention window — see documents_purge_after and '
  'admin_partner_documents_due_for_purge().';

-- ---------------------------------------------------------------------------
-- The purge queue lists PARTNER documents only
-- ---------------------------------------------------------------------------
-- Return-table columns cannot be changed with CREATE OR REPLACE, so this is a
-- drop and recreate. The body is otherwise unchanged: same admin check, same
-- due-date predicate, same ordering.
drop function if exists public.admin_partner_documents_due_for_purge();

create or replace function public.admin_partner_documents_due_for_purge()
returns table (
  user_id               uuid,
  face_image_path       text,
  status                public.partner_application_status,
  documents_purge_after timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.face_image_path, p.status, p.documents_purge_after
    from public.partner_profiles p
   where public.is_admin()
     and p.documents_purge_after is not null
     and p.documents_purge_after <= now()
     -- Only rows that still HAVE a face photograph. A profile already purged
     -- has nothing due, and listing it invites a second delete of a file that
     -- is gone.
     and p.face_image_path is not null
   order by p.documents_purge_after asc;
$$;

comment on function public.admin_partner_documents_due_for_purge() is
  'Partner face photographs whose retention window has elapsed. Deliberately '
  'does NOT list customer_profiles.student_id_image_path: that document is '
  'retained while the account is active, and a delete queue must name only '
  'things that may be deleted.';

revoke execute on function public.admin_partner_documents_due_for_purge() from public, anon;
grant  execute on function public.admin_partner_documents_due_for_purge() to authenticated;
