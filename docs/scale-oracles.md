# Scale and concurrency oracles

`tests/integration/scale-oracles.mts` is the reproducible M6-1 oracle. It uses a
deterministic seed (`SCALE_SEED`, default `gutter-issue-26-v1`) and real PostgreSQL tables,
indexes, and the derived-page cache. The default CI-sized fixture is 1,000 books × 10 pages
(10,000 page rows). The opt-in full fixture is 100,000 books × 20 pages (2,000,000 page rows):

```sh
GUTTER_SCALE_ORACLE=1 pnpm --filter @gutter/db exec tsx ../../tests/integration/scale-oracles.mts
GUTTER_SCALE_ORACLE=1 SCALE_FULL=1 pnpm --filter @gutter/db exec tsx ../../tests/integration/scale-oracles.mts
```

The oracle hard-fails on exact row counts, the catalog ordering index, the trigram search index,
five-reader producer coalescing, warm-cache hits, cache GC completion, changed/no-change scan
counts, and a sparse 20-TB logical file whose allocated blocks remain negligible. It prints p50/p95
catalog/search/scan timings for
diagnosis only; timing is not a correctness gate because CI hardware is variable. The report
records Node/PostgreSQL versions, seed, dataset sizes, selected indexes, cache results, and sparse
allocation. Run on isolated disposable PostgreSQL storage; never point it at a user database.

The 10k tiny-CBZ and hardware latency runs are intentionally opt-in. Correctness/plan assertions
are separate from latency reports, and a missing platform capability must be recorded rather than
converted into a passing timing claim.

The optional tiny-CBZ filesystem probe creates exactly 10,000 deterministic one-page archives,
enumerates and validates them, then removes its temporary directory:

```sh
SCALE_TINY_CBZ=1 pnpm benchmark:tiny-cbz
```
