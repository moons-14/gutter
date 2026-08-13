# Direct license and provenance inventory

| Component                    | Exact version/tag                          | License                                  | Primary provenance                                                                                                      |
| ---------------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node                         | 24.19.0-bookworm-slim                      | MIT                                      | nodejs.org / Docker Official Image                                                                                      |
| PostgreSQL                   | 18.1                                       | PostgreSQL License                       | PostgreSQL Docker Official Image                                                                                        |
| Caddy                        | v2.11.4 custom build                       | Apache-2.0                               | caddyserver/caddy peeled commit `e2eee6a7fce366321294c9c2a79f3146891dcbdf`; official runtime digest in `Dockerfile.web` |
| Go builder                   | 1.26.5-alpine3.23                          | BSD-3-Clause                             | Docker Official Image; immutable digest in `Dockerfile.web`                                                             |
| Caddy modules                | x/net 0.56.0 / x/text 0.39.0 / grpc 1.82.1 | BSD-3-Clause / BSD-3-Clause / Apache-2.0 | exact `go.mod` requirements applied in the constrained Caddy build                                                      |
| pnpm                         | 11.20.0                                    | MIT                                      | pnpm.io                                                                                                                 |
| yauzl / @types/yauzl         | 3.4.0 / 3.4.0                              | MIT                                      | npmjs.com/package/yauzl / npmjs.com/package/@types/yauzl                                                                |
| saxes                        | 6.0.0                                      | ISC                                      | npmjs.com/package/saxes                                                                                                 |
| chokidar                     | 5.0.0                                      | MIT                                      | npmjs.com/package/chokidar                                                                                              |
| Turbo                        | 2.10.7                                     | MIT                                      | vercel/turborepo                                                                                                        |
| TypeScript                   | 5.9.3                                      | Apache-2.0                               | microsoft/TypeScript                                                                                                    |
| SvelteKit/Svelte/Vite        | 2.59.1 / 5.56.8 / 7.3.6                    | MIT                                      | sveltejs / vitejs                                                                                                       |
| @csstools/color-helpers      | 5.1.0                                      | MIT-0                                    | csstools/postcss-plugins (Svelte UI test dependency)                                                                    |
| Hono/node-server/zod-openapi | 4.13.0 / 2.1.0 / 1.5.1                     | MIT                                      | honojs                                                                                                                  |
| Zod                          | 4.4.3                                      | MIT                                      | colinhacks/zod                                                                                                          |
| Drizzle/pg/pg-boss           | 0.45.2 / 8.22.0 / 12.27.0                  | Apache-2.0 / MIT / MIT                   | drizzle.team / brianc/node-postgres / tomekbuszewski/pg-boss                                                            |
| Pino/prom-client/sharp       | 10.3.1 / 15.1.3 / 0.35.3                   | MIT / Apache-2.0 / Apache-2.0            | pinojs / siimon/prom-client / lovell/sharp                                                                              |

The final runtime removes the unused base-image `curl` dependency chain with deterministic,
offline apk metadata; this does not add scanner exclusions or mutable package operations.

## Local PWA icon provenance

`scripts/pwa-icon.svg` is the sole canonical source for the committed
`apps/web/static/icons/icon-192.png` and `icon-512.png` artifacts. It is original,
repository-authored Gutter artwork, generated deterministically with the pinned `sharp` package.
It contains no third-party marks, logos, illustrations, or other third-party visual assets.

`pnpm audit:licenses` is the lockfile-installed transitive audit. It writes a stable report of
package name, version, and license only; paths and other machine-local package metadata are
discarded. The allowlist accepts MIT, MIT-0, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, CC0-1.0,
`(MIT OR CC0-1.0)`, 0BSD, PostgreSQL, and Unlicense. Missing, unknown, non-listed, GPL, and AGPL
labels fail closed.

The sole non-allowlist exception is `@img/sharp-libvips-linux-x64@1.3.2` under
`LGPL-3.0-or-later`. It is a runtime optional platform dependency of Apache-2.0 `sharp@0.35.3`,
and the worker's page validator dynamically loads its bundled native `libvips` shared object.
Distribution of the worker image must retain the applicable LGPL notices and provide the required
corresponding-source/relinking information; this exception is not a blanket LGPL approval.

## Future, not-installed decision

Better Auth is planned for the future multi-user authentication milestone, not an installed M0
component. Its version and license will be added to this inventory only when it is introduced.
