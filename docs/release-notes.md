# Gutter v1 release record

This file is the tracked release-notes, known-limits, and rollback reference. A published release
must append the exact commit, image digests, evidence JSON path/checksum, SBOM/provenance paths,
and the output of `verify-release-gate.mjs final`.

Known limits: Linux is official; macOS/Windows Docker and NFS/SMB behavior are best-effort and
must carry explicit unavailable reasons when untested. Catalog projections are rebuildable, while
auth/ACL/user state, overrides, audit, tombstone, and error records require PostgreSQL backup.

Rollback is restore-then-roll-forward after a destructive migration; binary downgrade is not a
supported recovery path. See `docs/operations-runbook.md` for the bounded recovery procedure.
