import { loadConfig } from "./config.js"
import { createLogger } from "./logger.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreText } from "./restore.js"

/**
 * oh-my-opensecret 插件入口。
 *
 * Hook：
 * - `experimental.chat.messages.transform` — LLM 请求前脱敏
 * - `experimental.text.complete` — 响应完成后还原
 * - `tool.execute.before` — 工具执行前还原
 */

/**
 * 提取命中位置的前后上下文，类似 grep -C。
 * @param {string} text 完整文本
 * @param {number} start 命中起始位置
 * @param {number} end 命中结束位置
 * @param {number} contextLen 上下文长度（字符数）
 * @returns {{ before: string, after: string }}
 */
function contextAround(text, start, end, contextLen = 30) {
  const ctx = Math.max(contextLen, 0)
  const beforeStart = Math.max(0, start - ctx)
  const afterEnd = Math.min(text.length, end + ctx)
  let before = text.slice(beforeStart, start)
  let after = text.slice(end, afterEnd)
  // 如果截取的不是开头/结尾，加省略号
  if (beforeStart > 0) before = "…" + before
  if (afterEnd < text.length) after = after + "…"
  // 换行符替换为可视标记，保持单行
  before = before.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
  after = after.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
  return { before, after }
}

const OpenSecret = async (ctx) => {
  // 1. 加载配置（含自举 + 自动发现）
  // 先以默认 File 模式创建 logger，加载完配置后再更新
  const logger = createLogger({
    level: "info",
    filePath: "~/.oh-my-opensecret/oh-my-opensecret.log",
    prefix: "[oh-my-opensecret]",
    maxSize: "10m",
    maxFiles: 7,
  })
  const config = await loadConfig(ctx.directory, logger)
  logger.level = config.logging.level
  logger.filePath = config.logging.file
  logger.maxSize = config.logging.maxSize
  logger.maxFiles = config.logging.maxFiles

  logger.debug(
    `配置加载: ${config.loadedFrom || "默认生成"} enabled=${config.enabled} autoDiscovery=${config.autoDiscovery}`,
  )

  if (!config.enabled) {
    logger.info("插件已禁用（enabled=false），注册为空 hook")
    return {}
  }

  // 2. 构建模式集
  const patterns = buildPatternSet(config.patterns)

  // 3. 会话管理器缓存（sessionID → PlaceholderSession）
  /** @type {Map<string, PlaceholderSession>} */
  const sessions = new Map()

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    let session = sessions.get(key)
    if (session) return session

    session = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, session)
    return session
  }

  return {
    /**
     * 消息列表转换：向 LLM 发送前脱敏所有消息中的敏感信息。
     * 注意：必须 in-place 修改 output.messages，不可重新赋值。
     */
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output?.messages
      if (!Array.isArray(msgs) || msgs.length === 0) return

      // 取第一个消息的 sessionID
      const sessionID =
        msgs[0]?.info?.sessionID ?? msgs[0]?.parts?.[0]?.sessionID
      const session = getSession(sessionID)
      if (!session) return

      session.cleanup()
      let changed = 0

      for (const msg of msgs) {
        const parts = Array.isArray(msg?.parts) ? msg.parts : []
        for (const part of parts) {
          if (!part) continue

          // 普通文本
          if (part.type === "text") {
            if (part.ignored) continue
            if (typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changed++
            part.text = after
            continue
          }

          // 推理文本
          if (part.type === "reasoning") {
            if (typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changed++
            part.text = after
            continue
          }

          // 工具调用/输出
          if (part.type === "tool") {
            const state = part.state
            if (!state || typeof state !== "object") continue

            // 工具输入深度脱敏
            if (state.input && typeof state.input === "object") {
              redactDeep(state.input, patterns, session)
            }

            if (state.status === "completed" && typeof state.output === "string") {
              const result = redactText(state.output, patterns, session)
              if (result.matches.length > 0) {
                changed++
                for (const m of result.matches) {
                  const before = state.output
                  // 用替换后的文本取上下文
                  const after = result.text
                  const phLen = m.placeholder.length
                  const ctx = contextAround(after, m.start, m.start + phLen, 30)
                  logger.debug(`脱敏 output: ...${ctx.before}[${m.placeholder}]${ctx.after}...`)
                }
              }
              state.output = result.text
              continue
            }
            if (state.status === "error" && typeof state.error === "string") {
              const result = redactText(state.error, patterns, session, config.prefix)
              if (result.matches.length > 0) {
                changed++
                for (const m of result.matches) {
                  const after = result.text
                  const phLen = m.placeholder.length
                  const ctx = contextAround(after, m.start, m.start + phLen, 30)
                  logger.debug(`脱敏 error: ...${ctx.before}[${m.placeholder}]${ctx.after}...`)
                }
              }
              state.error = result.text
              continue
            }
            if (state.status === "pending" && typeof state.raw === "string") {
              const result = redactText(state.raw, patterns, session, config.prefix)
              if (result.matches.length > 0) {
                changed++
                for (const m of result.matches) {
                  const after = result.text
                  const phLen = m.placeholder.length
                  const ctx = contextAround(after, m.start, m.start + phLen, 30)
                  logger.debug(`脱敏 raw: ...${ctx.before}[${m.placeholder}]${ctx.after}...`)
                }
              }
              state.raw = result.text
              continue
            }
          }
        }
      }

      if (changed > 0) {
        logger.debug(`messages.transform: 脱敏了 ${changed} 处文本片段`)
      }
    },

    /**
     * 文本输出完成：将占位符还原为原文。
     */
    "experimental.text.complete": async (input, output) => {
      if (!output || typeof output !== "object") return
      if (typeof output.text !== "string" || !output.text) return

      const session = getSession(input?.sessionID)
      if (!session) return

      session.cleanup()
      const before = output.text
      const after = restoreText(before, session)
      if (after !== before) {
        output.text = after
        logger.debug("text.complete: 还原了 1 处占位符")
      }
    },

    /**
     * 工具执行前：将参数中的占位符还原为明文。
     */
    "tool.execute.before": async (input, output) => {
      const session = getSession(input?.sessionID)
      if (!session) return

      session.cleanup()
      restoreDeep(output?.args, session)
    },
  }
}

export default OpenSecret
export { OpenSecret }
