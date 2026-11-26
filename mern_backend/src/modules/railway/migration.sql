-- Railway integration: widen the provider_connections CHECK constraint.
--
-- Run this ONCE against your Neon database before connecting Railway. There is
-- no migration tool in this repo, and `schema.sql` is `IF NOT EXISTS`-guarded,
-- so re-applying it does NOT alter an existing table's constraint.
--
-- Without this, POST /api/v1/connections/railway/token fails with:
--   error: new row for relation "provider_connections" violates check
--   constraint "provider_connections_provider_type_check"  (SQLSTATE 23514)
--
-- Apply it with psql, or by pasting it into the Neon SQL editor:
--   psql "$DATABASE_URL" -f mern_backend/src/modules/railway/migration.sql
--
-- This statement lists EVERY provider, so running it also covers Render — it
-- is safe whether or not `modules/render/migration.sql` was applied first, and
-- safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- WHY 'azure' IS IN THIS LIST
--
-- The live Neon database's constraint contained 'azure' and the table had an
-- active 'azure' row, even though NOTHING in this repository references that
-- provider — it was added to the database by hand at some point. A migration
-- that listed only the providers the code knows about would have dropped it,
-- failed revalidation against that row, and rolled back.
--
-- So this list is the UNION of what the code supports and what the database
-- already holds. Dropping a value is a data decision, not a refactor: it
-- orphans whatever rows use it, and `services.provider_connection_id`
-- references them. If 'azure' is genuinely dead, delete its rows deliberately
-- first, then narrow the constraint in a separate change.
-- ---------------------------------------------------------------------------

BEGIN;

-- Pre-flight: turn Postgres's cryptic "is violated by some row" into a message
-- that names the values actually in the way. This is the check whose absence
-- made the azure drift above a surprise.
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(DISTINCT provider_type, ', ')
    INTO offenders
    FROM provider_connections
   WHERE provider_type NOT IN
         ('vercel', 'render', 'railway', 'cloudflare', 'azure', 'neon', 'atlas', 'homelab');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'provider_connections holds provider_type value(s) not in the new CHECK list: %. '
      'Add them to both lists in this file (and to schema.sql) before running it, '
      'or delete those rows deliberately first.', offenders;
  END IF;
END $$;

ALTER TABLE provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_provider_type_check;

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_provider_type_check
  CHECK (provider_type IN
         ('vercel', 'render', 'railway', 'cloudflare', 'azure', 'neon', 'atlas', 'homelab'));

COMMIT;

-- Verify:
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'provider_connections'::regclass
--      AND contype = 'c';
