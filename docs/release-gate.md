# v1 release gate

This document is the release contract for the local/NAS Compose deployment. A release is
one exact Git tree, identified by its commit, lockfile, image digests, generated evidence, and
the operator record. The gate is fail-closed: a missing result is `unavailable`, never `pass`.

## Deployment matrix and NAS mounts

Linux is the official validation platform: the pinned Node, PostgreSQL, Caddy, and Playwright
versions in this tree must run through CI and the Compose smoke job. macOS and Windows Docker
Desktop are best-effort only; record the platform, Docker/Compose versions, command, and an
explicit `unavailable` reason when Docker, NFS, SMB, or the required filesystem behavior is not
available. Do not infer support from a host that was not tested.

The source inventory is always read-only. Start from `compose.library.example.yaml`, replacing
the placeholder host path outside version control:

```yaml
services:
  worker:
    environment:
      GUTTER_ALLOWED_ROOTS_JSON: '[{"id":"comics","path":"/libraries/comics"}]'
    volumes:
      - /mnt/comics:/libraries/comics:ro
```

For a local disk, use `/srv/gutter/library:/libraries/comics:ro`. For an NFS mount, mount it on
the host first with the site’s approved `ro` export and then use
`/mnt/nfs/comics:/libraries/comics:ro`. For SMB/CIFS, mount the host share with a root-owned
credentials file (`chmod 600`), `ro`, and a least-privilege UID/GID, then use
`/mnt/smb/comics:/libraries/comics:ro`. Never put credentials or host paths in the committed
Compose examples. A missing or disconnected mount is an unavailable source: scans must not mark
items deleted or mutate projections; follow the NAS-unavailable runbook in
`docs/operations-runbook.md`.

`scripts/nas-source-oracle.sh` is the mandatory Linux local-source check: it attempts a mutation
against a read-only fixture, verifies the source hash is unchanged, and emits typed NFS/SMB
best-effort unavailable records with the exact host probe command required for an operator mount.

## Required exact-tree evidence

The release record must contain the commit SHA, `pnpm-lock.yaml` checksum, image references and
digests, and the output of these gates on that same tree. The machine-readable record must match
`docs/platform-evidence.schema.json` and include every gate ID and all three platform names from
`docs/release-gate-manifest.json`; every artifact entry carries a SHA-256 checksum.

| Gate                                        | Required result | Evidence                                                                                                                              |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| dependency, format, lint, type, unit, build | pass            | CI log and command line                                                                                                               |
| license and MIT/exception notices           | pass            | `docs/license-audit.json`, `docs/license-inventory.md`                                                                                |
| secret/container/static checks              | pass            | `scripts/verify-release-gate.mjs` output and image scan/SBOM                                                                          |
| migration and OpenAPI compatibility         | pass            | `scripts/prepare-migration-compatibility-fixture.sh`, `scripts/migration-compatibility-oracle.sh`, `scripts/check-openapi-compat.mjs` |
| browser E2E and Compose smoke               | pass            | CI artifacts                                                                                                                          |
| backup/restore                              | pass            | `scripts/compose-restore-drill.sh` output and checksum manifest                                                                       |
| scale/concurrency (#26)                     | pass            | #26 evidence JSON, schema, and baseline                                                                                               |

The final gate must include an SPDX or CycloneDX SBOM for each built image, provenance attestation
for the build inputs, the committed license inventory and generated audit, release notes, known
limits, and the rollback boundary. A registry or signing service may store attestations, but the
application has no external SaaS dependency and no runtime call to one.

Run `pnpm verify:release-gate contract` in ordinary CI to validate the contract and pinned image
references without pretending that release evidence exists. A release manager runs
`pnpm verify:release-gate final path/to/release-evidence.json` only after all gates have run. Final
mode compares the evidence commit and lockfile hash with the current tree, checks every artifact
checksum, requires all gate statuses to be `pass`, and rejects missing, `blocked`, `fail`, or
deferred evidence. Platform records may be `unavailable` only with a concrete reason; a required
release gate may not use `unavailable` as a substitute for execution.

`pnpm run:release-gates` executes the bounded commands, Compose smoke, backup/restore drill, and
the #26 scale oracle, saving each command’s output and checksum under `RELEASE_ARTIFACT_DIR`.
The final verifier requires the scale schema, baseline, and passing evidence. Container
vulnerability scanning, SBOM
generation, and provenance attestation are executed by the same script using pinned release-runner
tools (`gitleaks`, `trivy`, `syft`, and `cosign`); their outputs must be added as checksummed
artifacts and referenced by the corresponding gates before final mode. Missing tools or image refs
fail the run rather than producing a partial release.

The exact release-runner image refs are tracked in `docs/release-tool-refs.json`; update them only
from an observed official registry digest and retain the version tag alongside the digest.

The release workflow must execute, rather than merely list, the dependency/license/secret scan,
container vulnerability scan, migration and OpenAPI checks, browser/UI E2E, Compose smoke,
backup/restore drill, and scale oracle. It must save command output and
checksummed artifacts before invoking final mode. Use the pinned image digests in the Dockerfiles
and Compose files; update them only after observing a digest from the official registry and
recording the source/version in the release evidence.

## Threat-model checklist

- Archive parsing is bounded and validates ZIP structure, page paths, and size before reading.
- Reader and scanner paths remain contained beneath the configured root; source mounts are `:ro`.
- API and worker use separate database roles; public ingress is Caddy only, and `/api/metrics` is
  denied at that ingress.
- Reader capabilities/PATs are bounded, secret-managed, redacted from logs, and never metric labels.
- Cache files are disposable derived state; cache keys, paths, source paths, filenames, and secrets
  are not exported as labels or log fields.
- Provider sidecars are not part of M2. There is no Redis, hosted control plane, upload service,
  or external telemetry dependency.

Each claim is executable: archive/path safety is covered by the page-validation and reader tests;
source immutability by the read-only Compose mount and restore drill checksum; role/ACL/proxy/PAT
boundaries by runtime ACL, public API, and metrics-denial tests; cache redaction and bounded
labels by the worker metrics tests; and no-SaaS/no-provider scope by the release-gate verifier’s
Compose scan. The release record must link each result and artifact, not rely on this checklist
alone.

## Rollback and limitations

Supported upgrade is one release at a time from the recorded prior schema after a verified backup.
Rollback after a destructive migration is restore-then-roll-forward, not binary downgrade; see
`docs/operations-runbook.md`. Catalog projections are rebuildable from the externally backed-up
source inventory. Auth/ACL/user state, overrides, audit, tombstone, and error records are durable
and must be present in the PostgreSQL archive.

The release record must state hardware-dependent timing results separately from correctness and
query-plan gates. NFS/SMB locking, Docker Desktop filesystem performance, and sparse-file support
are platform limitations; if not tested, record `unavailable` with the reason and do not claim a
passing result.
