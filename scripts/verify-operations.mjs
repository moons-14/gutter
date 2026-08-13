import { readFile } from 'node:fs/promises';
const runbook = await readFile(new URL('../docs/operations-runbook.md', import.meta.url), 'utf8');
const drill = await readFile(new URL('./compose-restore-drill.sh', import.meta.url), 'utf8');
const required = ['gutter_queue_lag_seconds', 'gutter_database_size_bytes', 'expand/contract', 'fresh, isolated Compose', 'tombstone', 'NAS unavailable', 'Full cache disk'];
for (const term of required) if (!runbook.includes(term)) throw new Error(`runbook_missing:${term}`);
if (/172\.30\.0\.0\/24|ipv4_address/.test(drill)) throw new Error('drill_fixed_network_detected');
if (!drill.includes('internal: !override')) throw new Error('drill_network_override_missing');
console.log(`operations runbook checks passed (${required.length} requirements)`);
