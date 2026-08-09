# Quality and license inventory

All runtime dependencies are local OSS packages; direct provenance is recorded in
[`license-inventory.md`](license-inventory.md). `pnpm audit:licenses` creates the completed,
lockfile-installed transitive [`license-audit.json`](license-audit.json) report and fails on
GPL/AGPL labels. M1 ships no GPL code/assets and calls no SaaS; package manifests pin direct
versions exactly.

Redact authorization/cookie/password/token fields, never commit default secrets, and keep API and
worker private. Health is process-only; readiness validates PostgreSQL and `0009_access_control`.
Run the PostgreSQL root/discovery-reconciliation oracle with
`docker compose --profile integration run --rm --build integration`; it uses the dedicated,
sentinel-guarded `gutter_integration` database.
Production uses `compose.production.example.yaml` and requires Docker Compose v2.24.4 or newer
because its secret overlay uses Compose reset tags to remove direct variables before mounting
`*_FILE` secrets.

Catalog list performance is verified with a generated 100k-row `catalog_series_list_state` fixture: `ANALYZE` plus JSON `EXPLAIN ANALYZE` must name the keyset B-tree and selective (three-or-more-character) trigram indexes. Timings are observational, not pass/fail thresholds.
