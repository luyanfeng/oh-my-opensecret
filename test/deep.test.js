import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreDeep, redactDeep } from "../src/deep.js"
import { PlaceholderSession } from "../src/session.js"
import { buildPatternSet } from "../src/patterns.js"

function createSession() {
  return new PlaceholderSession({ prefix: "__OMOS_", ttlMs: 3600000, maxMappings: 1000 })
}

function deepFreeze(v) {
  if (v && typeof v === "object") {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

describe("deep.js", () => {
  describe("restoreDeep", () => {
    it("还原简单对象中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("real-value", "TEST")
      const obj = { key: ph }
      const result = restoreDeep(obj, session)
      assert.equal(result.key, "real-value")
      assert.notEqual(result, obj)
      assert.equal(obj.key, ph)
    })

    it("还原嵌套对象中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("secret", "TEST")
      const obj = { nested: { deep: ph } }
      const result = restoreDeep(obj, session)
      assert.equal(result.nested.deep, "secret")
      assert.equal(obj.nested.deep, ph)
    })

    it("还原数组中的占位符", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("token-123", "TOKEN")
      const arr = ["prefix", ph, "suffix"]
      const result = restoreDeep(arr, session)
      assert.deepEqual(result, ["prefix", "token-123", "suffix"])
      assert.deepEqual(arr, ["prefix", ph, "suffix"])
    })

    it("不存在的占位符保持不变", () => {
      const session = createSession()
      const obj = { key: "__OMOS_NONEXIST_abcdef123456__" }
      const result = restoreDeep(obj, session)
      assert.equal(result.key, "__OMOS_NONEXIST_abcdef123456__")
    })

    it("循环引用不爆栈", () => {
      const session = createSession()
      const obj = { name: "test" }
      obj.self = obj
      let result
      // 不应该抛异常
      assert.doesNotThrow(() => {
        result = restoreDeep(obj, session)
      })
      assert.equal(result.name, "test")
      assert.equal(result.self, result)
    })

    it("非对象入参原样返回", () => {
      const session = createSession()
      assert.equal(restoreDeep("plain string", session), "plain string")
      assert.equal(restoreDeep(null, session), null)
      assert.equal(restoreDeep(undefined, session), undefined)
      assert.equal(restoreDeep(42, session), 42)
    })

    it("非 plain object（如 Date）原样返回同一引用", () => {
      const session = createSession()
      const date = new Date("2024-01-01")
      const result = restoreDeep({ date }, session)
      assert.equal(result.date, date)
    })

    it("冻结的 question 工具参数可还原且不修改原对象", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("real-value", "TEST")
      const input = deepFreeze({
        question: `请使用 ${ph} 继续`,
        header: ph,
        options: [{ label: ph, description: `使用 ${ph}` }],
        multiple: false,
      })

      let result
      assert.doesNotThrow(() => {
        result = restoreDeep(input, session)
      })

      assert.equal(result.question, "请使用 real-value 继续")
      assert.equal(result.header, "real-value")
      assert.equal(result.options[0].label, "real-value")
      assert.equal(result.options[0].description, "使用 real-value")
      assert.equal(result.multiple, false)

      // 原对象未被修改
      assert.equal(input.question, `请使用 ${ph} 继续`)
      assert.equal(input.header, ph)
      assert.equal(input.options[0].label, ph)
      assert.ok(Object.isFrozen(input))
      assert.ok(Object.isFrozen(input.options))
      assert.ok(Object.isFrozen(input.options[0]))
    })

    it("未冻结的普通对象常规路径还原正常", () => {
      const session = createSession()
      const ph = session.getOrCreatePlaceholder("plain-secret", "TEST")
      const input = { command: `echo ${ph}`, args: ["--flag", ph], nested: { key: ph } }
      const result = restoreDeep(input, session)
      assert.deepEqual(result, {
        command: "echo plain-secret",
        args: ["--flag", "plain-secret"],
        nested: { key: "plain-secret" },
      })
      assert.equal(input.command, `echo ${ph}`)
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

      const restored = restoreDeep(original, session)
      // 验证已还原
      assert.deepEqual(restored, snapshot)
    })
  })
})
