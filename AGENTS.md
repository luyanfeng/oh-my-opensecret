# oh-my-opensecret — AGENTS.md

OpenCode 隐私脱敏插件。在 LLM 请求发送前脱敏敏感信息，响应完成后自动还原，工具执行前还原参数。

## 项目概要

- **入口**: `src/index.js` — V2 `Plugin.define({ id, setup(ctx) })` 导出，注册 hook 并导出纯处理函数
- **类型**: ESM (`"type": "module"`)
- **依赖**: `js-yaml`（配置解析）；`@opencode/plugin` 为 peerDependency（由 opencode server 运行时提供）
- **测试**: `node:test`（Node 内置），无第三方测试库
- **出口文件**: `package.json` `"files"` 含 `src/` 和 `oh-my-opensecret.yaml.example`

## 架构

```
src/
├── index.js      # 插件入口（V2 Plugin.define + hook 注册 + 纯处理函数导出）
├── singleton.js   # 进程级单例协调（globalThis 夺权，确保一个 server 进程只有一个实例注册 hook）
├── config.js     # 配置加载（级联查找 + YAML + auto-discovery）
├── patterns.js   # 匹配规则构建（关键词/正则/内置/排除）+ BUILTIN 规则表
├── engine.js     # 脱敏引擎（重叠命中处理）
├── session.js    # 会话占位符管理器（HMAC 映射、TTL 淘汰、LRU）
├── restore.js    # 占位符还原（正则替换）
├── deep.js       # 深度遍历工具（递归脱敏/还原对象树）
└── logger.js     # 分级日志系统（文件输出、大小/日期滚动）
```

## Hook 注册（`src/index.js`）

V2 机制：`Plugin.define({ id, setup(ctx) })`，`setup` 内通过 `ctx.session.hook(name, cb)` / `ctx.tool.hook(name, cb)` 注册 hook，返回 cleanup 函数。

| V1 Hook | V2 Hook | 作用 | 注意事项 |
|---------|---------|------|----------|
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` | LLM 请求前脱敏 | in-place 修改 `event.messages[].content`；V2 无 sessionID，见下 |
| `experimental.text.complete` | `ctx.session.hook("http.response")` | 响应完成后还原 | `event.response` 是 `Response`；只对 `application/json`/`text/*` 读流还原，其余透传 |
| `tool.execute.before` | `ctx.tool.hook("execute.before")` | 工具执行前还原参数 | 修改 `event.input`（深度遍历） |

**关键 V2 差异（已确认官方行为）**：
- V2 `context` hook 事件**不带 `sessionID`**，因此整个 server 进程共用一把 HMAC 密钥与一张占位符映射表（密钥不出本机）。`src/index.js` 的 `makeContextHandler` 在脱敏前显式调用 `session.cleanup()`。
- `Message` 结构：`msg.content[]` 取代 V1 的 `msg.parts[]`；part 类型为 `text`/`reasoning`/`tool-call`/`tool-result`（取代 V1 的 `tool` state 对象）。
- `enabled=false` 时不注册任何 hook（返回 undefined）。

## 配置加载优先级（`src/config.js:310-325`）

1. `$OPENCODE_SECRET_CONFIG` 环境变量指向的文件
2. 项目根 `./oh-my-opensecret.yaml`
3. 项目 `.opencode/oh-my-opensecret.yaml`
4. `~/.config/opencode/oh-my-opensecret.yaml`
5. 以上都不存在 → 自动生成默认配置到 `~/.config/opencode/oh-my-opensecret.yaml`

## 测试

```bash
npm test                        # 等价于 node --test
node --test test/engine.test.js # 单文件
node --test test/acceptance.test.js  # 最全面（Key 格式、内置规则、auto-discovery）
node --test test/session.test.js     # 含 setTimeout，较慢
```

- 测试目录 `test/` 含 7 个文件
- 使用临时目录 `.test-tmp/`（已 gitignored），`after` 钩子中递归删除
- `acceptance.test.js` — 最全面的验收测试
- `integration.test.js` — 完整 hook 生命周期
- `restore-sim.test.js` — sessionID 匹配/不匹配/空/null/多轮还原
- `session.test.js` — 含 TTL 测试（`setTimeout` 等待），运行较慢

## 关键机制

### 占位符格式

```
{PREFIX}_{CATEGORY}_{hash12}__   例: __OMOS_OPENAI_KEY_ab12cd34ef56__
```

- `hash12` = HMAC-SHA256(进程级共享 secret, 原文) 前 12 位 hex
- **V2 无 sessionID**：整个 server 进程共用一把随机 secret 与一张映射表，故同进程内同一原文 → 同一占位符（稳定可逆）
- 极低概率 hash 冲突时追加 `_N` 后缀

### 脱敏引擎重叠处理（`engine.js`）

1. 外层优先（大范围命中覆盖小范围）
2. 从右到左替换，避免 index 偏移
3. 已有占位符区间跳过（防止二次脱敏）
4. 排除列表（exclude）中的内容不脱敏

### 内置规则（`patterns.js:7-80`）

`email`, `china_phone`, `china_id`, `uuid`, `ipv4`, `ipv6`, `mac`, `jwt`, `db_connection`

规则定义支持两种正则语法（可叠加）：
- `/pattern/flags` 字面量语法
- `(?i)(?m)(?s)` 内联前缀

### Auto-discovery（`config.js`）

- 启动时扫描 `opencode.json`/`opencode.jsonc`
- 从 `apiKey`、`token`、`secret`、`password` 等敏感键名中提取值
- 已覆盖的值 → 以 `✅` 注释标记
- 未覆盖的值 → 自动生成正则规则追加到 `patterns.regex`，以 `# auto-generated` 注释标记来源
- 不覆盖已有 `placeholder-id` 的规则

### 日志系统（`logger.js`）

- 4 级日志：`debug < info < warn < error`
- 文件日志，支持大小/日期滚动
- 日志内容自动脱敏（`sk-*`, `ghp_*`, `AKIA*` 等替换为 `<redacted>`）

## 操作陷阱

- **V2 修改 hook 时必须 in-place 操作 `event` 对象**：`context` 改 `event.messages[].content`；`http.response` 改 `event.response`（重建 `Response`）；`execute.before` 改 `event.input`
- **进程级单例**：每个 location 各加载一份插件实例，但仅「最新注册者」经 `ProcessSingleton`（`src/singleton.js`）真正注册 hook，其余空转 —— 保证同一 server 进程只有一个本插件实现生效
- `config.js` 中 YAML 的 `placeholder-id` 在 JS 对象中可能是 `placeholderId`（`config.js:645` 同时检查两者）
- `deep.js` 使用 `WeakSet` 防循环引用（`restoreDeep` / `redactDeep` 各自独立）
- `logger.js` 中 `flush()` 方法重复定义（第 108 和 120 行），第二个覆盖第一个 — 调试时异步写入可能未完成
- `engine.js` 中 `redactText` 接受可选的 `placeholderPrefix` 参数用于跳过已脱敏值（V2 暂时未传入，因为全局共享密钥下无需跳过）
- 测试用临时目录在 `after` 钩子中递归删除，调试时可注释
- V2 不再按 sessionID 隔离；同进程内任一来源脱敏的值都可被还原（密钥不出本机）
- 本地单测直接导入 `src/index.js` 导出的 `redactEvent` / `restoreResponseText` / `restoreInput` 纯函数，无需 V2 运行时（`@opencode/plugin` 在测试环境缺省时退化为最小 define）
