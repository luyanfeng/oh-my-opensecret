# Opencode 插件 API 参考

> 来源：opencode.ai/docs/plugins、@opencode-ai/plugin 类型定义
> 整理日期：2026-06-04

## 插件入口定义

```ts
import type { Plugin } from "@opencode-ai/plugin"

const MyPlugin: Plugin = async (ctx) => {
  // ctx.directory: 项目根目录
  // 返回 Hooks 对象
  return { ... }
}

export default MyPlugin
// 或具名导出
export const MyPlugin = async (ctx) => { ... }
```

## 可用 Hooks 完整列表

### 1. 生命周期类

#### `event`
```ts
event?: (input: { event: Event }) => Promise<void>
```
通用事件监听，所有系统事件都会触发。

#### `config`
```ts
config?: (input: Config) => Promise<void>
```
配置加载时调用，可修改配置。

### 2. 聊天/消息类

#### `chat.message`
```ts
"chat.message"?: (
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```
单条消息收到时，可追加 parts 或修改消息内容。

#### `chat.params`
```ts
"chat.params"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
) => Promise<void>
```
发送给 LLM 前修改参数（temperature、topP 等）。

#### `chat.headers`
```ts
"chat.headers"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
) => Promise<void>
```
注入自定义 HTTP header。

#### `experimental.chat.messages.transform`
```ts
"experimental.chat.messages.transform"?: (
  input: {},
  output: { messages: { info: Message; parts: Part[] }[] },
) => Promise<void>
```
⚠️ **必须 in-place 修改**：`output.messages` 赋值 = no-op，必须用 `splice` 原地修改数组。

#### `experimental.chat.system.transform`
```ts
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>
```
构建 system prompt 时调用，可注入/改写 system 消息。

### 3. 工具执行类

#### `tool.execute.before`
```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```
工具执行前调用，修改参数。

#### `tool.execute.after`
```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>
```
工具执行后调用，修改结果。

#### `tool.definition`
```ts
"tool.definition"?: (
  input: { toolID: string },
  output: { description: string; parameters: any },
) => Promise<void>
```
修改工具定义（描述、参数 schema）。

#### `shell.env`
```ts
"shell.env"?: (
  input: { cwd: string; sessionID?: string; callID?: string },
  output: { env: Record<string, string> },
) => Promise<void>
```
Shell 执行前注入环境变量。

### 4. 权限类

#### `permission.ask`
```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
) => Promise<void>
```
工具权限询问时调用，可自动允许/拒绝。

### 5. 命令类

#### `command.execute.before`
```ts
"command.execute.before"?: (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: Part[] },
) => Promise<void>
```
斜杠命令执行前，注入 context parts。

### 6. Session 压缩类

#### `experimental.session.compacting`
```ts
"experimental.session.compacting"?: (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void>
```
Session 压缩前注入自定义上下文，或完全替换压缩 prompt。

### 7. 输出类

#### `experimental.text.complete`
```ts
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```
文本输出完成时调用（修改最终文本，如脱敏后还原）。

## Hooks 对比总结

| Hook | 触发时机 | 变更对象 | 备注 |
|------|---------|---------|------|
| `chat.message` | 新消息时 | `output.parts` | 追加上下文用 |
| `chat.params` | 请求 LLM 前 | `output.temperature` 等 | 参数调优 |
| `chat.headers` | 请求 LLM 前 | `output.headers` | 注入 header |
| `messages.transform` | 消息列表构建后 | `output.messages[]` | 须 in-place splice |
| `system.transform` | system prompt 构建时 | `output.system[]` | 注入系统消息 |
| `text.complete` | 文本输出完成 | `output.text` | 还原最终文本 |
| `tool.execute.before` | 工具执行前 | `output.args` | 修改入参 |
| `tool.execute.after` | 工具执行后 | `output.output` | 修改出参 |
| `tool.definition` | 工具定义发送前 | `output.description/parameters` | 修改工具描述 |
| `shell.env` | shell 执行前 | `output.env` | 注入环境变量 |
| `permission.ask` | 权限询问 | `output.status` | 自动放行/拒绝 |
| `command.execute.before` | 命令执行前 | `output.parts` | 注入上下文 |
| `session.compacting` | Session 压缩前 | `output.context/prompt` | 注入压缩上下文 |
