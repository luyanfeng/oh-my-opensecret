# oh-my-opensecret — AGENTS.md

OpenCode 隐私脱敏插件。LLM 请求发送前脱敏敏感信息，工具执行前还原工具参数；响应方向不还原（不注册任何响应侧 hook）。

## 项目概要

- **入口**: 包根 `index.js`（目录型插件 shim，重导出 `src/index.js`）；真实实现 `src/index.js` —— V2 `Plugin.define({ id, setup(ctx) })`，注册 hook 并导出纯处理函数
- **类型**: ESM (`"type": "module"`)
- **依赖**: `js-yaml`（配置解析）。`@opencode/plugin` 声明在 `devDependencies`（由 opencode server 运行时提供；`src/index.js` 用 `await import()` 动态引入，缺省时退化为最小 define，保证模块可被独立单测导入）
- **测试**: `node:test`（Node 内置），无第三方测试库
- **出口文件**: `package.json` `"files"` = `index.js`、`src`、`oh-my-opensecret.yaml.example`

## 架构

```
index.js           # 目录型插件入口 shim（重导出 src/index.js，host 在包根找 index 入口）
src/
├── index.js      # 插件入口（V2 Plugin.define + hook 注册 + 纯处理函数导出）
├── singleton.js  # 进程级单例协调（globalThis 夺权，保证一个 server 进程只有一个实例注册 hook）
├── config.js     # 配置加载（级联查找 + YAML 解析 + fail-fast 校验 + auto-discovery 报告写回）
├── patterns.js   # 匹配规则构建（关键词/正则/内置/排除）+ BUILTIN 规则表
├── engine.js     # 脱敏引擎（重叠命中处理）
├── session.js    # 占位符管理器（HMAC 映射、TTL 淘汰、LRU、占位符正则）
├── restore.js    # 占位符还原（正则替换）
├── deep.js       # 深度遍历工具（递归脱敏/还原对象树）
└── logger.js     # 分级日志系统（文件输出、大小/日期滚动）
```

## Hook 注册（`src/index.js`）

V2 机制：`Plugin.define({ id, setup(ctx) })`，`setup` 内通过 `ctx.session.hook(name, cb)` / `ctx.tool.hook(name, cb)` 注册 hook，返回 cleanup 函数。插件**只注册这两个** hook：

| hook | handler 工厂 | 事件载荷（官方类型） | 作用 |
|------|--------------|---------------------|------|
| `ctx.session.hook("context", cb)` | `makeContextHandler()` | `SessionContext`：`system` / `messages` / `options` | LLM 请求发出前脱敏，**in-place** 改写 `event.messages[].content` 与 `event.system` |
| `ctx.tool.hook("execute.before", cb)` | `makeToolHandler()` | `{ tool, sessionID, agent, messageID, id, input }` | 工具执行前还原参数，**整体替换** `event.input` 引用 |

- 回调签名是 `(input: Event) => Promise<void> | void`，**返回值不被消费**（类型见 `registration.d.ts` 的 `Hooks<Spec>`）。只能改事件对象本身。
- `enabled === false` 时 `setup` 直接 `return`，**不注册任何 hook**，也不占用单例槽位。
- 两个 handler 进入时都先 `session.cleanup()`，淘汰过期映射。

字段名、hook 完整清单、Message part 判别值、`ToolResultPart.result` 形态见 `doc/02-plugin-api-reference.md`。

### 进程级共享占位符（设计选择）

一个 active 实例持有**一把 HMAC 密钥 + 一张占位符映射表**，覆盖整个 server 进程；同进程内同一原文恒定映射到同一占位符，密钥不出本机。

> ⚠️ **未实测项**：本设计当初的理由是「context hook 事件不带 `sessionID`」，但这一点**没有实测验证**，而官方类型 `SessionContext extends SessionRequest` 声明了 `readonly sessionID: Session.ID` —— **类型层存在 ≠ 运行时一定填充**。
> 结论本身（进程级共享）无论如何都是安全且保守的选择，因此保持不变。若后续实测确认运行时可用 `sessionID`，可重新评估是否需要按会话隔离。不要因为类型定义就断定运行时行为。

## 配置加载（`src/config.js`）

`getConfigCandidates(directory)` 的候选顺序：

1. `$OPENCODE_SECRET_CONFIG` 指定的文件 —— **显式指定时只认这一个路径**，不再回落项目根/全局
2. `<项目根>/oh-my-opensecret.yaml`
3. `<项目根>/.opencode/oh-my-opensecret.yaml`
4. `<全局配置目录>/oh-my-opensecret.yaml`

