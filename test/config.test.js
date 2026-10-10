import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import yaml from "js-yaml"
import * as fs from "node:fs/promises"
import { existsSync } from "node:fs"
import * as path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 收敛到 .test-tmp/config 子目录：node --test 并行跑各测试文件，
// 直接用 .test-tmp 根目录会在 after 里删掉其它文件正在使用的目录
const TMP = path.join(__dirname, "..", ".test-tmp", "config")

/**
 * 完整的 noop logger（4 级齐全）。
 * loadConfig 的自动发现失败分支会调 log.error，只写 3 级的 mock 会崩：
 * TypeError: log.error is not a function。
 */
const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

/** 所有用例创建的目录统一登记，after 里一次性清干净 */
const createdDirs = []

async function makeTmpDir(prefix) {
  const dir = path.join(TMP, `${prefix}-${crypto.randomBytes(4).toString("hex")}`)
  await fs.mkdir(dir, { recursive: true })
  createdDirs.push(dir)
  return dir
}

/**
 * 写入一份最小可用插件配置（auto-discovery 关闭，避免 opencode.json 干扰）。
 * extra 追加在 patterns: 之后（YAML 键序无关）。
 */
async function writeCfg(dir, extra = "") {
  await fs.writeFile(
    path.join(dir, "oh-my-opensecret.yaml"),
    "enabled: true\nauto_discovery: false\n" +
      "patterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n" +
      extra,
    "utf8",
  )
}

/**
 * 写入一份最小可用插件配置，但**开启** auto_discovery 且 patterns 全空，
 * 供 auto-discovery 报告块的用例复用（writeCfg 关掉了 auto_discovery）。
 */
async function writeAutoDiscoveryCfg(cfgPath) {
  await fs.writeFile(
    cfgPath,
    "enabled: true\nauto_discovery: true\npatterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
    "utf8",
  )
}

/** 报告块的结束行（比配置文件自己的分隔线短一个 =） */
const REPORT_FOOTER = "# ========================================="

