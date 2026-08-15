/**
 * 策略引擎：每次 NIP-46 调用在执行前经过这里，得到 allow / deny / require_approval。
 *
 * 扩展性设计：
 * - 决策由有序规则数组产生，首条命中即生效，未命中默认 deny；
 * - 规则来源可组合（bunker 全局设置 + 会话在 connect 时声明的 perms），
 *   未来可插入按时间窗、按客户端标签等新规则而不动调用方代码。
 */

export type PolicyEffect = 'allow' | 'deny' | 'require_approval'

export interface PolicyDecision {
  effect: PolicyEffect
  /** 供审计日志与审批 App 展示 */
  reason: string
}

export interface PolicyContext {
  clientPubkey: string
  method: string
  /** sign_event 时待签事件的 kind，其余方法为 undefined */
  eventKind?: number
}

export interface PolicyRule {
  id: string
  match(ctx: PolicyContext): boolean
  decide(ctx: PolicyContext): PolicyDecision
}

/** bunker 级别的用户可调设置，存于 DO storage。 */
export interface PolicySettings {
  /**
   * 会话 perms 未覆盖时的默认效果。
   * 自托管个人 bunker 推荐 require_approval：一切签名进审批队列。
   */
  defaultEffect: PolicyEffect
  /** 即使没有会话 perms 也直接放行的 kind（低风险元数据操作）。 */
  autoAllowKinds: number[]
  /** 是否对 nip04/nip44 加解密方法也要求审批。 */
  approvalForEphemeral: boolean
}

export const DEFAULT_POLICY_SETTINGS: PolicySettings = {
  defaultEffect: 'require_approval',
  autoAllowKinds: [0, 3, 10002],
  approvalForEphemeral: true,
}

/** 会话在 connect 时声明的 perms：`sign_event:0-3, nip44_encrypt` 这样的字符串。 */
export interface SessionPerms {
  /** method 名 → 允许的 kind 区间；无 kind 限制的方法值为 undefined */
  grants: Map<string, Array<[number, number]> | undefined>
}

export function parseSessionPerms(perms?: string): SessionPerms {
  const grants = new Map<string, Array<[number, number]> | undefined>()
  if (!perms) return { grants }
  for (const raw of perms.split(',').map((s) => s.trim()).filter(Boolean)) {
    const colon = raw.indexOf(':')
    const method = colon === -1 ? raw : raw.slice(0, colon)
    const kindRange = colon === -1 ? undefined : raw.slice(colon + 1)
    if (!method) continue
    if (!kindRange) {
      grants.set(method, undefined)
    } else {
      const m = kindRange.match(/^(\d+)(?:-(\d+))?$/)
      if (!m) continue
      const from = Number(m[1])
      const to = m[2] ? Number(m[2]) : from
      const list = grants.get(method) ?? []
      list.push([from, to])
      grants.set(method, list)
    }
  }
  return { grants }
}

function permCovers(perms: SessionPerms, method: string, kind?: number): boolean {
  const ranges = perms.grants.get(method)
  if (perms.grants.has(method) && ranges === undefined) return true
  if (!ranges || kind === undefined) return false
  return ranges.some(([from, to]) => kind >= from && kind <= to)
}

// ---- 规则集构建 -------------------------------------------------------

const READ_ONLY_METHODS = new Set(['describe', 'ping', 'get_public_key', 'get_relays'])
const EPHEMERAL_METHODS = new Set([
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
])

export function buildRules(settings: PolicySettings, perms: SessionPerms): PolicyRule[] {
  const rules: PolicyRule[] = []

  // 1. 只读方法始终放行
  rules.push({
    id: 'read-only',
    match: (ctx) => READ_ONLY_METHODS.has(ctx.method),
    decide: () => ({ effect: 'allow', reason: '只读方法' }),
  })

  // 2. 会话 perms 显式授权（connect 时用户同意的范围）
  rules.push({
    id: 'session-perm',
    match: (ctx) => permCovers(perms, ctx.method, ctx.eventKind),
    decide: (ctx) => ({
      effect: 'allow',
      reason: `会话授权：${ctx.method}${ctx.eventKind !== undefined ? ` (kind ${ctx.eventKind})` : ''}`,
    }),
  })

  // 3. 低风险 kind 自动放行（设置项）
  rules.push({
    id: 'auto-allow-kinds',
    match: (ctx) => ctx.method === 'sign_event' && ctx.eventKind !== undefined && settings.autoAllowKinds.includes(ctx.eventKind),
    decide: (ctx) => ({ effect: 'allow', reason: `kind ${ctx.eventKind} 配置为自动放行` }),
  })

  // 4. 加解密方法按设置处理
  if (settings.approvalForEphemeral) {
    rules.push({
      id: 'ephemeral-approval',
      match: (ctx) => EPHEMERAL_METHODS.has(ctx.method),
      decide: () => ({ effect: 'require_approval', reason: '消息加解密需要审批' }),
    })
  } else {
    rules.push({
      id: 'ephemeral-allow',
      match: (ctx) => EPHEMERAL_METHODS.has(ctx.method),
      decide: () => ({ effect: 'allow', reason: '消息加解密已配置为放行' }),
    })
  }

  // 5. 兜底：默认效果
  rules.push({
    id: 'default',
    match: () => true,
    decide: () => ({ effect: settings.defaultEffect, reason: '默认策略' }),
  })

  return rules
}

export class PolicyEngine {
  private rules: PolicyRule[]

  constructor(
    private settings: PolicySettings = DEFAULT_POLICY_SETTINGS,
    private perms: SessionPerms = parseSessionPerms(),
  ) {
    this.rules = buildRules(this.settings, this.perms)
  }

  /** 新会话建立或设置变更后重建规则集。 */
  rebuild(settings: PolicySettings, perms: SessionPerms): void {
    this.settings = settings
    this.perms = perms
    this.rules = buildRules(settings, perms)
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.match(ctx)) return rule.decide(ctx)
    }
    return { effect: 'deny', reason: '无规则命中，默认拒绝' }
  }
}
