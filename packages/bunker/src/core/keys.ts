/**
 * 密钥管理：nsec/npub 编解码、KEK 派生、nsec 的静态加密存储。
 *
 * 设计约束：
 * - 明文私钥只存在于 DO 内存，落盘前必须加密；
 * - 加密密钥不从用户口令派生（bunker 需要无人值守签名），而是从服务端
 *   secret BUNKER_KEK 经 HKDF 按 bunkerId 派生，换取"单 secret 泄露不等于
 *   全部密钥泄露"的纵深防御；
 * - 所有原语使用 WebCrypto / @noble，无原生依赖，Workers 原生可用。
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as nip19 from 'nostr-tools/nip19'

export interface SealedKey {
  /** AES-GCM 密文（含 tag），base64 */
  ciphertext: string
  /** 12 字节随机 nonce，base64 */
  iv: string
  /** 创建时间（毫秒） */
  createdAt: number
}

/** 从环境变量解析 KEK；开发/测试环境允许默认值并打警告。 */
export function resolveKek(env: { BUNKER_KEK?: string }): Uint8Array {
  const raw = env.BUNKER_KEK
  if (raw && /^[0-9a-f]{64}$/i.test(raw)) return hexToBytes(raw)
  // 未配置：仅开发环境可用确定性 KEK，生产部署必须 `wrangler secret put BUNKER_KEK`
  console.warn('[bunker] BUNKER_KEK not set — using insecure development key')
  return sha256(new TextEncoder().encode('insecure-dev-kek'))
}

/** 按 bunkerId（即 pubkey hex）从 KEK 派生唯一的 AES 密钥。 */
export function deriveKeyEncryptionKey(kek: Uint8Array, bunkerId: string): Uint8Array {
  return hkdf(sha256, kek, undefined, new TextEncoder().encode(`bunker-key:${bunkerId}`), 32)
}

export async function sealSecret(
  kek: Uint8Array,
  bunkerId: string,
  secretHex: string,
): Promise<SealedKey> {
  const key = await crypto.subtle.importKey('raw', deriveKeyEncryptionKey(kek, bunkerId), 'AES-GCM', false, [
    'encrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secretHex),
  )
  return {
    ciphertext: b64Encode(new Uint8Array(ct)),
    iv: b64Encode(iv),
    createdAt: Date.now(),
  }
}

/** 解密并以 64 位 hex 字符串返回私钥（便于直接校验与传给 nostr-tools）。 */
export async function openSecret(
  kek: Uint8Array,
  bunkerId: string,
  sealed: SealedKey,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', deriveKeyEncryptionKey(kek, bunkerId), 'AES-GCM', false, [
    'decrypt',
  ])
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(sealed.iv) },
    key,
    b64Decode(sealed.ciphertext),
  )
  return new TextDecoder().decode(pt)
}

// ---- bech32 与 hex 互转 ----------------------------------------------

export function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') throw new Error('expected nsec, got ' + decoded.type)
  return decoded.data as Uint8Array
}

export function encodeNsec(secret: Uint8Array): string {
  return nip19.nsecEncode(secret)
}

export function encodeNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex)
}

export function secretToHex(secret: Uint8Array): string {
  return bytesToHex(secret)
}

export function hexIsValid(priv_or_pub: string): boolean {
  return /^[0-9a-f]{64}$/.test(priv_or_pub)
}

// ---- 通用 base64 ------------------------------------------------------

export function b64Encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
