import { readFile } from 'node:fs/promises';
const runbook = await readFile(new URL('../docs/operations-runbook.md', import.meta.url), 'utf8');
const drill = await readFile(new URL('./compose-restore-drill.sh', import.meta.url), 'utf8');
const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const productionCompose = await readFile(
  new URL('../compose.production.example.yaml', import.meta.url),
  'utf8',
);
const migration = await readFile(
  new URL('./migration-compatibility-oracle.sh', import.meta.url),
  'utf8',
);
const migrationFixture = await readFile(
  new URL('./prepare-migration-compatibility-fixture.sh', import.meta.url),
  'utf8',
);
const releaseGates = await readFile(new URL('./run-release-gates.sh', import.meta.url), 'utf8');
const composeSmoke = await readFile(new URL('./compose-smoke-release.sh', import.meta.url), 'utf8');
const required = [
  'gutter_queue_lag_seconds',
  'gutter_database_size_bytes',
  'expand/contract',
  'fresh, isolated Compose',
  'tombstone',
  'NAS unavailable',
  'Full cache disk',
  'GUTTER_BACKUP_ROLE',
  'GUTTER_RESTORE_CONFIRMATION',
  'catalog_preferred_release_overrides',
  'source_metadata_issues',
  'GUTTER_MIGRATION_CONFIRM',
];
for (const term of required)
  if (!runbook.includes(term)) throw new Error(`runbook_missing:${term}`);
if (/172\.30\.0\.0\/24|ipv4_address|(^|\n)[ \t]*subnet:/.test(compose + productionCompose))
  throw new Error('fixed_network_detected');
if (
  !/^networks:\s*$/m.test(compose) ||
  !/^  internal:\s*$/m.test(compose) ||
  !/^    internal: true\s*$/m.test(compose)
)
  throw new Error('internal_network_definition_missing');
if (!drill.includes('internal: !override')) throw new Error('drill_network_override_missing');
if (!drill.includes('compose_build_flags="--build"'))
  throw new Error('drill_exact_tree_build_missing');
if (/trap[^\n]*\bERR\b|\$LINENO/.test(drill)) throw new Error('drill_uses_nonportable_err_trap');
if (!drill.includes('chmod 644 "$root/secrets"/*'))
  throw new Error('drill_secret_permissions_missing');
if (!releaseGates.includes('chmod 0444 "$path"'))
  throw new Error('release_secret_permissions_missing');
if (!releaseGates.includes('./scripts/compose-smoke-release.sh'))
  throw new Error('compose_smoke_wrapper_missing');
if (
  !/project="gutter-release-smoke-/.test(composeSmoke) ||
  !composeSmoke.includes('docker compose -p "$project" up --build')
)
  throw new Error('compose_smoke_isolation_missing');
if (
  !composeSmoke.includes('down -v --remove-orphans') ||
  !composeSmoke.includes('trap cleanup EXIT')
)
  throw new Error('compose_smoke_cleanup_missing');
if (
  !drill.includes('merged_config=') ||
  !drill.includes('fixed network address or subnet detected')
)
  throw new Error('drill_network_preflight_missing');
if (!drill.includes('backup-postgres.sh') || !drill.includes('restore-postgres.sh'))
  throw new Error('real_backup_restore_scripts_missing');
if (!drill.includes('/api/metrics') || !drill.includes('404'))
  throw new Error('public_metrics_probe_missing');
if (!drill.includes('project_b=') || !drill.includes('run_id='))
  throw new Error('unique_drill_project_missing');
if (!caddy.includes('handle /api/metrics') || !caddy.includes('respond 404'))
  throw new Error('public_metrics_not_denied');
if (!migration.includes('pg_restore --list') || !migration.includes('roll forward'))
  throw new Error('migration_oracle_missing');
if (
  !migrationFixture.includes('prior_tag=0013_runtime_acl_bootstrap') ||
  !migrationFixture.includes('meta/_journal.json') ||
  !migrationFixture.includes('./scripts/migration-compatibility-oracle.sh')
)
  throw new Error('migration_fixture_missing');
console.log(`operations runbook checks passed (${required.length} requirements)`);
