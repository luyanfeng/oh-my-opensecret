import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { redactText } from "../src/engine.js"
import { buildPatternSet } from "../src/patterns.js"
import { PlaceholderSession } from "../src/session.js"

function createSession() {
  return new PlaceholderSession({ prefix: "__OMOS_", ttlMs: 3600000, maxMappings: 1000 })
}

describe("engine.js - redactText", () => {
  it("空文本返回空", () => {
    const session = createSession()
    const patterns = buildPatternSet({})
    assert.equal(redactText("", patterns, session).text, "")
    assert.equal(redactText(null, patterns, session).text, "")
    assert.equal(redactText(undefined, patterns, session).text, "")
  })

  it("无匹配时原文不变", () => {
    const session = createSession()
    const patterns = buildPatternSet({ keywords: [{ value: "secret", placeholderId: "TEST" }] })
    const result = redactText("hello world", patterns, session)
    assert.equal(result.text, "hello world")
    assert.equal(result.matches.length, 0)
  })

  it("关键词匹配替换", () => {
    const session = createSession()
    const patterns = buildPatternSet({ keywords: [{ value: "my-api-key", placeholderId: "API_KEY" }] })
    const result = redactText("key is my-api-key", patterns, session)
    assert.ok(result.text.includes("__OMOS_"))
    assert.ok(!result.text.includes("my-api-key"))
    assert.equal(result.matches.length, 1)
  })

  it("正则匹配替换", () => {
    const session = createSession()
    const patterns = buildPatternSet({
      regex: [{ pattern: "sk-[A-Za-z0-9]{48}", placeholderId: "OPENAI_KEY" }],
    })
    const apiKey = "sk-" + "a".repeat(48)
    const result = redactText(`openai key: ${apiKey}`, patterns, session)
    assert.ok(result.text.includes("__OMOS_"))
    assert.ok(!result.text.includes(apiKey))
  })

  it("排除列表中的内容不脱敏", () => {
    const session = createSession()
    const patterns = buildPatternSet({
      keywords: [{ value: "localhost", placeholderId: "HOST" }],
      exclude: ["localhost"],
    })
    const result = redactText("host is localhost", patterns, session)
    assert.equal(result.text, "host is localhost")
    assert.equal(result.matches.length, 0)
  })

  it("重叠命中处理正确", () => {
    const session = createSession()
    const patterns = buildPatternSet({
      keywords: [
        { value: "abcdef", placeholderId: "ABC" },
        { value: "cde", placeholderId: "CDE" },
      ],
    })
    // "abcdef" 覆盖 [0,6]，"cde" 覆盖 [2,5] → 被完全包含
    const result = redactText("abcdef", patterns, session)
    assert.ok(result.text.includes("__OMOS_"))
    // 只有最外层 abcdef 被替换，cde 被包含不单独出现
    assert.equal(result.matches.length, 1)
  })

  it("多次出现同一关键词各自替换", () => {
    const session = createSession()
    const patterns = buildPatternSet({ keywords: [{ value: "xxx", placeholderId: "SECRET" }] })
    const result = redactText("xxx and xxx", patterns, session)
    assert.equal(result.matches.length, 2)
    const parts = result.text.split("__OMOS_")
    assert.equal(parts.length, 3) // 两个占位符分割三段
  })

  it("session 中同一原文复用同一占位符", () => {
    const session = createSession()
    const patterns = buildPatternSet({ keywords: [{ value: "my-secret", placeholderId: "TEST" }] })
    const r1 = redactText("my-secret", patterns, session)
    const r2 = redactText("my-secret", patterns, session)
    assert.equal(r1.text, r2.text)
  })

  it("内置规则正常工作", () => {
    const session = createSession()
    const patterns = buildPatternSet({ builtin: ["email", "ipv4"] })
    const result = redactText("contact: user@example.com, ip: 192.168.1.1", patterns, session)
    assert.ok(result.text.includes("__OMOS_"))
    assert.ok(!result.text.includes("user@example.com"))
    assert.ok(!result.text.includes("192.168.1.1"))
  })
})
