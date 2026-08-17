/**
 * Worker 入口：管理 API（管理员 token 鉴权）+ 设备 API（审批 App，
 * device token 鉴权）+ 静态控制台（assets）。
 *
 * 鉴权模型（自托管单人场景）：
 * - ADMIN_TOKEN：唯一管理员，可创建/查看/配置所有 bunker；
 * - device token：每个 bunker 一个，仅能查看待审批请求与决议，
 *   hash 存于 DO 内，只在创建/轮换时明文返回一次。
 */
import { BunkerDO } from './do/bunker'
import { Router, bearer } from './api/router'
import { encodeNpub } from './core/keys'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

export { BunkerDO }

export interface Env {
  BUNKER: DurableObjectNamespace
  ASSETS?: Fetcher
  ADMIN_TOKEN?: string
  BUNKER_KEK?: string
  DEFAULT_RELAYS?: string
}

const router = new Router<Env>()

function stubFor(env: Env, pubkey: string): DurableObjectStub {
  return env.BUNKER.get(env.BUNKER.idFromName(pubkey))
}

function doFetch(env: Env, pubkey: string, path: string, init?: RequestInit): Promise<Response> {
  return stubFor(env, pubkey).fetch(`https://do${path}`, init)
}

function json(data: unknown, status = 200): Response {
  return Response.json(data as Record<string, unknown>, { status })
}

function cors(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  return new Response(res.body, { status: res.status, headers })
}

function isAdmin(req: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN
  if (!expected) {
    // 开发环境未配置 secret 时使用固定值，与 KEK 的降级策略一致
    console.warn('[bunker] ADMIN_TOKEN not set — accepting dev token')
    return bearer(req) === 'dev-admin-token'
  }
  const actual = bearer(req)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// ---- 管理 API ---------------------------------------------------------

router.add('POST', '/api/admin/bunkers', async (req, _p, _u, env) => {
  const body = (await req.json().catch(() => ({}))) as {
    generate?: boolean
    secretHex?: string
    relays?: string[]
    connectSecret?: string
  }
  let secretHex = body.secretHex
  if (!secretHex && body.generate !== false) {
    secretHex = bytesToHex(generateSecretKey())
  }
  if (!secretHex || !/^[0-9a-f]{64}$/.test(secretHex)) {
    return json({ error: 'secretHex 必须是 64 位 hex，或传 generate: true' }, 400)
  }
  const pubkey = getPublicKey(hexToBytes(secretHex))
  const res = await doFetch(env, pubkey, '/init', {
    method: 'POST',
    body: JSON.stringify({ secretHex, relays: body.relays, connectSecret: body.connectSecret }),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!res.ok) return json(data, res.status as 400 | 409)
  const relays = (data.relays as string[]) ?? []
  const queryParts = relays.map((r) => `relay=${r}`)
  if (body.connectSecret) {
    queryParts.push(`secret=${body.connectSecret}`)
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : ''
  const uri = `bunker://${pubkey}${queryString}`
  const uriNpub = `bunker://${encodeNpub(pubkey)}${queryString}`

  return json({
    pubkey,
    npub: encodeNpub(pubkey),
    bunkerUri: uri,
    bunkerUriNpub: uriNpub,
    deviceToken: data.deviceToken,
    relays,
  })
})

router.add('GET', '/api/admin/bunkers/:pubkey', async (req, p, _u, env) => {
  const res = await doFetch(env, p.pubkey!, '/status')
  const data = await res.json()
  return json(data, res.status)
})

router.add('GET', '/api/admin/bunkers/:pubkey/debug', async (req, p, _u, env) => {
  const res = await doFetch(env, p.pubkey!, '/internal/debug')
  const data = await res.json()
  return json(data, res.status)
})

router.add('POST', '/api/admin/bunkers/:pubkey/settings', async (req, p, _u, env) => {
  const body = await req.json()
  const res = await doFetch(env, p.pubkey!, '/settings', { method: 'POST', body: JSON.stringify(body) })
  return json(await res.json(), res.status)
})

router.add('POST', '/api/admin/bunkers/:pubkey/revoke', async (req, p, _u, env) => {
  const body = await req.json()
  const res = await doFetch(env, p.pubkey!, '/revoke', { method: 'POST', body: JSON.stringify(body) })
  return json(await res.json(), res.status)
})

router.add('POST', '/api/admin/bunkers/:pubkey/rotate-device-token', async (req, p, _u, env) => {
  const res = await doFetch(env, p.pubkey!, '/rotate-device-token', { method: 'POST' })
  return json(await res.json(), res.status)
})

router.add('GET', '/api/admin/bunkers/:pubkey/audit', async (req, p, u, env) => {
  const res = await doFetch(env, p.pubkey!, `/audit?limit=${u.searchParams.get('limit') ?? 50}`)
  return json(await res.json(), res.status)
})

// 控制台直接操作审批队列（已过 ADMIN_TOKEN 鉴权，DO 侧以 admin 标记放行）
router.add('GET', '/api/admin/bunkers/:pubkey/pending', async (req, p, _u, env) => {
  const res = await doFetch(env, p.pubkey!, '/pending?admin=1')
  return json(await res.json(), res.status)
})

router.add('POST', '/api/admin/bunkers/:pubkey/decide', async (req, p, _u, env) => {
  const body = await req.json()
  const res = await doFetch(env, p.pubkey!, '/decide?admin=1', { method: 'POST', body: JSON.stringify(body) })
  return json(await res.json(), res.status)
})

// ---- 设备 API（审批 App）----------------------------------------------

router.add('GET', '/api/v1/:pubkey/pending', async (req, p, u, env) => {
  const token = bearer(req)
  const res = await doFetch(env, p.pubkey!, `/pending?token=${encodeURIComponent(token)}`)
  return cors(json(await res.json(), res.status))
})

router.add('POST', '/api/v1/:pubkey/decide', async (req, p, _u, env) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  body.token = bearer(req)
  const res = await doFetch(env, p.pubkey!, '/decide', { method: 'POST', body: JSON.stringify(body) })
  return cors(json(await res.json(), res.status))
})

router.add('GET', '/api/v1/:pubkey/status', async (req, p, _u, env) => {
  const res = await doFetch(env, p.pubkey!, '/status')
  return cors(json(await res.json(), res.status))
})

// ---- 入口 -------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
      })
    }

    const match = router.dispatch(req)
    if (!match) return new Response('not found', { status: 404 })

    const isAdminRoute = new URL(req.url).pathname.startsWith('/api/admin')
    if (isAdminRoute) {
      if (!isAdmin(req, env)) return json({ error: 'invalid admin token' }, 401)
    }

    return Promise.resolve(match.handler(req, match.params, match.url, env)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[bunker] unhandled:', message)
      return json({ error: 'internal error' }, 500)
    })
  },
}
