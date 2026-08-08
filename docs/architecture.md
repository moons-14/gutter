# Architecture

M1 dependency direction is `apps -> packages`; packages never import apps. `web` is static and
same-origin proxies `/api` through Caddy. `api`, `worker`, `migrate`, and PostgreSQL are internal;
only web publishes port 8080. PostgreSQL is `postgres:18.1`; named `db-data` and `cache-data`
volumes persist state.

`migrate` is the sole schema applier. The idempotent `0004_page_validation` migration adds durable
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
Global suppression is deliberately separate from rebuildable scan state. M1 has no watcher, reader, auth,
mutable root API, or external provider. Page validation is a worker-only, read-only follow-up: it
checks ZIP CRCs and fully decodes a first frame with sharp. Each page has a 128 MiB cap, an item has a
2 GiB aggregate cap, and decoder input is capped at 100M pixels. Same-size/same-mtime replacement is
a documented best-effort limitation. Claims carry a monotonically increasing lease epoch; expired
owners cannot renew, release, or complete after reclamation. Failures back off and become terminal on
the fifth claim until the source changes. Pino JSON
logging redacts secrets; direct development secrets and `*_FILE` variants remain supported.
