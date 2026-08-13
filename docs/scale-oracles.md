# Scale and concurrency oracles

`tests/integration/scale-oracles.mts` is the reproducible M6-1 oracle. It uses a
deterministic seed (`SCALE_SEED`, default `gutter-issue-26-v1`) and real PostgreSQL tables,
indexes, and the derived-page cache. The default CI-sized fixture is 1,000 books × 10 pages
(10,000 page rows). The opt-in full fixture is 100,000 books × 20 pages (2,000,000 page rows):

```sh
GUTTER_SCALE_ORACLE=1 pnpm --filter @gutter/db exec tsx ../../tests/integration/scale-oracles.mts
GUTTER_SCALE_ORACLE=1 SCALE_FULL=1 pnpm --filter @gutter/db exec tsx ../../tests/integration/scale-oracles.mts
```

The oracle hard-fails on exact row counts, the production catalog/search query shape and its
joined plan (`catalog_series_list_state`, publications, releases, and source items), five-reader
producer coalescing, warm-cache hits, a successful quota-preserving GC result, native scanner and
reconciliation outcomes (`updated=N`, then `unchanged=N`, then exactly one changed manifest), and
20 TiB of aggregate sparse logical capacity, split across two 10-TiB files so the probe also runs
on filesystems with a 16-TiB per-file limit, while allocated blocks remain negligible. Its 1,000-file Compose
fixture writes valid one-page CBZs under the disposable `scale-source` volume, runs the real
discovery scanner/reconciler, starts the production worker entrypoint with its PgBoss
reconciliation queue, verifies a queue-completed scan, validates a page through `page-validator`,
and reads bytes through `reader-stream` and `derived-cache`. It prints p50/p95
catalog/search/native-scan timings for
diagnosis only; timing is not a correctness gate because CI hardware is variable. The portable
regression baseline is exact counts, zero quarantines, one cold producer for five readers, a true
within-quota GC result, required production joins in both plans, and fewer than 1,024 allocated
filesystem blocks for the sparse probe. The report records Node/PostgreSQL versions, seed,
run ID, dataset sizes, query shape, queue completion, cache pressure/reclamation, and the sparse
file count, maximum file size, aggregate logical size, and aggregate allocation. It is emitted as
a JSON line and written to `SCALE_EVIDENCE_PATH` (or a temporary
file); its committed schema and baseline are `docs/scale-oracle-evidence.schema.json` and
`docs/scale-oracle-baseline.json`. Run on isolated disposable
PostgreSQL storage; never point it at a user database.

The 10k tiny-CBZ and hardware latency runs are intentionally opt-in. Correctness/plan assertions
are separate from latency reports, and a missing platform capability must be recorded rather than
converted into a passing timing claim.

The optional tiny-CBZ filesystem probe creates exactly 10,000 structurally valid deterministic
one-page archives, enumerates them with the project discovery scanner, validates one through the
project page validator, and removes its temporary directory:

```sh
SCALE_TINY_CBZ=1 pnpm benchmark:tiny-cbz
```
