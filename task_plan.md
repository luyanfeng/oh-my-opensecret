# Task Plan: oh-my-opensecret Opencode 插件

## Goal

构建一个 YAML 配置驱动的、场景化的 Opencode 隐私脱敏插件，在发送给 LLM 前脱敏敏感信息，响应完成后自动还原，工具执行前还原参数，覆盖完整生命周期。

## Current Phase

Phase 7 (规划中)

## Phases

### Phase 1: 需求分析与设计参考 ✅ 已完成

- [x] 分析需求、明确功能范围
- [x] 研究 Opencode 插件 API（16 个 hook 的类型签名和用途）
- [x] 提炼设计参考（架构模块划分、核心设计模式、占位符格式、脱敏引擎策略）
- [x] 确定技术选型（YAML、js-yaml、Node ESM、node:test）
- [x] 清理文档中的外部引用痕迹
- **Status:** complete
- **产出:**
  - `doc/01-design-reference.md` — 设计参考文档

### Phase 2: 项目骨架搭建 ✅ 已完成

- [x] 创建 `package.json`（名称、入口、依赖声明）
- [x] 创建 `src/` 目录结构与入口文件（8 个模块）
- [x] 实现 YAML 配置加载系统（4 级查找、schema 校验）
- [x] 实现分级日志系统（debug/info/warn/error，可配置目标）
- [x] 创建配置示例文件 `oh-my-opensecret.yaml.example`
- [x] **配置自举**：启动时检查配置是否存在，不存在则生成默认配置（含 `auto-discovery: true`）
- [x] **自动发现 API Key**：当 `auto-discovery: true` 时，启动后扫描 Opencode 配置（opencode.json），提取 apiKey 等敏感字段生成正则规则追加到主配置
  - 不存在的规则 → 直接写入（激活状态）
  - 已存在的规则 → 跳过，不覆盖
  - 有冲突的项 → 以注释形式写入，标注冲突信息
- **Status:** complete
- **产出:**
  - `src/config.js` — 配置加载（级联查找 + YAML 解析 + auto-discovery）
  - `src/logger.js` — 分级日志系统（文件输出 + 滚动）
  - `oh-my-opensecret.yaml.example` — 完整配置示例

### Phase 3: 核心引擎实现 ✅ 已完成

- [x] 实现脱敏引擎（关键词/正则匹配、重叠命中处理、从右到左替换）
- [x] **脱敏引擎单元测试**（engine.test.js，覆盖关键词/正则/重叠/排除/无匹配）
- [x] 实现会话占位符管理器（HMAC-SHA256、双向映射、TTL 淘汰、hash 冲突处理）
- [x] **会话管理器单元测试**（session.test.js，覆盖格式/冲突/淘汰/TTL 过期）
- [x] 实现深度脱敏/还原工具（WeakSet 防循环引用）
- [x] 实现文本还原系统（正则替换占位符回原文）
- [x] 扩展内置 pattern 库（数据库连接串、JWT、AWS key 等 20+ 内置规则）
- **Status:** complete
- **产出:**
  - `src/engine.js` — 脱敏引擎
  - `src/session.js` — 会话占位符管理器
  - `src/deep.js` — 深度遍历脱敏/还原
  - `src/restore.js` — 文本还原
  - `src/patterns.js` — 内置 pattern 库 + 规则构建
  - `test/engine.test.js` — 脱敏引擎测试（~14 用例）
  - `test/session.test.js` — 会话管理测试（~8 用例）
  - `test/deep.test.js` — 深度工具测试（9 用例）

### Phase 4: Hook 注册与集成 ✅ 已完成

- [x] 注册 `experimental.chat.messages.transform` — LLM 请求前脱敏所有消息（text/reasoning/tool parts）
- [x] 注册 `experimental.text.complete` — 响应完成后还原占位符
- [x] 注册 `tool.execute.before` — 工具执行前还原参数中的占位符
- [x] 插件入口集成测试（integration.test.js，覆盖配置加载 + hook 调用链路）
- **Status:** complete
- **产出:**
  - `src/index.js` — 插件入口（3 个 hook 注册）
  - `test/integration.test.js` — 集成测试

