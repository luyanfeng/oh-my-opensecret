import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import yaml from "js-yaml"

describe("config.js - profile 合并", () => {
  it("无 profile 时使用 base patterns", async () => {
    const { loadConfig } = await import("../src/config.js")
    const dir = path.join(__dirname, "..", ".test-tmp", "profile-none")
    await fs.mkdir(dir, { recursive: true })

    const cfgYaml = `enabled: true\nauto_discovery: false\npatterns:\n  builtin: [email]\n  regex:\n    - { pattern: "sk-[A-Za-z0-9]{48}", placeholderId: "OPENAI_KEY" }`
    await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

    const cfg = await loadConfig(dir, { info: () => {}, debug: () => {} })
    assert.deepEqual(cfg.patterns.builtin, ["email"])
    assert.equal(cfg.patterns.regex.length, 1)
    assert.equal(cfg.profile, "")
  })

  it("激活 profile 时 keywords/regex 拼接，builtin 覆盖", async () => {
    const { loadConfig } = await import("../src/config.js")
    const dir = path.join(__dirname, "..", ".test-tmp", "profile-merge")
    await fs.mkdir(dir, { recursive: true })

    const cfgYaml = `enabled: true\nauto_discovery: false\nprofile: "test-profile"\npatterns:\n  keywords:\n    - { value: "global-key", placeholderId: "GLOBAL" }\n  regex:\n    - { pattern: "global-regex", placeholderId: "GLOBAL" }\n  builtin: [email]\n  exclude: ["example.com"]\nprofiles:\n  test-profile:\n    patterns:\n      keywords:\n        - { value: "profile-key", placeholderId: "PROFILE" }\n      regex:\n        - { pattern: "profile-regex", placeholderId: "PROFILE" }\n      builtin: [uuid, jwt]\n      exclude: ["localhost"]`
    await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

    const cfg = await loadConfig(dir, { info: () => {}, debug: () => {} })

    // keywords 拼接
    assert.equal(cfg.patterns.keywords.length, 2)
    assert.equal(cfg.patterns.keywords[0].value, "global-key")
    assert.equal(cfg.patterns.keywords[1].value, "profile-key")

    // regex 拼接
    assert.equal(cfg.patterns.regex.length, 2)

    // builtin 被 profile 覆盖
    assert.deepEqual(cfg.patterns.builtin, ["uuid", "jwt"])

    // exclude 被 profile 覆盖
    assert.deepEqual(cfg.patterns.exclude, ["localhost"])

    assert.equal(cfg.profile, "test-profile")
  })

  it("profile 不存在时回退到 base patterns", async () => {
    const { loadConfig } = await import("../src/config.js")
    const dir = path.join(__dirname, "..", ".test-tmp", "profile-missing")
    await fs.mkdir(dir, { recursive: true })

    const cfgYaml = `enabled: true\nauto_discovery: false\nprofile: "non-existent"\npatterns:\n  builtin: [email]\nprofiles:\n  other:\n    patterns:\n      builtin: [uuid]`
    await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

    const cfg = await loadConfig(dir, { info: () => {}, debug: () => {} })
    assert.deepEqual(cfg.patterns.builtin, ["email"])
  })
})
