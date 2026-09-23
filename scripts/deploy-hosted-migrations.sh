#!/usr/bin/env bash
# Applies the migrations the hosted project has not had yet, in order.
#
# WHAT HAS BEEN APPLIED IS READ FROM THE DATABASE, not from a list in this file.
# supabase_migrations.schema_migrations is the history the Supabase CLI keeps;
# a version recorded there is skipped. This script used to carry a fixed list
# and replay all of it every run, which re-ran migrations hosted already had
# and put back older versions of functions that later migrations had replaced.
#
# Each pending migration runs in ONE transaction together with the row that
# records it, and aborts on the first error: a migration is either applied and
# recorded, or neither. Nothing here skips or ignores a failing statement.
#
# REFUSES TO APPLY OUT OF ORDER. A pending migration older than the newest one
# recorded means the history and the schema disagree, and guessing which one is
# right is how a database ends up in a state no build from empty reproduces.
#
#   ./scripts/deploy-hosted-migrations.sh            apply what is pending
#   ./scripts/deploy-hosted-migrations.sh --dry-run  list it, change nothing
#
# SUPABASE_DB_URL from the environment wins; otherwise it is read from
# .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  set -a; . ./.env.local; set +a
fi

psql_q() { psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -q "$@"; }

if [ "$(psql_q -tAc "select to_regclass('supabase_migrations.schema_migrations') is not null")" != "t" ]; then
  echo "No supabase_migrations.schema_migrations here, so what has been applied is unknown." >&2
  echo "Refusing to guess." >&2
  exit 1
fi

applied="$(psql_q -tAc "select version from supabase_migrations.schema_migrations")"
newest="$(psql_q -tAc "select coalesce(max(version), '') from supabase_migrations.schema_migrations")"

pending=()
for file in supabase/migrations/*.sql; do
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  grep -qx "$version" <<<"$applied" && continue
  if [[ "$version" < "$newest" ]]; then
    echo "$base is not recorded, but $newest is. Refusing to apply out of order." >&2
    exit 1
  fi
  pending+=("$base")
done

echo "recorded as applied: $(grep -c . <<<"$applied") (newest $newest)"
if [ ${#pending[@]} -eq 0 ]; then
  echo "pending: none"
else
  echo "pending: ${pending[*]}"
fi
$DRY_RUN && exit 0

for base in ${pending[@]+"${pending[@]}"}; do
  version="${base%%_*}"
  name="${base#*_}"
  echo "--> $base"
  psql_q --single-transaction \
    -f "supabase/migrations/${base}.sql" \
    -c "insert into supabase_migrations.schema_migrations (version, name, statements)
        values ('${version}', '${name}', '{}')"
done

echo
echo "--> verifying"
checks="$(psql_q -tA <<SQL
with fn as (
  select p.proname, p.prosrc, pg_get_function_result(p.oid) as result
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
)
select 'menu_items.is_active          = ' || count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'menu_items' and column_name = 'is_active'
union all
select 'vendor_set_menu_item_active   = ' || count(*) from fn where proname = 'vendor_set_menu_item_active'
union all
select 'vendor_apply_menu_state       = ' || count(*) from fn where proname = 'vendor_apply_menu_state'
union all
select 'vendor_menu returns is_active = ' || count(*) from fn
  where proname = 'vendor_menu' and result like '%is_active%'
union all
select 'vendor_menu newest first      = ' || count(*) from fn
  where proname = 'vendor_menu'
    and prosrc like '%order by m.created_at desc, m.sort_order, m.name, m.id;%'
union all
select 'order_notes                   = ' || count(*) from pg_class
  where oid = to_regclass('public.order_notes')
union all
select 'customer_order_signal         = ' || count(*) from fn where proname = 'customer_order_signal'
union all
select 'every migration recorded      = '
       || (count(*) = $(ls supabase/migrations/*.sql | wc -l | tr -d ' '))::int
  from supabase_migrations.schema_migrations;
SQL
)"
echo "$checks"
if grep -q '= 0$' <<<"$checks"; then
  echo "Verification FAILED." >&2
  exit 1
fi
