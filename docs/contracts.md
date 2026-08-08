# M0 acceptance mapping

| ID     | Decision / validation                                                     |
| ------ | ------------------------------------------------------------------------- |
| M0-001 | pnpm/Turbo apps and packages; `pnpm typecheck` / `pnpm build`             |
| M0-002 | MIT and OSS-only inventory in `docs/quality.md`; no GPL/SaaS              |
| M0-003 | Compose health gates and internal services; `docker compose config`       |
| M0-004 | `packages/db/drizzle/0000_initial.sql`; repeat `pnpm migrate`             |
| M0-005 | API `/health`, `/ready`, `/metrics`, `/openapi.json`; worker pg-boss boot |
| M0-006 | static Svelte service worker, manifest, ja/en shell and Caddy proxy       |
| M0-007 | format/check/lint/typecheck/unit/build and test profile smoke scripts     |
| M0-008 | scoped instructions, issue-ready backlog, templates and CI                |
| M0-009 | non-root runtime, no defaults secrets, redact, internal service boundary  |
| M0-010 | README Linux/NAS/restore/proxy limitations                                |

Each ID is a stable requirement and its validation oracle: M0-001 uses `pnpm typecheck/build`;
M0-002 uses `pnpm audit:licenses`; M0-003 uses `docker compose config`; M0-004 uses repeated
`pnpm migrate`; M0-005/M0-006 use the health/PWA smoke; M0-007 uses the named root scripts; and
M0-008–M0-010 use the linked canonical docs and template inspection.

Rejected alternatives: PWA plugin, Redis, OTel, uploads, a native app, catalog/auth/reader work,
and external SaaS are outside M0.
