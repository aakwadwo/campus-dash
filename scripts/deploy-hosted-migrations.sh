#!/usr/bin/env bash
# Applies the outstanding migrations to the hosted project, in order.
#
# Each runs in its own transaction and aborts on the first error, so a failure
# leaves the previous state rather than a half-applied function. Every one of
# these is CREATE OR REPLACE FUNCTION plus grants — no table DDL, no data
# changes, no constraint changes — so re-running is safe.
#
#   ./scripts/deploy-hosted-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a

for m in \
  20260926000001_admin_dashboard_totals \
  20260927000001_phone_collision_safe_provisioning \
  20260928000001_service_fee_six_ninety_five \
  20260928000002_vendor_active_count
do
  echo "--> $m"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -q \
    -f "supabase/migrations/${m}.sql"
done

echo
echo "--> verifying"
psql "$SUPABASE_DB_URL" -tAc "
select 'service_fee_bps          = ' || service_fee_bps from public.pricing_config;
select 'admin_dashboard_totals   = ' || count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='admin_dashboard_totals';
select 'vendor_active_count      = ' || count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='vendor_active_count';
select 'phone collision fix      = ' || count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='handle_new_auth_user_for'
    and p.prosrc like '%already belongs to another identity%';"
