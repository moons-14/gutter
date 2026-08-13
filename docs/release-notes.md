# Gutter v1 release record

This file is the tracked release-notes, known-limits, and rollback reference. A published release
must append the exact commit, image digests, evidence JSON path/checksum, SBOM/provenance paths,
and the output of `verify-release-gate.mjs final`.

Known limits: Linux is official; macOS/Windows Docker and NFS/SMB behavior are best-effort and
must carry explicit unavailable reasons when untested. Catalog projections are rebuildable, while
auth/ACL/user state, overrides, audit, tombstone, and error records require PostgreSQL backup.

The web image retains the official Caddy v2.11.4 Alpine runtime layout but replaces its binary
with a reproducible source build. The source tag, peeled commit, archive checksum, immutable Go
builder, module requirements, build flags, and Apache-2.0/BSD notices are tracked in
`docs/release-tool-refs.json` and `docs/license-inventory.md`. This is a constrained security
patch until an official Caddy image includes the required upstream module fixes; rollback is to
the preceding immutable web image digest only after the release gate re-scans it.

Rollback is restore-then-roll-forward after a destructive migration; binary downgrade is not a
supported recovery path. See `docs/operations-runbook.md` for the bounded recovery procedure.
