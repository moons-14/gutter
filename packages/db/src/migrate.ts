import { migrateSchema, pool } from './index.js';

await migrateSchema();
await pool.end();
