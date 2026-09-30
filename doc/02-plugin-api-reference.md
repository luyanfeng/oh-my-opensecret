# OpenCode 插件 API 参考（V2）

> 权威来源：已安装的 `node_modules/@opencode/plugin@2.0.x` / `node_modules/@opencode/ai` 类型定义
> 关键文件：`dist/promise/plugin.d.ts`、`dist/promise/session.d.ts`、`dist/promise/tool.d.ts`、
> `dist/promise/registration.d.ts`、`dist/host.js`、`@opencode/ai/dist/schema/messages.d.ts`
> 核对日期：2026-09-30

本文只收录 oh-my-opensecret 实际用到或容易踩坑的部分，字段名逐条对照上述 `.d.ts`。

## 1. 包名与入口形态

包名是 **`@opencode/plugin`**（不是 `@opencode-ai/plugin`），入口是 `Plugin.define`：

```ts
// node_modules/@opencode/plugin/dist/promise/plugin.d.ts
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export type Cleanup = () => Promise<void> | void
export declare function define(plugin: Plugin): Plugin
```

```js
// oh-my-opensecret/src/index.js
export default Plugin.define({
  id: "oh-my-opensecret",
  async setup(ctx) {
    // ... 注册 hook ...
    return () => { /* cleanup */ }   // 可选
  },
})
```

`@opencode/plugin` 的具名导出 `Plugin` 是一个只含 `define` 的命名空间对象（运行时验证：`Object.keys(Plugin) === ["define"]`）。

## 2. 目录型插件必须有根 `index.js`

`dist/host.js` 解析插件入口：

```js
// node_modules/@opencode/plugin/dist/host.js
const specifier = target.name
  ? [target.name, subpath].filter(Boolean).join("/")
  : path.resolve(target.directory, subpath || "index")
// ...
return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }
```

以 `file://` 目录形式加载时（`target.name` 为空），server 入口走 `entry(["server", ""])` → `""` 为 falsy → 落到 **`path.resolve(directory, "index")`**。所以包根必须有 `index.js`/`index.mjs` 等，插件才会被识别。

oh-my-opensecret 的包根 `index.js` 因此是一个 re-export shim：

```js
export { default } from "./src/index.js"
export * from "./src/index.js"
```

## 3. `Context`（`setup` 的入参）

`dist/promise/plugin.d.ts` 的 `Context` 接口，oh-my-opensecret 用到的字段：

| 字段 | 类型 | 用途 |
|------|------|------|
| `location` | `Location.Info` | 取 `.directory` 作为项目根；缺失时回退 `process.cwd()` |
| `session` | `SessionDomain` | `session.hook(name, cb, options?)` |
| `tool` | `ToolDomain` | `tool.hook(name, cb)` |
| `app` | `App` | `{ name, version, channel }` |
| `options` | `PluginOptions` | 插件配置 |
| `storage` | `StorageDomain` | **per-location 隔离**（落盘按 location 分目录），不能当进程级会合点 |

其余域：`agent` / `aisdk` / `command` / `event` / `experimental.terminal` / `integration` / `mcp` /
`model` / `generate` / `permission` / `plugin` / `provider` / `reference` / `rpc` / `shell` /
`skill` / `vcs` / `websearch` / `worktree`。

## 4. hook 注册签名与返回值

```ts
// dist/promise/registration.d.ts
export interface Registration {
  readonly dispose: () => Promise<void>
}
export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void
) => Promise<Registration>
export type ModelHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never
) => Promise<Registration>
// ModelHookOptions = { readonly providerID?: string }   // 仅带 model 字段的 hook 可传
```

关键点：

- `hook()` 本身是 **async**，返回 `Promise<Registration>`。要拿 `dispose` 必须 `await`。
- 回调返回值是 `Promise<void> | void`，**宿主不消费返回值**。想改数据只能改事件对象本身。
- `ctx.session.hook` 是 `ModelHooks`，**第三个参数只在事件带 `model` 字段时才允许**（传错会类型报错）。

## 5. `ctx.session.hook` —— 全部可用事件

`SessionHooks`（`dist/promise/session.d.ts`）：

| 事件名 | 事件类型 | 载荷要点 |
|--------|---------|---------|
| `prompt` | `SessionPrompt` | `sessionID` / `messageID` / `prompt` / `metadata` / `delivery` |
| **`context`** | **`SessionContext`** | **本插件使用**：见下 |
| `compaction` | `SessionCompaction` | `SessionContext` + `result?: SessionCompactionResult`（设置则跳过模型请求） |
| `generate` | `SessionGenerate` | 等同 `SessionContext` |
| `title` | `SessionTitle` | `SessionRequest` + `result?: string`（设置则跳过模型请求） |
| `model.request` | `SessionModelRequest` | `sessionID` / `agent` / `model` / `kind` / `baseURL?` / `headers` |
| `http.request` | `SessionHttpRequest` | `... + request: Request` |
| `http.response` | `SessionHttpResponse` | `... + response: Response` |
| `experimental.ws.handshake` | `SessionWebSocketHandshake` | `url` / `headers` |
| `experimental.ws.send` | `SessionWebSocketSend` | `frame: string`（替换后原样发出） |
| `experimental.ws.receive` | `SessionWebSocketReceive` | `frame: string` |
| `retry` | `SessionRetry` | `error` / `attempt` / `decision: { retry: false } \| { retry: true, delay: number }` |

