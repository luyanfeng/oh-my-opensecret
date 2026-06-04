# OpenCode 右侧栏插件能力研究报告

> 日期：2026-06-04
> 目标：研究是否能在 OpenCode 右侧栏区域中给 oh-my-opensecret 插件显示脱敏信息面板

---

## 一、核心结论

**OpenCode v1.15.13 中不存在 `sidebar` hook 或 `"ui.sidebar"` hook。**

| 方案 | 状态 | 来源 |
|------|------|------|
| `sidebar` hook (Issue #5971) | ❌ **未实现** | `SidebarPanel`/`SidebarPanelItem` API 从未合入主线 |
| `"ui.sidebar"` hook (PR #16804) | ❌ **未合入** | 2026-03 关闭，review 未通过，已 stale |
| **TUI slot 系统** (PR #19347) | ✅ **已实现** | **v1.15.13 中唯一可行的方案** |

---

## 二、三条技术路线详解

### 路线 A：`sidebar` hook（Issue #5971 — 从未实现）

**提案 API（仅存在于 Issue body 中）：**

```typescript
interface SidebarPanelItem {
  label: string
  value?: string
  status?: "success" | "warning" | "error" | "info"
}

interface SidebarPanel {
  id: string
  title: string
  items: SidebarPanelItem[] | (() => SidebarPanelItem[])
}

interface Hooks {
  sidebar?: SidebarPanel[] | (() => SidebarPanel[])
}
```

**提案特点：**
- `sidebar` 和 `items` 都可以是函数（动态内容）
- 客户端每 5 秒轮询 `GET /plugin/sidebar`
- UI 以可折叠/展开的面板渲染
- 内容格式固定为 label + value + status，无自由文本/多行

**提案中的用法示例：**
```typescript
hooks: {
  sidebar: () => [{
    id: "metrics",
    title: "Live Metrics",
    items: () => [
      { label: "Requests", value: String(requestCount) },
      { label: "Last Update", value: new Date().toLocaleTimeString() }
    ]
  }]
}
```

**状态：** PR #6389 尝试实现但已关闭未合入。后续无新进展。

---

### 路线 B：`"ui.sidebar"` hook（PR #16804 — 未合入）

**实际修改的代码（来自 diff 分析）：**

```typescript
// packages/plugin/src/index.ts 新增
export type SidebarItem = {
  id: string
  label: string
  icon: string
  href: string
  order?: number
}

// Hooks 接口中新增
export interface Hooks {
  "ui.sidebar"?: (input: {}, output: { items: SidebarItem[] }) => Promise<void>
}
```

**PR 特点：**
- 不是富面板，而是 **简单导航按钮**（icon + label + href 点击跳转）
- 在 Web 应用的 sidebar rail 中渲染为图标按钮（Settings 和 Help 之间）
- 采用 `(input, output) => Promise<void>` 模式（与其他 hooks 一致）
- 服务端通过 `GET /plugin/sidebar` 聚合

**渲染代码（来自 `sidebar-shell.tsx` diff）：**
```tsx
<div class="flex max-h-40 w-full flex-col items-center gap-2 overflow-y-auto no-scrollbar">
  <For each={props.pluginItems() || []}>
    {(item) => (
      <Tooltip placement={placement()} value={item.label}>
        <IconButton icon={getIconName(item.icon)} variant="ghost" size="large"
          onClick={() => props.onOpenPluginItem(item.href)} aria-label={item.label} />
      </Tooltip>
    )}
  </For>
</div>
```

**为什么未合入：**
- 所有 CI 检查通过，作者标注 `merge-ready`
- **未获得 OpenCode 团队成员的 review/approval**
- 最后活跃在 2026-03-26，之后静默关闭
- 存在竞争路线（#5971 的 `SidebarPanel` API 更丰富）

---

### 路线 C：TUI Slot 系统（✅ 已实现，推荐）

**这是 v1.15.13 中唯一可用的方案。**

#### 核心 API

```typescript
// 从 @opencode-ai/plugin/tui 导入
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
```

**TUI 插件入口签名：**
```typescript
type TuiPlugin = (
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  meta: TuiPluginMeta
) => Promise<void>

type TuiPluginModule = {
  id?: string
  tui: TuiPlugin
  server?: never  // v1 插件只能 export server 或 tui，不可同时存在
}
```

**注册 sidebar 内容的 API：**
```typescript
api.slots.register({
  order: number,    // 排序值（内置插件：Context=100, MCP=200, LSP=300, Todo=400, Files=500）
  slots: {
    sidebar_content(ctx: TuiSlotContext, props: { session_id: string }) {
      // 返回 SolidJS JSX
      return <box>...</box>
    },
  },
})
```

#### 可用的 sidebar slot

| Slot 名 | Props | 模式 | 说明 |
|---------|-------|------|------|
| `sidebar_title` | `{ session_id, title, share_url? }` | `single_winner` | 会话标题 |
| `sidebar_content` | `{ session_id }` | **叠加渲染** | 主内容区，多个插件可同时贡献 |
| `sidebar_footer` | `{ session_id }` | `single_winner` | 底部（版本信息等） |

#### 内置 sidebar 插件（按 order 排序）

| 插件 ID | Order | 功能 | 数据来源 |
|---------|-------|------|---------|
| `internal:sidebar-context` | 100 | Token 用量、费用 | `api.state.session.messages()`, `api.state.session.get()` |
| `internal:sidebar-mcp` | 200 | MCP 服务器状态 | `api.state.mcp()` |
| `internal:sidebar-lsp` | 300 | LSP 状态 | `api.state.lsp()` |
| `internal:sidebar-todo` | 400 | 待办事项 | `api.state.session.todo()` |
| `internal:sidebar-files` | 500 | 修改的文件列表 | `api.state.session.diff()` |

#### 渲染机制（`sidebar.tsx`）

```tsx
<box width={42} height="100%">
  <scrollbox flexGrow={1}>
    <box flexShrink={0} gap={1} paddingRight={1}>
      <TuiPluginRuntime.Slot name="sidebar_title" mode="single_winner" ... />
      <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
    </box>
  </scrollbox>
  <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" ... />
</box>
```

- `sidebar_content` 没有设置 `mode`，使用默认模式（**所有注册的插件叠加渲染**）
- 外部插件可以插入任意 order 值：`order: 50`（最上方）、`order: 250`（MCP 和 LSP 之间）、`order: 650`（最下方）

#### TUI 插件可访问的完整 API

| API 分组 | 说明 |
|---------|------|
| `api.state.session.*` | 会话数据（messages, todo, diff, status, permission, question） |
| `api.state.mcp()` | MCP 服务器列表 |
| `api.state.lsp()` | LSP 状态 |
| `api.state.provider` | Provider 信息 |
| `api.state.path` | 路径信息（directory, config, state） |
| `api.state.vcs` | Git 分支信息 |
| `api.client` | HTTP 客户端（可调用服务端 API） |
| `api.event.on(type, handler)` | 事件订阅 |
| `api.kv.get/set` | 持久化键值存储 |
| `api.theme.current` | 当前主题 |
| `api.ui.*` | UI 组件（Dialog, Toast, Prompt 等） |
| `api.lifecycle.onDispose(fn)` | 清理回调 |

#### 最小 TUI 插件示例

```typescript
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <box>
            <text>My Plugin</text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "oh-my-opensecret",
  tui,
}
export default plugin
```

---

## 三、双入口方案（Server + TUI）

### 规则

**v1 插件模块是目标互斥的：** 一个模块文件不能同时 export `server` 和 `tui`。但一个 npm 包可以通过 `package.json` 暴露两个入口点。

### package.json 配置

```json
{
  "name": "oh-my-opensecret",
  "exports": {
    ".": "./src/index.js",
    "./server": "./src/index.js",
    "./tui": "./src/tui/index.jsx"
  },
  "oc-plugin": [["server"], ["tui"]]
}
```

### 用户配置方式

用户需要分别在两个配置文件中添加：

```json
// opencode.json — Server 插件（现有逻辑：脱敏/还原 hooks）
{ "plugin": ["oh-my-opensecret"] }

// tui.json — TUI 插件（新增：sidebar 信息面板）
{ "plugin": ["oh-my-opensecret"] }
```

### 真实案例

- **opencode-forge**（chriswritescode-dev）— 同包双入口
- **@aexol/opencode-tui** — 同包双入口

---

## 四、Server 插件 → TUI 插件数据桥接

TUI 插件运行在 TUI 进程中，不能直接访问 server 插件内存中的 `sessions Map`、`patterns` 等数据。需要桥接：

### 方案一：通过 HTTP API（推荐）

1. **Server 插件** 注册一个自定义 tool 或利用现有 API 暴露脱敏统计
2. **TUI 插件** 通过 `api.client` 轮询获取数据
3. 更新方式：定时轮询（如 5s 一次）或通过事件触发

### 方案二：通过键值存储（KV）

1. **Server 插件** 将脱敏统计写入 `kv` 存储
2. **TUI 插件** 通过 `api.kv.get()` 读取

### 方案三：通过事件总线

1. **Server 插件** 在脱敏时发出事件
2. **TUI 插件** 通过 `api.event.on()` 订阅

---

## 五、推荐实现路径

```
Step 1: 创建 TUI 插件入口 src/tui/index.jsx
        在 sidebar_content 渲染静态面板（标题 + 示例信息）

Step 2: 实现数据桥接
        Server 插件暴露统计数据 → TUI 插件通过 api.client 获取

Step 3: 完善 UI
        状态指示、折叠/展开、动态刷新
```

---

## 六、参考资源

- TUI 插件规范：[packages/opencode/specs/tui-plugins.md](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/specs/tui-plugins.md)
- TUI 插件 API 类型：[packages/plugin/src/tui.ts](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/tui.ts)
- 内置 sidebar 插件源码：`packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/`
- Sidebar 渲染组件：`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- Issue #5971（sidebar panel 提案）：https://github.com/anomalyco/opencode/issues/5971
- PR #16804（ui.sidebar hook）：https://github.com/anomalyco/opencode/pull/16804
- Issue #28902（TUI widget API 提案）：https://github.com/anomalyco/opencode/issues/28902
- 真实 TUI 插件参考：`opencode-sidebar-background-sessions`、`opencode-agents-sidebar`、`opencode-forge`
