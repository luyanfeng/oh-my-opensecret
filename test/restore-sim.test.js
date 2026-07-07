/**
 * 模拟验证：text.complete 还原问题排查
 *
 * 模拟 OpenCode 的完整 hook 调用流程，重点验证：
 * 1. messages.transform 和 text.complete 之间 sessionID 是否一致
 * 2. 还原是否真的能还原占位符
 * 3. sessionID 为空时是否跳过还原
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, "..", ".test-tmp", "restore-sim")

async function createMinimalConfig(dir) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "oh-my-opensecret.yaml"),
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

describe("还原问题模拟验证", () => {
  let hooks
  let dir

  before(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
    dir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
    await createMinimalConfig(dir)
    const { default: OpenSecret } = await import("../src/index.js")
    hooks = await OpenSecret({ directory: dir })
  })

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
  })

  // ---- 测试 1: 正常流程，sessionID 一致 ----
  it("正常流程: 脱敏→还原 (sessionID 一致)", async () => {
    const sessionID = "test-session-1"

    // 脱敏
    const msg = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "My key is my-secret" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg)
    const redacted = msg.messages[0].parts[0].text
    console.log(`  脱敏后: "${redacted}"`)
    assert.ok(redacted.includes("__OMOS_"), "应被脱敏")
    assert.ok(!redacted.includes("my-secret"), "不应含原文")

    // 还原（同一 sessionID）
    const output = { text: redacted }
    await hooks["experimental.text.complete"]({ sessionID }, output)
    console.log(`  还原后: "${output.text}"`)
    assert.equal(output.text, "My key is my-secret", "还原后应与原文一致")
  })

  // ---- 测试 2: sessionID 不匹配 ----
  it("sessionID 不匹配: 还原失败", async () => {
    const sessionID = "test-session-2"

    // 脱敏
    const msg = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "api key: my-secret" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg)
    const redacted = msg.messages[0].parts[0].text
    console.log(`  脱敏后: "${redacted}"`)

    // 用不同 sessionID 还原
    const output = { text: redacted }
    await hooks["experimental.text.complete"]({ sessionID: "wrong-session" }, output)
    console.log(`  错误 sessionID 还原后: "${output.text}"`)
    // 应该仍然是占位符，因为 sessionID 不同，映射表里没有
    assert.ok(output.text.includes("__OMOS_"), "sessionID 不匹配时占位符应保持原样")
    // 不包含原文
    assert.ok(!output.text.includes("my-secret"), "不应还原为原文")
  })

  // ---- 测试 3: sessionID 为空/undefined ----
  it("sessionID 为 undefined: 还原跳过", async () => {
    const sessionID = "test-session-3"

    // 脱敏
    const msg = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "my-secret is here" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg)
    const redacted = msg.messages[0].parts[0].text
    console.log(`  脱敏后: "${redacted}"`)

    // sessionID 为 undefined
    const output = { text: redacted }
    await hooks["experimental.text.complete"]({}, output)
    console.log(`  undefined sessionID 还原后: "${output.text}"`)
    // 应保持占位符
    assert.ok(output.text.includes("__OMOS_"), "sessionID 为空时占位符应保持原样")
  })

  // ---- 测试 4: sessionID 为 null ----
  it("sessionID 为 null: 还原跳过", async () => {
    const sessionID = "test-session-4"

    const msg = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "my-secret again" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg)
    const redacted = msg.messages[0].parts[0].text
    console.log(`  脱敏后: "${redacted}"`)

    const output = { text: redacted }
    await hooks["experimental.text.complete"]({ sessionID: null }, output)
    console.log(`  null sessionID 还原后: "${output.text}"`)
    assert.ok(output.text.includes("__OMOS_"), "sessionID 为 null 时占位符应保持原样")
  })

  // ---- 测试 5: messages.transform 取 sessionID 的两种路径 ----
  it("messages.transform sessionID 取法: info.sessionID vs parts.sessionID", async () => {
    // 路径1: info.sessionID
    const msg1 = {
      messages: [{
        info: { sessionID: "from-info" },
        parts: [{ type: "text", text: "my-secret info-path" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg1)
    const r1 = msg1.messages[0].parts[0].text
    console.log(`  info.sessionID 脱敏后: "${r1}"`)

    // 用 "from-info" 还原
    const out1 = { text: r1 }
    await hooks["experimental.text.complete"]({ sessionID: "from-info" }, out1)
    console.log(`  用 from-info 还原: "${out1.text}"`)
    assert.equal(out1.text, "my-secret info-path", "info.sessionID 路径应正确")

    // 路径2: parts.sessionID
    const msg2 = {
      messages: [{
        parts: [{ sessionID: "from-parts", type: "text", text: "my-secret parts-path" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg2)
    const r2 = msg2.messages[0].parts[0].text
    console.log(`  parts.sessionID 脱敏后: "${r2}"`)

    const out2 = { text: r2 }
    await hooks["experimental.text.complete"]({ sessionID: "from-parts" }, out2)
    console.log(`  用 from-parts 还原: "${out2.text}"`)
    assert.equal(out2.text, "my-secret parts-path", "parts.sessionID 路径应正确")
  })

  // ---- 测试 6: TTL 过期导致还原失败 ----
  it("TTL 过期: 映射被清理后无法还原", { timeout: 5000 }, async () => {
    // 创建一个超短 TTL 的配置
    const ttlDir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
    await fs.mkdir(ttlDir, { recursive: true })
    await fs.writeFile(
      path.join(ttlDir, "oh-my-opensecret.yaml"),
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
    const { default: OpenSecret } = await import("../src/index.js")
    const h = await OpenSecret({ directory: ttlDir })

    const sid = "ttl-test"
    const msg = {
      messages: [{
        info: { sessionID: sid },
        parts: [{ type: "text", text: "temp-secret value" }],
      }],
    }
    await h["experimental.chat.messages.transform"]({}, msg)
    const redacted = msg.messages[0].parts[0].text
    console.log(`  TTL 脱敏后: "${redacted}"`)

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 100))

    // 还原
    const output = { text: redacted }
    await h["experimental.text.complete"]({ sessionID: sid }, output)
    console.log(`  TTL 过期后还原: "${output.text}"`)
    // 应保持占位符，因为映射已被清理
    assert.ok(output.text.includes("__OMOS_"), "TTL 过期后占位符应保持原样")
    assert.notEqual(output.text, "temp-secret value", "TTL 过期后不应还原")
  })

  // ---- 测试 7: 同一 session 内 messages.transform 调用多次后还原 ----
  it("同一 session 多次脱敏后仍能还原", async () => {
    const sessionID = "multi-call-session"

    // 第一次脱敏
    const msg1 = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "first my-secret" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg1)
    const r1 = msg1.messages[0].parts[0].text
    console.log(`  第一次脱敏后: "${r1}"`)

    // 第二次脱敏（同一 session）
    const msg2 = {
      messages: [{
        info: { sessionID },
        parts: [{ type: "text", text: "second my-secret" }],
      }],
    }
    await hooks["experimental.chat.messages.transform"]({}, msg2)
    const r2 = msg2.messages[0].parts[0].text
    console.log(`  第二次脱敏后: "${r2}"`)

    // 两个占位符应该相同（同一 session 同一原文）
    const ph1 = r1.replace("first ", "")
    const ph2 = r2.replace("second ", "")
    assert.equal(ph1, ph2, "同一 session 内同一原文应映射到相同占位符")

    // 还原第一次
    const out1 = { text: r1 }
    await hooks["experimental.text.complete"]({ sessionID }, out1)
    console.log(`  还原第一次: "${out1.text}"`)
    assert.equal(out1.text, "first my-secret")

    // 还原第二次
    const out2 = { text: r2 }
    await hooks["experimental.text.complete"]({ sessionID }, out2)
    console.log(`  还原第二次: "${out2.text}"`)
    assert.equal(out2.text, "second my-secret")
  })
})
