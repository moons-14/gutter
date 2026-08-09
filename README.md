# gutter

MIT-licensed, self-hosted comic-library foundation. M3 keeps library sources read-only while the
internal worker streams authorized pages and maintains a disposable derived-byte cache; authentication
and a reader UI are not implemented.

## Linux quickstart

Install Docker Compose, set an explicit development password, and start the stack:

```sh
read -rs POSTGRES_PASSWORD
export POSTGRES_PASSWORD
docker compose up --build
```

Only the web service is published (`http://localhost:8080`). The web reverse-proxies `/api` to
the internal API. Run `docker compose --profile test run --rm test` for the live-stack smoke
after `docker compose up -d db migrate api web`.

For production, Docker Compose v2.24.4 or newer is required for the reset tags in the overlay.
Create non-committed `secrets/postgres_password` and `secrets/database_url`, then run:

```sh
docker compose -f compose.yaml -f compose.production.example.yaml up --build
```

The overlay removes the direct development variables before PostgreSQL consumes its official
`POSTGRES_PASSWORD_FILE` and API, worker, and migrate consume `DATABASE_URL_FILE`. The values are
mandatory at runtime: use either direct development values or the file variants, never both.

For NAS libraries, mount NFS/SMB on the host and bind only that host mount into `worker`. Copy the
tracked example and adjust its one root id, host mount, and matching container path:

```sh
sudo mount -t nfs nas:/comics /mnt/comics
cp compose.library.example.yaml compose.library.yaml
docker compose -f compose.yaml -f compose.library.yaml up --build
```

`GUTTER_ALLOWED_ROOTS_JSON` defaults to `[]` and is immutable process configuration: it is a JSON
array of at most 64 `{ "id", "path" }` objects. IDs match `^[a-z][a-z0-9-]{0,62}$`; paths are
absolute worker-container paths, cannot be `/`, and cannot be equal or nested. One worker-container
mount namespace can contain multiple explicit worker-only `:ro` binds, one for each configured
path; it does not create a namespace per root. The worker checks each configured directory before
its queue starts, records the snapshot in PostgreSQL, then queues one bounded read-only discovery
run per ready root. Discovery recognizes CBZ archives and innermost image directories, quarantines
bad archives, and never writes library contents. It reads an optional direct `ComicInfo.xml` as
rebuildable local metadata (exact filename wins; a unique case variant is accepted with a warning),
while page order/count remain the source of truth. Global catalog suppression is stored separately
from source metadata and does not modify or delete a library file. Changed manifests enqueue a
worker-only full-frame validation: invalid pages are skipped and a fully invalid item is hidden
from the visible catalog. Limits are 128 MiB/page, 2 GiB/item, and 100M input pixels.
Validation is retried with bounded backoff and becomes terminal after the fifth failed lease; a later
source change creates a new intent (manual retry is a future administrative feature).
Full reconciliation is durable database state and runs every 15 minutes by default, rather than
trusting NAS file events. `GUTTER_RECONCILIATION_INTERVAL_SECONDS` accepts 60–86400 and
`GUTTER_STABLE_GRACE_MS` accepts 0–60000. Internal operator control uses configured root IDs only,
never paths:

```sh
docker compose exec worker node --import tsx src/scan.ts scan status
docker compose exec worker node --import tsx src/scan.ts scan enqueue --root <root-id>
docker compose exec worker node --import tsx src/scan.ts scan cancel --request <request-uuid>
docker compose exec worker node --import tsx src/scan.ts scan cancel --run <run-bigint>
```

The command receives the worker's existing database configuration and exposes safe IDs, counters,
and bounded codes only. A request received during a running scan creates one durable follow-up.
Optional watcher hints are disabled by default (`GUTTER_WATCHER_HINTS_ENABLED=false`) and debounce
for five seconds (`GUTTER_WATCHER_HINT_DEBOUNCE_MS=5000`); they only queue a full root reconciliation
and never make deletion decisions from NAS events.
On older Linux kernels, recursive read-only bind mounts may leave submounts writable; use a
Docker/Linux version that enforces recursive read-only mounts or ensure the host mount layout has
no writable submounts.

## Derived reader cache

The worker opens and pins the currently authorized source page before consulting its cache. Cache
bytes are therefore never authorization or source truth: a missing, deleted, or corrupt entry is
regenerated from the source, and no library file is changed. `cache-data` is mounted only into the
single Compose worker service. In this deployment, cache coalescing and leases are worker-process
local; multiple worker replicas sharing a cache volume are unsupported until durable coordination is
introduced.

The worker defaults to `/cache/derived` and a 10 GiB quota. Set
`GUTTER_DERIVED_CACHE_ROOT` (absolute worker path) and
`GUTTER_DERIVED_CACHE_QUOTA_BYTES` (1 through 50,000,000,000) to change them. The following
operator commands expose filesystem-authoritative current bytes and quota plus advisory, rebuildable
hit/miss/eviction/failure/last-GC counters; counters reset if the disposable cache is removed:

```sh
docker compose exec worker node --import tsx src/cache.ts status
docker compose exec worker node --import tsx src/cache.ts gc
```

Do not mount remote storage in API containers. Restore PostgreSQL only with an operator-managed
`pg_dump`/`pg_restore` workflow while the application is stopped. Put Caddy/Nginx or Tailscale in
front of port 8080 for remote access. TLS, auth, external metadata providers, and reader streaming are
later milestones. Run focused root/discovery checks with `pnpm unit` and start the snapshot flow with the
Compose command above. Run the PostgreSQL reconciliation oracle with
`docker compose --profile integration run --rm --build integration`; it uses a dedicated
`gutter_integration` database and requires its test-only environment sentinel.
