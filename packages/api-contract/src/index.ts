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

export const adminUsersCursor = z.string().min(1).max(1024);
export const adminUsersQuery = z
  .object({
    q: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: adminUsersCursor.optional(),
  })
  .strict();
export const adminUser = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    role: z.string().nullable(),
    banned: z.boolean(),
  })
  .strict();
export const adminUsersResponse = z
  .object({ items: z.array(adminUser), nextCursor: adminUsersCursor.nullable() })
  .strict();
export const adminUsersErrorResponse = z
  .object({
    error: z.enum(['authentication_required', 'invalid_request', 'invalid_cursor', 'not_found']),
  })
  .strict();
export const adminUsersRoute = createRoute({
  method: 'get',
  path: '/admin/users',
  request: { query: adminUsersQuery },
  responses: {
    200: {
      description: 'admin-only user directory',
      content: { 'application/json': { schema: adminUsersResponse } },
    },
    400: {
      description: 'invalid request',
      content: { 'application/json': { schema: adminUsersErrorResponse } },
    },
    401: {
      description: 'authentication required',
      content: { 'application/json': { schema: adminUsersErrorResponse } },
    },
    404: {
      description: 'not found',
      content: { 'application/json': { schema: adminUsersErrorResponse } },
    },
  },
});
export const adminUserStateDeleteRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{id}/user-state',
  request: {
    params: z.object({ id: z.string().min(1) }),
    headers: z
      .object({
        'x-request-id': z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,128}$/)
          .optional(),
      })
      .passthrough(),
    body: { content: { 'application/json': { schema: z.object({}).strict() } } },
  },
  responses: {
    200: {
      description: 'permanently deleted user state',
      content: {
        'application/json': {
          schema: z.object({ deleted: z.record(z.string(), z.number()) }).strict(),
        },
      },
    },
    400: {
      description: 'invalid request or self deletion',
      content: {
        'application/json': { schema: z.object({ error: z.enum(['invalid_request']) }).strict() },
      },
    },
    401: {
      description: 'authentication required',
      content: {
        'application/json': {
          schema: z.object({ error: z.literal('authentication_required') }).strict(),
        },
      },
    },
    403: {
      description: 'invalid same-origin mutation',
      content: {
        'application/json': { schema: z.object({ error: z.literal('invalid_origin') }).strict() },
      },
    },
    404: {
      description: 'not found or unauthorized',
      content: {
        'application/json': { schema: z.object({ error: z.literal('not_found') }).strict() },
      },
    },
  },
});

const decimalId = z.string().regex(/^[1-9][0-9]*$/);

/** Opaque, server-issued user-state identities and pagination contracts. */
export const userStateProgressKey = z.string().regex(/^source:[A-Za-z0-9_-]+$/);
export const userStateCursor = z.string().min(1).max(4096);
export const userStatePageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: userStateCursor.optional(),
  })
  .strict();
export const userStatePageResponse = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      nextCursor: userStateCursor.nullable(),
    })
    .strict();
export const userStateErrorResponse = z
  .object({
    error: z.enum([
      'authentication_required',
      'invalid_origin',
      'invalid_cursor',
      'not_found',
      'invalid_pagination',
      'invalid_resume_limit',
      'invalid_user_progress_request',
      'invalid_user_target_request',
      'invalid_user_target_state',
      'invalid_bookmark_request',
      'invalid_collection_name',
      'invalid_collection_request',
      'invalid_collection_id',
      'invalid_collection_member_request',
      'progress_conflict',
    ]),
  })
  .strict();
export const userStateProgressQuery = z
  .object({
    rootId: z.string().min(1),
    progressKey: userStateProgressKey,
  })
  .strict();
export const userStateProgressBody = z
  .object({
    rootId: z.string().min(1),
    progressKey: userStateProgressKey,
    expectedRevision: z.number().int().nonnegative(),
    pageOrdinal: z.number().int().min(0).max(1000000),
    completed: z.boolean(),
  })
  .strict();
export const userStateProgressResponse = z
  .object({ progress: z.record(z.string(), z.unknown()).nullable() })
  .strict();
export const userStateBookmarkBody = z
  .object({
    rootId: z.string().min(1),
    progressKey: userStateProgressKey,
    pageOrdinal: z.number().int().min(0).max(1000000),
    label: z.string().max(256).nullable().optional(),
  })
  .strict();
const userStateTargetFields = {
  rootId: z.string().min(1),
  favorite: z.boolean().optional(),
  hidden: z.boolean().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
} as const;
export const userStateTargetBody = z.discriminatedUnion('targetKind', [
  z
    .object({
      ...userStateTargetFields,
      targetKind: z.literal('source'),
      targetKey: userStateProgressKey,
    })
    .strict(),
  z
    .object({
      ...userStateTargetFields,
      targetKind: z.literal('check'),
      targetKey: userStateProgressKey,
    })
    .strict(),
  z
    .object({
      ...userStateTargetFields,
      targetKind: z.literal('series'),
      targetKey: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      ...userStateTargetFields,
      targetKind: z.literal('publication'),
      targetKey: z.string().regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/),
    })
    .strict(),
]);
export const userStateCollectionMemberBody = z.discriminatedUnion('targetKind', [
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('source'),
      targetKey: userStateProgressKey,
      member: z.boolean(),
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('check'),
      targetKey: userStateProgressKey,
      member: z.boolean(),
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('series'),
      targetKey: z.string().regex(/^[0-9a-f]{64}$/),
      member: z.boolean(),
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('publication'),
      targetKey: z.string().regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/),
      member: z.boolean(),
    })
    .strict(),
]);
export const userStateCollectionMemberDeleteBody = z.discriminatedUnion('targetKind', [
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('source'),
      targetKey: userStateProgressKey,
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('check'),
      targetKey: userStateProgressKey,
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('series'),
      targetKey: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      rootId: z.string().min(1),
      targetKind: z.literal('publication'),
      targetKey: z.string().regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/),
    })
    .strict(),
]);
const stateItem = z.record(z.string(), z.unknown());
export const userStatePage = userStatePageResponse(stateItem);
export const userStateProgressConflictResponse = z
  .object({
    error: z.literal('progress_conflict'),
    progress: z.record(z.string(), z.unknown()).nullable(),
    requestId: z.string().min(1).max(128),
  })
  .strict();
