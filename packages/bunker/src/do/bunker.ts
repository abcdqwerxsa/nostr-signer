/**
 * BunkerDO —— 每个 DO 实例即一个独立的远程签名器（bunker）。
 *
 * 实例名 = bunker pubkey hex，由 Worker 在导入密钥时确定。
 *
 * 职责：
 * - 维护到各 relay 的出站 WebSocket，订阅 kind 24133 的 NIP-46 请求；
 * - 会话管理（connect 建立会话并记录 perms）；
 * - 每次调用先过 PolicyEngine；require_approval 的请求进入审批队列，
 *   由移动 App 通过 Worker → DO 的 /decide 决议后异步应答；
 * - nsec 以 AES-GCM 密文存于 DO SQLite，密钥从 Worker secret BUNKER_KEK 派生。
 *
 * 容错：出站 WebSocket 无法 hibernate，DO 被驱逐后连接断开属正常；
 * alarm 周期性重连并按 since 游标补拉驱逐期间错过的请求。
 */
import { DurableObject } from 'cloudflare:workers'
import type { Event } from 'nostr-tools/pure'
import { getPublicKey } from 'nostr-tools/pure'
import {
  b64Encode,
  openSecret,
  sealSecret,
  resolveKek,
  hexIsValid,
  encodeNpub,
} from '../core/keys'
import {
  decryptTransport,
  encryptTransport,
  errorResponse,
  getMethod,
  listMethodNames,
  methodRequiresSession,
  okResponse,
  parseRequest,
  type Nip46Response,
  type TransportScheme,
} from '../core/nip46'
import {
  DEFAULT_POLICY_SETTINGS,
  PolicyEngine,
  parseSessionPerms,
  type PolicySettings,
} from '../core/policy'

interface Env {
  BUNKER_KEK?: string
  DEFAULT_RELAYS?: string
}

const REQ_KIND = 24133
const APPROVAL_TTL_MS = 120_000
const ALARM_INTERVAL_MS = 30_000

interface PendingRequest {
  rpcId: string
  client: string
  scheme: TransportScheme
  method: string
  params: string[]
  /** 展示给审批 App 的摘要（不含敏感明文的裁剪版另算） */
  createdAt: number
  expiresAt: number
}

export class BunkerDO extends DurableObject<Env> {
  private secret: Uint8Array | null = null
  private pubkey = ''
  private relays = new Map<string, WebSocket>()
  private debugLogs: string[] = []

