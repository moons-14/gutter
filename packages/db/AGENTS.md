# Database package

`migrate` is the sole schema applier. M0 uses PostgreSQL 18 and exactly one idempotent initial
Drizzle-style SQL migration. API and worker must call `assertSchema` before readiness.
