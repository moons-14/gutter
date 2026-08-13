import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const policy = await readFile(new URL('../packages/db/drizzle/0013_runtime_acl_bootstrap.sql', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../scripts/bootstrap-runtime-acl.sh', import.meta.url), 'utf8');
const migrate = await readFile(new URL('../packages/db/src/migrate.ts', import.meta.url), 'utf8');
const restore = await readFile(new URL('../scripts/restore-postgres.sh', import.meta.url), 'utf8');
const workerReadiness = await readFile(
  new URL('../apps/worker/src/operator-metrics.ts', import.meta.url),
  'utf8',
);

test('canonical runtime policy is reused by migration and restore bootstrap', () => {
  assert.match(policy, /revoke all on all tables in schema public from gutter_api, gutter_worker/);
  assert.match(policy, /grant execute on function gutter_user_can_read_release\(text, bigint\) to gutter_api;/);
  assert.match(policy, /grant execute on function gutter_user_can_read_release\(text, bigint\) to gutter_worker;/);
  assert.match(policy, /public_progress_source_items, public_reader_source_pages,/);
  assert.match(policy, /gutter_public_api_tokens, gutter_user_state_revisions/);
  assert.match(policy, /grant insert, update on gutter_public_api_tokens to gutter_api;/);
  assert.match(bootstrap, /0013_runtime_acl_bootstrap\.sql/);
  assert.match(migrate, /0013_runtime_acl_bootstrap\.sql/);
  assert.match(workerReadiness, /version='0013_runtime_acl_bootstrap'/);
});

test('worker policy excludes auth, ACL, and user-state DML while preserving queue/catalog access', () => {
  assert.doesNotMatch(policy, /grant [^;]+ on[^;]*(?:"user"|library_access_grants|user_target_state|user_progress|gutter_acl_audit)[^;]* to gutter_worker/);
  assert.match(policy, /grant select, insert, update, delete on\n  catalog_libraries, catalog_series/);
  assert.match(policy, /grant delete on validation_intents to gutter_worker/);
  assert.match(policy, /grant select, insert, update, delete on all tables in schema pgboss to gutter_worker/);
  assert.match(policy, /grant execute on function gutter_change_library_access\(text, text, text, text, text\) to gutter_api/);
});

test('restore refuses non-fresh targets and never cleans a live schema', () => {
  assert.doesNotMatch(restore, /pg_restore --clean/);
  assert.match(restore, /target_relations=/);
  assert.match(restore, /target_functions=/);
  assert.match(restore, /unexpected_extensions=/);
  assert.match(restore, /extname not in \('plpgsql', 'pg_trgm'\)/);
  assert.match(restore, /create extension if not exists pg_trgm/);
});
