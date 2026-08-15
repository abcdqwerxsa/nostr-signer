import { describe, expect, it } from 'vitest'
import {
  b64Decode,
  b64Encode,
  decodeNsec,
  encodeNpub,
  hexIsValid,
  openSecret,
  resolveKek,
  sealSecret,
} from '../src/core/keys'
import { decryptTransport, encryptTransport } from '../src/core/nip46'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'

describe('密钥封存', () => {
  it('seal → open 往返一致', async () => {
    const kek = resolveKek({ BUNKER_KEK: 'f'.repeat(64) })
    const secret = bytesToHex(generateSecretKey())
    const sealed = await sealSecret(kek, getPublicKey(hexBytes(secret)), secret)
    expect(sealed.ciphertext).not.toContain(secret)
    const opened = await openSecret(kek, getPublicKey(hexBytes(secret)), sealed)
    expect(opened).toBe(secret)
  })

  it('错误的 bunkerId 无法解密（HKDF 派生隔离）', async () => {
    const kek = resolveKek({ BUNKER_KEK: 'f'.repeat(64) })
    const secret = bytesToHex(generateSecretKey())
    const sealed = await sealSecret(kek, 'a'.repeat(64), secret)
    await expect(openSecret(kek, 'b'.repeat(64), sealed)).rejects.toThrow()
  })
})

describe('传输层加密协商', () => {
  const bunker = generateSecretKey()
  const client = generateSecretKey()
  const bunkerPk = getPublicKey(bunker)
  const clientPk = getPublicKey(client)

  it('NIP-44 往返', () => {
    const ct = encryptTransport('hello 世界', bunker, clientPk, 'nip44')
    expect(ct).not.toContain('hello')
    expect(decryptTransport(ct, client, bunkerPk).plain).toBe('hello 世界')
  })

  it('NIP-04 往返与自动探测', () => {
    const ct = encryptTransport('hello', bunker, clientPk, 'nip04')
    const { plain, scheme } = decryptTransport(ct, client, bunkerPk)
    expect(plain).toBe('hello')
    expect(scheme).toBe('nip04')
    const ct44 = encryptTransport('hello', bunker, clientPk, 'nip44')
    expect(decryptTransport(ct44, client, bunkerPk).scheme).toBe('nip44')
  })
})

describe('编码工具', () => {
  it('base64 往返', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    expect(b64Decode(b64Encode(bytes))).toEqual(bytes)
  })
  it('nsec/npub 编解码与 hex 校验', () => {
    const sk = generateSecretKey()
    expect(decodeNsec(nip19.nsecEncode(sk))).toEqual(sk)
    expect(encodeNpub(getPublicKey(sk))).toBe(nip19.npubEncode(getPublicKey(sk)))
    expect(hexIsValid(bytesToHex(sk))).toBe(true)
    expect(hexIsValid('xyz')).toBe(false)
  })
})

import { nip19 } from 'nostr-tools'

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
