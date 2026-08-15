/**
 * 端到端集成测试：模拟一个 NIP-46 客户端（签名 kind 24133 事件）
 * 走完 connect → 只读方法 → 签名审批 → 拒绝 → 会话 perms 直通 的完整链路。
 * relay 交互通过 DO 内部端点注入/捕获，不依赖外部网络。
 */
import { describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import * as nip04 from 'nostr-tools/nip04'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Nip46Response } from '../src/core/nip46'

const ADMIN = 'test-admin-token'

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, init)
}

function doStub(pubkey: string) {
  return env.BUNKER.get(env.BUNKER.idFromName(pubkey))
}

interface Client {
  secret: Uint8Array
  pubkey: string
}

/** 构造并发送一条 NIP-46 请求事件，等同客户端通过 relay 投递 */
async function sendRpc(
  bunkerPubkey: string,
  client: Client,
  req: { id: string; method: string; params: string[] },
  scheme: 'nip04' | 'nip44' = 'nip44',
): Promise<void> {
  const plain = JSON.stringify(req)
  const content =
    scheme === 'nip44'
      ? nip44.encrypt(plain, nip44.getConversationKey(client.secret, bunkerPubkey))
      : nip04.encrypt(client.secret, bunkerPubkey, plain)
  const event = finalizeEvent(
    { kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', bunkerPubkey]], content },
    client.secret,
  )
  const res = await doStub(bunkerPubkey).fetch('https://do/internal/relay-event', {
    method: 'POST',
    body: JSON.stringify({ event }),
  })
  expect(res.ok).toBe(true)
  // DO 内部处理完成后再返回
  await new Promise((r) => setTimeout(r, 20))
}

/** 取 bunker 最近发出的应答并用客户端视角解密 */
async function takeReplies(bunkerPubkey: string, client: Client): Promise<Nip46Response[]> {
  const res = await doStub(bunkerPubkey).fetch('https://do/internal/replies')
  const { replies } = (await res.json()) as { replies: Nip46Response[] }
  return replies
}

/** 等待最近一条应答（简单轮询，上限 2s） */
async function waitForReply(
  bunkerPubkey: string,
  rpcId: string,
): Promise<Nip46Response | undefined> {
  for (let i = 0; i < 40; i++) {
    const res = await doStub(bunkerPubkey).fetch('https://do/internal/replies')
    const { replies } = (await res.json()) as { replies: Nip46Response[] }
    const hit = replies.filter((r) => r.id === rpcId).at(-1)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return undefined
}

describe('NIP-46 全链路', () => {
  it('创建 → connect → 审批签名 → 拒绝 → perms 直通', async () => {
    // 1. 管理员创建 bunker
    const createRes = await workerFetch('/api/admin/bunkers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generate: true, connectSecret: 'pw123', relays: ['wss://relay.invalid'] }),
    })
    expect(createRes.ok).toBe(true)
    const bunker = (await createRes.json()) as {
      pubkey: string
      bunkerUri: string
      deviceToken: string
    }
    expect(bunker.bunkerUri).toMatch(/^bunker:\/\/npub1/)

    const client: Client = { secret: generateSecretKey(), pubkey: '' }
    client.pubkey = getPublicKey(client.secret)
    const bp = bunker.pubkey

    // 2. 错误 connect secret 被拒
    await sendRpc(bp, client, { id: 'c1', method: 'connect', params: [client.pubkey, 'wrong'] })
    const r1 = await waitForReply(bp, 'c1')
    expect(r1?.error).toContain('invalid connect secret')

    // 3. 正确 connect（无 perms）→ ack
    await sendRpc(bp, client, { id: 'c2', method: 'connect', params: [client.pubkey, 'pw123'] })
    const r2 = await waitForReply(bp, 'c2')
    expect(r2?.result).toBe('ack')

    // 4. 只读方法直接放行（走 nip04 传输验证兼容层）
    await sendRpc(bp, client, { id: 'g1', method: 'get_public_key', params: [] }, 'nip04')
    const r3 = await waitForReply(bp, 'g1')
    expect(r3?.result).toBe(bp)

    // 5. 未授权 kind 的签名 → 进入审批队列（此时无应答）
    const template = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'hello from integration test',
    }
    await sendRpc(bp, client, { id: 's1', method: 'sign_event', params: [JSON.stringify(template)] })
    const none = await waitForReply(bp, 's1')
    expect(none).toBeUndefined()

    // 设备 API 能看到 pending
    const pendingRes = await workerFetch(`/api/v1/${bp}/pending`, {
      headers: { Authorization: `Bearer ${bunker.deviceToken}` },
    })
    expect(pendingRes.ok).toBe(true)
    const pending = (await pendingRes.json()) as { requests: Array<{ rpcId: string; method: string }> }
    expect(pending.requests).toHaveLength(1)
    expect(pending.requests[0]!.rpcId).toBe('s1')

    // 批准 → 得到合法签名
    const approveRes = await workerFetch(`/api/v1/${bp}/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bunker.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rpcId: 's1', allow: true }),
    })
    expect(approveRes.ok).toBe(true)
    const signed = await waitForReply(bp, 's1')
    expect(signed?.error).toBeUndefined()
    const event = JSON.parse(signed!.result!) as Event
    expect(verifyEvent(event)).toBe(true)
    expect(event.pubkey).toBe(bp)
    expect(event.content).toBe(template.content)

    // 6. 拒绝路径：nip44_encrypt 默认需审批 → deny → 收到 rejected
    await sendRpc(bp, client, {
      id: 'e1',
      method: 'nip44_encrypt',
      params: ['aa'.repeat(32), 'secret message'],
    })
    const denyRes = await workerFetch(`/api/v1/${bp}/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bunker.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rpcId: 'e1', allow: false }),
    })
    expect(denyRes.ok).toBe(true)
    const denied = await waitForReply(bp, 'e1')
    expect(denied?.error).toContain('rejected by user')

    // 7. 带 perms 的 connect：sign_event:1 直接放行
    await sendRpc(bp, client, {
      id: 'c3',
      method: 'connect',
      params: [client.pubkey, 'pw123', 'sign_event:1'],
    })
    const r4 = await waitForReply(bp, 'c3')
    expect(r4?.result).toBe('ack')
    await sendRpc(bp, client, { id: 's2', method: 'sign_event', params: [JSON.stringify(template)] })
    const auto = await waitForReply(bp, 's2')
    expect(auto?.error).toBeUndefined()
    expect(verifyEvent(JSON.parse(auto!.result!) as Event)).toBe(true)

    // 8. 未建立会话的陌生客户端 → unauthorized
    const stranger: Client = { secret: generateSecretKey(), pubkey: '' }
    stranger.pubkey = getPublicKey(stranger.secret)
    await sendRpc(bp, stranger, { id: 'x1', method: 'get_public_key', params: [] })
    const unauth = await waitForReply(bp, 'x1')
    expect(unauth?.error).toContain('unauthorized')

    // 9. 状态与审计可读
    const statusRes = await workerFetch(`/api/admin/bunkers/${bp}`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
    const status = (await statusRes.json()) as { sessions: unknown[]; pubkey: string }
    expect(status.sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('设备 token 错误时 pending 与 decide 均拒绝', async () => {
    const createRes = await workerFetch('/api/admin/bunkers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generate: true }),
    })
    const bunker = (await createRes.json()) as { pubkey: string }
    const bad = await workerFetch(`/api/v1/${bunker.pubkey}/pending`, {
      headers: { Authorization: 'Bearer nope' },
    })
    expect(bad.status).toBe(401)
  })

  it('管理员 token 错误 → 401', async () => {
    const res = await workerFetch('/api/admin/bunkers', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ generate: true }),
    })
    expect(res.status).toBe(401)
  })

  it('admin 路由可直接查看与决议审批队列', async () => {
    const createRes = await workerFetch('/api/admin/bunkers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generate: true }),
    })
    const bunker = (await createRes.json()) as { pubkey: string }
    const client: Client = { secret: generateSecretKey(), pubkey: '' }
    client.pubkey = getPublicKey(client.secret)

    await sendRpc(bunker.pubkey, client, { id: 'a1', method: 'connect', params: [client.pubkey] })
    await waitForReply(bunker.pubkey, 'a1')
    await sendRpc(bunker.pubkey, client, {
      id: 'a2',
      method: 'sign_event',
      params: [JSON.stringify({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'dm' })],
    })

    const pendingRes = await workerFetch(`/api/admin/bunkers/${bunker.pubkey}/pending`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
    expect(pendingRes.ok).toBe(true)
    const pending = (await pendingRes.json()) as { requests: Array<{ rpcId: string }> }
    expect(pending.requests.map((r) => r.rpcId)).toContain('a2')

    const decideRes = await workerFetch(`/api/admin/bunkers/${bunker.pubkey}/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rpcId: 'a2', allow: true }),
    })
    expect(decideRes.ok).toBe(true)
    const reply = await waitForReply(bunker.pubkey, 'a2')
    expect(reply?.error).toBeUndefined()
    expect(verifyEvent(JSON.parse(reply!.result!) as Event)).toBe(true)
  })
})
