# 插件设计参考

> 核对日期：2026-09-30
> 事实来源：`src/*.js` 实际代码 + `node_modules/@opencode/plugin@2.0.x` / `@opencode/ai` 类型定义
> 用途：oh-my-opensecret 的架构模式与设计决策速查

## 架构模块划分

```
index.js           # 目录型插件入口 shim（重导出 src/index.js）
src/
├── index.js       # 插件入口：Plugin.define + hook 注册 + 纯处理函数导出
├── singleton.js   # 进程级单例协调（globalThis 会合与夺权）
├── config.js      # 配置加载（级联查找 + YAML 解析 + fail-fast 校验 + auto-discovery 报告写回）
├── patterns.js    # 匹配规则构建（关键词/正则/内置/排除）+ BUILTIN 规则表
├── engine.js      # 脱敏引擎（重叠命中处理）
├── session.js     # 占位符管理器（HMAC 映射、TTL 淘汰、LRU、占位符正则）
├── restore.js     # 占位符还原（正则替换）
├── deep.js        # 深度遍历工具（递归脱敏/还原）
└── logger.js      # 分级日志系统（文件输出、大小/日期滚动）
```

## 核心设计模式

### 1. 占位符格式

```
{PREFIX}_{CATEGORY}_{hash12}__
{PREFIX}_{CATEGORY}_{hash12}_N__     (hash 极低概率冲突时)
例：__OMOS_EMAIL_ab12cd34ef56__
```

- `hash12` = `HMAC-SHA256(secret, 原文)` 的前 12 位十六进制小写
- `CATEGORY` 经 `sanitizeCategory()` 清洗为大写字母 / 数字 / 下划线，可含 `_`（如 `DB_CONNECTION`）
- **secret 与映射表按「整个 server 进程」共享**（一把随机密钥 + 一张双向表），密钥不出本机
- 同一进程内同一原文 → 同一占位符（稳定可逆）；对上游 provider 不可逆（无密钥无法反查）
- 还原正则在 `getPlaceholderRegex()`：类别段必须**非贪婪**匹配。贪婪会把相邻占位符合并成一个 token，导致还原查表落空、占位符原样透出

> 该「进程级共享」是保守设计。`SessionContext` 在类型层声明了 `readonly sessionID`，
> 但运行时是否一定填充**未实测**；若确认可用可重新评估按会话隔离。详见 `AGENTS.md` 与 `doc/02-plugin-api-reference.md`。

### 2. 配置查找优先级

`getConfigCandidates(directory)`：

1. `$OPENCODE_SECRET_CONFIG` 指定的文件 —— **显式指定时只认这一个路径**，不再回落下面几处
2. `<项目根>/oh-my-opensecret.yaml`
3. `<项目根>/.opencode/oh-my-opensecret.yaml`
4. `<全局配置目录>/oh-my-opensecret.yaml`

以上都不存在 → `generateDefaultYaml()` 生成默认配置并原子写回（`$OPENCODE_SECRET_CONFIG` 存在时写到该路径，否则写到全局配置目录）。

全局配置目录（`globalOpencodeConfigDir()`，与宿主一致）：`$OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`。

写文件统一走 `writeFileAtomic()`：先写 `*.tmp` 再 `rename`，避免并发进程抢文件与半截损坏。

### 3. 脱敏引擎策略（`src/engine.js`）

- **关键词匹配**：`indexOf` 线性扫描全部出现位置
- **正则匹配**：`matchAll` 全局扫描；flags 缺 `g` 时自动补 `g`
- **排除列表**：`exclude` 分精确集合与 glob（`*` → `[^\r\n]+`、`?` → `[^\r\n]`，其余字面转义）两类，命中即跳过
- **重叠处理**：命中先按 `start ASC, end DESC` 排序（外层优先）→ `subtractCovered()` 切出不重叠区间 → `insertCovered()` 合并 covered 区间 → 再按 `start DESC` **从右到左替换**，避免索引偏移
- **幂等**：`redactText()` 第 4 参 `placeholderPrefix` 传入时可预扫描已有占位符区间并跳过（`collectPlaceholderRanges` / `isPlaceholderLike`）。当前调用方未传该参数，因此不启用
- **自举**：无配置时自动生成默认配置
- **安全关闭**：`enabled: false` → `setup` 直接返回，**不注册任何 hook**，插件为 no-op

### 4. 生命周期 Hook

只注册两个：

| 注册点 | 事件 | 时机 | 作用 | 改写方式 |
|--------|------|------|------|---------|
| `ctx.session.hook("context", cb)` | `SessionContext` | LLM 请求发出前 | 脱敏 `system` 与 `messages[].content` | **in-place** 改字段 |
| `ctx.tool.hook("execute.before", cb)` | `{ tool, sessionID, agent, messageID, id, input }` | 工具执行前 | 还原 `input` 中的占位符 | **整体替换 `event.input` 引用** |