以上都不存在 → `generateDefaultYaml()` 自动生成默认配置：`$OPENCODE_SECRET_CONFIG` 存在时生成到该路径，否则生成到全局配置目录。

全局配置目录（`globalOpencodeConfigDir()`，与宿主一致）：`$OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`。

项目根目录取自 `ctx.location.directory`（缺失时 `process.cwd()`）。

## 测试

```bash
npm test                              # 等价于 node --test
node --test test/engine.test.js       # 单文件
node --test test/acceptance.test.js   # 最全面（Key 格式、内置规则、auto-discovery）
node --test test/session.test.js      # 含 setTimeout 等待，较慢
```

- 测试目录 `test/` 含 7 个文件
- 使用临时目录 `.test-tmp/`（已 gitignored），`after` 钩子中递归删除
- `acceptance.test.js` — 最全面的验收测试
- `config.test.js` — 配置查找/生成/校验
- `integration.test.js` — 插件入口与 hook 生命周期的等价流程
- `restore-sim.test.js` — 脱敏→还原闭环、无占位符原样、多次脱敏占位符稳定、TTL 过期后无法还原
- `deep.test.js` — `restoreDeep` 不改入参、`redactDeep` 原地改
- `engine.test.js` — `redactText` 重叠命中处理
- `session.test.js` — `PlaceholderSession` 映射/淘汰主路径

## 关键机制

### 占位符格式

```
{PREFIX}_{CATEGORY}_{hash12}__   例: __OMOS_EMAIL_ab12cd34ef56__
{PREFIX}_{CATEGORY}_{hash12}_N__ (hash 冲突时)
```

- `hash12` = HMAC-SHA256(进程级共享 secret, 原文) 前 12 位 hex
- CATEGORY 经 `sanitizeCategory()` 清洗为大写字母/数字/下划线，可含 `_`（如 `DB_CONNECTION`）
- 同一进程内同一原文 → 同一占位符（稳定可逆）
- 极低概率 hash 冲突时追加 `_N` 后缀
- 还原正则在 `getPlaceholderRegex()`：类别段**非贪婪**匹配，否则相邻占位符会被贪心合并成一个 token

### 配置校验：fail-fast

`loadConfig()` 流程 = 查找/生成 → `validateSchema()` → `normalizeConfig()` → auto-discovery。

- **默认值只用于「字段缺失」；「字段非法」一律抛错中止加载**，不做 warn + 套默认值。
- 非法即报错的情形：YAML 语法错；顶层不是映射；`enabled` / `auto_discovery` 非布尔；`logging` 非对象；`logging.level` 不在 `debug|info|warn|error`；`logging.file` 非字符串；`logging.rotation` 非对象；`rotation.max_size` 非字符串/数字；`rotation.max_files` 非正整数；`placeholder_prefix` 非非空字符串；`session` 非对象；`session.ttl` 非字符串或时长格式非法；`session.max_mappings` 非正数；`patterns.{keywords,regex,builtin,exclude}` 非数组；正则规则无法编译。
- 一次收集全部错误后合并抛出（`配置校验失败 (<path>): - ...`）。
- 唯一「捕获后只记日志」的是 auto-discovery 阶段的 I/O/写回失败（`log.error`），配置非法则是直接中止。

> 注意：`logger.js` 的级别表含 `off`，但配置文件的 `logging.level` 校验白名单只有 `debug|info|warn|error` —— 写 `off` 会被判为非法并中止加载。

### 自定义 regex 的 flags 会被保留

`parsePatternFlags()` 同时支持两种语法，可叠加：

- `/pattern/flags` 字面量语法（`/[a-z]+/i`）
- `(?i)(?m)(?s)` 内联前缀

匹配阶段强制补 `g`（`redactText` 内部 `flags.includes("g") ? flags : "g" + flags`）。auto-discovery 的覆盖判定与运行时脱敏共用 `compileRegexRules()`，避免两侧解析结果不一致。

### 脱敏引擎重叠处理（`engine.js`）

1. 外层优先（`start ASC, end DESC` 排序，大范围命中覆盖小范围）
2. `subtractCovered` 分割出不重叠区间 → `insertCovered` 合并 covered
3. 从右到左替换，避免 index 偏移
4. exclude（精确 / glob）命中的原文跳过
5. `redactText` 的第 4 个参数 `placeholderPrefix` 用于跳过已脱敏值；**当前调用方未传**，因此实际不启用该跳步

### 内置规则（`src/patterns.js` 的 `BUILTIN`）

`email`、`china_phone`、`china_id`、`uuid`、`ipv4`、`ipv6`、`mac`、`jwt`、`db_connection` —— 共 9 条，**全部是通用 PII，不含任何平台 API Key**。API Key 需自行写进 `patterns.regex`。