`SessionRequestKind = "primary" | "compaction" | "title" | "generate"`。

### `SessionContext` 事件结构（本插件的脱敏入口）

```ts
export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  system: Array<SystemPart>          // 可写
  messages: Array<Message>           // 可写
  options: SessionRequestOptions     // 可写
}
export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}
```

- `system` / `messages` / `options` 可写，插件 **in-place** 改写 `messages[].content` 与 `system`。
- `SystemPart` 只有一种形态：`{ type: "text", text: string, cache?, metadata? }`。

> ⚠️ **未实测项**：`SessionContext` 在**类型层**声明了 `readonly sessionID: Session.ID`（继承自 `SessionRequest`），
> 但「运行时是否一定填充」没有实测验证过。**类型层存在 ≠ 运行时一定存在**，不要据此下结论。
> oh-my-opensecret 当前不依赖 `event.sessionID`，采用进程级共享一把密钥 + 一张映射表的保守设计。
> 若后续实测确认运行时可用，可重新评估是否需要按会话隔离。

## 6. `ctx.tool.hook` —— 全部可用事件

`ToolHooks`（`dist/promise/tool.d.ts`）：

```ts
interface ToolHooks {
  readonly "execute.before": {
    tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID        // ← 字段名是 id，不是 callID
    input: unknown                  // ← 唯一可写字段
  }
  readonly "execute.after": { /* 同上 */ } & (
    { readonly status: "completed"; result: Tool.Result } |
    { readonly status: "error";     error: Tool.Error }
  )
}
```

⚠️ V2 的调用标识字段是 **`id`**（`Tool.CallID` 是 `Schema.brand<Schema.String, "Tool.CallID">`），不是 `callID`；参数容器叫 **`input`**，不是 `args`；没有单独的 `output` 容器。

`ToolDomain` 其余成员：`transform`、`reload()`、`list()`，以及 `hook`。

> **运行时行为（实测，非类型声明）**：`execute.before` 事件中 `input` 的**值**已被宿主 `Object.freeze`，
> 原地改嵌套字段会抛 `Attempted to assign to readonly property`；`event` 对象本身可写。
> 由于回调返回值不被消费，唯一可行写法是**整体替换引用**：
> `event.input = restoreInput(event.input, session)`（与宿主自带插件 `opencode.tool.input.repair` 同构）。

## 7. Message part —— 判别联合

`Message.content` 的元素类型是 `ContentPart`（`@opencode/ai/dist/schema/messages.d.ts`），按 `type` 判别，共 **7** 种：

| `type` | 关键字段 | 本插件处理 |
|--------|---------|-----------|
| `text` | `text: string` | ✅ 脱敏 |
| `media` | `media`（bytes / base64 / url / ref）、`filename?` | ❌ |
| `tool-call` | `id: string`、`name: string`、`namespace?`、`input: unknown`、`providerExecuted?` | ✅ 对 `input` 做 `redactDeep` |
| `tool-result` | `id: string`、`name: string`、`result` | ✅ 见下 |
| `reasoning` | `text: string`、`encrypted?` | ✅ 脱敏 |
| `compaction` | `provider`、`id?`、`text?: string \| null`、`encrypted?` | ❌（含 `text` 但未处理） |
| `effort` | `effort?`、`previous?` | ❌ |

oh-my-opensecret 的 `redactEvent()` 实现了 `redactTextPart()`，覆盖 `text` / `reasoning` / `tool-call` / `tool-result` 四类；`media` / `compaction` / `effort` 直接跳过。

### `ToolResultPart.result` —— 4 种形态

```ts
| { type: "json";   value: unknown }
| { type: "text";   value: unknown }
| { type: "error";  value: unknown }
| { type: "content"; value: Array<{ type: "text"; text: string }
                                  | { type: "file"; uri: string; mime: string; name?: string }> }
```

oh-my-opensecret 的 `redactToolResult()` 逐一处理：

| `result.type` | 处理方式 |
|---------------|---------|
| `text` / `error` | `value` 是字符串 → `redactText` |
| `json` | `value` 是字符串 → `redactText`；是对象 → `redactDeep`（原地） |
| `content` | 遍历数组，只对 `{ type: "text" }` 的 `text` 做 `redactText`；`file` 项不动 |

> 注意 `content` 形态里的文本字段名是 `text`（不是 `value`），与 `ToolResultPart` 顶层一致。

## 8. oh-my-opensecret 侧的对应实现

| 事件字段 | 处理函数（`src/index.js` / `src/deep.js`） |
|---------|------|
| `system[]` / `messages[].content[]` 遍历 | `redactEvent()` |
| `part.text`（`text` / `reasoning`） | `redactText()`（`src/engine.js`） |
| `part.input`（`tool-call`） | `redactDeep()`（原地，`WeakSet` 防环） |
| `part.result`（`tool-result`） | `redactToolResult()` |
| `event.input`（`execute.before`） | `restoreInput()` → `restoreDeep()`（**返回新树**，`WeakMap<原对象,新副本>` 防环），整体替换引用 |

## 9. 与宿主内置插件的一致性

`event.input = restoreInput(event.input, session)` 与宿主自带插件 `opencode.tool.input.repair` 同构：
hook 回调没有「返回新对象」的通道，只能整体替换事件上的引用。