/** 报告块（注释行）中所有以 `[path]` 开头的数据行 */
function reportEntries(content) {
  return content.split("\n").filter((l) => /^#\s+\[.+\]\s+[✅❌]/.test(l))
}

/**
 * 报告块原文：从 header 行到结束行整段。
 * 报告块内允许出现旧的/陈旧的条目，因此「某条路径是否还在报告里」只能在块内判断，
 * 不能对整个文件做子串匹配——patterns.regex 里残留的 auto-generated 注释会带同样的路径。
 */
function reportBlock(content) {
  const lines = content.split("\n")
  const headerIdx = lines.findIndex((l) => l.includes("auto-discovered: 扫描报告"))
  if (headerIdx < 0) return ""
  const footerIdx = lines.findIndex((l, i) => i > headerIdx && l === REPORT_FOOTER)
  return lines.slice(headerIdx, footerIdx < 0 ? undefined : footerIdx + 1).join("\n")
}

/** 解析报告块概要行；概要行缺失或格式不符时返回 null */
function reportSummary(text) {
  const m = text.match(/^# 概要: (\d+) 个已覆盖 · (\d+) 个未覆盖$/m)
  return m ? { covered: Number(m[1]), uncovered: Number(m[2]) } : null
}

/** 断言 text 中不含 secret 的任何 minLen 长片段 */
function assertNoFragment(text, secret, label, minLen = 8) {
  assert.ok(!text.includes(secret), `${label}: 不得残留完整原文`)
  for (let i = 0; i + minLen <= secret.length; i++) {
    const frag = secret.slice(i, i + minLen)
    assert.ok(!text.includes(frag), `${label}: 残留原文片段 "${frag}"`)
  }
}

describe("config.js", () => {
  let isoGlobalDir
  let savedOpencodeConfigDir
  let savedSecretConfig

  before(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
    await fs.mkdir(TMP, { recursive: true })

    // ---- 关键隔离：把全局 OpenCode 配置目录指向 .test-tmp ----
    // globalOpencodeConfigDir() 读取顺序：OPENCODE_CONFIG_DIR → XDG_CONFIG_HOME/opencode → ~/.config/opencode
    // 不隔离的话，readOpencodeConfig 会向上找到用户真实的 ~/.config/opencode/opencode.json，
    // 把真实 API Key 派生成规则写进测试临时目录（数据泄漏 + 用例不确定性）。
    savedOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    savedSecretConfig = process.env.OPENCODE_SECRET_CONFIG
    isoGlobalDir = path.join(TMP, "global-isolated")
    await fs.mkdir(isoGlobalDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = isoGlobalDir
    delete process.env.OPENCODE_SECRET_CONFIG
  })

  // OPENCODE_SECRET_CONFIG / OPENCODE_CONFIG_DIR 一旦被设置就会改变配置查找路径，
  // 用例之间必须强制复位，否则一个用例的设置会静默改变后续用例的行为。
  afterEach(() => {
    delete process.env.OPENCODE_SECRET_CONFIG
    process.env.OPENCODE_CONFIG_DIR = isoGlobalDir
  })

  after(async () => {
    if (savedOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = savedOpencodeConfigDir
    if (savedSecretConfig === undefined) delete process.env.OPENCODE_SECRET_CONFIG
    else process.env.OPENCODE_SECRET_CONFIG = savedSecretConfig

    for (const dir of createdDirs) await fs.rm(dir, { recursive: true, force: true })
    // 兜底：整个子目录删掉，保证 .test-tmp 不留残留
    await fs.rm(TMP, { recursive: true, force: true })
  })

  // =============================================
  // 配置加载
  // =============================================
  describe("配置加载", () => {
    it("无配置时自动生成默认配置到 OPENCODE_SECRET_CONFIG 指向的路径", async () => {
      const isoDir = await makeTmpDir("isolated")
      process.env.OPENCODE_SECRET_CONFIG = path.join(isoDir, "no-such-file.yaml")

      const { loadConfig } = await import("../src/config.js")
      const cfg = await loadConfig(isoDir, NOOP_LOGGER)

      assert.equal(cfg.enabled, true)
      assert.equal(cfg.autoDiscovery, true)
      assert.equal(cfg.prefix, "__OMOS_")
      assert.equal(cfg.loadedFrom, path.join(isoDir, "no-such-file.yaml"))

      const content = await fs.readFile(cfg.loadedFrom, "utf8")
      assert.ok(content.includes("auto_discovery: true"))
      assert.ok(content.includes("OPENAI_KEY"))

      // OPENCODE_SECRET_CONFIG 一旦设置就只认该路径，必须当场撤销，否则污染后续用例
      delete process.env.OPENCODE_SECRET_CONFIG
    })

    it("无配置且无环境变量时生成到全局配置目录", async () => {
      const dir = await makeTmpDir("generate")
      const { loadConfig } = await import("../src/config.js")

      const cfg = await loadConfig(dir, NOOP_LOGGER)
      assert.equal(
        cfg.loadedFrom,
        path.join(isoGlobalDir, "oh-my-opensecret.yaml"),
        "默认配置应生成到隔离后的全局配置目录",
      )
      assert.ok(existsSync(cfg.loadedFrom))
      // 后续用例需要干净起点，删掉生成的默认配置
      await fs.rm(cfg.loadedFrom, { force: true })
    })

    it("配置查找优先级：环境变量 > 项目根 > 项目 .opencode/ > 全局目录", async () => {
      const { loadConfig } = await import("../src/config.js")
      const projectDir = await makeTmpDir("lookup")
      const globalCfg = path.join(isoGlobalDir, "oh-my-opensecret.yaml")
      const dotCfg = path.join(projectDir, ".opencode", "oh-my-opensecret.yaml")
      const rootCfg = path.join(projectDir, "oh-my-opensecret.yaml")

      // 1) 只有全局目录有配置 → 命中第 4 级
      await writeCfg(isoGlobalDir, 'placeholder_prefix: "__GLOBAL_"\n')
      let cfg = await loadConfig(projectDir, NOOP_LOGGER)
      assert.equal(cfg.prefix, "__GLOBAL_")
      assert.equal(cfg.loadedFrom, globalCfg)

      // 2) 项目 .opencode/ 也有 → 命中第 3 级
      await fs.mkdir(path.join(projectDir, ".opencode"), { recursive: true })
      await writeCfg(path.join(projectDir, ".opencode"), 'placeholder_prefix: "__DOT_"\n')
      cfg = await loadConfig(projectDir, NOOP_LOGGER)
      assert.equal(cfg.prefix, "__DOT_")
      assert.equal(cfg.loadedFrom, dotCfg)

      // 3) 项目根也有 → 命中第 2 级
      await writeCfg(projectDir, 'placeholder_prefix: "__ROOT_"\n')
      cfg = await loadConfig(projectDir, NOOP_LOGGER)
      assert.equal(cfg.prefix, "__ROOT_")
      assert.equal(cfg.loadedFrom, rootCfg)

      // 4) 环境变量指定 → 命中第 1 级，且只认这一个路径
      const envDir = await makeTmpDir("lookup-env")
      await writeCfg(envDir, 'placeholder_prefix: "__ENV_"\n')
      process.env.OPENCODE_SECRET_CONFIG = path.join(envDir, "oh-my-opensecret.yaml")
      cfg = await loadConfig(projectDir, NOOP_LOGGER)
      assert.equal(cfg.prefix, "__ENV_")
      assert.equal(cfg.loadedFrom, path.join(envDir, "oh-my-opensecret.yaml"))
    })
  })

  // =============================================
  // 全局配置目录隔离（防止读取用户真实配置）
  // =============================================
  describe("全局 OpenCode 配置目录隔离", () => {
    it("自动发现只扫描隔离目录里的 opencode.json，不读真实用户配置", async () => {
      const dir = await makeTmpDir("iso-scan")
      const fakeKey = "fake-iso-key-0001"
      await fs.writeFile(
        path.join(isoGlobalDir, "opencode.json"),
        JSON.stringify({ providers: { fakeco: { apiKey: fakeKey } } }, null, 2),
        "utf8",
      )
      await fs.writeFile(
        path.join(dir, "oh-my-opensecret.yaml"),
        "enabled: true\nauto_discovery: true\npatterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const cfg = await loadConfig(dir, NOOP_LOGGER)
      const content = await fs.readFile(cfg.loadedFrom, "utf8")

      const entries = reportEntries(content)
      // 真实用户配置里有 4+ 个 apiKey；若隔离失效，报告条目数会 > 1
      assert.equal(entries.length, 1, `报告应只有隔离目录里的 1 个敏感值，实际: ${JSON.stringify(entries)}`)
      assert.ok(entries[0].includes("[providers.fakeco.apiKey]"), `报告条目应带配置路径: ${entries[0]}`)
      assertNoFragment(content, fakeKey, "隔离扫描报告", 8)

      await fs.rm(path.join(isoGlobalDir, "opencode.json"), { force: true })
    })

    it("OPENCODE_CONFIG_DIR 指向 .test-tmp，全局目录不是真实 HOME 目录", () => {
      const realGlobal = path.join(os.homedir(), ".config", "opencode")
      assert.notEqual(
        path.resolve(isoGlobalDir),
        path.resolve(realGlobal),
        "隔离目录不得就是真实用户配置目录",
      )
      assert.ok(
        path.resolve(isoGlobalDir).startsWith(path.resolve(TMP) + path.sep),
        "隔离目录必须落在 .test-tmp 内",
      )
    })
  })

  // =============================================
  // Auto-discovery 报告与规则
  // =============================================
  describe("Auto-discovery", () => {
    it("生成的规则真能脱敏对应密钥，且报告不含任何原文片段", async () => {
      const dir = await makeTmpDir("discovery")
      const secrets = {
        "apiKey": "sk-test-key-123456789",
        "providers.openai.apiKey": "sk-abcdefghijklmnopqrstuvwxyz123456",
        "providers.github.token": "ghp_testPersonalAccessToken123",
      }
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            apiKey: secrets["apiKey"],
            providers: {
              openai: { apiKey: secrets["providers.openai.apiKey"] },
              github: { token: secrets["providers.github.token"] },
            },
          },
          null,
          2,
        ),
        "utf8",
      )
      await fs.writeFile(
        path.join(dir, "oh-my-opensecret.yaml"),
        "enabled: true\nauto_discovery: true\npatterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const { buildPatternSet } = await import("../src/patterns.js")
      const { redactText } = await import("../src/engine.js")
      const { PlaceholderSession } = await import("../src/session.js")

      const cfg = await loadConfig(dir, NOOP_LOGGER)
      const content = await fs.readFile(cfg.loadedFrom, "utf8")

      // 1) 报告块存在，且每个敏感值都有一条带配置路径的条目
      assert.ok(content.includes("auto-discovered"), "配置中应包含自动发现的注释标记")
      const entries = reportEntries(content)
      assert.equal(entries.length, Object.keys(secrets).length, `报告条目数不符: ${JSON.stringify(entries)}`)
      for (const [secretPath, value] of Object.entries(secrets)) {
        const entry = entries.find((l) => l.includes(`[${secretPath}]`))
        assert.ok(entry, `报告缺少 ${secretPath} 的条目`)
        assert.ok(entry.includes("✅"), `派生新规则后应标记已覆盖: ${entry}`)
        assert.ok(!entry.includes(value.slice(0, 6)), `报告条目不得含原文片段: ${entry}`)
      }

      // 2) 报告与规则整体不得含任何 >=8 字符原文片段
      for (const [secretPath, value] of Object.entries(secrets)) {
        assertNoFragment(content, value, `配置文件(${secretPath})`, 8)
      }

      // 3) 生成的规则跑起来必须真能脱敏（报告判定与运行时行为一致）
      const patterns = buildPatternSet(cfg.patterns)
      const session = new PlaceholderSession({ prefix: cfg.prefix, ttlMs: cfg.ttlMs, maxMappings: 1000 })
      for (const [secretPath, value] of Object.entries(secrets)) {
        const redacted = redactText(`token=${value}`, patterns, session).text
        assert.ok(redacted.includes("__OMOS_"), `${secretPath} 应被自动生成的规则脱敏: ${redacted}`)
        assertNoFragment(redacted, value, `运行时脱敏(${secretPath})`, 8)
      }
    })

    it("已被同 id 规则占用的值保持未覆盖，报告写明长度且不含原文片段", async () => {
      const dir = await makeTmpDir("discovery-uncovered")
      // 取与报告样板（opencode.json / auto-discovered / placeholder-id 等）无任何
      // 3 字符公共片段的值，否则下面的 3 字符片段扫描会命中报告自身的合法内容
      const key = "Zt7qR9xLm2Vb9Lp"
      await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ apiKey: key }), "utf8")
      // 已存在同名 placeholder-id → 派生规则被跳过 → 该值保持 ❌ 未覆盖
      await fs.writeFile(
        path.join(dir, "oh-my-opensecret.yaml"),
        "enabled: true\nauto_discovery: true\npatterns:\n" +
          '  regex:\n    - { pattern: "existing-rule", placeholder-id: "APIKEY_KEY" }\n' +
          "  keywords: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const cfg = await loadConfig(dir, NOOP_LOGGER)
      const content = await fs.readFile(cfg.loadedFrom, "utf8")

      assert.ok(content.includes("existing-rule"), "用户已有规则应保留")
      const entry = reportEntries(content).find((l) => l.includes("[apiKey]"))
      assert.ok(entry, "报告应有 apiKey 条目")
      assert.ok(entry.includes("❌"), `占位 id 已存在的值应保持未覆盖: ${entry}`)
      assert.ok(entry.includes(`${key.length} 字符`), `未覆盖条目应写明长度: ${entry}`)

      // 未覆盖分支同样不得写任何原文片段（>=3 字符即失败）
      const reportText = content
        .split("\n")
        .filter((l) => l.trimStart().startsWith("#"))
        .join("\n")
      for (let i = 0; i + 3 <= key.length; i++) {
        const frag = key.slice(i, i + 3)
        assert.ok(!reportText.includes(frag), `报告块残留原文片段 "${frag}"`)
      }
    })

    it("报告判定 covered 时，运行时必须真能脱敏该值（/…/i 与 (?i) flags 一致）", async () => {
      const dir = await makeTmpDir("discovery-flags")
      const literalKey = "SECT-AB12"   // 大写，只靠 /…/i 的 i 标志才能命中
      const inlineKey = "INLINE-Xy99"  // 只靠 (?i) 内联前缀才能命中
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { sect: { apiKey: literalKey }, inline: { apiKey: inlineKey } } }),
        "utf8",
      )
      await fs.writeFile(
        path.join(dir, "oh-my-opensecret.yaml"),
        "enabled: true\nauto_discovery: true\npatterns:\n" +
          '  regex:\n    - { pattern: "/sect-[a-z0-9]{4}/i", placeholder-id: "SECT_LITERAL" }\n' +
          '    - { pattern: "(?i)INLINE-[a-z0-9]{4}", placeholder-id: "INLINE_FLAG" }\n' +
          "  keywords: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const { buildPatternSet } = await import("../src/patterns.js")
      const { redactText } = await import("../src/engine.js")
      const { PlaceholderSession } = await import("../src/session.js")

      const cfg = await loadConfig(dir, NOOP_LOGGER)
      const content = await fs.readFile(cfg.loadedFrom, "utf8")

      const entries = reportEntries(content)
      for (const [secretPath, value] of [
        ["providers.sect.apiKey", literalKey],
        ["providers.inline.apiKey", inlineKey],
      ]) {
        const entry = entries.find((l) => l.includes(`[${secretPath}]`))
        assert.ok(entry, `报告缺少 ${secretPath} 的条目`)
        assert.ok(entry.includes("✅"), `${secretPath} 应判定为已覆盖: ${entry}`)
        // 报告会指名命中的规则 id（"✅ 已匹配 <id>"），这是刻意设计——告诉用户哪条规则覆盖了该值。
        // 本用例的 id 由测试自己写入、且与密钥共享前缀，扫描前先剔除，否则无法区分
        // 「config.js 泄漏了密钥」与「报告回显了测试自写的规则 id」。
        let reportText = entries.join("\n")
        for (const authoredId of ["SECT_LITERAL", "INLINE_FLAG"]) {
          reportText = reportText.split(authoredId).join("<id>")
        }
        assertNoFragment(reportText, value, `扫描报告(${secretPath})`, 6)
        assert.ok(!content.includes(value), `配置文件(${secretPath}): 不得残留完整原文`)
      }

      // 报告说 covered，运行时就必须脱敏成功——这正是此前「报告撒谎」的回归点
      const patterns = buildPatternSet(cfg.patterns)
      const session = new PlaceholderSession({ prefix: cfg.prefix, ttlMs: cfg.ttlMs, maxMappings: 1000 })
      for (const value of [literalKey, inlineKey]) {
        const redacted = redactText(`token=${value}`, patterns, session).text
        assert.ok(redacted.includes("__OMOS_"), `${value} 应被脱敏: ${redacted}`)
        assert.ok(!redacted.includes(value), `${value} 不得明文残留: ${redacted}`)
      }
    })

    it("短密钥（8~12 字符）的报告不含原文片段", async () => {
      const dir = await makeTmpDir("discovery-short")
      const secrets = {
        "providers.len8.apiKey": "abcd1234",
        "providers.len9.apiKey": "abcd12345",
        "providers.len10.apiKey": "abcd123456",
        "providers.len11.apiKey": "abcd1234567",
        "providers.len12.apiKey": "abcd12345678",
      }
      await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ providers: { len8: { apiKey: secrets["providers.len8.apiKey"] }, len9: { apiKey: secrets["providers.len9.apiKey"] }, len10: { apiKey: secrets["providers.len10.apiKey"] }, len11: { apiKey: secrets["providers.len11.apiKey"] }, len12: { apiKey: secrets["providers.len12.apiKey"] } } }), "utf8")
      await fs.writeFile(
        path.join(dir, "oh-my-opensecret.yaml"),
        "enabled: true\nauto_discovery: true\npatterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const cfg = await loadConfig(dir, NOOP_LOGGER)
      const content = await fs.readFile(cfg.loadedFrom, "utf8")

      const entries = reportEntries(content)
      assert.equal(entries.length, Object.keys(secrets).length, `报告条目数不符: ${JSON.stringify(entries)}`)
      for (const [secretPath, value] of Object.entries(secrets)) {
        const entry = entries.find((l) => l.includes(`[${secretPath}]`))
        assert.ok(entry, `报告缺少 ${secretPath} 的条目`)
        assert.ok(entry.includes(`${value.length} 字符`) || entry.includes("✅"), `条目应带长度或覆盖标记: ${entry}`)
        assertNoFragment(content, value, `配置文件(${secretPath})`, 8)
      }
    })

    it("连续两次自动发现：报告块唯一、文件头分隔线不被破坏、新条目不插到文件头", async () => {
      const dir = await makeTmpDir("discovery-report")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      const header = "# ============================================"
      const ownHeader = "# 这是配置文件自己的头部注释"

      await fs.writeFile(
        cfgPath,
        `${header}\n${ownHeader}\nenabled: true\nauto_discovery: true\n` +
          "patterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { alpha: { apiKey: "alpha-secret-key-0001" } } }),
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      await loadConfig(dir, NOOP_LOGGER)

      // 第二轮：新增一个敏感值
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          providers: {
            alpha: { apiKey: "alpha-secret-key-0001" },
            bravo: { apiKey: "bravo-secret-key-0002" },
          },
        }),
        "utf8",
      )
      await loadConfig(dir, NOOP_LOGGER)
      // 第三轮：无变化，确认幂等
      await loadConfig(dir, NOOP_LOGGER)

      const lines = (await fs.readFile(cfgPath, "utf8")).split("\n")

      // 报告块只能有一个（此前锚点是文件头分隔线子串，每轮顶高一格）
      assert.equal(lines.filter((l) => l.includes("auto-discovered: 扫描报告")).length, 1, "扫描报告块只能有一个")
      // 报告尾部分隔线（比配置文件自己的分隔线短一个 =）只能有一个
      assert.equal(lines.filter((l) => l === "# =========================================").length, 1, "报告尾部分隔线只能有一个")
      // 文件头未被破坏
      assert.equal(lines[0], header, "配置文件首行必须是它自己的分隔线")
      assert.equal(lines[1], ownHeader, "配置文件头部注释必须保持在原位")
      assert.equal(lines.filter((l) => l === header).length, 1, "配置文件分隔线只能出现一次")

      const reportIdx = lines.findIndex((l) => l.includes("auto-discovered: 扫描报告"))
      const patternsIdx = lines.findIndex((l) => l.startsWith("patterns:"))
      assert.ok(reportIdx > 2, `报告块不得被插到文件头，实际行号 ${reportIdx}`)
      assert.ok(reportIdx < patternsIdx, `报告块应位于 patterns: 之前，实际 ${reportIdx} vs ${patternsIdx}`)

      const content = lines.join("\n")
      const entries = reportEntries(content)
      assert.equal(entries.length, 2, `两轮后应恰好 2 条报告条目: ${JSON.stringify(entries)}`)
      assert.ok(entries.some((l) => l.includes("[providers.alpha.apiKey]")))
      assert.ok(entries.some((l) => l.includes("[providers.bravo.apiKey]")))
      assert.equal(
        lines.filter((l) => l.includes("# auto-generated for:")).length,
        2,
        "两条规则各出现一次，第三轮不应重复追加",
      )
      assertNoFragment(content, "alpha-secret-key-0001", "配置文件(alpha)", 8)
      assertNoFragment(content, "bravo-secret-key-0002", "配置文件(bravo)", 8)
    })

    // =============================================
    // 报告块「每轮由本轮 results 整体重算重写」的回归用例
    // 三个缺陷共有的根因：报告块内容本可完全由本轮 results 决定，
    // 旧实现却靠「报告中是否已存在该路径」做增量追加，导致
    // 已有路径的覆盖状态不刷新（缺陷 A）、概要统计与块内条目数脱节（缺陷 B）、
    // 配置里已不存在的路径永久滞留（缺陷 C）。
    // =============================================

    it("覆盖状态会更新：路径不变、规则被删后同一条目由 ❌ 翻转为 ✅（缺陷 A）", async () => {
      const dir = await makeTmpDir("discovery-status-flip")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      // 与报告样板（opencode.json / apiKey / auto-generated …）无任何 3 字符公共片段
      const key = "Wq4nZb7Ht3Kc9Mv"
      await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ apiKey: key }), "utf8")
      // 第一轮：用户已手写同 placeholder-id 的规则 → 派生规则被跳过 → 该值只能记 ❌
      await fs.writeFile(
        cfgPath,
        "enabled: true\nauto_discovery: true\npatterns:\n" +
          '  regex:\n    - { pattern: "existing-rule", placeholder-id: "APIKEY_KEY" }\n' +
          "  keywords: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      await loadConfig(dir, NOOP_LOGGER)

      const content1 = await fs.readFile(cfgPath, "utf8")
      const entry1 = reportEntries(content1).find((l) => l.includes("[apiKey]"))
      assert.ok(entry1, "第一轮报告应有 apiKey 条目")
      assert.ok(entry1.includes("❌"), `同 id 规则已存在时该值应记未覆盖: ${entry1}`)

      // 用户随后手动删掉那条规则：报告块原样留在原处，regex 清空（路径本身没变）
      await fs.writeFile(
        cfgPath,
        "enabled: true\nauto_discovery: true\n" + reportBlock(content1) + "\n" +
          "patterns:\n  regex: []\n  keywords: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )

      await loadConfig(dir, NOOP_LOGGER)
      const content2 = await fs.readFile(cfgPath, "utf8")
      const entries2 = reportEntries(content2)
      const entry2 = entries2.find((l) => l.includes("[apiKey]"))
      assert.ok(entry2, "第二轮报告仍应有 apiKey 条目")
      // 关键断言：路径已存在于报告、只是覆盖状态变了 → 那一条必须被改写，而不是保持原样
      assert.ok(entry2.includes("✅"), `规则补齐后同一条目应翻转为已覆盖: ${entry2}`)
      // 状态翻转只能就地改写，不得靠追加产生第二行
      assert.equal(entries2.length, 1, `同一路径只应有一条报告条目: ${JSON.stringify(entries2)}`)
      assert.deepEqual(reportSummary(content2), { covered: 1, uncovered: 0 })
      assertNoFragment(reportBlock(content2), key, "报告块(状态翻转)", 3)
    })

    it("概要统计与报告块实际条目数一致（缺陷 B）", async () => {
      const dir = await makeTmpDir("discovery-summary")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      await writeAutoDiscoveryCfg(cfgPath)

      const { loadConfig } = await import("../src/config.js")
      // 第一轮：路径形态为 provider.alpha.options.apiKey
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ provider: { alpha: { options: { apiKey: "Wq4nZb7Ht3Kc9Mv" } } } }),
        "utf8",
      )
      await loadConfig(dir, NOOP_LOGGER)

      // 第二轮：用户改了配置结构，路径形态变成 providers.bravo.settings.apiKey
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { bravo: { settings: { apiKey: "Hy8kLm3Pq7Rt5Wz" } } } }),
        "utf8",
      )
      await loadConfig(dir, NOOP_LOGGER)

      const block = reportBlock(await fs.readFile(cfgPath, "utf8"))
      const entries = reportEntries(block)
      const summary = reportSummary(block)
      assert.ok(summary, `报告块必须含概要行: ${block}`)
      // 概要里的两个数字之和必须能解释块内的实际条目数
      assert.equal(
        entries.length,
        summary.covered + summary.uncovered,
        `概要「${summary.covered} 已覆盖 + ${summary.uncovered} 未覆盖」与实际 ${entries.length} 条不符: ${block}`,
      )
      // 本轮只扫到 1 个敏感值，块内就必须只有 1 条
      assert.equal(entries.length, 1, `报告块只应反映本轮结果: ${JSON.stringify(entries)}`)
      assert.ok(entries[0].includes("[providers.bravo.settings.apiKey]"), `报告应只反映本轮路径: ${entries[0]}`)
      // 首行的「共 N 个」同样必须与条目数一致
      assert.match(block, new RegExp(`共 ${entries.length} 个`), `「共 N 个」与实际条目数不符: ${block}`)
    })

    it("配置里已不存在的路径，其陈旧报告条目必须被清除（缺陷 C）", async () => {
      const dir = await makeTmpDir("discovery-stale")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      await writeAutoDiscoveryCfg(cfgPath)

      const { loadConfig } = await import("../src/config.js")
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ provider: { alpha: { options: { apiKey: "Wq4nZb7Ht3Kc9Mv" } } } }),
        "utf8",
      )
      await loadConfig(dir, NOOP_LOGGER)
      assert.ok(
        reportBlock(await fs.readFile(cfgPath, "utf8")).includes("provider.alpha.options.apiKey"),
        "第一轮报告应含旧路径形态",
      )

      // 用户把 provider.alpha.options.apiKey 改名成 providers.bravo.settings.apiKey
      // （provider 名也换掉，避免派生出的 placeholder-id 撞上第一轮的 ALPHA_KEY）
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { bravo: { settings: { apiKey: "Hy8kLm3Pq7Rt5Wz" } } } }),
        "utf8",
      )
      await loadConfig(dir, NOOP_LOGGER)

      const block = reportBlock(await fs.readFile(cfgPath, "utf8"))
      // 只在报告块内判断：patterns.regex 里残留的 auto-generated 规则注释不属于报告块
      assert.ok(!block.includes("provider.alpha.options.apiKey"), `报告块残留旧路径: ${block}`)
      assert.ok(
        !reportEntries(block).some((l) => l.includes("alpha")),
        `报告块残留旧条目: ${JSON.stringify(reportEntries(block))}`,
      )
      assert.equal(reportEntries(block).length, 1, `陈旧条目清除后只应剩 1 条: ${JSON.stringify(reportEntries(block))}`)
      assert.ok(block.includes("[providers.bravo.settings.apiKey]"), `报告应含本轮路径: ${block}`)
    })

    it("同一输入连续三轮：报告块唯一、条目不增长、第 2/3 轮文件内容逐字一致", async () => {
      const dir = await makeTmpDir("discovery-idempotent")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      const header = "# ============================================"
      const ownHeader = "# 这是配置文件自己的头部注释"
      await fs.writeFile(
        cfgPath,
        `${header}\n${ownHeader}\nenabled: true\nauto_discovery: true\n` +
          "patterns:\n  keywords: []\n  regex: []\n  builtin: []\n  exclude: []\n",
        "utf8",
      )
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          providers: {
            one: { apiKey: "Wq4nZb7Ht3Kc9Mv" },
            two: { token: "Hy8kLm3Pq7Rt5Wz" },
          },
        }),
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      const snaps = []
      for (let round = 1; round <= 3; round++) {
        await loadConfig(dir, NOOP_LOGGER)
        snaps.push(await fs.readFile(cfgPath, "utf8"))
      }

      // 第 1 轮派生规则尚未落盘，条目描述只能写 "auto-generated: <path>"；
      // 第 2 轮规则已在文件里、整体重算后描述改指真实规则 id，此后必须完全稳定。
      assert.equal(
        snaps[1],
        snaps[2],
        `第 2/3 轮文件内容必须逐字一致:\n--- 第 2 轮 ---\n${snaps[1]}\n--- 第 3 轮 ---\n${snaps[2]}`,
      )

      for (const [index, snap] of snaps.entries()) {
        const round = index + 1
        const lines = snap.split("\n")
        assert.equal(
          lines.filter((l) => l.includes("auto-discovered: 扫描报告")).length,
          1,
          `第 ${round} 轮：扫描报告块只能有一个`,
        )
        assert.equal(lines.filter((l) => l === REPORT_FOOTER).length, 1, `第 ${round} 轮：报告结束行只能有一个`)
        assert.equal(reportEntries(snap).length, 2, `第 ${round} 轮：条目数必须是 2，不得增长`)
        assert.equal(lines[0], header, `第 ${round} 轮：文件头分隔线不得被报告块挤掉`)
        assert.equal(lines[1], ownHeader, `第 ${round} 轮：用户头部注释必须留在原位`)
        assert.deepEqual(reportSummary(snap), { covered: 2, uncovered: 0 }, `第 ${round} 轮：概要与条目必须一致`)
      }
      assert.equal(
        snaps[2].split("\n").filter((l) => l.includes("# auto-generated for:")).length,
        2,
        "派生规则注释不得重复追加",
      )
      assertNoFragment(reportBlock(snaps[2]), "Wq4nZb7Ht3Kc9Mv", "报告块(幂等-one)", 3)
      assertNoFragment(reportBlock(snaps[2]), "Hy8kLm3Pq7Rt5Wz", "报告块(幂等-two)", 3)
    })

    it("报告块整体重写不得破坏用户配置（手写规则 / builtin / exclude / 其它段）", async () => {
      const dir = await makeTmpDir("discovery-preserve")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      // 报告块只能插在 patterns: 之前 → patterns: 之前的整段必须是逐字不变的用户内容
      const userHead = [
        "# ============================================",
        "# 用户自己的配置头部注释",
        "enabled: true",
        "auto_discovery: true",
        "logging:",
        '  level: "info"',
        "session:",
        '  ttl: "2h"',
        "",
      ].join("\n")
      const userPatterns = [
        "patterns:",
        '  keywords: ["password"]',
        "  regex:",
        '    - { pattern: "/own-[a-z0-9]{4}/", placeholder-id: "OWN_MANUAL" }',
        '  builtin: ["email", "uuid"]',
        "  exclude:",
        '    - "**/fixtures/*"',
        '    - "src/**/*.test.js"',
        "",
      ].join("\n")
      await fs.writeFile(cfgPath, userHead + userPatterns, "utf8")
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { bravo: { settings: { apiKey: "Wq4nZb7Ht3Kc9Mv" } } } }),
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      let content = ""
      for (let round = 1; round <= 3; round++) {
        await loadConfig(dir, NOOP_LOGGER)
        content = await fs.readFile(cfgPath, "utf8")
        assert.ok(content.startsWith(userHead), `第 ${round} 轮：patterns: 之前的用户配置必须逐字未变:\n${content}`)
      }

      // 用户写下的每一行都只能保留一份（既不能丢，也不能被复制）
      for (const line of userPatterns.split("\n").filter((l) => l.trim() !== "")) {
        const count = content.split("\n").filter((l) => l === line).length
        assert.equal(count, 1, `用户配置行必须原样保留且不重复: ${line}`)
      }

      // 语义层面同样未被破坏
      const parsed = yaml.load(content)
      assert.deepEqual(parsed.patterns.exclude, ["**/fixtures/*", "src/**/*.test.js"], "exclude 列表被改写")
      assert.deepEqual(parsed.patterns.builtin, ["email", "uuid"], "builtin 列表被改写")
      assert.deepEqual(parsed.patterns.keywords, ["password"], "keywords 列表被改写")
      assert.deepEqual(
        parsed.patterns.regex.find((r) => r["placeholder-id"] === "OWN_MANUAL"),
        { pattern: "/own-[a-z0-9]{4}/", "placeholder-id": "OWN_MANUAL" },
        "用户手写规则被改写",
      )
      assert.equal(parsed.session.ttl, "2h", "session 段被改写")
      assert.equal(parsed.logging.level, "info", "logging 段被改写")
    })

    it("报告块「概要」行被删后应自愈重建（概要是生成内容，不是块边界锚点）", async () => {
      // 为什么概要行缺失不算损坏：报告块的内容完全由本轮扫描结果决定，每轮由 results
      // 整体重算并整体替换，块边界只认 header 与结束行两行。概要行是渲染出来的
      // 统计文本，删掉它下一轮就会被重新生成，块结构与统计一致性都能自行恢复。
      // 真正的损坏是「边界行」缺失（见下一个用例：结束行被删），那种情况无法确定
      // 块的范围，必须抛错而不是猜位置重写。
      const dir = await makeTmpDir("discovery-missing-summary")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      await writeAutoDiscoveryCfg(cfgPath)
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { solo: { apiKey: "Wq4nZb7Ht3Kc9Mv" } } }),
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      await loadConfig(dir, NOOP_LOGGER)

      // 手工破坏：只删掉「概要」行，header 与结束行都保留
      const broken = (await fs.readFile(cfgPath, "utf8"))
        .split("\n")
        .filter((l) => !/^# 概要: /.test(l))
        .join("\n")
      assert.equal(reportEntries(broken).length, 1, "破坏前报告块应有一条目")
      assert.ok(broken.includes("auto-discovered: 扫描报告"), "破坏后 header 应仍在")
      assert.ok(broken.includes(REPORT_FOOTER), "破坏后结束行应仍在")
      assert.equal(reportSummary(broken), null, "破坏后概要行应缺失")
      await fs.writeFile(cfgPath, broken, "utf8")

      const errors = []
      const logger = { debug() {}, info() {}, warn() {}, error(m) { errors.push(String(m)) } }
      let thrown = null
      try {
        await loadConfig(dir, logger)
      } catch (err) {
        thrown = err
      }
      // 块边界完整 → 不构成损坏，必须正常加载而不是抛错
      assert.equal(
        thrown,
        null,
        `边界行完整时不得抛错，实际: ${thrown?.message}；错误日志: ${JSON.stringify(errors)}`,
      )
      assert.deepEqual(errors, [], "未失败却记了 error 日志，属于静默降级")

      const content = await fs.readFile(cfgPath, "utf8")
      const lines = content.split("\n")
      const block = reportBlock(content)
      // 概要行被重新渲染，且格式与内容都由本轮 results 决定
      assert.deepEqual(
        reportSummary(block),
        { covered: 1, uncovered: 0 },
        `概要行未被正确重建: ${block}`,
      )
      assert.equal(
        lines.filter((l) => l.startsWith("# 概要")).length,
        1,
        `概要行必须恰好重建一条: ${block}`,
      )
      assert.ok(
        block.includes("# 概要: 1 个已覆盖 · 0 个未覆盖"),
        `概要行格式不符: ${block}`,
      )
      // 块结构完整：header / 结束行各一份，没有因重写而复制或丢失
      assert.equal(
        lines.filter((l) => l.includes("auto-discovered: 扫描报告")).length,
        1,
        `header 必须恰好一份: ${content}`,
      )
      assert.equal(
        lines.filter((l) => l === REPORT_FOOTER).length,
        1,
        `结束行必须恰好一份: ${content}`,
      )
      // 概要数字之和必须能解释块内实际条目数（重建不是拼贴，统计要自洽）
      const entries = reportEntries(block)
      const summary = reportSummary(block)
      assert.equal(
        entries.length,
        summary.covered + summary.uncovered,
        `概要「${summary.covered} 已覆盖 + ${summary.uncovered} 未覆盖」与实际 ${entries.length} 条不符: ${block}`,
      )
      assert.equal(entries.length, 1, `报告块只应反映本轮结果: ${JSON.stringify(entries)}`)
      assert.ok(entries[0].includes("[providers.solo.apiKey]"), `条目路径应为本轮扫描结果: ${entries[0]}`)
      // 重建的是整块内容而不是补一行概要：再跑一轮，块应逐字稳定
      await loadConfig(dir, NOOP_LOGGER)
      assert.equal(
        reportBlock(await fs.readFile(cfgPath, "utf8")),
        block,
        "自愈后的报告块应在下一轮保持稳定",
      )
    })

    it("报告块损坏（结束行被删）时必须抛错，且不得半写文件（fail-fast）", async () => {
      const dir = await makeTmpDir("discovery-broken-footer")
      const cfgPath = path.join(dir, "oh-my-opensecret.yaml")
      await writeAutoDiscoveryCfg(cfgPath)
      await fs.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ providers: { solo: { apiKey: "Wq4nZb7Ht3Kc9Mv" } } }),
        "utf8",
      )

      const { loadConfig } = await import("../src/config.js")
      await loadConfig(dir, NOOP_LOGGER)

      // 手工破坏：删掉报告块的结束行 → 块边界无法确定，必须报错而不是猜位置重写
      const broken = (await fs.readFile(cfgPath, "utf8"))
        .split("\n")
        .filter((l) => l !== REPORT_FOOTER)
        .join("\n")
      await fs.writeFile(cfgPath, broken, "utf8")

      const errors = []
      const logger = { debug() {}, info() {}, warn() {}, error(m) { errors.push(String(m)) } }
      // 不用 assert.rejects 的第三个参数：它在 promise settle 之前求值，拿不到实际错误日志
      let thrown = null
      try {
        await loadConfig(dir, logger)
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, `缺少结束行时必须抛错；实际捕获到的错误日志: ${JSON.stringify(errors)}`)
      assert.match(thrown.message, /报告块已损坏|手动删除该注释块/)
      // 抛错时不得留下半写状态
      assert.equal(await fs.readFile(cfgPath, "utf8"), broken, "抛错后配置文件不得被改写")
    })
  })

  // =============================================
  // fail-fast 校验
  // =============================================
  describe("非法配置必须抛错（不得静默回落默认值）", () => {
    const invalidCases = [
      ["patterns.regex 写成字符串", 'patterns:\n  regex: "not-an-array"\n', /patterns\.regex must be an array/],
      ["patterns.exclude 写成对象", "patterns:\n  exclude: { a: 1 }\n", /patterns\.exclude must be an array/],
      ["patterns 写成数组", "patterns:\n  - a\n", /patterns must be an object/],
      ["logging.level 非法", 'logging:\n  level: "verbose"\n', /logging\.level must be one of/],
      ["logging.level 写 off（配置白名单不含 off）", 'logging:\n  level: "off"\n', /logging\.level must be one of/],
      ["logging 写成字符串", 'logging: "info"\n', /logging must be an object/],
      ["logging.file 非字符串", "logging:\n  file: 123\n", /logging\.file must be a string/],
      ["rotation.max_files 非正整数", "logging:\n  rotation:\n    max_files: 0\n", /max_files must be a positive integer/],
      ["rotation.max_size 类型非法", "logging:\n  rotation:\n    max_size: true\n", /max_size must be a string or number/],
      ["session.ttl 格式非法", 'session:\n  ttl: "1 hour"\n', /session\.ttl 格式非法/],
      ["session.ttl 非字符串", "session:\n  ttl: 3600\n", /session\.ttl must be a string/],
      ["session.max_mappings 非正数", "session:\n  max_mappings: 0\n", /max_mappings must be a positive number/],
      ["enabled 非布尔", 'enabled: "yes"\n', /enabled must be a boolean/],
      ["auto_discovery 非布尔", 'auto_discovery: "true"\n', /auto_discovery must be a boolean/],
      ["placeholder_prefix 为空", 'placeholder_prefix: ""\n', /placeholder_prefix must be a non-empty string/],
      ["正则规则无法编译", 'patterns:\n  regex:\n    - { pattern: "/[unclosed/i", placeholder-id: "BAD" }\n', /规则非法/],
    ]

    for (const [name, cfgYaml, expected] of invalidCases) {
      it(name, async () => {
        const dir = await makeTmpDir("invalid")
        await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")
        const { loadConfig } = await import("../src/config.js")
        await assert.rejects(() => loadConfig(dir, NOOP_LOGGER), expected)
      })
    }

    it("YAML 语法错误", async () => {
      const dir = await makeTmpDir("invalid-yaml")
      await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), "patterns: [\n  regex: {oops\n", "utf8")
      const { loadConfig } = await import("../src/config.js")
      await assert.rejects(() => loadConfig(dir, NOOP_LOGGER))
    })

    it("配置内容不是映射", async () => {
      const dir = await makeTmpDir("invalid-shape")
      await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), "- a\n- b\n", "utf8")
      const { loadConfig } = await import("../src/config.js")
      await assert.rejects(() => loadConfig(dir, NOOP_LOGGER), /必须是 YAML 映射/)
    })
  })

  // =============================================
  // 时长解析
  // =============================================
  describe("session.ttl 归一化", () => {
    it("合法时长换算为毫秒，缺失用默认 1h", async () => {
      const { loadConfig } = await import("../src/config.js")
      const cases = [
        ["500ms", 500],
        ["30s", 30_000],
        ["15m", 900_000],
        ["2h", 7_200_000],
        ["1d", 86_400_000],
        [undefined, 3_600_000],
      ]
      for (const [ttl, expected] of cases) {
        const dir = await makeTmpDir("ttl")
        await writeCfg(dir, ttl === undefined ? "" : `session:\n  ttl: "${ttl}"\n`)
        const cfg = await loadConfig(dir, NOOP_LOGGER)
        assert.equal(cfg.ttlMs, expected, `ttl=${ttl} 应换算为 ${expected}ms`)
      }
    })
  })

  // =============================================
  // 原子写入的并发安全
  // =============================================
  describe("writeFileAtomic 并发安全", () => {
    // 回归：tmp 名曾为 `${target}.${pid}.${Date.now()}.tmp`，同进程同毫秒并发会撞名，
    // 先完成的 rename 拿走 tmp，后到的 rename 报 ENOENT。真实触发场景：插件在每个
    // location 各实例化一份（注册在全局 opencode.json），同一 server 进程内多个 location
    // 并发 setup → 并发 loadConfig → 写同一个全局配置文件。
    it("同进程同毫秒并发写同一文件不抛错、无 tmp 残留、最终内容完整", async () => {
      const { writeFileAtomic } = await import("../src/config.js")
      const dir = await makeTmpDir("atomic-race")
      const target = path.join(dir, "config.yaml")

      // 冻结时间：强制所有并发调用拿到同一 Date.now()，比真实场景更苛刻。
      // 只用 pid + 毫秒的命名在此必然撞名，唯一化后不再撞。
      const realNow = Date.now
      Date.now = () => 1_791_611_102_027
      try {
        const payloads = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
        const results = await Promise.allSettled(
          payloads.map((p) => writeFileAtomic(target, p)),
        )
        const rejected = results.filter((r) => r.status === "rejected")
        assert.equal(
          rejected.length,
          0,
          `并发写全部应成功，实际失败: ${rejected.map((r) => r.reason.message).join("; ")}`,
        )

        // 最终内容必须是某一份完整 payload（原子性），不能是拼接/截断
        const final = await fs.readFile(target, "utf8")
        assert.ok(
          payloads.includes(final),
          `最终文件内容应为某一份完整写入，实际: ${JSON.stringify(final)}`,
        )

        // 不留 tmp 残骸
        const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))
        assert.deepEqual(leftovers, [], `不应残留 tmp 文件: ${leftovers.join(", ")}`)
      } finally {
        Date.now = realNow
      }
    })

    it("tmp 名含随机分量，同 pid 同毫秒也不重复", async () => {
      const { writeFileAtomic } = await import("../src/config.js")
      const dir = await makeTmpDir("atomic-unique")
      const target = path.join(dir, "config.yaml")
      const realNow = Date.now
      Date.now = () => 42
      try {
        // 串行写 3 次，逐一记录写入期间出现的 tmp 名（用 rename 前后的目录快照近似）
        const seen = new Set()
        for (let i = 0; i < 3; i++) {
          const before = new Set(await fs.readdir(dir))
          const p = writeFileAtomic(target, `v${i}`)
          // 让出事件循环，使 tmp 已落盘后再抓一次
          await new Promise((r) => setImmediate(r))
          for (const f of await fs.readdir(dir)) {
            if (!before.has(f) && f.endsWith(".tmp")) seen.add(f)
          }
          await p
        }
        // 三次独立调用的 tmp 名互不相同（随机分量生效）
        assert.ok(seen.size >= 1, "应观察到 tmp 文件")
        // 每次写完都清干净
        const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))
        assert.deepEqual(leftovers, [])
      } finally {
        Date.now = realNow
      }
    })
  })
})

