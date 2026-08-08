# Gutter repository

M2 is a pnpm/Turbo TypeScript monorepo. Dependency direction is `apps -> packages`; packages do
not import apps. Use exact dependency pins, `pnpm`, and Drizzle migrations only. Keep API/worker
internal to Compose; web is the sole published service. Catalog projections are rebuildable from
the read-only source inventory; durable preferences use stable source/root keys. Do not add auth,
reader, Redis, OTel, uploads, external providers, or a PWA plugin in M2.