`ipv6` 只匹配全写 8 组形式（`(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}`），压缩写法（`2001:db8::1`）不匹配。

### Auto-discovery（`config.js`）

- 仅在 `enabled` 与 `auto_discovery` 同时为真时执行
- 扫描 `opencode.json` / `opencode.jsonc`（项目根、`.opencode/`、全局配置目录）；文件读得出但解析失败直接抛错，不静默跳过
- 敏感键名见 `SENSITIVE_KEYS`（`apiKey`/`token`/`secret`/`password`/`authorization`/`dsn` 等，key 做 `toLowerCase()` 比对），值长度 ≥ 8 且不是占位符形态才收集
- 已覆盖的值 → 报告标 `✅`；未覆盖 → `derivePlaceholderId()` 派生 id、`generatePattern()` 生成正则（只取前缀 + 长度量词），追加到 `patterns.regex` 末尾
- **报告与规则不含任何原文片段**：只写配置路径、覆盖状态、字符长度
- **按行定位写回**（`writeDiscoveryReport()`）：新规则按 `^\s*regex:` 所在行 + 缩进推断插入点；报告块以 `REPORT_HEADER_RE` 为首行锚点、`# 概要: ` 行为插入锚点，逐行 `findIndex`/`splice`，**连续运行不重复插入、不破坏文件头**
- 已存在同 `placeholder-id` 的规则跳过，不覆盖用户配置
- 报告块被破坏（缺「概要」行）或配置缺 `patterns:` 时抛错

### 日志系统（`logger.js`）

- 5 级内部级别表：`debug < info < warn < error < off`（配置文件 `logging.level` 只接受前 4 个）
- 纯文件输出，支持大小 + 日期滚动，超出 `maxFiles` 删最旧
- **`Logger#applyConfig()` 是 `level`/`filePath`/`maxSize`/`maxFiles` 的唯一写入入口**：级别名→数值、`~`→`$HOME`、大小字符串→字节数全在 logger 内归一化。直接给字段赋值会让级别过滤与按大小滚动静默失效
- 写日志的内容再过一遍脱敏（`sk-*`、`gh[pousr]_*`、`github_pat_*`、`AKIA*`、长 base64 → `<redacted>`）
- logger 自身故障（重命名/删除失败）写 stderr（`_reportFault`），避免递归

## 操作陷阱

- **`context` hook 可原地改 `event.messages[].content`；`execute.before` 的 `event.input` 的「值」已被宿主 `Object.freeze`**，只能整体替换引用、不能原地改嵌套字段 —— 原地赋值会抛 `Attempted to assign to readonly property`，导致工具调用失败。`event` 对象本身可写。hook 回调返回值不被消费，`return { input }` 无效；正确写法是 `event.input = restoreInput(event.input, session)`（与宿主自带插件 `opencode.tool.input.repair` 同构）
- **进程级单例**：每个 location 各加载一份插件实例，但仅「最新注册者」经 `ProcessSingleton`（`src/singleton.js`）真正注册 hook，其余空转 —— 保证同一 server 进程只有一个本插件实现生效。`ProcessSingleton` 用 `globalThis.__ohMyOpenSecretRuntime__` 会合（模块级变量在各 location 的独立模块实例间不共享，`ctx.storage` 又是 per-location 隔离的，都不能当会合点）；新实例直接夺权并让旧 owner 显式 `deactivate`，`release()` 时 owner 交给当前最新仍存活的实例
- `patterns.regex` 的分类名：YAML 写 `placeholder-id`、JS 写 `placeholderId`，`compileRegexRules()` 两者都读；**`patterns.keywords` 只读 `placeholderId`**（YAML 里写 `placeholder-id` 会被忽略，分类回落到 `TEXT`）
- `deep.js`：`restoreDeep` 返回重建的**新树**、不修改入参，用 `WeakMap<原对象,新副本>` 防循环引用；`redactDeep` 原地修改，用 `WeakSet`。两者都只遍历 Array / PlainObject
- `engine.js` 头部的 `parsePatternFlags` 附近无占位符前缀参数时，`isPlaceholderLike` 分支不会执行（依赖第 4 参）
- 测试用临时目录在 `after` 钩子中递归删除，调试时可注释
- 本地单测直接导入 `src/index.js` 导出的 `redactEvent` / `restoreResponseText` / `restoreInput` 纯函数，无需 V2 运行时（`@opencode/plugin` 缺省时退化为最小 define）
- 包根 `index.js` 不可删：`host.js` 对目录型插件走 `path.resolve(target.directory, subpath || "index")`，没有根 `index.*` 会被判定为「找不到插件」
