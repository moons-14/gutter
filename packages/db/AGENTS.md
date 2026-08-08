# Database package

`migrate` is the sole schema applier. M1 uses PostgreSQL 18 and Drizzle-style SQL migrations.
The worker asserts `0002_source_inventory` before reconciling library-root snapshots, then starts
pg-boss. Keep filesystem and archive work outside short database transactions.
