// OpenAPI 3.1 generated from the route table so the document cannot drift from
// the real endpoints (P0-8).

export function buildOpenApi(routes, {
  title = 'YOLO Data API',
  version = '0.1.0',
} = {}) {
  const paths = {};
  for (const route of routes) {
    paths[route.path] ??= {};
    const operation = {
      operationId: route.id,
      summary: route.summary || `${route.method} ${route.path}`,
      tags: route.tags,
      responses: {
        200: {
          description: 'Success',
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
          },
        },
      },
    };
    if (route.description) {
      operation.description = route.description;
    }
    if (route.paramNames.length > 0) {
      operation.parameters = route.paramNames.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
    }
    if (route.requestBody) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': { schema: { type: 'object', additionalProperties: true } },
        },
      };
    }
    if (route.adminOnly) {
      operation.security = [{ userId: [] }];
    }
    paths[route.path][route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title, version },
    paths,
    components: {
      securitySchemes: {
        userId: { type: 'apiKey', in: 'header', name: 'x-user-id' },
      },
    },
  };
}
