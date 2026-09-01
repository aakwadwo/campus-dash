#!/usr/bin/env node
/**
 * Prints a stable, sorted description of everything the security model depends
 * on: tables, columns, enums, constraints, indexes, triggers, RLS, policies,
 * functions, grants, revokes, default privileges, scheduled jobs, storage
 * buckets and platform reference data.
 *
 * Its reason to exist is one question: does supabase/schema.sql, installed into
 * an empty database, produce the same database that supabase/migrations/
 * produces? Take a snapshot of each and diff them. A difference is either a bug
 * in the canonical schema or a deliberate decision — and it has to be one or
 * the other, never unnoticed.
 *
 *   node scripts/schema-snapshot.mjs > /tmp/from-migrations.json
 *   # ...install schema.sql into an empty database...
 *   node scripts/schema-snapshot.mjs > /tmp/from-schema.json
 *   diff /tmp/from-migrations.json /tmp/from-schema.json
 *
 * Connects to the local stack by default; pass SUPABASE_DB_URL to point it at
 * any other database, including the hosted project.
 */

import pg from 'pg';

const QUERIES = {
  enums: `
    select t.typname || ' = ' || string_agg(e.enumlabel, ',' order by e.enumsortorder) as v
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
     group by t.typname`,

  tables: `
    select c.relname || ' rls=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'`,

  columns: `
    select table_name || '.' || column_name || ' ' || data_type
           || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '-') as v
      from information_schema.columns
     where table_schema = 'public'`,

  constraints: `
    select rel.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) as v
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public'`,

  indexes: `
    select indexname || ' :: ' || indexdef as v
      from pg_indexes where schemaname = 'public'`,

  triggers: `
    select n.nspname || '.' || c.relname || ' ' || t.tgname || ' :: '
           || pg_get_triggerdef(t.oid) as v
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname in ('public', 'auth')`,

  policies: `
    select tablename || ' ' || policyname || ' ' || cmd
           || ' roles=' || array_to_string(roles, ',')
           || ' using=' || coalesce(qual, '-')
           || ' check=' || coalesce(with_check, '-') as v
      from pg_policies where schemaname = 'public'`,

  functions: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ' returns ' || pg_get_function_result(p.oid)
           || ' lang=' || l.lanname
           || ' secdef=' || p.prosecdef
           || ' volatile=' || p.provolatile::text
           || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
           || ' md5=' || md5(p.prosrc) as v
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public'`,

  table_grants: `
    select grantee || ' ' || privilege_type || ' on ' || table_name as v
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`,

  function_grants: `
    select r.rolname || ' EXECUTE on ' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')' as v
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
     where n.nspname = 'public'
       and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,

  public_function_grants: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ' is EXECUTE-able by PUBLIC' as v
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and coalesce(array_to_string(p.proacl, ','), '') like '%=X/%'
       and coalesce(array_to_string(p.proacl, ','), '') like '%,=X/%'`,

  default_privileges: `
    select coalesce(n.nspname, '-') || ' ' || d.defaclobjtype::text || ' by '
           || r.rolname || ' :: ' || e.entry::text as v
      from pg_default_acl d
      join pg_roles r on r.oid = d.defaclrole
      left join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral unnest(d.defaclacl) as e(entry)
     where coalesce(n.nspname, '') = 'public'`,

  extensions: `
    select e.extname || ' @ ' || n.nspname as v
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace`,

  cron_jobs: `
    select jobname || ' | ' || schedule || ' | ' || btrim(command) as v
      from cron.job where jobname like 'campus-dash-%'`,

  storage_buckets: `
    select id || ' public=' || public
           || ' limit=' || coalesce(file_size_limit::text, '-')
           || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), '-') as v
      from storage.buckets`,

  // Reference data the product cannot start without. Development actors are
  // deliberately not compared: the seed is not part of the canonical schema.
  reference_pricing_config: `
    select 'service_fee_bps=' || service_fee_bps
           || ' delivery_fee_pesewas=' || delivery_fee_pesewas
           || ' partner_share_of_delivery_bps=' || partner_share_of_delivery_bps
           || ' vendor_response_seconds=' || vendor_response_seconds
           || ' partner_search_seconds=' || partner_search_seconds
           || ' customer_absent_wait_seconds=' || customer_absent_wait_seconds
           || ' payment_pending_timeout_seconds=' || payment_pending_timeout_seconds as v
      from public.pricing_config where id`,

  reference_terms: `
    select audience || ' v' || version || ' :: ' || title || ' :: ' || md5(body) as v
      from public.terms_documents`,
};

const url = process.env.SUPABASE_DB_URL;
const client = new pg.Client(
  url
    ? {
        connectionString: url,
        ssl:
          url.includes('localhost') || url.includes('127.0.0.1')
            ? false
            : { rejectUnauthorized: false },
      }
    : {
        host: process.env.TEST_PGHOST || '127.0.0.1',
        port: Number(process.env.TEST_PGPORT || 54322),
        database: 'postgres',
        user: 'postgres',
        password: 'postgres',
      }
);

await client.connect();
const snapshot = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  const { rows } = await client.query(sql);
  snapshot[name] = rows.map((r) => r.v).sort();
}
await client.end();

console.log(JSON.stringify(snapshot, null, 2));
