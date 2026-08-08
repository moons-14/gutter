FROM node:24.19.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS api-deploy
RUN pnpm --filter @gutter/api --prod deploy /out

FROM build AS worker-deploy
RUN pnpm --filter @gutter/worker --prod deploy /out

FROM build AS migrate-deploy
RUN pnpm --filter @gutter/db --prod deploy /out

FROM node:24.19.0-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --uid 10001 gutter
USER gutter

FROM runtime-base AS api
COPY --from=api-deploy --chown=gutter:gutter /out /app

FROM runtime-base AS worker
COPY --from=worker-deploy --chown=gutter:gutter /out /app

FROM runtime-base AS migrate
COPY --from=migrate-deploy --chown=gutter:gutter /out /app
