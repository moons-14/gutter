# Architecture

M0 dependency direction is `apps -> packages`; packages never import apps. `web` is static and
same-origin proxies `/api` through Caddy. `api`, `worker`, `migrate`, and PostgreSQL are internal;
only web publishes port 8080. PostgreSQL is `postgres:18.1` (verified available on Docker Hub on
2026-08-08). Named `db-data` and `cache-data` volumes persist state.

Drizzle robustness is preferred over SQL hacks. `migrate` is the sole schema applier and installs
the idempotent `0000_initial` version. API and worker reject incompatible schema versions. Worker
uses pg-boss. Pino JSON logging redacts secrets and Prometheus serves internal metrics. Containers
run non-root where the base permits it and do not mount libraries into API. Secrets accept direct
development variables or `*_FILE` paths.

Target scale is 100k books, 20 TB, and five users. Benchmark by generated metadata/path fixtures,
controlled CBZ/image samples, and representative PostgreSQL query/load tests; do not require 20 TB
physical test data.