### Phase 5: 场景化配置 ⏳ 已移除

> Profile 功能因实用性有限（需 YAML 编辑 + 重启 Opencode 才能切换）已被移除。
> 场景分析文档保留作为参考，不再有对应的实现代码。
- **Status:** removed
- **保留产出（仅文档参考）:**
  - `doc/scenarios/01-daily-chat.md`
  - `doc/scenarios/02-code-review.md`
  - `doc/scenarios/03-ci-cd.md`

### Phase 6: 测试与交付 ✅ 已完成

- [x] 深度工具测试（deep.js 单元测试，9 个用例，覆盖脱敏/还原/循环引用/非 plain object）
- [x] 配置加载测试（config.test.js，覆盖 schema 校验/默认值/时长解析）
- [x] 验收测试（acceptance.test.js，覆盖完整脱敏→还原闭环）
- [x] 最终审查与交付
- **Status:** complete
- **产出:**
  - `test/config.test.js` — 配置测试
  - `test/acceptance.test.js` — 验收测试
  - 全量测试覆盖：7 个测试文件

### Phase 7: TUI Sidebar 脱敏信息面板 ⏳ 待实现

- [ ] 创建 TUI 插件入口 `src/tui/index.jsx`，在 `sidebar_content` slot 渲染脱敏信息面板
- [ ] 实现 Server → TUI 数据桥接（暴露统计 API 或事件通信）
- [ ] 面板内容：插件状态、当前会话脱敏数、规则数、活跃 Profile、占位符前缀等
- [ ] 支持折叠/展开、动态刷新
- [ ] 更新 `package.json` 添加 `./tui` 导出入口
- [ ] 更新配置文档告知用户需在 `tui.json` 中注册
- **Status:** pending

## 项目结构总览

```
oh-my-opensecret/
├── package.json              # 包配置（入口、依赖、脚本）
├── oh-my-opensecret.yaml.example  # 配置示例
├── src/
│   ├── index.js              # 插件入口（3 个 hook 注册）
│   ├── config.js             # 配置加载（级联查找 + YAML 解析 + auto-discovery）
│   ├── patterns.js           # 匹配规则构建（关键词/正则/内置/排除 + 20+ 内置规则）
│   ├── engine.js             # 脱敏引擎（重叠命中处理）
│   ├── session.js            # 会话占位符管理器（HMAC 映射、TTL 淘汰）
│   ├── restore.js            # 占位符还原（正则替换）
│   ├── deep.js               # 深度遍历工具（递归脱敏/还原，防循环引用）
│   └── logger.js             # 分级日志系统（文件输出 + 滚动）
├── test/
│   ├── engine.test.js        # 脱敏引擎单元测试
│   ├── session.test.js       # 会话管理单元测试
│   ├── deep.test.js          # 深度工具单元测试
│   ├── config.test.js        # 配置加载测试

│   ├── integration.test.js   # 集成测试
│   └── acceptance.test.js    # 验收测试
└── doc/
    ├── 01-design-reference.md     # 设计参考文档
    ├── 02-plugin-api-reference.md # 插件 API 参考
    ├── 03-sidebar-research.md     # TUI 侧边栏可行性研究报告
    └── scenarios/
        ├── 01-daily-chat.md       # 日常对话场景分析
        ├── 02-code-review.md      # 代码审查场景分析
        └── 03-ci-cd.md            # CI/CD 场景分析
```

