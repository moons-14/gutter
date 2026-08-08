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
