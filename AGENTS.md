# Gutter repository

M0 is a pnpm/Turbo TypeScript monorepo. Dependency direction is `apps -> packages`; packages do
not import apps. Use exact dependency pins, `pnpm`, and Drizzle migrations only. Keep API/worker
internal to Compose; web is the sole published service. Do not add catalog, auth, reader, Redis,
OTel, uploads, or a PWA plugin in M0.
