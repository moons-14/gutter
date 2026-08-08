# M1 acceptance mapping

| ID          | Decision / validation                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| M1R-001     | Immutable `GUTTER_ALLOWED_ROOTS_JSON` parser, canonical JSON, SHA-256 generation, and `pnpm unit` |
| M1R-002     | Worker-only `:ro` bind example and `docker compose config`                                        |
| M1R-003–004 | `@gutter/library-roots` namespace validation and focused filesystem fixtures                      |
| M1R-005     | `packages/db/drizzle/0002_source_inventory.sql` and repeated migration integration oracle         |
| M1R-006     | Worker reconciliation before pg-boss; PostgreSQL integration oracle                               |
| M1R-007     | Package-only domain dependency direction and no API-contract change                               |
| M1R-008     | `pnpm unit` parser and filesystem cases                                                           |
| M1R-009     | README/Compose/docs boundary and exact integration command                                        |

M1 records immutable configured-root availability snapshots and rebuildable, read-only source
inventory discovery. Issue #5 adds the rebuildable local ComicInfo projection (`ComicInfo.xml`,
Anansi v1/v2/common v2.1 draft fields; pinned source commit
`99e1453a163c777b4b5320a68732f6f133ac7918`) and durable global suppression. Issue #4 adds
worker-only streaming CRC/full-first-frame image validation. M2 may use disabled-by-default watcher
hints that discard event paths and only enqueue full-root reconciliation; it has no reader, auth,
mutable registration API/UI, external provider, or source writes.
User-specific hiding is deferred until authentication and will use a separate table. Run the
focused PostgreSQL oracle with `docker compose --profile integration run --rm --build integration`.
