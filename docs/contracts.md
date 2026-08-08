# M1 acceptance mapping

| ID          | Decision / validation                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| M1R-001     | Immutable `GUTTER_ALLOWED_ROOTS_JSON` parser, canonical JSON, SHA-256 generation, and `pnpm unit` |
| M1R-002     | Worker-only `:ro` bind example and `docker compose config`                                        |
| M1R-003–004 | `@gutter/library-roots` namespace validation and focused filesystem fixtures                      |
| M1R-005     | `packages/db/drizzle/0001_library_roots.sql` and repeated migration integration oracle            |
| M1R-006     | Worker reconciliation before pg-boss; PostgreSQL integration oracle                               |
| M1R-007     | Package-only domain dependency direction and no API-contract change                               |
| M1R-008     | `pnpm unit` parser and filesystem cases                                                           |
| M1R-009     | README/Compose/docs boundary and exact integration command                                        |

M1 records immutable configured-root availability snapshots only. It does not provide a scanner,
watcher, reader, auth, mutable registration API/UI, external provider, or source writes. Run the
focused PostgreSQL oracle with `docker compose --profile integration run --rm --build integration`.
