# Architecture

M1 dependency direction is `apps -> packages`; packages never import apps. `web` is static and
same-origin proxies `/api` through Caddy. `api`, `worker`, `migrate`, and PostgreSQL are internal;
only web publishes port 8080. PostgreSQL is `postgres:18.1`; named `db-data` and `cache-data`
volumes persist state.

`migrate` is the sole schema applier. The idempotent `0001_library_roots` migration adds the
library-root snapshot table, and API/worker reject incompatible schemas. Before pg-boss starts, the
worker parses immutable `GUTTER_ALLOWED_ROOTS_JSON`, validates each configured directory in its one
container mount namespace, then writes one short reconciliation transaction. Library binds are
explicit, worker-only, and read-only; API never receives a library bind. Validation only uses
metadata, canonical path resolution, and one directory entry: it never scans or changes sources.

M1 has no catalog scanner, watcher, reader, auth, mutable root API, or external provider. Pino JSON
logging redacts secrets; direct development secrets and `*_FILE` variants remain supported.