两者进入时都先 `session.cleanup()` 淘汰过期映射。

> `execute.before` 事件中 `input` 的**值**已被宿主 `Object.freeze`（运行时行为，非类型声明），
> 原地改会抛 `Attempted to assign to readonly property`；hook 回调返回值不被消费，
> `return { input }` 无效，唯一可行写法是 `event.input = restoreInput(event.input, session)`。

**不注册响应侧 hook**（`SessionHooks` 中的 `http.response` 等一律不注册），因此脱敏是**单向**的：模型回复里复述的占位符在界面上仍显示占位符形态。占位符 ↔ 原文的还原只发生在工具入参方向。

### 5. 占位符管理器（`src/session.js`）

- 双向映射：`forward`（占位符 → 原文）、`reverse`（原文 → 占位符），一一对应
- `created` 记录最近一次命中/创建时间（`lookup` / `lookupReverse` 命中即刷新），因此「时间戳最小」= 最久未使用
- TTL 过期淘汰（默认 `1h`）
- `max_mappings` 容量上限，超限时 `evictLeastRecentlyUsed()` 淘汰最久未使用的一条
- hash 极低概率冲突时追加 `_N` 后缀（`_2`、`_3`…）
- 双向映射不一致时**直接抛错**，不做静默修复

### 6. 深度遍历工具（`src/deep.js`）

两个函数语义不同，**不能混用**：

| 函数 | 是否原地 | 防环结构 | 用途 |
|------|---------|---------|------|
| `restoreDeep()` | ❌ **返回重建的新树**，不修改入参 | `WeakMap<原对象, 新副本>`（同时保留共享结构） | 还原工具入参（宿主冻结了原值） |
| `redactDeep()` | ✅ 原地修改 | `WeakSet` | 脱敏 `tool-call.input`、`tool-result.result.value` |

- 都只遍历 `Array` / `PlainObject`（`isPlainObject()`：`proto === Object.prototype || proto === null`）
- `Date`、类实例等非 PlainObject 类型**原样返回同一引用**，不重建、不脱敏
- 非对象值（string / number / null / undefined）原样返回

### 7. 配置校验：fail-fast

`loadConfig()` 流程 = 查找/生成 → `validateSchema()` → `normalizeConfig()` → auto-discovery。

- **默认值只用于「字段缺失」；「字段非法」一律抛错中止加载**，不 warn 后套默认值
- 一次收集全部错误后合并抛出（`配置校验失败 (<path>): - ...`），便于一次改完
- 覆盖范围：类型检查（boolean / object / array / string / 正整数 / 正数）、`session.ttl` 时长格式（`ms/s/m/h/d`）、`logging.level` 白名单（`debug|info|warn|error`）、正则可编译性（`regexCompileError()` 实编译一次）
- 唯一「捕获后只记日志」的是 auto-discovery 阶段的 I/O / 写回失败（`log.error`）——因为那意味着新发现的密钥会以明文进 LLM，必须显式暴露
- `logger.js` 内部级别表另有 `off`，但配置文件校验白名单不含它，写 `off` 会被判非法

### 8. 进程级单例（`src/singleton.js`）

- 动机：OpenCode 2.x server 进程里**每个 location 各加载一份插件实例**。N 份实例各自注册同一批 hook，会多出 N 次遍历与 N 张互不相通的映射表
- 会合点用 `globalThis.__ohMyOpenSecretRuntime__`（`{ slots, owner }`）：
  - 模块级变量不行 —— 同一 entrypoint 在同进程内被求值为 N 份独立模块实例，模块级状态互不共享
  - `ctx.storage` 不行 —— per-location 隔离（落盘按 location 分目录）
- 选举规则：**最新注册者直接夺权**，并显式让旧 owner `deactivate()`（停 hook + 清空映射表）。不押注「宿主每次都调 cleanup」——只加载新实例而不卸载旧实例时，旧 owner 会一直占着 owner
- 让位后的实例 handler 内有 `if (!session) return` 守卫，映射表清空后直接空转
- `release()`（teardown）：退位后把 owner 交给当前最新注册且仍存活的实例
- JS 单线程 ⇒ 注册 / 夺权 / 让位都在同一同步块完成，无竞态

## 自动发现机制

- 开关：`enabled` 与 `auto_discovery` 同时为真（配置键 `auto_discovery`）
- 扫描 Opencode 自身配置：`opencode.json` / `opencode.jsonc`，路径为项目根、`.opencode/`、全局配置目录
  - `JSON.parse` 失败则走 JSONC 分支：先把字符串字面量替换成占位标记，再剥注释，最后还原 —— 避免注释里的 `//` 破坏字符串
  - 文件读得出但解析不了**直接抛错**，不静默跳过（静默跳过 = 漏扫密钥 = 明文进 LLM）
