import type { MiddlewareHandler } from 'hono'

export function authMiddleware(_permission: string): MiddlewareHandler {
  return async (_c, next) => { await next() }
}
