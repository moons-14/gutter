# v1 delivery plan

M2 is the catalog foundation. The source-read-only invariant remains non-negotiable through v1:
Gutter may scan and derive cache/projection data, but never moves, edits, deletes, renames,
repacks, or uploads the operator's comic files.

| Epic                                                   | Delivery scope                                                                                                     | Depends on                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [#8](https://github.com/moons-14/gutter/issues/8) M3   | Safe source streaming, filesystem-shaped derived cache and GC, reader modes/gestures, installable web/PWA behavior | M2 source inventory, page validation, catalog releases            |
| [#9](https://github.com/moons-14/gutter/issues/9) M4   | Versioned local metadata-provider sidecars and intentionally small public API/PAT surface                          | M2 canonical identities and catalog read contracts                |
| [#10](https://github.com/moons-14/gutter/issues/10) M5 | Better Auth, no-signup operator flow, per-user progress/history/likes/hide, library ACL                            | M3 reader release/page identity; M4 API boundary where applicable |
| [#11](https://github.com/moons-14/gutter/issues/11) M6 | 100k/20 TB operational benchmark, observability, backup/restore drills, security review, versioned v1 release      | M3-M5 stable data/API contracts                                   |

## v1 exit gate

- A Compose-only install can scan a read-only NAS bind, read a catalog, stream and read supported
  CBZ/directory pages on desktop and mobile, and reclaim derived cache through bounded GC.
- Authentication, authorization and all personal state are enforced server-side; no unauthenticated
  Internet deployment claim is made before the M5/M6 security gate.
- The selected public API is versioned, documented, and covered by compatibility tests; internal
  worker and database APIs remain private to Compose.
- A representative scale run, backup plus restore rehearsal, upgrade/migration path, and release
  checklist pass on the exact release candidate.

## Before starting the next epic

Reconcile the status and scope of open cleanup tickets [#2](https://github.com/moons-14/gutter/issues/2)
(branded icon) and [#3](https://github.com/moons-14/gutter/issues/3) (root-boundary follow-up).
They should be closed, rescheduled, or explicitly incorporated before the v1 release gate; this
document does not claim either is complete.

## Explicit post-v1 non-goals

Native mobile applications, Kavita database migration, source-file mutation/uploads, Redis, and
external SaaS dependencies remain out of scope after v1 unless a later, separately approved
product decision changes that boundary.
