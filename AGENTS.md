# oh-my-opensecret — AGENTS.md

OpenCode 隐私脱敏插件。在 LLM 请求发送前脱敏敏感信息，响应完成后自动还原，工具执行前还原参数。

## 项目概要

- **入口**: `src/index.js` — 默认导出 `OpenSecret(ctx)` 函数，返回 hook 对象
- **类型**: ESM (`"type": "module"` in package.json)
- **依赖**: 仅 `js-yaml`（用于配置解析）
- **测试**: `node:test`（Node 内置测试框架），无第三方测试库
- **出口文件**: `package.json` 的 `"files"` 包含 `src/` 和 `oh-my-opensecret.yaml.example`

## 架构速览

```
src/
├── index.js      # 插件入口，注册 3 个 hook
├── config.js     # 配置加载（级联查找 + YAML + auto-discovery）
├── patterns.js   # 匹配规则构建（关键词/正则/内置/排除）+ BUILTIN 规则表
├── engine.js     # 脱敏引擎（重叠命中处理）
├── session.js    # 会话占位符管理器（HMAC 映射、TTL 淘汰、LRU）
├── restore.js    # 占位符还原（字符串正则替换）
├── deep.js       # 深度遍历工具（递归脱敏/还原对象树）
└── logger.js     # 分级日志系统（文件输出、大小/日期滚动）
```

## Hook 注册

插件注册 3 个 OpenCode hook（见 `src/index.js:88-224`）：

| Hook | 作用 | 注意事项 |
|------|------|----------|
| `experimental.chat.messages.transform` | LLM 请求前脱敏 | **必须 in-place 修改 `output.messages`**，不可重新赋值 |
| `experimental.text.complete` | 响应完成后还原 | 修改 `output.text` |
| `tool.execute.before` | 工具执行前还原参数 | 修改 `output.args`（深度遍历） |

## 关键工作流

### 配置加载优先级（`src/config.js:310-325`）

1. `$OPENCODE_SECRET_CONFIG` 环境变量指向的文件
2. 项目根 `./oh-my-opensecret.yaml`
3. 项目 `.opencode/oh-my-opensecret.yaml`
4. `~/.config/opencode/oh-my-opensecret.yaml`
5. 以上都不存在 → 自动生成默认配置到 `~/.config/opencode/oh-my-opensecret.yaml`

### 测试

```bash
# 运行全部测试
npm test    # 等价于 node --test

# 运行单个测试文件
node --test test/engine.test.js

# 运行验收测试（慢，涉及文件 I/O 和 hook 集成）
node --test test/acceptance.test.js
```

- 测试目录 `test/` 含 6 个文件
- 测试使用临时目录 `.test-tmp/`（已 gitignored）
- `acceptance.test.js` 是最全面的测试（涵盖各平台 Key 格式、内置规则、auto-discovery、双向验证）
- `integration.test.js` 测试完整 hook 生命周期（加载→脱敏→还原→工具参数还原）
- `session.test.js` 含 TTL 测试（`setTimeout` 等待），运行较慢

### Auto-discovery 机制

`config.js` 中的 `autoDiscovery` 功能：
- 启动时扫描 `opencode.json`/`opencode.jsonc`
- 从 `apiKey`、`token`、`secret`、`password` 等敏感键名中提取值
- 已覆盖的值 → 以 `✅` 注释标记
- 未覆盖的值 → 自动生成正则规则追加到 `patterns.regex`，以 `# auto-generated` 注释标记来源
- 不覆盖已有 `placeholder-id` 的规则

### 占位符格式

```
{PREFIX}_{CATEGORY}_{hash12}__
# 例: __OMOS_OPENAI_KEY_ab12cd34ef56__
```

- `hash12` = HMAC-SHA256(会话随机 secret, 原文) 前 12 位 hex
- 同一 session 内同一原文 → 同一占位符（稳定可逆）
- 不同 session 使用不同随机 secret，占位符不同
- 极低概率 hash 冲突时追加 `_N` 后缀

### 脱敏引擎重叠处理策略（`engine.js`）

1. 外层优先（大范围命中覆盖小范围）
2. 从右到左替换，避免 index 偏移
3. 已有占位符区间跳过（防止二次脱敏）
4. 排除列表（exclude）中的内容不脱敏

### 内置规则（`patterns.js:7-80`）

`email`, `china_phone`, `china_id`, `uuid`, `ipv4`, `ipv6`, `mac`, `jwt`, `db_connection`

规则定义支持两种正则语法（可叠加）：
- `/pattern/flags` 字面量语法
- `(?i)(?m)(?s)` 内联前缀

### 日志系统（`logger.js`）

- 4 级日志：`debug < info < warn < error`
- 文件日志，支持大小/日期滚动
- 日志内容自动脱敏（`sk-*`, `ghp_*`, `AKIA*` 等替换为 `<redacted>`）

## 常见操作陷阱

- 修改 hook 时必须 **in-place 操作** `output` 对象，不能重新赋值
- 测试用临时目录在 `after` 钩子中递归删除，调试时可注释
- 配置加载使用 `js-yaml` 解析，YAML 中 `placeholder-id` 在 JS 对象中可能是 `placeholderId`（`config.js:644` 同时检查两者）
- `logger.js` 中有 `flush()` 方法重复定义（第 108 和 120 行），第二个覆盖第一个 — 注意调试时异步写入可能未完成
- `session.js` 使用 `WeakSet` 防循环引用（`deep.js`）
- `engine.js` 中 `redactText` 接受可选的 `placeholderPrefix` 参数用于跳过已脱敏值 — 只在 `messages.transform` hook 中传入
