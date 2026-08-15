import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY_SETTINGS,
  PolicyEngine,
  parseSessionPerms,
} from '../src/core/policy'

describe('会话 perms 解析', () => {
  it('解析 method 与 kind 区间', () => {
    const perms = parseSessionPerms('sign_event:0-3, nip44_encrypt, sign_event:30078')
    expect(perms.grants.has('nip44_encrypt')).toBe(true)
    expect(perms.grants.get('sign_event')).toEqual([
      [0, 3],
      [30078, 30078],
    ])
  })
  it('容忍空串与脏数据', () => {
    const perms = parseSessionPerms('')
    expect(perms.grants.size).toBe(0)
    expect(parseSessionPerms('sign_event:abc').grants.size).toBe(0)
  })
})

describe('策略引擎', () => {
  it('默认策略：只读放行，签名进审批，未授权 kind 不放行', () => {
    const engine = new PolicyEngine(DEFAULT_POLICY_SETTINGS, parseSessionPerms())
    expect(engine.evaluate({ clientPubkey: 'a', method: 'ping' }).effect).toBe('allow')
    expect(engine.evaluate({ clientPubkey: 'a', method: 'get_public_key' }).effect).toBe('allow')
    expect(engine.evaluate({ clientPubkey: 'a', method: 'sign_event', eventKind: 1 }).effect)
      .toBe('require_approval')
    // kind 0 是低风险元数据，默认自动放行
    expect(engine.evaluate({ clientPubkey: 'a', method: 'sign_event', eventKind: 0 }).effect)
      .toBe('allow')
  })

  it('会话 perms 显式授权优先', () => {
    const engine = new PolicyEngine(
      DEFAULT_POLICY_SETTINGS,
      parseSessionPerms('sign_event:1'),
    )
    expect(engine.evaluate({ clientPubkey: 'a', method: 'sign_event', eventKind: 1 }).effect)
      .toBe('allow')
    expect(engine.evaluate({ clientPubkey: 'a', method: 'sign_event', eventKind: 4 }).effect)
      .toBe('require_approval')
  })

  it('默认效果可配置为自动放行', () => {
    const engine = new PolicyEngine(
      { ...DEFAULT_POLICY_SETTINGS, defaultEffect: 'allow', autoAllowKinds: [] },
      parseSessionPerms(),
    )
    expect(engine.evaluate({ clientPubkey: 'a', method: 'sign_event', eventKind: 4 }).effect)
      .toBe('allow')
  })

  it('加解密方法在默认设置下需要审批，可配置放行', () => {
    const strict = new PolicyEngine(DEFAULT_POLICY_SETTINGS, parseSessionPerms())
    expect(strict.evaluate({ clientPubkey: 'a', method: 'nip44_encrypt' }).effect)
      .toBe('require_approval')
    const lax = new PolicyEngine(
      { ...DEFAULT_POLICY_SETTINGS, approvalForEphemeral: false },
      parseSessionPerms(),
    )
    expect(lax.evaluate({ clientPubkey: 'a', method: 'nip44_encrypt' }).effect).toBe('allow')
  })
})
