// Declarative route table + middleware pipeline (P0-8). The table is the single
// source of truth for dispatch and for the generated OpenAPI document.

function compilePath(pathTemplate) {
  const names = [];
  const source = String(pathTemplate)
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      // Supports `:id` (any non-slash segment) and `:id(\d+)` (constrained),
      // which mirrors the `(\d+)` vs `([^/]+)` distinction of the legacy
      // if-chain so numeric routes keep rejecting non-numeric ids.
      const parsed = segment.match(/^:([A-Za-z0-9_]+)(?:\(([^)]*)\))?$/);
      if (!parsed) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const name = parsed[1];
      names.push(name);
      return `(${parsed[2] || '[^/]+'})`;
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

export function normalizeRoute(route) {
  if (!route || typeof route.handler !== 'function') {
    throw new Error('route requires a handler');
  }
  const method = String(route.method ?? 'GET').toUpperCase();
  const pathTemplate = String(route.path ?? '');
  if (!pathTemplate.startsWith('/')) {
    throw new Error(`route path must start with "/": ${pathTemplate}`);
  }
  const dynamic = pathTemplate.includes(':');
  const compiled = dynamic ? compilePath(pathTemplate) : null;
  return {
    id: route.id ?? `${method} ${pathTemplate}`,
    method,
    path: dynamic
      ? pathTemplate.replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?/g, '{$1}')
      : pathTemplate,
    routePath: pathTemplate,
    regex: compiled?.regex ?? null,
    paramNames: compiled?.names ?? [],
    middleware: route.middleware ?? [],
    tags: route.tags ?? ['default'],
    summary: route.summary ?? '',
    description: route.description ?? '',
    adminOnly: route.adminOnly === true,
    requestBody: route.requestBody !== false
      && ['POST', 'PUT', 'PATCH'].includes(method),
    handler: route.handler,
  };
}

export class RouteTable {
  constructor() {
    this.routes = [];
  }

  add(route) {
    const normalized = normalizeRoute(route);
    if (this.routes.some((item) => (
      item.method === normalized.method && item.path === normalized.path
    ))) {
      throw new Error(`duplicate route: ${normalized.method} ${normalized.path}`);
    }
    this.routes.push(normalized);
    return this;
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }
      if (!route.regex && route.routePath !== pathname) {
        continue;
      }
      if (route.regex) {
        const match = pathname.match(route.regex);
        if (!match) {
          continue;
        }
        return {
          route,
          params: match.slice(1).map(decodeURIComponent),
        };
      }
      return { route, params: [] };
    }
    return null;
  }

  list() {
    return [...this.routes];
  }
}

export function createRouteTable() {
  return new RouteTable();
}

export function parseMiddleware(token) {
  const text = String(token ?? '');
  const separator = text.indexOf(':');
  if (separator === -1) {
    return { name: text, arg: null };
  }
  return { name: text.slice(0, separator), arg: text.slice(separator + 1) };
}

// Runs the middleware chain declared on a route, then the handler. Middleware
// signatures are (ctx, next) => Promise. The table, not the chain, is the
// source of truth — middleware are referenced by name from the registry.
export async function runRoute(ctx, route, middlewareRegistry) {
  // errorBoundary is framework-owned and always innermost-outermost: it wraps
  // the whole declared chain so handler/ middleware throws become responses.
  const chain = [middlewareRegistry.errorBoundary()];
  for (const token of route.middleware) {
    const { name, arg } = parseMiddleware(token);
    const factory = middlewareRegistry[name];
    if (!factory) {
      throw new Error(`unknown middleware: ${name}`);
    }
    chain.push(factory(arg));
  }
  let index = -1;
  const dispatch = async (position) => {
    if (position <= index) {
      throw new Error('next() called multiple times');
    }
    index = position;
    const layer = chain[position];
    if (!layer) {
      return route.handler(ctx);
    }
    return layer(ctx, () => dispatch(position + 1));
  };
  return dispatch(0);
}
