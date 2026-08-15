# SIGNPOST — 自托管 Nostr 远程签名器（NIP-46 Bunker）

一套两件：

| 组件 | 目录 | 说明 |
|---|---|---|
| **Bunker** | `packages/bunker` | Cloudflare Worker + Durable Objects 实现的 NIP-46 远程签名器，密钥加密托管，策略引擎 + 审批队列 |
| **审批终端** | `packages/app` | Flutter App（Android / iOS），轮询待审批请求，一键批准/拒绝 |

任何支持 Nostr Connect（NIP-46）的客户端 —— Damus、Amethyst、Primal、Coracle 等 —— 都能直接连上你的 bunker，无需额外开发。

---

## 架构

```
 Nostr 客户端 (任意端)          自托管 Cloudflare Worker             你的手机
┌──────────────┐   wss    ┌─────────────────────────────┐   https  ┌──────────────┐
│ Damus/Amethyst├─────────►│ Relay ⇄ BunkerDO（每密钥一实例）│◄─────────┤ SIGNPOST App │
└──────────────┘          │  · NIP-46 方法路由           │  轮询/决议 └──────────────┘
                          │  · 策略引擎（allow/deny/审批） │
                          │  · nsec AES-GCM 加密存储      │
                          │  · 审批队列（120s TTL）       │
                          └─────────────────────────────┘
```

- **DO 实例名 = bunker pubkey**，一钥一实例，状态天然隔离
- 出站 WebSocket 监听 relay 的 kind 24133 事件；DO 被驱逐后由 alarm 重连并按 `since` 游标补拉
- nsec 以 `AES-GCM(HKDF(BUNKER_KEK, bunkerId))` 加密后落 DO SQLite，明文只在内存
- 传输层同时支持 NIP-04（旧客户端）与 NIP-44（新客户端），按密文形态自动探测
- 所有调用经过策略引擎：会话 perms（connect 时声明）> 低风险 kind 自动放行 > 默认进审批队列

## 快速开始（Bunker）

```bash
cd packages/bunker
pnpm install

# 本地开发（默认使用开发 KEK / dev-admin-token，仅限本机）
pnpm dev

# 部署
wrangler secret put BUNKER_KEK   # openssl rand -hex 32
wrangler secret put ADMIN_TOKEN  # openssl rand -hex 16
pnpm deploy
```

打开 Worker 域名即进入 **SIGNPOST 控制台**（输入 ADMIN_TOKEN）：
1. 部署 bunker（生成新密钥或导入 64 位 hex）
2. 复制 `bunker://npub…?relay=…` 粘贴到 Nostr 客户端完成连接
3. 复制三段式配对串给审批 App

## 快速开始（审批 App）

```bash
cd packages/app
flutter pub get
flutter run    # flutter build apk --release / flutter build ipa
```

首次启动粘贴配对串 `api|pubkey|token` 即接入。

## 安全模型

| 层 | 机制 |
|---|---|
| 私钥静态存储 | AES-256-GCM，密钥由 Worker secret `BUNKER_KEK` 经 HKDF 按 bunker 派生 |
| 客户端准入 | connect secret（可选）+ 会话表，可随时吊销 |
| 调用授权 | 策略引擎：只读放行 / 会话 perms / kind 白名单 / 默认审批 |
| 审批链路 | device token（SHA-256 哈希存 DO，常数时间比较），泄露可即时轮换 |
| 审计 | 全量决策日志（最近 500 条）在控制台可查 |

**威胁模型须知**：这是"托管热签名器"——密钥在 Cloudflare 边缘解密使用。它比把 nsec 直接交给每个客户端好得多（隔离、可吊销、可审计），但不等价于硬件钱包。若追求最高安全，可将策略设为全部审批并搭配本 App 使用。

## 扩展点

- **新 NIP-46 方法**：`src/core/nip46.ts` 中 `registerMethod()`，零改动分发器
- **新策略规则**：`src/core/policy.ts` 的 `buildRules()` 注入有序规则
- **新 relay 集合**：创建时传 `relays`，或改 `DEFAULT_RELAYS` 环境变量
- **推送通知**：App 目前 3s 轮询；可在 DO `enqueueApproval` 处挂 NIP-17 通知或 APNs/FCM

## API 一览

管理（Bearer ADMIN_TOKEN）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/bunkers` | 创建（`{secretHex?|generate:true, relays?, connectSecret?}`） |
| GET | `/api/admin/bunkers/:pubkey` | 状态（relay/会话/pending） |
| POST | `/api/admin/bunkers/:pubkey/settings` | 更新策略 |
| POST | `/api/admin/bunkers/:pubkey/revoke` | 吊销客户端会话 |
| POST | `/api/admin/bunkers/:pubkey/rotate-device-token` | 轮换设备 token |
| GET | `/api/admin/bunkers/:pubkey/audit` | 审计日志 |

设备（Bearer deviceToken，供审批 App）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/:pubkey/pending` | 待审批队列 |
| POST | `/api/v1/:pubkey/decide` | `{rpcId, allow}` 决议 |
| GET | `/api/v1/:pubkey/status` | bunker 状态 |

## 测试

```bash
cd packages/bunker && pnpm test   # 15 项：加密、策略、NIP-46 全链路（workerd 真实运行时）
```
