# Design System: SIGNPOST — 仪器面板 / 磷光琥珀 (Instrument Panel / Phosphor Amber)

## 1. Visual Theme & Atmosphere
SIGNPOST 采用**工业仪器面板 (Instrument Terminal Panel)** 设计风格。界面灵感源于军工加密终端、高密蓝图网格与磷光琥珀单色指示灯。
- **密度**: Cockpit Dense (8/10) — 紧凑、精确、无无效留白
- **排版**: Monospace Monochromatic — 全员等宽字体，高密度密码学符号呈现
- **饰面**: Corner Bracket Frame — 四角加固琥珀色 L 型切角标记，无软绵绵的圆角阴影堆砌
- **氛围**: 暗墨底层 `#0b0c0e` + 44px 蓝图点阵网格 + 单色琥珀 `#ffb224` 精确高亮

---

## 2. Color Palette & Roles

### Dark Canvas & Surfaces (主色调)
- **Deep Ink Base** (`#0b0c0e`) — 全局最高底色，仪表盘黑洞幕布
- **Console Surface** (`#111316`) — 输入框、表格 hover、待审批卡片卡槽底色
- **Elevated Ink** (`#17191d`) — Read-only 只读框、弹出窗、侧边栏底色

### Lines & Borders (结构分割)
- **Grid Subdued Line** (`#26282d`) — 1px 卡片与底层格子线
- **Interactive Border** (`#33363c`) — 默认按钮、输入框、表头分隔线

### Phosphor Amber Accents (主指示色)
- **Phosphor Amber** (`#ffb224`) — 单色核心高亮，按钮 hover、选中态、密码学 Hash、品牌标记
- **Amber Dim** (`#8f6413`) — 辅助虚线框、深层背景混合点缀色

### Semantic Indicators (状态语义)
- **Status OK Green** (`#7ee081`) — 节点在线 (LINKED)、已批准状态
- **Status Alert Red** (`#ff6b5e`) — 节点离线 (DOWN)、拒绝/危险操作按钮 (ROTATE)
- **Text Main** (`#d6d3cb`) — 主正文与输入字色
- **Text Dim** (`#8a877f`) — 标签与辅助描述文本
- **Text Faint** (`#55534d`) — 页脚、只读标记、小尺寸元数据

---

## 3. Typography Rules

- **Font Family**: Standard Monospace Hierarchy (`ui-monospace`, `JetBrains Mono`, `Cascadia Code`, `SFMono-Regular`, `Consolas`, `monospace`)
- **Display / Header**: `font-weight: 600`, `letter-spacing: 0.38em`, 大写模式。品牌名采用 `SIGNPOST` 结合 `POST` 琥珀反色高亮
- **Section Titles (H2)**: `font-size: 11px`, `letter-spacing: 0.3em`, `color: #ffb224`, 带 `TAG` 状态标识
- **Labels**: `font-size: 10px`, `letter-spacing: 0.2em`, `text-transform: uppercase`, `color: #8a877f`
- **Numbers & Hashes**: 强制纯等宽（Monospace），禁止混用比例字体

---

## 4. Component Stylings (Web Console)

### 1. Corner Bracket Panel (角标记面板 `.panel`)
- 相对定位 `position: relative`，带有 1px 细线边框 (`#26282d`)。
- 使用 `::before` 和 `::after` 伪元素在左上角与右下角绘制 `9px * 9px` 的 `2px solid #ffb224` 琥珀色直角加固边框。

### 2. Form Inputs & Copyline (输入框组 `.copyline`)
- **高度**: 统一 `34px` 垂直对齐。
- **只读框 (`input:read-only`)**: 背景 `#17191d`，边框 `#33363c`，字色 `#ffb224`，单行溢出 `text-overflow: ellipsis`。
- **组合输入框 (`.copyline`)**: 输入框与复制按钮紧密拼接。输入框无右边框 (`border-right: 0`)，按钮左边框连接，`z-index` 切换保证 Focus outline 完整。

### 3. Tactile Buttons (按键规范)
- 纯硬朗直角（`border-radius: 0`），大写字符，`letter-spacing: 0.16em`。
- **Primary**: 琥珀边框 + 琥珀字，Active 态反色充盈 (`#ffb224` 背景 + `#0b0c0e` 文字)。
- **Danger**: 红色 Hover / Focus 反馈，用于 Token 轮换、会话吊销与拒绝操作。

### 4. Status Pills (状态胶囊 `.pill`)
- 细线 1px 边框指示（`ok`: `#7ee081`, `down`: `#ff6b5e`, `amber`: `#ffb224`）。

---

## 5. Mobile App Guidelines (Flutter `packages/app`)

为了使 Flutter 移动审批 App 保持完全一致的视觉语言，App 端需遵循以下规范：

### Flutter Theme Setup
- **Theme Mode**: Dark Mode Default
- **Scaffold Background**: `Color(0xFF0B0C0E)`
- **Card Background**: `Color(0xFF111316)`
- **Primary / Accent Color**: `Color(0xFFFFB224)`
- **Font Family**: `JetBrainsMono` / Monospace (Google Fonts)

### Flutter UI Component Specs
1. **Header & Navigation**:
   - 采用硬朗大写 Header，带 1.5px 直角方形 Logo 与 琥珀色闪烁指示器。
2. **Approval Cards (待审批卡片)**:
   - 1px 边框 `Color(0xFF33363C)`，无 Rounded Corners (直角/2px极微圆角)。
   - NIP-46 方法名使用 `Color(0xFFFFB224)` 单色显示，代码块（Payload Pre）采用纯黑底 `Color(0xFF0B0C0E)`。
3. **Action Buttons**:
   - 底部并排固定按钮："批准签名" (Primary Amber) 与 "拒绝" (Danger Red)。
   - 按钮自带按压 Tactile 极简震动反馈（HapticFeedback.lightImpact）。
4. **Device Pairing Input Screen**:
   - 一键粘贴配对串支持（自动解析 `api|pubkey|token`）。
   - 输入框采用等宽深色内嵌样，Focus 时显示琥珀边框。

---

## 6. Anti-Patterns (严格禁止)

- ❌ 禁止使用极轻的圆角卡片、大阴影、粉/紫霓虹渐变（Neon Blue/Purple Glow）。
- ❌ 禁止在仪表盘界面使用 Serif 衬线字体或非等宽混排。
- ❌ 禁止使用纯白背景色或纯红/纯蓝原生原色。
- ❌ 禁止输入框与按钮高度错位或在移动端出现横向滚动条。
- ❌ 禁止添加冗余的微操动画或影响操作速度的延迟过渡。