  private logDebug(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`
    this.debugLogs.push(line)
    if (this.debugLogs.length > 100) this.debugLogs.shift()
    console.log(line)
  }

  /** 调试/测试用：最近发布出去的 NIP-46 应答（内存，最多 20 条） */
  private recentReplies: Nip46Response[] = []

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  // ======================= HTTP 表面（Worker 内部调用） =======================

  async fetch(req: Request): Promise<Response> {
    await this.ensureInitialized()
    const url = new URL(req.url)
    const path = url.pathname
    const json = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>

    try {
      // ---- 生命周期 ----
      if (path === '/init' && req.method === 'POST') return await this.handleInit(await json())
      if (path === '/connect-secret' && req.method === 'POST') {
        const body = await json()
        await this.setMeta('connect_secret', String(body.secret ?? ''))
        return Response.json({ ok: true })
      }

      // ---- 以下均要求已初始化 ----
      if (!this.pubkey) return Response.json({ error: 'bunker not initialized' }, { status: 409 })

      if (path === '/status' && req.method === 'GET') return await this.handleStatus()
      if (path === '/pending' && req.method === 'GET') return await this.handlePending(url)
      if (path === '/decide' && req.method === 'POST') {
        const body = await json()
        // admin 转发标记（Worker admin 路由专用）
        if (url.searchParams.get('admin') === '1') body.admin = true
        return await this.handleDecide(body)
      }
      if (path === '/revoke' && req.method === 'POST') {
        const body = await json()
        this.ctx.storage.sql.exec(
          `DELETE FROM sessions WHERE client = ?`,
          String(body.client ?? ''),
        )
        await this.audit(String(body.client ?? ''), 'revoke', 'revoked', `会话已吊销`)
        return Response.json({ ok: true })
      }
      if (path === '/settings' && req.method === 'POST') {
        const body = await json()
        const merged = { ...this.settings(), ...(body.settings as Partial<PolicySettings> | undefined) }
        await this.setMeta('policy_settings', JSON.stringify(merged))
        return Response.json({ ok: true, settings: merged })
      }
      if (path === '/audit' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
        const rows = [...this.ctx.storage.sql.exec(
          `SELECT ts, client, method, decision, detail FROM audit_log ORDER BY id DESC LIMIT ?`,
          limit,
        )]
        return Response.json({ entries: rows })
      }
      if (path === '/rotate-device-token' && req.method === 'POST') {
        const token = this.newToken()
        await this.setMeta('device_token_hash', await this.tokenHash(token))
        return Response.json({ deviceToken: token })
      }
      // ---- 内部端点：测试与调试（DO 不对外暴露，仅同 Worker 内可达） ----
      if (path === '/internal/debug' && req.method === 'GET') {
        const wsStatus: Record<string, string> = {}
        for (const [u, ws] of this.relays.entries()) {
          wsStatus[u] = ws.readyState === 1 ? 'OPEN' : ws.readyState === 0 ? 'CONNECTING' : ws.readyState === 2 ? 'CLOSING' : 'CLOSED'
        }
        return Response.json({
          pubkey: this.pubkey,
          secretInitialized: !!this.secret,
          relays: wsStatus,
          logs: this.debugLogs,
        })
      }
      if (path === '/internal/relay-event' && req.method === 'POST') {
        const body = await json()
        await this.onClientEvent(body.event as unknown as Event)
        return Response.json({ ok: true })
      }
      if (path === '/internal/replies' && req.method === 'GET') {
        return Response.json({ replies: this.recentReplies.slice(-20) })
      }
      return new Response('not found', { status: 404 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return Response.json({ error: message }, { status: 400 })
    }
  }

  // ======================= 初始化与密钥 =======================

  private async ensureInitialized(): Promise<void> {
    this.ensureSchema()
    if (this.secret) return
    const sealed = this.getMeta('sealed_key')
    if (!sealed) return
    this.pubkey = await this.storageIdToPubkey()
    const parsed = JSON.parse(sealed) as { ciphertext: string; iv: string; createdAt: number }
    this.secret = hexToBytesLocal(await openSecret(resolveKek(this.env), this.pubkey, parsed))
    await this.connectAllRelays()
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }

  private ensureSchema(): void {
    if (this.schemaReady) return
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      client TEXT PRIMARY KEY, perms TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_requests (
      rpc_id TEXT PRIMARY KEY, client TEXT NOT NULL, scheme TEXT NOT NULL,
      method TEXT NOT NULL, params TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending')`)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      client TEXT NOT NULL, method TEXT NOT NULL, decision TEXT NOT NULL, detail TEXT NOT NULL)`)
    this.schemaReady = true
  }

  private schemaReady = false

  /** DO 实例名即 pubkey hex；直接读取避免循环依赖。 */
  private async storageIdToPubkey(): Promise<string> {
    let pk = this.getMeta('pubkey')
    if (!pk) {
      pk = this.ctx.id.name ?? ''
      await this.setMeta('pubkey', pk)
    }
    return pk
  }

  private async handleInit(body: Record<string, unknown>): Promise<Response> {
    if (this.getMeta('sealed_key')) {
      return Response.json({ error: 'bunker already initialized' }, { status: 409 })
    }
    const nsecHex = String(body.secretHex ?? '')
    if (!hexIsValid(nsecHex)) return Response.json({ error: 'invalid secret hex' }, { status: 400 })
    const pubkey = getPublicKey(hexToBytesLocal(nsecHex))
    if (this.ctx.id.name && this.ctx.id.name !== pubkey) {
      return Response.json(
        { error: 'DO instance name must equal bunker pubkey' },
        { status: 400 },
      )
    }
    this.pubkey = pubkey
    const sealed = await sealSecret(resolveKek(this.env), pubkey, nsecHex)
    await this.setMeta('pubkey', pubkey)
    await this.setMeta('sealed_key', JSON.stringify(sealed))

    const relays = Array.isArray(body.relays) && body.relays.length
      ? (body.relays as string[])
      : (this.env.DEFAULT_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    await this.setMeta('relays', JSON.stringify(relays))
    if (body.connectSecret) await this.setMeta('connect_secret', String(body.connectSecret))

    const token = this.newToken()
    await this.setMeta('device_token_hash', await this.tokenHash(token))

    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
    this.secret = new Uint8Array(hexToBytesLocal(nsecHex))
    await this.connectAllRelays()

    return Response.json({ pubkey, deviceToken: token, relays })
  }

  // ======================= relay 连接管理 =======================

  private relayList(): string[] {
    const raw = this.getMeta('relays')
    if (!raw) return []
    return JSON.parse(raw) as string[]
  }

  private async connectAllRelays(): Promise<void> {
    for (const url of this.relayList()) {
      if (!this.relays.has(url)) this.connectRelay(url)
    }
  }

  private connectRelay(url: string): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      console.warn(`[bunker ${this.pubkey}] WebSocket init error for ${url}:`, err)
      this.scheduleFastReconnect()
      return
    }
    this.relays.set(url, ws)

    const sendSubscription = () => {
      const subId = `bkr-${this.pubkey.slice(0, 8)}`
      const reqMsg = [
        'REQ',
        subId,
        { kinds: [REQ_KIND], '#p': [this.pubkey], since: this.cursor() },
      ]
      this.logDebug(`Subscribing to ${url} with subId ${subId}`)
      this.sendToRelay(ws, reqMsg)
    }

    if (ws.readyState === WebSocket.OPEN) {
      sendSubscription()
    } else {
      ws.addEventListener('open', sendSubscription)
    }

    ws.addEventListener('message', (ev: MessageEvent) => this.onRelayMessage(url, ev.data as string))
    const onDown = () => {
      this.logDebug(`Relay connection closed: ${url}`)
      this.relays.delete(url)
      this.scheduleFastReconnect()
    }
    ws.addEventListener('close', onDown)
    ws.addEventListener('error', onDown)
  }

  private scheduleFastReconnect(): void {
    // 利用 alarm 做退避重连：排 3s 短 alarm
    this.ctx.storage.setAlarm(Math.min(Date.now() + 3_000, this.nextAlarmOr(Date.now() + 3_000)))
  }

  private nextAlarmOr(fallback: number): number {
    return fallback
  }

  private sendToRelay(ws: WebSocket, msg: unknown[]): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    } catch (e) {
      this.logDebug(`sendToRelay error: ${e}`)
    }
  }

  private cursor(): number {
    const raw = this.getMeta('req_cursor')
    // 允许回溯过去 30 天的事件，防止错失 connect 或由于网络时钟偏差遗漏
    return raw ? Math.max(0, Number(raw) - 300) : Math.floor(Date.now() / 1000) - 86400 * 30
  }

  private onRelayMessage(url: string, data: string): void {
    this.logDebug(`Relay [${url}] msg: ${data.slice(0, 160)}`)
    let msg: unknown[]
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    const [type, , payload] = msg
    if (type === 'EVENT' && payload && typeof payload === 'object') {
      void this.onClientEvent(payload as unknown as Event).catch((err) =>
        this.logDebug(`handle event failed: ${err}`),
      )
    }
  }

  private async publishToRelays(event: Event): Promise<void> {
    for (const ws of this.relays.values()) this.sendToRelay(ws, ['EVENT', event])
  }

  // ======================= NIP-46 请求处理 =======================

  private async onClientEvent(event: Event): Promise<void> {
    if (event.kind !== REQ_KIND || !event.pubkey) return
    // 只处理发给本 bunker 的事件
    if (!event.tags.some(([t, v]) => t === 'p' && v === this.pubkey)) return
    if (event.created_at > Math.floor(Date.now() / 1000) + 300) return // 未来事件直接丢弃

    // 更新补拉游标（落后 60s 余量，容忍 relay 时间偏移）
    const cur = this.cursor()
    if (event.created_at > cur) await this.setMeta('req_cursor', String(event.created_at - 60))

    const client = event.pubkey
    let plain: string
    let scheme: TransportScheme
    try {
      ;({ plain, scheme } = decryptTransport(event.content, this.secret!, client))
    } catch {
      console.warn(`[bunker ${this.pubkey}] decrypt failed from ${client}`)
      return
    }
    let req: ReturnType<typeof parseRequest>
    try {
      req = parseRequest(plain)
    } catch {
      return
    }
    await this.dispatch(client, scheme, req)
  }

  private async dispatch(
    client: string,
    scheme: TransportScheme,
    req: ReturnType<typeof parseRequest>,
  ): Promise<void> {
    const reply = (res: Nip46Response) => void this.reply(client, scheme, res)

    if (req.method === 'connect') return await this.handleConnect(client, scheme, req.id, req.params, reply)

    const session = this.getSession(client)
    if (!session && methodRequiresSession(req.method)) {
      return reply(errorResponse(req.id, `unauthorized: no session for ${encodeNpub(client)}`))
    }

    const handler = getMethod(req.method)
    if (!handler) return reply(errorResponse(req.id, `unsupported method: ${req.method}`))

    // 策略评估
    let eventKind: number | undefined
    if (req.method === 'sign_event') {
      try {
        eventKind = JSON.parse(req.params[0] ?? '{}').kind
      } catch {
        return reply(errorResponse(req.id, 'sign_event: invalid event template'))
      }
    }
    const engine = new PolicyEngine(this.settings(), parseSessionPerms(session?.perms))
    const decision = engine.evaluate({ clientPubkey: client, method: req.method, eventKind })

    if (decision.effect === 'deny') {
      await this.audit(client, req.method, 'deny', decision.reason)
      return reply(errorResponse(req.id, `denied by policy: ${decision.reason}`))
    }

    if (decision.effect === 'allow') {
      try {
        const result = await handler.handle({
          secret: this.secret!,
          bunkerPubkey: this.pubkey,
          clientPubkey: client,
          method: req.method,
          params: req.params,
          reply: () => {},
        })
        await this.audit(client, req.method, 'allow', decision.reason)
        return reply(okResponse(req.id, result))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.audit(client, req.method, 'error', message)
        return reply(errorResponse(req.id, `${req.method} failed: ${message}`))
      }
    }

    // require_approval → 入队，等待 App 决议
    await this.enqueueApproval({
      rpcId: req.id,
      client,
      scheme,
      method: req.method,
      params: req.params,
      createdAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    })
    await this.audit(client, req.method, 'pending', decision.reason)
  }

  private async handleConnect(
    client: string,
    scheme: TransportScheme,
    reqId: string,
    params: string[],
    reply: (res: Nip46Response) => void,
  ): Promise<void> {
    const expectedSecret = this.getMeta('connect_secret')
    let secretParam: string | undefined
    let perms = ''

    // 兼容 NIP-46 各种客户端对 params 的组织方式：
    // [target_pubkey/client_pubkey, secret, perms] 或 [secret, perms]
    if (params.length >= 2 && (params[0] === this.pubkey || params[0] === client || params[0].length === 64)) {
      secretParam = params[1]
      perms = params[2] ?? ''
    } else if (params.length >= 1) {
      secretParam = params[0]
      perms = params[1] ?? ''
    }

    if (expectedSecret && secretParam !== expectedSecret) {
      await this.audit(client, 'connect', 'deny', 'connect secret 不匹配')
      return reply(errorResponse(reqId, 'invalid connect secret'))
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (client, perms, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client) DO UPDATE SET perms = excluded.perms, last_seen_at = excluded.last_seen_at`,
      client, perms, Date.now(), Date.now(),
    )
    await this.audit(client, 'connect', 'allow', perms ? `perms: ${perms}` : '连接成功')
    reply(okResponse(reqId, 'ack'))
  }

  private async reply(client: string, scheme: TransportScheme, res: Nip46Response): Promise<void> {
    const content = encryptTransport(JSON.stringify(res), this.secret!, client, scheme)
    const { finalizeEvent } = await import('nostr-tools/pure')
    const event = finalizeEvent(
      { kind: REQ_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', client]], content },
      this.secret!,
    )
    this.recentReplies.push(res)
    if (this.recentReplies.length > 20) this.recentReplies.shift()
    await this.publishToRelays(event)
  }

  // ======================= 审批队列 =======================

  private async enqueueApproval(r: PendingRequest): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pending_requests
         (rpc_id, client, scheme, method, params, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      r.rpcId, r.client, r.scheme, r.method, JSON.stringify(r.params), r.createdAt, r.expiresAt,
    )
  }

  private async handleDecide(body: Record<string, unknown>): Promise<Response> {
    const token = String(body.token ?? '')
    if (body.admin !== true && !(await this.verifyDeviceToken(token))) {
      return Response.json({ error: 'invalid device token' }, { status: 401 })
    }
    const rpcId = String(body.rpcId ?? '')
    const allow = Boolean(body.allow)
    const row = [...this.ctx.storage.sql.exec(
      `SELECT rpc_id, client, scheme, method, params, created_at, expires_at, status
       FROM pending_requests WHERE rpc_id = ?`, rpcId,
    )][0]
    if (!row) return Response.json({ error: 'no such request' }, { status: 404 })
    if (row.status !== 'pending') return Response.json({ error: `already ${row.status}` }, { status: 409 })
    if (Date.now() > Number(row.expires_at)) {
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'expired' WHERE rpc_id = ?`, rpcId)
      return Response.json({ error: 'request expired' }, { status: 410 })
    }

    const client = String(row.client)
    const scheme = String(row.scheme) as TransportScheme
    const method = String(row.method)
    const params = JSON.parse(String(row.params)) as string[]

    if (!allow) {
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'denied' WHERE rpc_id = ?`, rpcId)
      await this.audit(client, method, 'denied', '用户在 App 中拒绝')
      await this.reply(client, scheme, errorResponse(rpcId, 'rejected by user'))
      return Response.json({ ok: true, status: 'denied' })
    }

    const handler = getMethod(method)
    if (!handler) {
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'error' WHERE rpc_id = ?`, rpcId)
      await this.reply(client, scheme, errorResponse(rpcId, `unsupported method: ${method}`))
      return Response.json({ ok: true, status: 'error' })
    }
    try {
      const result = await handler.handle({
        secret: this.secret!,
        bunkerPubkey: this.pubkey,
        clientPubkey: client,
        method,
        params,
        reply: () => {},
      })
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'approved' WHERE rpc_id = ?`, rpcId)
      await this.audit(client, method, 'approved', '用户在 App 中批准')
      await this.reply(client, scheme, okResponse(rpcId, result))
      return Response.json({ ok: true, status: 'approved' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'error' WHERE rpc_id = ?`, rpcId)
      await this.reply(client, scheme, errorResponse(rpcId, `${method} failed: ${message}`))
      return Response.json({ ok: true, status: 'error', error: message })
    }
  }

  private async handlePending(url: URL): Promise<Response> {
    // admin=1 仅供 Worker 的 admin 路由内部转发（那里已做 ADMIN_TOKEN 鉴权），
    // 外部无法直接访问 DO。
    if (url.searchParams.get('admin') !== '1' &&
        !(await this.verifyDeviceToken(url.searchParams.get('token') ?? ''))) {
      return Response.json({ error: 'invalid device token' }, { status: 401 })
    }
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT rpc_id, client, method, params, created_at, expires_at, status
       FROM pending_requests WHERE status = 'pending' ORDER BY created_at ASC`,
    )]
    return Response.json({
      requests: rows.map((r) => ({
        rpcId: String(r.rpc_id),
        client: String(r.client),
        clientNpub: encodeNpub(String(r.client)),
        method: String(r.method),
        summary: summarize(String(r.method), JSON.parse(String(r.params)) as string[]),
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      })),
      methods: listMethodNames(),
    })
  }

  // ======================= 状态与运维 =======================

  private async handleStatus(): Promise<Response> {
    const sessions = [...this.ctx.storage.sql.exec(
      `SELECT client, perms, created_at, last_seen_at FROM sessions ORDER BY last_seen_at DESC`,
    )]
    const pendingCount = [...this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS n FROM pending_requests WHERE status = 'pending'`,
    )][0]
    return Response.json({
      pubkey: this.pubkey,
      pubkeyNpub: encodeNpub(this.pubkey),
      relays: this.relayList().map((url) => ({
        url,
        state: this.relays.get(url)?.readyState === WebSocket.OPEN ? 'open' : 'down',
      })),
      sessions: sessions.map((s) => ({
        client: String(s.client),
        clientNpub: encodeNpub(String(s.client)),
        perms: String(s.perms ?? ''),
        createdAt: Number(s.created_at),
        lastSeenAt: Number(s.last_seen_at),
      })),
      pendingCount: Number(pendingCount?.n ?? 0),
      settings: this.settings(),
      hasDeviceToken: Boolean(this.getMeta('device_token_hash')),
    })
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized()
    if (!this.secret) return
    await this.connectAllRelays()
    // 过期请求回一个 error，避免客户端干等
    const now = Date.now()
    for (const row of this.ctx.storage.sql.exec(
      `SELECT rpc_id, client, scheme FROM pending_requests WHERE status = 'pending' AND expires_at < ?`,
      now,
    )) {
      this.ctx.storage.sql.exec(`UPDATE pending_requests SET status = 'expired' WHERE rpc_id = ?`, String(row.rpc_id))
      await this.audit(String(row.client), '', 'expired', '审批超时')
      await this.reply(
        String(row.client),
        String(row.scheme) as TransportScheme,
        errorResponse(String(row.rpc_id), 'approval timed out'),
      )
    }
    // 审计日志保留最近 500 条
    this.ctx.storage.sql.exec(
      `DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 500)`,
    )
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }

  // ======================= 存储小工具 =======================

  private getMeta(key: string): string | null {
    const row = [...this.ctx.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key)][0]
    return row ? String(row.value) : null
  }

  private async setMeta(key: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value,
    )
  }

  private getSession(client: string): { perms: string } | null {
    const row = [...this.ctx.storage.sql.exec(
      `SELECT perms FROM sessions WHERE client = ?`, client,
    )][0]
    return row ? { perms: String(row.perms ?? '') } : null
  }

  private settings(): PolicySettings {
    const raw = this.getMeta('policy_settings')
    if (!raw) return DEFAULT_POLICY_SETTINGS
    return { ...DEFAULT_POLICY_SETTINGS, ...(JSON.parse(raw) as Partial<PolicySettings>) }
  }

  private async audit(client: string, method: string, decision: string, detail: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit_log (ts, client, method, decision, detail) VALUES (?, ?, ?, ?, ?)`,
      Date.now(), client, method, decision, detail,
    )
  }

  private newToken(): string {
    return b64Encode(crypto.getRandomValues(new Uint8Array(24))).replace(/[/+=]/g, (c) =>
      ({ '/': '-', '+': '_', '=': '' })[c] ?? '',
    )
  }

  private async tokenHash(token: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return b64Encode(new Uint8Array(digest))
  }

  private async verifyDeviceToken(token: string): Promise<boolean> {
    const expected = this.getMeta('device_token_hash')
    if (!expected || !token) return false
    const actual = await this.tokenHash(token)
    if (expected.length !== actual.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i)
    return diff === 0
  }
}

/** 供审批 App 展示的请求摘要：只留必要信息，内容截断。 */
function summarize(method: string, params: string[]): Record<string, unknown> {
  const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s)
  try {
    if (method === 'sign_event') {
      const ev = JSON.parse(params[0] ?? '{}')
      return {
        kind: ev.kind,
        content: clip(String(ev.content ?? '')),
        tags: Array.isArray(ev.tags) ? ev.tags.slice(0, 8) : [],
        createdAt: ev.created_at,
      }
    }
    if (method.startsWith('nip04') || method.startsWith('nip44')) {
      return {
        peer: params[0] ? encodeNpub(params[0]) : null,
        text: clip(params[1] ?? ''),
      }
    }
  } catch {
    /* fallthrough */
  }
  return { params: params.map((p) => clip(p, 80)) }
}

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
