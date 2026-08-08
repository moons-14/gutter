import { createRoute, z } from '@hono/zod-openapi';

export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: { 200: { description: 'process is alive' } },
});
export const readinessRoute = createRoute({
  method: 'get',
  path: '/ready',
  responses: {
    200: { description: 'database and schema are ready' },
    503: { description: 'not ready' },
  },
});
export const schemaVersionResponse = z.object({ schemaVersion: z.string() });

const catalogQuery = z
  .object({
    q: z.string().max(256).optional(),
    libraryId: z.string().max(63).optional(),
    kind: z.enum(['artbook', 'special', 'chapter', 'issue', 'volume']).optional(),
    creator: z.string().max(256).optional(),
    group: z.string().max(256).optional(),
    publisher: z.string().max(256).optional(),
    sort: z.enum(['name', 'source_updated', 'discovered', 'metadata_updated']).default('name'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const catalogListResponse = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
  libraries: z.array(z.record(z.string(), z.unknown())).optional(),
});
export const catalogLibrariesRoute = createRoute({
  method: 'get',
  path: '/catalog/libraries',
  responses: {
    200: {
      description: 'catalog libraries',
      content: { 'application/json': { schema: catalogListResponse } },
    },
  },
});
export const catalogSeriesRoute = createRoute({
  method: 'get',
  path: '/catalog/series',
  request: { query: catalogQuery },
  responses: {
    200: {
      description: 'series',
      content: { 'application/json': { schema: catalogListResponse } },
    },
    400: { description: 'invalid query' },
  },
});
const decimalId = z.string().regex(/^[1-9][0-9]*$/);
export const catalogSeriesDetailRoute = createRoute({
  method: 'get',
  path: '/catalog/series/{id}',
  request: { params: z.object({ id: decimalId }) },
  responses: { 200: { description: 'series detail' }, 404: { description: 'not found' } },
});
export const catalogPublicationDetailRoute = createRoute({
  method: 'get',
  path: '/catalog/publications/{id}',
  request: { params: z.object({ id: decimalId }) },
  responses: { 200: { description: 'publication detail' }, 404: { description: 'not found' } },
});
export const catalogEntityRoute = (
  path: '/catalog/creators/{id}' | '/catalog/groups/{id}' | '/catalog/publishers/{id}',
) =>
  createRoute({
    method: 'get',
    path,
    request: { params: z.object({ id: decimalId }) },
    responses: { 200: { description: 'catalog entity' }, 404: { description: 'not found' } },
  });
export const catalogEntitiesRoute = (
  path: '/catalog/creators' | '/catalog/groups' | '/catalog/publishers',
) =>
  createRoute({
    method: 'get',
    path,
    request: {
      query: z
        .object({
          q: z.string().max(256).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict(),
    },
    responses: {
      200: {
        description: 'visible catalog entities',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
          },
        },
      },
    },
  });