- 敏感键名（`SENSITIVE_KEYS`，key 做 `toLowerCase()` 比对）：`apiKey` / `token` / `secret` / `password` / `authorization` / `bearer` / `credentials` / `dsn` / `privateKey` / `clientSecret` / `appSecret` 等
- 收集条件：值是字符串、长度 ≥ 8、且不是占位符形态（`isPlaceholder()`）
- 数组式 provider 配置（`{"providers":[{"apiKey":"sk-..."}]}`）同样递归扫描
- 覆盖判定：与 `expandPatternsWithMeta()` 展开的**全部**有效规则（自定义 + 内置）逐条 `test`；展开复用 `patterns.compileRegexRules()`，与运行时脱敏共用同一套解析
- 未覆盖时：
  - `derivePlaceholderId(path)` 派生分类名（`providers.myminimaxi.apiKey` → `MYMINIMAXI_KEY`）
  - `generatePattern(value)` 生成正则：只取「首个非字母数字字符及其之前」作固定前缀（`sk-xxx` → `sk-`），其余用 `[A-Za-z0-9_-]{N}` + 负向断言，**不暴露完整原文**
  - `pattern` 用 `JSON.stringify` 转义（YAML 双引号标量兼容 JSON 转义，前缀含 `"` 或 `\` 时手写引号会产出非法 YAML）
  - 已有同 `placeholder-id` 则跳过，不覆盖用户配置
- **报告块按行定位写回**（`writeDiscoveryReport()`）：
  - 新规则：以 `^\s*regex:` 所在行 + 缩进推断插入点；空列表 `regex: []` 展开为多行
  - 报告块：`REPORT_HEADER_RE` 定位首行，`# 概要: ` 行为插入锚点，逐行 `findIndex` + `splice`；**不用分隔线字符串做锚点**（文件头的分隔线更长且包含该子串，`String.replace` 只会替换首处，会把报告插进文件头并逐轮上移）
  - 已有 path 的条目不重复插入，统计行就地重算
  - **报告里不含任何原文片段**：只写配置路径、覆盖状态、字符长度
  - 报告块损坏（缺「概要」行）或配置缺 `patterns:` 时抛错

## 内置规则（`src/patterns.js` 的 `BUILTIN`）

9 条，全部是通用 PII，**不含任何平台 API Key**：

`email`、`china_phone`、`china_id`、`uuid`、`ipv4`、`ipv6`、`mac`、`jwt`、`db_connection`

- `patterns.builtin` 按名称引用；`patterns.regex` 是自定义规则
- `ipv6` 只匹配全写 8 组形式 `(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}`，压缩写法（`2001:db8::1`）不匹配
- `db_connection` 要求 `://user:pass@` 形态（mysql / postgres / mongodb / redis）
- API Key 一律要在 `patterns.regex` 里自行添加

## 日志系统（`src/logger.js`）

- 内部级别表 `debug(0) < info(1) < warn(2) < error(3) < off(4)`；**配置文件 `logging.level` 的校验白名单只有前 4 个**
- 纯文件输出；滚动触发 = 文件大小超 `maxSize` **或** 日期变更
- 历史文件名 `<base>.<YYYY-MM-DD>.<seq><ext>`，超出 `maxFiles` 删最旧
- **`Logger#applyConfig()` 是 `level` / `filePath` / `maxSize` / `maxFiles` 的唯一写入入口**：级别名→数值、`~`→`$HOME`、大小字符串→字节数（`b/k/m/g`）全在 logger 内归一化。直接给字段赋值会把原始字符串塞进去，导致级别过滤与按大小滚动静默失效
- 写盘前再过一遍脱敏（`sk-*`、`gh[pousr]_*`、`github_pat_*`、`AKIA*`、长 base64 → `<redacted>`）
- logger 自身的故障（滚动重命名 / 历史删除失败）写 stderr（`_reportFault`），避免递归写日志

## 合理性原则

| 原则 | 说明 |
|------|------|
| 脱敏→传输→工具还原 闭环 | Provider 永远看不到明文，本地工具拿到真实值 |
| 脱敏单向 | 不注册响应侧 hook；占位符在回复侧保持占位符形态 |
| 配置自举 | 无配置时自动生成默认配置，开箱即用 |
| 非法配置中止 | 字段非法直接抛错，不静默套默认值；只有 auto-discovery 的 I/O 失败才降级为 error 日志 |
| `enabled: false` 安全降级 | 明确关闭时不注册任何 hook，插件成为 no-op |
| 环境变量单通道 | `$OPENCODE_SECRET_CONFIG` 显式指定时独占该路径，便于 CI 中完全控制配置来源 |
| 进程级会合 + 最新者上位 | 一个 server 进程只有一份插件实现在生效，且不依赖宿主一定调用 cleanup |
| 报告不含原文 | 配置文件通常会被提交 git，写回内容只含路径 / 覆盖状态 / 长度 |
