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

describe("index.js - 插件入口集成", () => {
  it("完整流程：加载 → 脱敏 → 还原 → 工具参数还原", async () => {
    const dir = await uniqueDir()

    // 写配置
    await fs.writeFile(
      path.join(dir, "oh-my-opensecret.yaml"),
      `enabled: true\nauto_discovery: false\nplaceholder_prefix: "__OMOS_"\npatterns:\n  keywords:\n    - { value: "my-secret", placeholderId: "TEST" }`,
      "utf8",
    )

    const { default: OpenSecret } = await import("../src/index.js")
    const hooks = await OpenSecret({ directory: dir })
    assert.ok(hooks)

    // ---- 测试 1: hooks 存在 ----
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
    assert.equal(typeof hooks["experimental.text.complete"], "function")
    assert.equal(typeof hooks["tool.execute.before"], "function")

    // ---- 测试 2: 脱敏 ----
    const msg = {
      messages: [{
        info: { sessionID: "sid-1" },
        parts: [{ type: "text", text: "My key is my-secret" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg)
    const afterRedact = msg.messages[0].parts[0].text
    assert.ok(afterRedact.includes("__OMOS_"))
    assert.ok(!afterRedact.includes("my-secret"))

    // ---- 测试 3: 还原 ----
    const output = { text: afterRedact }
    await hooks["experimental.text.complete"]({ sessionID: "sid-1" }, output)
    assert.equal(output.text, "My key is my-secret")

    // ---- 测试 4: 工具参数还原 ----
    const toolOutput = { args: { command: `echo ${afterRedact}` } }
    await hooks["tool.execute.before"]({ sessionID: "sid-1" }, toolOutput)
    assert.equal(toolOutput.args.command, "echo My key is my-secret")
  })

  after(async () => {
    await fs.rm(BASE, { recursive: true, force: true })
  })
})
