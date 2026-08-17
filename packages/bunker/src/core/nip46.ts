/**
 * NIP-46 协议层：JSON-RPC 请求/响应封装、传输层解密协商（NIP-04 / NIP-44）、
 * 方法注册表。
 *
 * 扩展方式：新方法 = 实现 MethodHandler 并调用 registerMethod()，
 * 无需改动分发器。
 */
import type { Event } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'

// ---- JSON-RPC 封装 ----------------------------------------------------

export interface Nip46Request {
  id: string
  method: string
  params: string[]
}

export interface Nip46Response {
  id: string
  result?: string
  error?: string
}

export function parseRequest(raw: string): Nip46Request {
  const obj = JSON.parse(raw) as Partial<Nip46Request>
  if (typeof obj.id !== 'string' || typeof obj.method !== 'string') {
    throw new Error('invalid NIP-46 request envelope')
  }
  return { id: obj.id, method: obj.method, params: Array.isArray(obj.params) ? obj.params : [] }
}

export function okResponse(id: string, result: string): Nip46Response {
  return { id, result }
}

export function errorResponse(id: string, error: string): Nip46Response {
  return { id, error }
}

// ---- 传输层加密 -------------------------------------------------------
// NIP-46 客户端目前两种传输并存：旧客户端 NIP-04、新客户端 NIP-44。
// 密文形态可区分：NIP-04 为 "<ct>?iv=<hex>"，NIP-44 v2 为单段 base64。

export type TransportScheme = 'nip04' | 'nip44'

export function detectScheme(content: string): TransportScheme {
  return content.includes('?iv=') ? 'nip04' : 'nip44'
}

export function decryptTransport(
  content: string,
  bunkerSecret: Uint8Array,
  peerPubkey: string,
): { plain: string; scheme: TransportScheme } {
  const scheme = detectScheme(content)
  const plain =
    scheme === 'nip04'
      ? nip04.decrypt(bunkerSecret, peerPubkey, content)
      : nip44.decrypt(content, nip44.getConversationKey(bunkerSecret, peerPubkey))
  return { plain, scheme }
}

export function encryptTransport(
  plain: string,
  bunkerSecret: Uint8Array,
  peerPubkey: string,
  scheme: TransportScheme,
): string {
  return scheme === 'nip04'
    ? nip04.encrypt(bunkerSecret, peerPubkey, plain)
    : nip44.encrypt(plain, nip44.getConversationKey(bunkerSecret, peerPubkey))
}

// ---- 方法注册表 -------------------------------------------------------

/** 方法执行所需的全部上下文，由 DO 组装注入。 */
export interface MethodContext {
  /** bunker 私钥 */
  secret: Uint8Array
  bunkerPubkey: string
  /** 请求方客户端 pubkey（hex） */
  clientPubkey: string
  method: string
  params: string[]
  /** 发出响应的通道：方法内同步返回，或审批后异步返回 */
  reply(result: Nip46Response): void
}

export interface MethodHandler {
  /** 是否需要已建立的会话（connect/describe/ping 为 false） */
  requiresSession: boolean
  /** 供 describe 方法播报 */
  handle(ctx: MethodContext): Promise<string>
}

const methods = new Map<string, MethodHandler>()

export function registerMethod(name: string, handler: MethodHandler): void {
  methods.set(name, handler)
}

export function getMethod(name: string): MethodHandler | undefined {
  return methods.get(name)
}

export function listMethodNames(): string[] {
  return [...methods.keys()]
}

export function methodRequiresSession(name: string): boolean {
  return methods.get(name)?.requiresSession ?? true
}

// ---- 内置方法：connect 在 DO 中处理（涉及会话写入），此处注册其余 ------

registerMethod('describe', {
  requiresSession: false,
  async handle() {
    return listMethodNames().join(' ')
  },
})

registerMethod('get_public_key', {
  requiresSession: true,
  async handle(ctx) {
    return ctx.bunkerPubkey
  },
})

registerMethod('ping', {
  requiresSession: true,
  async handle() {
    return 'pong'
  },
})

registerMethod('sign_event', {
  requiresSession: true,
  async handle(ctx, ) {
    const { finalizeEvent } = await import('nostr-tools/pure')
    const template = JSON.parse(ctx.params[0] ?? '{}') as Parameters<typeof finalizeEvent>[0]
    const signed = finalizeEvent(template, ctx.secret)
    return JSON.stringify(signed)
  },
})

registerMethod('nip04_encrypt', {
  requiresSession: true,
  async handle(ctx) {
    const peer = ctx.params[0]
    const text = ctx.params[1]
    if (!peer || text === undefined) throw new Error('nip04_encrypt: expected [pubkey, plaintext]')
    return nip04.encrypt(ctx.secret, peer, text)
  },
})

registerMethod('nip04_decrypt', {
  requiresSession: true,
  async handle(ctx) {
    const peer = ctx.params[0]
    const ct = ctx.params[1]
    if (!peer || ct === undefined) throw new Error('nip04_decrypt: expected [pubkey, ciphertext]')
    return nip04.decrypt(ctx.secret, peer, ct)
  },
})

registerMethod('nip44_encrypt', {
  requiresSession: true,
  async handle(ctx) {
    const peer = ctx.params[0]
    const text = ctx.params[1]
    if (!peer || text === undefined) throw new Error('nip44_encrypt: expected [pubkey, plaintext]')
    return nip44.encrypt(text, nip44.getConversationKey(ctx.secret, peer))
  },
})

registerMethod('nip44_decrypt', {
  requiresSession: true,
  async handle(ctx) {
    const peer = ctx.params[0]
    const ct = ctx.params[1]
    if (!peer || ct === undefined) throw new Error('nip44_decrypt: expected [pubkey, ciphertext]')
    return nip44.decrypt(ct, nip44.getConversationKey(ctx.secret, peer))
  },
})

/** NIP-46 relay 建议方法：返回 bunker 正在监听的 relay 读写策略。 */
registerMethod('get_relays', {
  requiresSession: true,
  async handle() {
    const relays: Record<string, { read: boolean; write: boolean }> = {
      'wss://relay.damus.io': { read: true, write: true },
      'wss://nos.lol': { read: true, write: true },
      'wss://purplepag.es': { read: true, write: true },
      'wss://relay.nostr.band': { read: true, write: true },
      'wss://relay.primal.net': { read: true, write: true },
    }
    return JSON.stringify(relays)
  },
})

export type { Event }