## 当前功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| YAML 配置加载 | ✅ | 4 级查找（env→project→.opencode→global）+ schema 校验 |
| 配置自举 | ✅ | 无配置时自动生成默认配置到 `~/.config/opencode/` |
| 自动发现 API Key | ✅ | 扫描 Opencode 配置中的 apiKey/token/secret 等字段，自动生成正则规则 |
| 关键词脱敏 | ✅ | 精确子串匹配，线性扫描 |
| 正则脱敏 | ✅ | 支持 `/pattern/flags` 字面量语法和 `(?i)(?m)(?s)` 内联前缀 |
| 重叠命中处理 | ✅ | 右侧优先排序 → subtractCovered 分割 → insertCovered 合并 |
| 20+ 内置规则 | ✅ | email/phone/id/uuid/ipv4/mac/jwt/db 及各大平台 API Key |
| 排除列表 | ✅ | 命中后跳过，用于白名单/豁免 |
| 会话占位符 | ✅ | HMAC-SHA256 双向映射，会话内稳定可逆 |
| TTL 淘汰 | ✅ | 过期映射自动清理（默认 1h） |
| LRU 淘汰 | ✅ | 超 maxMappings 上限时淘汰最旧映射（默认 100000） |
| Hash 冲突处理 | ✅ | 极低概率下追加 `_N` 后缀 |
| 消息脱敏 | ✅ | `messages.transform` hook：text/reasoning/tool 类型全部覆盖 |
| 输出还原 | ✅ | `text.complete` hook：还原占位符为原文 |
| 工具参数还原 | ✅ | `tool.execute.before` hook：深度还原工具入参 |
| 深度遍历 | ✅ | 递归 Array/PlainObject，WeakSet 防循环引用 |
| 场景 Profile | ❌ 已移除 | 需 YAML 编辑+重启才能切换，实际用处不大 |
| 分级日志 | ✅ | debug/info/warn/error，文件输出 + 滚动（按大小+日期） |
| `enabled: false` 降级 | ✅ | 完全禁用，注册空 hook，no-op |
| 6 个测试文件 | ✅ | engine/session/deep/config/integration/acceptance |
| **TUI Sidebar 面板** | ⏳ | 研究已完成，待实现 |

## Key Questions

1. YAML schema 校验用 js-yaml 自带能力还是额外引入 validator？
2. 占位符前缀用 `__OS_` 还是保留可配置策略？
3. 日志默认输出到 console 还是需要支持 file 输出？
4. 自动发现 API Key 时，扫描 Opencode 配置的哪些字段？只扫 `apiKey` 还是所有含 `key`/`secret`/`token` 的字段？
5. 自动发现的规则写入主配置文件时，如何避免覆盖用户已有的手动配置？（已存在 → 跳过；冲突 → 注释写入）

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| YAML 配置格式 | 支持注释、层次结构、可读性好，多 Profile 管理方便 |
| Node ESM 模块 | Opencode 插件标准，与 vibeguard 一致 |
| node:test 测试框架 | 零依赖，内建支持，够用 |
| 4 级配置查找策略（env → project → .opencode → global） | 灵活可靠，已验证 |
| 分级日志（debug/info/warn/error） | 比单一 debug 开关更精细可控 |
| HMAC-SHA256 占位符 | 会话内稳定、对 provider 不可逆 |
| 配置缺失时自动生成默认配置 | 降低用户上手成本，无配置也不是 no-op 而是开箱即用 |
| 自动发现 Opencode 配置中的 apiKey 生成规则 | 零配置即可保护用户已配置的密钥，减少遗漏风险 |
| `auto-discovery` 配置开关控制 | 用户可自主选择是否启用自动发现 |
| 已存在规则跳过 | 绝不覆盖用户手动配置 |
| 冲突项以注释写入 | 用户可见但不生效，按需手动启用 |
| 默认配置生成时 `enabled: true, auto-discovery: true` | 开箱即用，首次启动自动保护 |
| `enabled: false` 时 auto-discovery 不执行 | 插件整体关闭，自动发现无意义 |
| auto-discovery 每次启动都执行（幂等） | 已存在规则跳过，不影响性能 |
| Opencode 配置搜索路径：项目根 → `.opencode/` | 覆盖 opencode.json 常见存放位置 |
| 配置文件名统一为 `oh-my-opensecret.yaml` | 示例文件为 `oh-my-opensecret.yaml.example` |
| **TUI Sidebar 走 TUI Slot 系统** | `sidebar` hook 在 v1.15.13 中不存在，唯一可行方案 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| - | 1 | - |

## Notes

- 文档存于 `doc/`
- 研究文档 `doc/03-sidebar-research.md` 包含 TUI 侧边栏的完整 API 参考和实现方案
- 每完成一个 Phase 更新此文件
