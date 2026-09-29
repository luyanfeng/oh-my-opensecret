import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(__dirname, "..", ".test-tmp", "integration")

async function uniqueDir() {
  const dir = path.join(BASE, crypto.randomBytes(4).toString("hex"))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("index.js - V2 插件入口集成", () => {
  it("完整流程：加载 → 脱敏(context) → 还原(http.response) → 工具参数还原(execute.before)", async () => {
    const dir = await uniqueDir()

    // 写配置
    await fs.writeFile(
      path.join(dir, "oh-my-opensecret.yaml"),
      `enabled: true\nauto_discovery: false\nplaceholder_prefix: "__OMOS_"\npatterns:\n  keywords:\n    - { value: "my-secret", placeholderId: "TEST" }`,
      "utf8",
    )

    const { redactEvent, restoreResponseText, restoreInput } = await import("../src/index.js")
    const { loadConfig } = await import("../src/config.js")
    const { buildPatternSet } = await import("../src/patterns.js")
    const { PlaceholderSession } = await import("../src/session.js")
    const { createLogger } = await import("../src/logger.js")

    const logger = createLogger({ level: "off" })
    const config = await loadConfig(dir, logger)
    const patterns = buildPatternSet(config.patterns)
    const session = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })

    // ---- 测试 1: 脱敏（context hook 等价物）----
    const event = {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "My key is my-secret" }],
      }],
    }
    redactEvent(event, session, patterns, logger)
    const afterRedact = event.messages[0].content[0].text
    assert.ok(afterRedact.includes("__OMOS_"))
    assert.ok(!afterRedact.includes("my-secret"))

    // ---- 测试 2: 还原（http.response hook 等价物）----
    const restored = restoreResponseText(afterRedact, session)
    assert.equal(restored, "My key is my-secret")

    // ---- 测试 3: 工具参数还原（execute.before hook 等价物）----
    const input = { command: `echo ${afterRedact}` }
    restoreInput(input, session)
    assert.equal(input.command, "echo My key is my-secret")
  })

  after(async () => {
    await fs.rm(BASE, { recursive: true, force: true })
  })
})
