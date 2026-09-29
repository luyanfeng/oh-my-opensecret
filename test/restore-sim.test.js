/**
 * V2 还原验证（进程级共享会话）
 *
 * V2 的 context hook 不带 sessionID，因此整个 server 进程共用一把 HMAC 密钥
 * 与一张占位符映射表（见 src/index.js / AGENTS.md）。本测试不再验证
 * "sessionID 不匹配/为空导致跳过还原" —— 那是 V1 的每会话隔离语义；V2 下
 * 同一进程内任意来源脱敏的值都可被还原（密钥不出本机）。
 *
 * 重点验证：
 * 1. 脱敏 → 还原 闭环是否真的还原占位符
 * 2. 还原只作用于文本（不会破坏非文本字段）
 * 3. TTL 过期后映射被清理，无法还原
 * 4. 同一进程内多次脱敏同一原文，占位符稳定一致
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, "..", ".test-tmp", "restore-sim")

async function makeSession(configPath) {
  await fs.writeFile(
    configPath,
    `enabled: true
auto_discovery: false
placeholder_prefix: "__OMOS_"
patterns:
  keywords:
    - { value: "my-secret", placeholderId: "TEST" }
    - { value: "sk-proj-abc123def456", placeholderId: "OPENAI_KEY" }
  builtin:
    - email
    - ipv4
  exclude: []
`,
    "utf8",
  )
}

describe("还原问题模拟验证 (V2 共享会话)", () => {
  let session
  let patterns
  let logger
  let dir

  before(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
    dir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
    await fs.mkdir(dir, { recursive: true })
    const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
    await makeSession(cfgPath)

    const { loadConfig } = await import("../src/config.js")
    const { buildPatternSet } = await import("../src/patterns.js")
    const { PlaceholderSession } = await import("../src/session.js")
    const { createLogger } = await import("../src/logger.js")
    const { redactEvent } = await import("../src/index.js")

    logger = createLogger({ level: "off" })
    const config = await loadConfig(dir, logger)
    patterns = buildPatternSet(config.patterns)
    session = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    // 暴露 redactEvent 供用例调用
    globalThis.__redactEvent = (event) => redactEvent(event, session, patterns, logger)
  })

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
  })

  const redact = (text) => {
    const event = { messages: [{ role: "user", content: [{ type: "text", text }] }] }
    globalThis.__redactEvent(event)
    return event.messages[0].content[0].text
  }

  // ---- 测试 1: 正常流程，脱敏→还原 ----
  it("正常流程: 脱敏→还原 (共享会话)", async () => {
    const { restoreResponseText } = await import("../src/index.js")
    const redacted = redact("My key is my-secret")
    console.log(`  脱敏后: "${redacted}"`)
    assert.ok(redacted.includes("__OMOS_"), "应被脱敏")
    assert.ok(!redacted.includes("my-secret"), "不应含原文")

    const output = restoreResponseText(redacted, session)
    console.log(`  还原后: "${output}"`)
    assert.equal(output, "My key is my-secret", "还原后应与原文一致")
  })

  // ---- 测试 2: 无占位符的文本还原应为原样 ----
  it("无占位符文本: 还原为原样", async () => {
    const { restoreResponseText } = await import("../src/index.js")
    const plain = "没有任何敏感信息的普通文本"
    assert.equal(restoreResponseText(plain, session), plain)
  })

  // ---- 测试 3: 同一进程内多次脱敏后仍能还原 ----
  it("同一进程多次脱敏后仍能还原", async () => {
    const { restoreResponseText } = await import("../src/index.js")
    const r1 = redact("first my-secret")
    const r2 = redact("second my-secret")
    console.log(`  第一次脱敏后: "${r1}"`)
    console.log(`  第二次脱敏后: "${r2}"`)

    // 同一进程内同一原文应映射到相同占位符（共享密钥/映射）
    const ph1 = r1.replace("first ", "")
    const ph2 = r2.replace("second ", "")
    assert.equal(ph1, ph2, "同一进程内同一原文应映射到相同占位符")

    assert.equal(restoreResponseText(r1, session), "first my-secret")
    assert.equal(restoreResponseText(r2, session), "second my-secret")
  })

  // ---- 测试 4: TTL 过期导致还原失败 ----
  it("TTL 过期: 映射被清理后无法还原", { timeout: 5000 }, async () => {
    const { restoreResponseText } = await import("../src/index.js")
    const ttlDir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
    await fs.mkdir(ttlDir, { recursive: true })
    const cfgPath = path.join(ttlDir, "oh-my-opensecret.yaml")
    await fs.writeFile(
      cfgPath,
      `enabled: true
auto_discovery: false
placeholder_prefix: "__OMOS_"
session:
  ttl: "50ms"
  max_mappings: 1000
patterns:
  keywords:
    - { value: "temp-secret", placeholderId: "TEMP" }
  builtin: []
  exclude: []
`,
      "utf8",
    )
    const { loadConfig } = await import("../src/config.js")
    const { buildPatternSet } = await import("../src/patterns.js")
    const { PlaceholderSession } = await import("../src/session.js")
    const { createLogger } = await import("../src/logger.js")
    const { redactEvent } = await import("../src/index.js")

    const logger2 = createLogger({ level: "off" })
    const config = await loadConfig(ttlDir, logger2)
    const patterns2 = buildPatternSet(config.patterns)
    const sess = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })

    const ev = { messages: [{ role: "user", content: [{ type: "text", text: "temp-secret value" }] }] }
    redactEvent(ev, sess, patterns2, logger2)
    const redacted = ev.messages[0].content[0].text
    console.log(`  TTL 脱敏后: "${redacted}"`)

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 100))

    // 真实场景：下一轮请求会先 cleanup 再脱敏（见 src/index.js makeContextHandler）。
    // cleanup 会清除过期映射，使占位符无法再还原。
    sess.cleanup()

    const output = restoreResponseText(redacted, sess)
    console.log(`  TTL 过期后还原: "${output}"`)
    assert.ok(output.includes("__OMOS_"), "TTL 过期后占位符应保持原样")
    assert.notEqual(output, "temp-secret value", "TTL 过期后不应还原")
  })
})
