import { loadConfig } from "./config.js"
import { createLogger } from "./logger.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreText } from "./restore.js"
import { ProcessSingleton } from "./singleton.js"

/**
 * oh-my-opensecret 插件入口（OpenCode 2.x / V2 server plugin API）。
 *
 * V2 机制：`Plugin.define({ id, setup(ctx) })`，`setup` 内通过
 * `ctx.session.hook(name, cb)` / `ctx.tool.hook(name, cb)` 注册 hook，
 * 并返回 cleanup 函数（可选）。
 *
 * Hook 映射（不再兼容 V1）：
 * - V1 `experimental.chat.messages.transform` → V2 `session.hook("context")`   （请求前脱敏）
 * - V1 `experimental.text.complete`          → V2 `session.hook("http.response")`（响应后还原）
 * - V1 `tool.execute.before`                 → V2 `tool.hook("execute.before")` （工具参数还原）
 *
 * 进程级单例：每个 location 各加载一份插件实例，但仅有「最新注册者」实例真正注册
 * hook（见 singleton.js），确保同一 server 进程只有一个本插件实现在生效。
 */

// @opencode/plugin 由宿主（opencode server）在运行时提供。
// 测试中若不可用，退化为最小 define 实现，使模块可独立导入与单测。
/** @type {any} */
let Plugin = { define: (definition) => definition }
try {
  const mod = await import("@opencode/plugin")
  if (mod && mod.Plugin) Plugin = mod.Plugin
} catch {
  // 测试环境无宿主 SDK：保持降级 define，逻辑单测不依赖它。
}

/**
 * 还原工具结果（tool-result）中的文本/JSON 内容。in-place 修改。
 * @param {{ result?: { type: string, value?: unknown } }} part
 * @param {{ keywords: Array<{value:string,placeholderId:string}>, regex: Array<{pattern:string,placeholderId:string}>, exclude: { exact: Set<string>, glob: Array<{raw:string,re:RegExp}> } }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, placeholderId: string): string }} session
 */
function redactToolResult(part, patterns, session) {
  const result = part?.result
  if (!result || typeof result !== "object") return
  if (result.type === "text" || result.type === "error") {
    if (typeof result.value === "string") {
      result.value = redactText(result.value, patterns, session).text
    }
  } else if (result.type === "json") {
    if (typeof result.value === "string") {
      result.value = redactText(result.value, patterns, session).text
    } else if (result.value && typeof result.value === "object") {
      redactDeep(result.value, patterns, session)
    }
  } else if (result.type === "content") {
    if (Array.isArray(result.value)) {
      for (const c of result.value) {
        if (c && c.type === "text" && typeof c.text === "string") {
          c.text = redactText(c.text, patterns, session).text
        }
      }
    }
  }
}

/**
 * V2 消息脱敏（in-place）：遍历 `event.messages` 与 `event.system` 的所有文本/推理/
 * 工具调用/工具结果 part。供 `session.hook("context")` 调用，也可被单测直接调用。
 * @param {{ messages?: Array<any>, system?: Array<any> }} event
 * @param {{ getOrCreatePlaceholder(original: string, placeholderId: string): string }} session
 * @param {{ keywords: Array<{value:string,placeholderId:string}>, regex: Array<{pattern:string,placeholderId:string}>, exclude: { exact: Set<string>, glob: Array<{raw:string,re:RegExp}> } }} patterns
 * @param {{ debug?: (msg: string) => void }} [logger]
 */
export function redactEvent(event, session, patterns, logger) {
  const log = logger?.debug?.bind?.(logger) ?? (() => {})

  const redactTextPart = (part) => {
    if (!part) return
    if (part.type === "text" || part.type === "reasoning") {
      if (typeof part.text === "string") {
        const before = part.text
        part.text = redactText(before, patterns, session).text
        if (part.text !== before) log(`脱敏 text: 已替换敏感片段`)
      }
    } else if (part.type === "tool-call") {
      if (part.input && typeof part.input === "object") {
        redactDeep(part.input, patterns, session)
      }
    } else if (part.type === "tool-result") {
      redactToolResult(part, patterns, session)
    }
  }

  // system 指令（可能含从配置注入的密钥）
  if (Array.isArray(event?.system)) {
    for (const part of event.system) redactTextPart(part)
  }

  const msgs = event?.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return

  for (const msg of msgs) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const part of msg.content) redactTextPart(part)
  }
}

/**
 * 还原一段文本中的占位符。纯函数，供单测直接调用与 `restore.js` 复用。
 * 注：V2 的 `http.response` hook 已验证无法影响 TUI 展示（server 不消费替换后的 body），
 * 当前插件采用「脱敏单向、不还原」策略，不再注册该 hook；本导出保留还原能力供后续方案使用。
 * @param {string} text
 * @param {{ lookup(ph: string): string | undefined, prefix: string }} session
 * @returns {string}
 */
export function restoreResponseText(text, session) {
  return restoreText(String(text ?? ""), session)
}

/**
 * 工具参数还原（in-place）：深度还原 `input` 中的占位符。
 * 供 `tool.hook("execute.before")` 调用，也可被单测直接调用。
 * @param {unknown} input
 * @param {{ lookup(ph: string): string | undefined, prefix: string }} session
 */
export function restoreInput(input, session) {
  restoreDeep(input, session)
}

export default Plugin.define({
  id: "oh-my-opensecret",
  async setup(ctx) {
    // 1. 加载配置（含自举 + 自动发现）。目录用 V2 的 location.directory。
    const directory = String(ctx?.location?.directory ?? process.cwd())
    const logger = createLogger({
      level: "info",
      filePath: "~/.oh-my-opensecret/oh-my-opensecret.log",
      prefix: "[oh-my-opensecret]",
      maxSize: "10m",
      maxFiles: 7,
    })
    const config = await loadConfig(directory, logger)
    logger.level = config.logging.level
    logger.filePath = config.logging.file
    logger.maxSize = config.logging.maxSize
    logger.maxFiles = config.logging.maxFiles

    if (!config.enabled) {
      logger.info("插件已禁用（enabled=false），不注册 hook")
      return
    }

    // 2. 构建模式集
    const patterns = buildPatternSet(config.patterns)

    // 3. 进程级共享占位符会话（active 实例持有，密钥进程内唯一）。
    //    注意：V2 的 context hook 不带 sessionID，无法区分会话，
    //    故整个 server 进程共用一把 HMAC 密钥与一张映射表（密钥不出本机）。
    /** @type {PlaceholderSession | null} */
    let session = null
    /** @type {Array<{ dispose(): void }>} */
    let registrations = []

    const makeContextHandler = () => async (event) => {
      if (!session) return
      session.cleanup()
      redactEvent(event, session, patterns, logger)
    }

    const makeToolHandler = () => async (event) => {
      if (!session) return
      session.cleanup()
      restoreInput(event?.input, session)
    }

    // 4. 进程级单例：仅 active 实例注册 hook。
    const singleton = new ProcessSingleton({
      id: directory,
      activate: () => {
        session = new PlaceholderSession({
          prefix: config.prefix,
          ttlMs: config.ttlMs,
          maxMappings: config.maxMappings,
        })
        registrations.push(ctx.session.hook("context", makeContextHandler()))
        registrations.push(ctx.tool.hook("execute.before", makeToolHandler()))
      },
      deactivate: () => {
        for (const r of registrations) {
          try { r.dispose() } catch { /* 忽略已释放的 registration */ }
        }
        registrations = []
        session = null
      },
    })

    // 5. cleanup：释放单例槽位（可能把 owner 交给仍存活的最新实例）。
    return () => {
      singleton.release()
    }
  },
})
