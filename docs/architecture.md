# Architecture

M2 dependency direction is `apps -> packages`; packages never import apps. `web` is static and
same-origin proxies `/api` through Caddy. `api`, `worker`, `migrate`, and PostgreSQL are internal;
only web publishes port 8080. PostgreSQL is `postgres:18.1`; named `db-data` and worker-only
`cache-data` volumes persist state. The cache is derived and disposable, not a database projection
or authorization source: the worker opens the currently authorized source before cache lookup. The
Compose topology declares one worker service, so cache coalescing/leases are process-local; do not
scale workers onto a shared cache volume without durable coordination.

`migrate` is the sole schema applier. The idempotent `0007_metadata_integration` migration adds rebuildable
libraries, series, publications, releases and exact creator/group/publisher credits. Each identity
stores its canonical JSON alongside its SHA-256 key, so rebuild inputs remain inspectable. Catalog reads
start at `visible_source_items`, so suppression, quarantine, inactivity and zero-valid items are
filtered before aggregation; durable preferred-release rows are keyed by root and canonical publication
identity and are never rebuilt. The idempotent `0005_reconciliation_control` migration adds
durable scan requests, heartbeat/progress, cancellation flags, and due reconciliation state. A
30-second worker coordinator advances due roots and queues ordinary pg-boss request-ID jobs; it does
not use pg-boss cron or filesystem events. Requests coalesce per root and a running request gets one
durable follow-up. The idempotent `0004_page_validation` migration adds durable
manifest-addressed validation intents and page results. A changed manifest makes old results
non-authoritative immediately; a completed zero-valid result hides an item without touching its source.
The idempotent `0003_comicinfo_metadata` migration adds
rebuildable ComicInfo-derived metadata, page annotations and lifecycle issues alongside durable global
suppression rows; API/worker reject incompatible schemas. Before pg-boss starts, the
worker parses immutable `GUTTER_ALLOWED_ROOTS_JSON`, validates each configured directory in its one
container mount namespace, then writes one short reconciliation transaction. Library binds are
explicit, worker-only, and read-only; API never receives a library bind. Validation only uses
metadata, canonical path resolution, and one directory entry. After queue startup, the worker runs
bounded read-only discovery for ready roots; malformed archives are quarantined individually.
Discovery jobs persist only the root ID (with an optional observed generation for logs), use an
exclusive root-ID singleton key, and resolve the immutable ready-root map of their own worker
process. A removed or unready root is a successful no-op; a generation mismatch rebinds to that
process's current snapshot. M1 does not coordinate configuration rollout across multiple workers.
Active item batches become visible progressively; only a completed run performs final removals.
CBZ inspection owns a no-follow file descriptor and closes both archive and descriptor exactly once.
The scan re-realpaths before each directory open and checks containment; host filesystem mutation
races after that check remain an inherited best-effort limitation.

ComicInfo is local, optional, and never changes source files. A bounded UTF-8-only parser rejects DTDs,
entities and namespaces; valid fields override inferred title/series while page locators remain source-authoritative.
Global suppression is deliberately separate from rebuildable scan state. The static mobile catalog uses
same-origin `/api/catalog` reads only. Series lists have unsigned opaque, filter-bound (base64url JSON plus SHA-256 filter-hash)
keyset cursors for name, source update, discovery and metadata update order; cursor IDs stay decimal
strings and timestamp keys remain PostgreSQL microsecond text. A configured but temporarily unavailable
root retains its last active catalog; only an explicitly inactive/removed root is hidden. It is suitable
for trusted local/LAN deployment, not Internet exposure. M2 watcher hints are optional,
default-off, and never deletion truth. The M3 #20 validation reader keeps descriptors and page bytes
worker-owned and network-only. Its route-local scheduler uses `cache: no-store`, owns/revokes a
maximum three Blob URLs within 32 MiB, and persists only presentation and revision-aware progress.
There is no auth, mutable root API, or external provider. Page
validation is a worker-only, read-only follow-up: it
checks ZIP CRCs and fully decodes a first frame with sharp. Each page has a 128 MiB cap, an item has a
2 GiB aggregate cap, and decoder input is capped at 100M pixels. Same-size/same-mtime replacement is
a documented best-effort limitation. Claims carry a monotonically increasing lease epoch; expired
owners cannot renew, release, or complete after reclamation. Failures back off and become terminal on
the fifth claim until the source changes. Pino JSON
logging redacts secrets; direct development secrets and `*_FILE` variants remain supported.
