# Gutter repository

M1 is a pnpm/Turbo TypeScript monorepo. Dependency direction is `apps -> packages`; packages do
not import apps. Use exact dependency pins, `pnpm`, and Drizzle migrations only. Keep API/worker
internal to Compose; web is the sole published service. M1 only snapshots immutable, worker-only,
read-only library-root configuration before queue startup. Do not add catalog scanning, auth,
reader, Redis, OTel, uploads, or a PWA plugin in M1.
