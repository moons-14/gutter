# Database package

`migrate` is the sole schema applier. M1 uses PostgreSQL 18 and Drizzle-style SQL migrations.
The worker asserts `0001_library_roots` before reconciling library-root snapshots, then starts
pg-boss. Keep filesystem work outside the short database transaction.
