/**
 * 极简路由器：模式如 /api/admin/bunkers/:pubkey/pending，
 * 命中后以 params 映射调用 handler。保持零依赖，便于测试。
 */
export interface RouteParams {
  [key: string]: string | undefined
}

export type RouteHandler<E = unknown> = (
  req: Request,
  params: RouteParams,
  url: URL,
  env: E,
) => Promise<Response> | Response

export class Router<E = unknown> {
  private routes: Array<{ method: string; segments: string[]; handler: RouteHandler<E> }> = []

  add(method: string, pattern: string, handler: RouteHandler<E>): this {
    this.routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  dispatch(req: Request): { handler: RouteHandler<E>; params: RouteParams; url: URL } | null {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== req.method) continue
      if (route.segments.length !== parts.length) continue
      const params: RouteParams = {}
      let ok = true
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]!)
        else if (seg !== parts[i]) { ok = false; break }
      }
      if (ok) return { handler: route.handler, params, url }
    }
    return null
  }
}

/** Bearer token 提取 */
export function bearer(req: Request): string {
  const auth = req.headers.get('Authorization') ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return new URL(req.url).searchParams.get('token') ?? ''
}