const stateErrorResponse = {
  400: {
    description: 'invalid user-state request',
    content: { 'application/json': { schema: userStateErrorResponse } },
  },
  401: {
    description: 'authentication required',
    content: { 'application/json': { schema: userStateErrorResponse } },
  },
  404: {
    description: 'not found',
    content: { 'application/json': { schema: userStateErrorResponse } },
  },
};
export const userStateCollectionsRoute = createRoute({
  method: 'get',
  path: '/user-state/collections',
  request: { query: userStatePageQuery },
  responses: {
    200: {
      description: 'user collections',
      content: { 'application/json': { schema: userStatePage } },
    },
    ...stateErrorResponse,
  },
});
export const userStateCollectionMembersRoute = createRoute({
  method: 'get',
  path: '/user-state/collections/{id}/members',
  request: { params: z.object({ id: decimalId }), query: userStatePageQuery },
  responses: {
    200: {
      description: 'visible collection members',
      content: { 'application/json': { schema: userStatePage } },
    },
    ...stateErrorResponse,
  },
});
export const userStateBookmarksRoute = createRoute({
  method: 'get',
  path: '/user-state/bookmarks',
  request: { query: userStatePageQuery },
  responses: {
    200: {
      description: 'visible bookmarks',
      content: { 'application/json': { schema: userStatePage } },
    },
    ...stateErrorResponse,
  },
});
export const userStateTargetsRoute = createRoute({
  method: 'get',
  path: '/user-state/targets',
  request: { query: userStatePageQuery },
  responses: {
    200: {
      description: 'visible target state',
      content: { 'application/json': { schema: userStatePage } },
    },
    ...stateErrorResponse,
  },
});
export const userStateProgressGetRoute = createRoute({
  method: 'get',
  path: '/user-state/progress',
  request: { query: userStateProgressQuery },
  responses: {
    200: {
      description: 'progress state',
      content: { 'application/json': { schema: userStateProgressResponse } },
    },
    ...stateErrorResponse,
  },
});
export const userStateProgressPutRoute = createRoute({
  method: 'put',
  path: '/user-state/progress',
  request: { body: { content: { 'application/json': { schema: userStateProgressBody } } } },
  responses: {
    200: {
      description: 'updated progress',
      content: { 'application/json': { schema: userStateProgressResponse } },
    },
    409: {
      description: 'compare-and-set conflict',
      content: { 'application/json': { schema: userStateProgressConflictResponse } },
    },
    ...stateErrorResponse,
  },
});
export const userStateTargetPutRoute = createRoute({
  method: 'put',
  path: '/user-state/target',
  request: { body: { content: { 'application/json': { schema: userStateTargetBody } } } },
  responses: {
    200: {
      description: 'updated target state',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});
export const userStateBookmarkPostRoute = createRoute({
  method: 'post',
  path: '/user-state/bookmarks',
  request: { body: { content: { 'application/json': { schema: userStateBookmarkBody } } } },
  responses: {
    200: {
      description: 'updated bookmark',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});
export const userStateBookmarkDeleteRoute = createRoute({
  method: 'delete',
  path: '/user-state/bookmarks',
  request: {
    query: userStateProgressQuery.extend({
      pageOrdinal: z.coerce.number().int().min(0).max(1000000),
    }),
  },
  responses: {
    200: {
      description: 'deleted bookmark',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});
export const userStateCollectionPostRoute = createRoute({
  method: 'post',
  path: '/user-state/collections',
  request: {
    body: {
      content: {
        'application/json': { schema: z.object({ name: z.string().min(1).max(128) }).strict() },
      },
    },
  },
  responses: {
    201: {
      description: 'created collection',
      content: {
        'application/json': { schema: z.object({ collection: stateItem.nullable() }).strict() },
      },
    },
    409: {
      description: 'collection name already exists',
      content: {
        'application/json': {
          schema: z
            .object({
              error: z.literal('collection_conflict'),
              requestId: z.string().min(1).max(128),
            })
            .strict(),
        },
      },
    },
    ...stateErrorResponse,
  },
});
export const userStateCollectionDeleteRoute = createRoute({
  method: 'delete',
  path: '/user-state/collections/{id}',
  request: { params: z.object({ id: decimalId }) },
  responses: {
    200: {
      description: 'deleted collection',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});
export const userStateCollectionMemberPutRoute = createRoute({
  method: 'put',
  path: '/user-state/collections/{id}/members',
  request: {
    params: z.object({ id: decimalId }),
    body: { content: { 'application/json': { schema: userStateCollectionMemberBody } } },
  },
  responses: {
    200: {
      description: 'updated collection member',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});
export const userStateCollectionMemberDeleteRoute = createRoute({
  method: 'delete',
  path: '/user-state/collections/{id}/members',
  request: {
    params: z.object({ id: decimalId }),
    body: { content: { 'application/json': { schema: userStateCollectionMemberDeleteBody } } },
  },
  responses: {
    200: {
      description: 'deleted collection member',
      content: { 'application/json': { schema: z.object({ changed: z.boolean() }).strict() } },
    },
    ...stateErrorResponse,
  },
});

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
