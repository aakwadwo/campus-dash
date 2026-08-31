-- ============================================================================
-- Phase 3 — scheduled jobs
-- ============================================================================
-- expire_stale_orders() and expire_partner_search() were built and tested in
-- Phase 2, but nothing invoked them: a vendor who simply ignored an order left
-- it SUBMITTED for ever, and a dispatch search never gave up. This closes that.
--
-- The jobs run INSIDE the database rather than from an application cron. There
-- is no HTTP call to miss, no deploy that silently drops the schedule, and no
-- second place holding a copy of the business rule.
-- ============================================================================

create extension if not exists pg_cron with schema extensions;

-- Both functions call assert_service_or_admin(). pg_cron runs jobs as the
-- database owner, so session_user is 'postgres' and the assertion passes —
-- exactly the "direct database connection" case it was written for.

-- The vendor acceptance window is 60 seconds, so a coarser sweep would leave an
-- order visibly stuck past its own countdown. Every 30s bounds the error at
-- half a window.
select cron.schedule(
  'campus-dash-expire-stale-orders',
  '30 seconds',
  $$ select public.expire_stale_orders(); $$
);

-- The dispatch search window is 10 minutes; a minute of slack is immaterial and
-- keeps the job cheap. (pg_cron takes the "N seconds" form only for sub-minute
-- intervals; a one-minute schedule must use standard cron syntax.)
select cron.schedule(
  'campus-dash-expire-partner-search',
  '* * * * *',
  $$ select public.expire_partner_search(); $$
);

-- ---------------------------------------------------------------------------
-- Operational visibility
-- ---------------------------------------------------------------------------
-- A scheduler that silently stops is worse than no scheduler, because the
-- symptom (orders stuck at SUBMITTED) looks like an application bug. This lets
-- an admin see whether the jobs are actually running and whether they are
-- failing.
create or replace function public.admin_scheduled_job_status()
returns table (
  jobname     text,
  schedule    text,
  active      boolean,
  last_run    timestamptz,
  last_status text,
  last_error  text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.jobname::text,
         j.schedule::text,
         j.active,
         r.start_time,
         r.status::text,
         r.return_message::text
    from cron.job j
    left join lateral (
      select start_time, status, return_message
        from cron.job_run_details d
       where d.jobid = j.jobid
       order by d.start_time desc
       limit 1
    ) r on true
   where public.is_admin()
     and j.jobname like 'campus-dash-%'
   order by j.jobname;
$$;

grant execute on function public.admin_scheduled_job_status() to authenticated;
