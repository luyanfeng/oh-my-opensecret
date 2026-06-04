import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, "..", ".test-tmp")

// 辅助：清理并创建临时目录
async function setup(tmpDir) {
  await fs.rm(tmpDir, { recursive: true, force: true })
  await fs.mkdir(tmpDir, { recursive: true })
}

// 辅助：清理临时目录
async function teardown(tmpDir) {
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe("config.js", () => {
  let testDir

  before(async () => {
    testDir = path.join(TMP, "config-test")
    await setup(testDir)
  })

  after(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  it("无配置时自动生成默认配置", async () => {
    // 设置 OPENCODE_SECRET_CONFIG 指向不存在的路径，避免受全局配置干扰
    const oldEnv = process.env.OPENCODE_SECRET_CONFIG
    const isoDir = path.join(TMP, "isolated-" + crypto.randomBytes(4).toString("hex"))
    await fs.mkdir(isoDir, { recursive: true })
    process.env.OPENCODE_SECRET_CONFIG = path.join(isoDir, "no-such-file.yaml")

    const { loadConfig } = await import("../src/config.js")
    const log = { info: () => {}, debug: () => {}, warn: () => {} }

    const cfg = await loadConfig(isoDir, log)

    assert.equal(cfg.enabled, true)
    assert.equal(cfg.autoDiscovery, true)
    assert.equal(cfg.prefix, "__OMOS_")
    assert.ok(cfg.loadedFrom)
    // 环境变量指定时生成到环境变量路径，否则生成到全局目录
    assert.ok(
      !process.env.OPENCODE_SECRET_CONFIG || cfg.loadedFrom.includes("isolated"),
      "环境变量指定时应生成到环境变量指向的路径",
    )

    // 确认文件已创建
    const content = await fs.readFile(cfg.loadedFrom, "utf8")
    assert.ok(content.includes("auto_discovery: true"))
    assert.ok(content.includes("OPENAI_KEY"))

    if (oldEnv) process.env.OPENCODE_SECRET_CONFIG = oldEnv
    else delete process.env.OPENCODE_SECRET_CONFIG
    await fs.rm(isoDir, { recursive: true, force: true })
  })

  it("自动发现 Opencode 配置中的 apiKey", async () => {
    // 创建 mock Opencode 配置
    const opencodeConfig = {
      apiKey: "sk-test-key-123456789",
      providers: {
        openai: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
        },
        github: {
          token: "ghp_testPersonalAccessToken123",
        },
      },
    }
    await fs.writeFile(
      path.join(testDir, "opencode.json"),
      JSON.stringify(opencodeConfig, null, 2),
      "utf8",
    )

    // 设环境变量隔离，避免加载全局配置
    const oldEnv = process.env.OPENCODE_SECRET_CONFIG
    process.env.OPENCODE_SECRET_CONFIG = path.join(testDir, "nonexistent.yaml")

    const { loadConfig } = await import("../src/config.js")
    const log = { info: () => {}, debug: () => {}, warn: () => {} }
    const cfg = await loadConfig(testDir, log)

    // 确认自动发现的未覆盖值以注释写入配置文件
    const content = await fs.readFile(cfg.loadedFrom, "utf8")
    assert.ok(content.includes("auto-discovered"), "未覆盖的敏感值应以注释标记")
    // 不应包含原文
    assert.ok(!content.includes("sk-test-key"), "不应包含原文")
    assert.ok(!content.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "不应包含原文")

    if (oldEnv) process.env.OPENCODE_SECRET_CONFIG = oldEnv
    else delete process.env.OPENCODE_SECRET_CONFIG
  })

  it("4 级配置查找优先级正确", async () => {
    const subDir = path.join(TMP, "lookup-test")
    await setup(subDir)

    // 在 project root 放一个配置
    const projectCfg = { enabled: true, logging: { level: "debug" }, placeholder_prefix: "__TEST_" }
    await fs.writeFile(path.join(subDir, "oh-my-opensecret.yaml"), JSON.stringify(projectCfg), "utf8")

    const { loadConfig } = await import("../src/config.js")
    const log = { info: () => {}, debug: () => {}, warn: () => {} }
    const cfg = await loadConfig(subDir, log)

    assert.ok(cfg.loadedFrom.includes("oh-my-opensecret.yaml"))
  })
})

describe("logger.js", () => {
  it("分级日志：level 过滤正确", async () => {
    const { Logger } = await import("../src/logger.js")
    const tmpLog = path.join(TMP, "logger-level-test.log")
    await fs.rm(tmpLog, { force: true })

    const log = new Logger({ level: "warn", filePath: tmpLog })
    log.debug("should not appear")
    log.info("should not appear either")
    log.warn("test warning")

    await log.flush()

    const content = await fs.readFile(tmpLog, "utf8")
    assert.ok(!content.includes("should not appear"), "debug 级别的日志不应输出")
    assert.ok(!content.includes("should not appear either"), "info 级别的日志不应输出")
    assert.ok(content.includes("test warning"), "warn 级别的日志应输出")
    await fs.rm(tmpLog, { force: true })
  })
})
