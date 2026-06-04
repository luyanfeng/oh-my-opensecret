import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreDeep, redactDeep } from "../src/deep.js"
import { PlaceholderSession } from "../src/session.js"
import { buildPatternSet } from "../src/patterns.js"

function createSession() {
  return new PlaceholderSession({ prefix: "__OMOS_", ttlMs: 3600000, maxMappings: 1000 })
}

describe("deep.js", () => {
  describe("restoreDeep", () => {
    it("还原简单对象中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("real-value", "TEST")
      const obj = { key: ph }
      restoreDeep(obj, session)
      assert.equal(obj.key, "real-value")
    })

    it("还原嵌套对象中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("secret", "TEST")
      const obj = { nested: { deep: ph } }
      restoreDeep(obj, session)
      assert.equal(obj.nested.deep, "secret")
    })

    it("还原数组中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("token-123", "TOKEN")
      const arr = ["prefix", ph, "suffix"]
      restoreDeep(arr, session)
      assert.deepEqual(arr, ["prefix", "token-123", "suffix"])
    })

    it("不存在的占位符保持不变", () => {
      const session = createSession()
      const obj = { key: "__OMOS_NONEXIST_abcdef123456__" }
      restoreDeep(obj, session)
      assert.equal(obj.key, "__OMOS_NONEXIST_abcdef123456__")
    })

    it("循环引用不爆栈", () => {
      const session = createSession()
      const obj = { name: "test" }
      obj.self = obj
      // 不应该抛异常
      restoreDeep(obj, session)
      assert.equal(obj.name, "test")
    })
  })

  describe("redactDeep", () => {
    it("脱敏简单对象中的敏感字符串", () => {
      const session = createSession()
      const patterns = buildPatternSet({ keywords: [{ value: "my-key", placeholderId: "KEY" }] })
      const obj = { apiKey: "my-key" }
      redactDeep(obj, patterns, session)
      assert.ok(obj.apiKey.includes("__OMOS_"))
      assert.ok(!obj.apiKey.includes("my-key"))
    })

    it("脱敏嵌套对象中的敏感字符串", () => {
      const session = createSession()
      const patterns = buildPatternSet({ keywords: [{ value: "nested-secret", placeholderId: "SECRET" }] })
      const obj = { outer: { inner: "nested-secret" } }
      redactDeep(obj, patterns, session)
      assert.ok(obj.outer.inner.includes("__OMOS_"))
    })

    it("跳过非 plain object（如 Date）", () => {
      const session = createSession()
      const patterns = buildPatternSet({ keywords: [{ value: "2024", placeholderId: "YEAR" }] })
      const date = new Date("2024-01-01")
      const obj = { date }
      // 不抛异常即可
      redactDeep(obj, patterns, session)
      assert.ok(obj.date instanceof Date)
    })

    it("redactDeep 与 restoreDeep 互为逆操作", () => {
      const session = createSession()
      const patterns = buildPatternSet({ keywords: [{ value: "round-trip", placeholderId: "TEST" }] })
      const original = { command: "echo round-trip", cwd: "/tmp" }
      const snapshot = { command: "echo round-trip", cwd: "/tmp" }

      redactDeep(original, patterns, session)
      // 验证已脱敏
      assert.ok(original.command.includes("__OMOS_"))
      assert.ok(!original.command.includes("round-trip"))

      restoreDeep(original, session)
      // 验证已还原
      assert.deepEqual(original, snapshot)
    })
  })
})