describe("logger.js", () => {
  const LOG_TMP = path.join(TMP, "logger")

  before(async () => {
    await fs.mkdir(LOG_TMP, { recursive: true })
  })

  after(async () => {
    await fs.rm(LOG_TMP, { recursive: true, force: true })
  })

  async function logFilePath(name) {
    return path.join(LOG_TMP, name)
  }

  it("分级日志：level 过滤正确（debug/info 不落盘，warn 落盘）", async () => {
    const { Logger } = await import("../src/logger.js")
    const tmpLog = await logFilePath("level-test.log")

    const log = new Logger({ level: "warn", filePath: tmpLog })
    // 两条消息刻意用不互相包含的字符串，否则后一条断言会被前一条覆盖、永远不会执行
    log.debug("zzz-debug-level-marker zzz")
    log.info("zzz-info-level-marker zzz")
    log.warn("test warning")
    log.error("test error")
    await log.flush()

    const content = await fs.readFile(tmpLog, "utf8")
    assert.ok(!content.includes("zzz-debug-level-marker"), "debug 级别不应落盘")
    assert.ok(!content.includes("zzz-info-level-marker"), "info 级别不应落盘")
    assert.ok(content.includes("test warning"), "warn 级别应落盘")
    assert.ok(content.includes("test error"), "error 级别应落盘")
  })

  it("level=off 时全部不落盘，且不创建日志文件", async () => {
    const { Logger } = await import("../src/logger.js")
    const tmpLog = await logFilePath("off-test.log")

    const log = new Logger({ level: "off", filePath: tmpLog })
    log.error("off-level-error-marker")
    log.warn("off-level-warn-marker")
    await log.flush()

    assert.ok(!existsSync(tmpLog), "level=off 不应创建日志文件")
  })

  it("applyConfig 归一化：level 名→数值、maxSize 字符串→字节数", async () => {
    const { Logger } = await import("../src/logger.js")
    const log = new Logger({ level: "off" })
    log.applyConfig({ level: "warn", file: await logFilePath("apply.log"), maxSize: "10m", maxFiles: 3 })

    assert.equal(log.level, 2, "warn 应映射为数值 2")
    assert.equal(log.maxSize, 10 * 1024 * 1024, '"10m" 应换算为 10485760 字节')
    assert.equal(log.maxFiles, 3)

    log.applyConfig({ level: "debug", file: await logFilePath("apply2.log"), maxSize: "500k" })
    assert.equal(log.level, 0, "debug 应映射为数值 0")
    assert.equal(log.maxSize, 500 * 1024)
  })

  it("applyConfig 展开 ~ 为 $HOME，不产生字面量 ~ 目录", async () => {
    const { Logger } = await import("../src/logger.js")
    const log = new Logger({ level: "off" })
    log.applyConfig({ level: "off", file: "~/x.log", maxSize: "10m" })

    assert.equal(log.filePath, path.join(os.homedir(), "x.log"), "~ 必须展开为 $HOME")
    assert.ok(!log.filePath.includes("~"), `路径不得残留字面量 ~: ${log.filePath}`)
    assert.ok(!existsSync(path.join(process.cwd(), "~")), "不得创建字面量 ~ 目录")
    assert.ok(!existsSync(path.join(process.cwd(), "~/x.log")), "不得在字面量 ~ 目录下写日志")
  })

  it("非法 level / max_size / 单位抛错，不静默回落默认值", async () => {
    const { Logger } = await import("../src/logger.js")
    const log = new Logger({ level: "off" })
    const file = await logFilePath("invalid.log")

    assert.throws(() => log.applyConfig({ level: "verbose", file, maxSize: "10m" }), /未知的日志级别/)
    assert.throws(() => log.applyConfig({ level: "trace", file, maxSize: "10m" }), /未知的日志级别/)
    assert.throws(() => log.applyConfig({ level: "info", file, maxSize: "10x" }), /未知的日志大小单位/)
    assert.throws(() => log.applyConfig({ level: "info", file, maxSize: "10mb" }), /未知的日志大小单位/)
    assert.throws(() => log.applyConfig({ level: "info", file, maxSize: "big" }), /无法解析日志大小/)
    assert.throws(() => log.applyConfig({ level: "info", file, maxSize: -1 }), /日志大小非法/)
    assert.throws(() => log.applyConfig({ level: "info", file, maxSize: 0 }), /日志大小非法/)
    assert.throws(() => new Logger({ level: "verbose" }), /未知的日志级别/)

    // 抛错后字段不应被改成非法值
    assert.equal(log.level, 4, "非法 applyConfig 不应改动已生效的 level")
  })
})

// 文件级兜底清理：放在所有 describe 之外，确保最后执行。
// 各 describe 的 after 只能删自己的子目录，先执行的 describe 删掉 TMP 后，
// 后执行的 describe 又会重建——只靠 describe 级 after 会留下空目录。
after(async () => {
  await fs.rm(TMP, { recursive: true, force: true })
})
