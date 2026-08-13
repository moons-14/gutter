FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS api-deploy
RUN pnpm --filter @gutter/api --prod deploy /out
RUN mkdir -p /out/docs
COPY docs/openapi-v1.yaml /out/docs/openapi-v1.yaml
COPY docs/openapi-v1.json /out/docs/openapi-v1.json

FROM build AS worker-deploy
RUN pnpm --filter @gutter/worker --prod deploy /out

FROM build AS migrate-deploy
RUN pnpm --filter @gutter/db --prod deploy /out

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --uid 10001 gutter \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && mkdir -p /cache/derived \
  && chown -R gutter:gutter /cache
USER gutter

FROM runtime-base AS api
COPY --from=api-deploy --chown=gutter:gutter /out /app

FROM runtime-base AS worker
COPY --from=worker-deploy --chown=gutter:gutter /out /app

FROM runtime-base AS migrate
COPY --from=migrate-deploy --chown=gutter:gutter /out /app
