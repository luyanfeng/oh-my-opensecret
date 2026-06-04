import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yaml from "js-yaml"
import { BUILTIN, parsePatternFlags } from "./patterns.js"

const CONFIG_FILENAME = "oh-my-opensecret.yaml"
const ENV_CONFIG_PATH = "OPENCODE_SECRET_CONFIG"

/**
 * 解析时长字符串（如 "1h"、"30m"、"1d"）为毫秒数。
 * @param {string} input
 * @returns {number}
 */
function parseDurationMs(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return 60 * 60 * 1000

  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
  if (!m) return 60 * 60 * 1000

  const value = Number(m[1])
  const unit = m[2]
  if (!Number.isFinite(value) || value < 0) return 60 * 60 * 1000

  const units = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }
  return value * (units[unit] || 60 * 60 * 1000)
}

/** 展开 ~ 为当前用户 home 目录 */
function expandHome(p) {
  if (typeof p !== "string") return p
  if (p.startsWith("~" + path.sep) || p === "~") {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

// ---- 配置 Schema 校验 ----

/**
 * 校验并规范化原始配置对象。
 * @param {any} raw
 * @returns {{ valid: boolean, errors: string[], config: import("./config.js").NormalizedConfig }}
 */
function validateSchema(raw) {
  const errors = []

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["config must be an object"], config: null }
  }

  // enabled
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    errors.push("enabled must be a boolean")
  }

  // logging
  if (raw.logging !== undefined) {
    if (typeof raw.logging !== "object" || raw.logging === null) {
      errors.push("logging must be an object")
    } else {
      const validLevels = ["debug", "info", "warn", "error"]
      if (raw.logging.level !== undefined && !validLevels.includes(raw.logging.level)) {
        errors.push(`logging.level must be one of: ${validLevels.join(", ")}`)
      }
      if (raw.logging.file !== undefined && typeof raw.logging.file !== "string") {
        errors.push("logging.file must be a string")
      }
      if (raw.logging.rotation !== undefined) {
        if (typeof raw.logging.rotation !== "object" || raw.logging.rotation === null) {
          errors.push("logging.rotation must be an object")
        } else {
          if (raw.logging.rotation.max_size !== undefined && typeof raw.logging.rotation.max_size !== "string" && typeof raw.logging.rotation.max_size !== "number") {
            errors.push("logging.rotation.max_size must be a string or number")
          }
          if (raw.logging.rotation.max_files !== undefined && (!Number.isInteger(raw.logging.rotation.max_files) || raw.logging.rotation.max_files < 1)) {
            errors.push("logging.rotation.max_files must be a positive integer")
          }
        }
      }
    }
  }

  // auto_discovery
  if (raw.auto_discovery !== undefined && typeof raw.auto_discovery !== "boolean") {
    errors.push("auto_discovery must be a boolean")
  }

  // placeholder_prefix
  if (raw.placeholder_prefix !== undefined && (typeof raw.placeholder_prefix !== "string" || !raw.placeholder_prefix)) {
    errors.push("placeholder_prefix must be a non-empty string")
  }

  // session
  if (raw.session !== undefined) {
    if (typeof raw.session !== "object") {
      errors.push("session must be an object")
    } else {
      if (raw.session.ttl !== undefined && typeof raw.session.ttl !== "string") {
        errors.push("session.ttl must be a string (e.g. '1h')")
      }
      if (raw.session.max_mappings !== undefined && (!Number.isFinite(raw.session.max_mappings) || raw.session.max_mappings < 1)) {
        errors.push("session.max_mappings must be a positive number")
      }
    }
  }

  // patterns
  if (raw.patterns !== undefined) {
    if (typeof raw.patterns !== "object") {
      errors.push("patterns must be an object")
    } else {
      if (raw.patterns.keywords !== undefined && !Array.isArray(raw.patterns.keywords)) {
        errors.push("patterns.keywords must be an array")
      }
      if (raw.patterns.regex !== undefined && !Array.isArray(raw.patterns.regex)) {
        errors.push("patterns.regex must be an array")
      }
      if (raw.patterns.builtin !== undefined && !Array.isArray(raw.patterns.builtin)) {
        errors.push("patterns.builtin must be an array")
      }
      if (raw.patterns.exclude !== undefined && !Array.isArray(raw.patterns.exclude)) {
        errors.push("patterns.exclude must be an array")
      }
    }
  }

  // profile
  if (raw.profile !== undefined && typeof raw.profile !== "string") {
    errors.push("profile must be a string")
  }

  // profiles
  if (raw.profiles !== undefined) {
    if (typeof raw.profiles !== "object") {
      errors.push("profiles must be an object")
    }
  }

  return { valid: errors.length === 0, errors, config: raw }
}

/**
 * 将原始配置规范化（补全默认值）。
 * @param {any} raw
 * @returns {NormalizedConfig}
 */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {}

  const enabled = cfg.enabled !== false

  // logging
  const logCfg = cfg.logging && typeof cfg.logging === "object" ? cfg.logging : {}
  const rotCfg = logCfg.rotation && typeof logCfg.rotation === "object" ? logCfg.rotation : {}
  const logging = {
    level: logCfg.level || "info",
    file: expandHome(logCfg.file || "~/.oh-my-opensecret/oh-my-opensecret.log"),
    maxSize: rotCfg.max_size ?? "10m",
    maxFiles: rotCfg.max_files ?? 7,
  }
  const autoDiscovery = cfg.auto_discovery !== false
  const prefix = typeof cfg.placeholder_prefix === "string" && cfg.placeholder_prefix
    ? cfg.placeholder_prefix
    : "__OMOS_"

  const session = cfg.session && typeof cfg.session === "object" ? cfg.session : {}
  const ttlMs = parseDurationMs(session.ttl)
  const maxMappings = Number.isFinite(session.max_mappings) && session.max_mappings > 0
    ? Number(session.max_mappings)
    : 100000

  // 解析 Profile
  const activeProfileName = typeof cfg.profile === "string" && cfg.profile ? cfg.profile : ""
  const profiles = cfg.profiles && typeof cfg.profiles === "object" ? cfg.profiles : {}
  const basePatterns = cfg.patterns && typeof cfg.patterns === "object" ? cfg.patterns : {}

  let patterns
  if (activeProfileName && profiles[activeProfileName]) {
    const profileCfg = profiles[activeProfileName]
    const profilePats = profileCfg.patterns && typeof profileCfg.patterns === "object" ? profileCfg.patterns : {}
    patterns = mergePatterns(basePatterns, profilePats)
  } else {
    patterns = basePatterns
  }

  return {
    enabled,
    logging,
    autoDiscovery,
    prefix,
    ttlMs,
    maxMappings,
    patterns,
    profile: activeProfileName,
    _allProfiles: Object.keys(profiles),
  }
}

/**
 * 合并 base patterns 与 profile patterns。
 * 规则：keywords/regex 拼接去重，builtin/exclude profile 优先覆盖。
 * @param {object} base
 * @param {object} profile
 * @returns {object}
 */
function mergePatterns(base, profile) {
  return {
    keywords: [
      ...(Array.isArray(base.keywords) ? base.keywords : []),
      ...(Array.isArray(profile.keywords) ? profile.keywords : []),
    ],
    regex: [
      ...(Array.isArray(base.regex) ? base.regex : []),
      ...(Array.isArray(profile.regex) ? profile.regex : []),
    ],
    builtin: profile.builtin !== undefined
      ? (Array.isArray(profile.builtin) ? [...profile.builtin] : [])
      : (Array.isArray(base.builtin) ? [...base.builtin] : []),
    exclude: profile.exclude !== undefined
      ? (Array.isArray(profile.exclude) ? [...profile.exclude] : [])
      : (Array.isArray(base.exclude) ? [...base.exclude] : []),
  }
}

/**
 * @typedef {Object} NormalizedConfig
 * @property {boolean} enabled
 * @property {{ level: string, file: string, maxSize: string|number, maxFiles: number }} logging
 * @property {boolean} autoDiscovery
 * @property {string} prefix
 * @property {number} ttlMs
 * @property {number} maxMappings
 * @property {object} patterns
 * @property {string} profile - 当前激活的 profile 名（空串表示未设置）
 * @property {string[]} _allProfiles - 所有可用 profile 名称
 * @property {string} [loadedFrom]
 */

// ---- 默认配置生成 ----

/**
 * 生成默认配置内容（YAML 字符串）。
 * @returns {string}
 */
function generateDefaultYaml() {
  return `# ============================================
# oh-my-opensecret 配置
# ============================================
# 首次启动自动生成，你可按需修改。
# 修改后重启 Opencode 即生效。
# ============================================


# ---------- 基本开关 ----------

# 是否启用插件（true=启用，false=禁用）
enabled: true


# ---------- 日志配置 ----------

# level:  输出级别 debug/info/warn/error（默认 info）
# file:   日志文件路径（默认 ~/.oh-my-opensecret/oh-my-opensecret.log）
# rotation:
#   max_size:  "10m"    # 滚动阈值（500k/10m/1g）
#   max_files: 7        # 保留历史文件数（超出删除最旧）
# 滚动触发：文件超限或日期变更。
logging:
  level: info
  file: ~/.oh-my-opensecret/oh-my-opensecret.log


# ---------- 自动发现 ----------

# 启动时扫描 Opencode 配置中 apiKey/token/secret 等字段，
# 自动生成正则规则追加到配置文件。仅在 enabled: true 时生效。
auto_discovery: true


# ---------- 占位符 ----------

# 脱敏后占位符前缀。完整格式：{PREFIX}_{CATEGORY}_{hash12}__
placeholder_prefix: "__OMOS_"


# ---------- 场景 Profile ----------

# 激活的场景名（daily/code_review/ci_cd），不设置则使用 base patterns。
# 详见下方 profiles 定义。
# profile: "daily"


# ---------- 会话管理 ----------

session:
  # 占位符有效期（数字+单位 ms/s/m/h/d，默认 "1h"）
  ttl: "1h"
  # 单个 session 最大映射数，超限时 LRU 淘汰
  max_mappings: 100000


# ============================================
# 匹配规则
# ============================================

patterns:

  # ---------- 关键词匹配（精确子串）----------
  keywords: []

  # ---------- 自定义正则规则 ----------
  # pattern 支持 /regex/flags 字面量语法（如 "/[a-z]+/gi"），
  # 也支持 (?i)(?m)(?s) 内联前缀，两者可叠加。
  # 以下为示例（已注释，按需取消注释并修改）:
  regex:
    # - pattern: "sk-[A-Za-z0-9]{48}"
    #   placeholder-id: "OPENAI_KEY"
    # - pattern: "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+"
    #   placeholder-id: "GITHUB_TOKEN"
    # - pattern: "AKIA[0-9A-Z]{16}"
    #   placeholder-id: "AWS_ACCESS_KEY"

  # ---------- 内置规则 ----------
  # 按名称引用 src/patterns.js 中预定义的规则。
  # 每条规则的脱敏占位符前缀即其 placeholderId（如 email → __OMOS_EMAIL_xxx__）。
  #
  # 完整列表（含匹配内容简介）:
  #   email           邮箱地址
  #   china_phone     中国大陆手机号（1xx-xxxx-xxxx）
  #   china_id        中国大陆身份证号（18位数字+X）
  #   uuid            UUID v4 格式
  #   ipv4            IPv4 地址
  #   mac             MAC 地址（xx:xx:xx:xx:xx:xx）
  #   jwt             JWT Token（eyJxxx.eyJxxx.xxx）
  #   openai_key      OpenAI API Key（sk-... / sk-proj-...）
  #   openai_org_id   OpenAI 组织 ID（org-...）
  #   github_token    GitHub 令牌（ghp_... / gho_... / github_pat_...）
  #   aws_key         AWS Access Key（AKIA...）
  #   anthropic_key   Anthropic API Key（sk-ant-...）
  #   google_key      Google API Key（AIza...）
  #   stripe_key      Stripe API Key（sk_live_... / sk_test_...）
  #   hf_token        HuggingFace Token（hf_...）
  #   pplx_key        Perplexity API Key（pplx-...）
  #   groq_key        Groq API Key（gsk_...）
  #   gitlab_token    GitLab 个人访问令牌（glpat-...）
  #   replicate_key   Replicate API Token（r8_...）
  #   db_connection   数据库连接字符串（mysql://user:pass@host 等）
  #
  # 下行为默认启用列表，按需增删即可：
  builtin:
    - email
    - china_phone
    - china_id
    - uuid
    - ipv4
    - ipv6
    - mac

  # ---------- 排除列表（豁免）----------
  # 以下内容即使匹配规则也不会被脱敏
  exclude:
    - "example.com"
    - "localhost"
    - "127.0.0.1"
    - "0.0.0.0"


# ============================================
# 场景 Profile
# ============================================
# 通过顶层 profile 字段选择激活。
# Profile 的 patterns 与 base patterns 合并规则：
#   keywords/regex — 拼接
#   builtin/exclude — Profile 覆盖 base
# ============================================

profiles:

  # --- 日常对话 ---
  # 轻量脱敏，不影响正常聊天
  daily:
    description: "日常对话 - 轻量脱敏"
    patterns:
      builtin:
        - email
        - china_phone
        - uuid
      exclude:
        - "example.com"
        - "localhost"

  # --- 代码审查 ---
  # 全面脱敏，覆盖代码中可能出现的凭据
  code_review:
    description: "代码审查 - 全面脱敏"
    patterns:
      builtin:
        - email
        - china_phone
        - china_id
        - uuid
        - jwt
        - ipv4
        - ipv6
        - mac
        - github_token
        - openai_key
        - aws_key
      regex:
        - pattern: "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+"
          placeholder-id: "GITHUB_TOKEN"

  # --- CI/CD ---
  # 着重保护密钥和令牌
  ci_cd:
    description: "CI/CD - 着重保护密钥和令牌"
    patterns:
      builtin:
        - aws_key
        - github_token
        - openai_key
        - email
      regex:
        - pattern: "AKIA[0-9A-Z]{16}"
          placeholder-id: "AWS_ACCESS_KEY"
`
}

// ---- 配置查找 ----

/**
 * 获取配置候选路径列表。
 * @param {string} directory 项目根目录
 * @returns {string[]}
 */
export function getConfigCandidates(directory) {
  const dir = String(directory ?? process.cwd())
  const home = os.homedir()

  const envPath = process.env[ENV_CONFIG_PATH]
  const projectRoot = path.join(dir, CONFIG_FILENAME)
  const projectLocal = path.join(dir, ".opencode", CONFIG_FILENAME)

  if (envPath) {
    // 环境变量精确指定，不搜索全局路径
    return [path.resolve(dir, envPath), projectRoot, projectLocal]
  }

  const globalConfig = path.join(home, ".config", "opencode", CONFIG_FILENAME)
  return [projectRoot, projectLocal, globalConfig]
}

/**
 * 查找并加载配置文件。
 * @param {string} directory
 * @returns {Promise<{ filepath: string, raw: any }|null>}
 */
async function findAndReadConfig(directory) {
  const candidates = getConfigCandidates(directory)
  for (const filepath of candidates) {
    if (!filepath) continue
    if (!existsSync(filepath)) continue
    try {
      const content = await fs.readFile(filepath, "utf8")
      const raw = yaml.load(content)
      if (raw && typeof raw === "object") {
        return { filepath, raw }
      }
    } catch {
      continue
    }
  }
  return null
}

// ---- Opencode 配置读取 ----

/**
 * 查找并读取 Opencode 自身配置（opencode.json / opencode.jsonc）。
 * @param {string} directory
 * @returns {Promise<object|null>}
 */
async function readOpencodeConfig(directory) {
  const home = os.homedir()
  const candidates = [
    // 本地项目
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    // 全局 Opencode 配置
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
  ]
  for (const filepath of candidates) {
    if (!existsSync(filepath)) continue
    try {
      const content = await fs.readFile(filepath, "utf8")
      // 先试纯 JSON 解析（快且不受 regex 副作用影响）
      try { return JSON.parse(content) } catch { /* fall through to JSONC stripping */ }
      // JSONC: 用 placeholder 保护字符串内容，再剥离注释
      const strBucket = []
      const masked = content.replace(/"([^"\\]|\\.)*"/g, (m) => {
        strBucket.push(m)
        return `__JSONC_STR_${strBucket.length - 1}__`
      })
      const stripped = masked
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/__JSONC_STR_(\d+)__/g, (_, i) => strBucket[+i])
      return JSON.parse(stripped)
    } catch {
      continue
    }
  }
  return null
}

// ---- 自动发现 API Key ----

const SENSITIVE_KEYS = new Set([
  "apiKey", "apikey", "api_key", "api-key",
  "secret", "secretKey", "secret_key", "secret-key",
  "token", "accessToken", "access_token", "access-token",
  "password", "passwd",
  "privateKey", "private_key", "private-key",
  "appSecret", "app_secret", "app-secret",
  "clientSecret", "client_secret", "client-secret",
  "authToken", "auth_token", "auth-token",
  "refreshToken", "refresh_token", "refresh-token",
])

/**
 * 判断字符串是否为占位符（已被插件替换的密文）。
 * 占位符格式：{PREFIX}_{CATEGORY}_{hash12}__
 */
function isPlaceholder(value) {
  return /^__[A-Z]+_[A-Z0-9_]+_[a-f0-9]{12}__$/.test(String(value ?? ""))
}

/**
 * 递归遍历对象，收集敏感字段的字符串值。
 * @param {object} obj
 * @param {string} prefix 当前路径前缀
 * @returns {Array<{ path: string, value: string }>}
 */
function collectSensitiveValues(obj, prefix = "") {
  const results = []
  if (!obj || typeof obj !== "object") return results

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key

    if (typeof value === "string" && value.length >= 8 && SENSITIVE_KEYS.has(key)) {
      if (!isPlaceholder(value)) {
        results.push({ path: fullPath, value })
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      results.push(...collectSensitiveValues(value, fullPath))
    }
  }
  return results
}

/**
 * 展开所有有效的正则模式（自定义 + 内置规则），返回带描述信息的规则列表。
 * @param {object} rawConfig 解析后的 YAML 配置
 * @returns {Array<{ regex: RegExp, name: string, description: string, source: string }>}
 */
function expandPatternsWithMeta(rawConfig) {
  const rules = []

  // 自定义正则
  const custom = rawConfig?.patterns?.regex ?? []
  for (const r of custom) {
    const pat = String(r.pattern ?? "")
    if (!pat) continue
    try {
      const parsed = parsePatternFlags(pat)
      let flags = parsed.flags
      if (!flags.includes("g")) flags = "g" + flags
      const pid = r.placeholderId ?? r["placeholder-id"]
      const name = pid ? String(pid).trim() : "custom"
      rules.push({
        regex: new RegExp(parsed.pattern, flags),
        name,
        description: name,
        source: "custom",
      })
    } catch { /* skip */ }
  }

  // 内置规则
  const builtinNames = rawConfig?.patterns?.builtin ?? []
  for (const name of builtinNames) {
    const key = String(name ?? "").trim()
    if (!key) continue
    const rule = BUILTIN.get(key)
    if (!rule) continue
    const pat = String(rule.pattern ?? "")
    if (!pat) continue
    try {
      const parsed = parsePatternFlags(pat)
      let flags = parsed.flags
      if (!flags.includes("g")) flags = "g" + flags
      rules.push({
        regex: new RegExp(parsed.pattern, flags),
        name: key,
        description: rule.description || key,
        source: "builtin",
      })
    } catch { /* skip */ }
  }

  return rules
}

/**
 * 扫描 Opencode 配置中的敏感字段，逐一分析是否已被规则覆盖。
 * 返回每个敏感值的覆盖状态和匹配规则信息。
 * @param {object} opencodeCfg
 * @param {object} rawConfig 当前配置对象
 * @returns {Array<{ path: string, covered: boolean, ruleName: string|null, ruleDescription: string|null, value: string }>}
 */
function analyzeSensitiveValues(opencodeCfg, rawConfig) {
  const entries = collectSensitiveValues(opencodeCfg)
  const allRules = expandPatternsWithMeta(rawConfig)

  return entries.map(({ path, value }) => {
    const match = allRules.find((r) => {
      r.regex.lastIndex = 0
      return r.regex.test(value)
    })
    return {
      path,
      value,
      covered: !!match,
      ruleName: match ? match.name : null,
      ruleDescription: match ? match.description : null,
    }
  })
}

// ---- 主动导出 ----

/**
 * 插件配置加载入口。
 * 1. 按优先级查找配置文件
 * 2. 未找到则生成默认配置并写入
 * 3. 校验 schema
 * 4. 若 autoDiscovery 开启，扫描 Opencode 配置并自动追加规则
 * @param {string} directory 项目根目录
 * @param {{ info: Function, debug: Function }} [logger]
 * @returns {Promise<NormalizedConfig & { loadedFrom: string }>}
 */
export async function loadConfig(directory, logger) {
  const log = logger || { info: () => {}, debug: () => {} }

  // 1. 查找配置文件
  const found = await findAndReadConfig(directory)

  let rawConfig
  let configPath

  if (!found) {
    // 2. 未找到，生成默认配置
    log.info("未找到配置文件，正在生成默认配置...")

    // 环境变量指定路径时生成到该路径，否则生成到 Opencode 全局配置目录
    const envPath = process.env[ENV_CONFIG_PATH]
    const defaultPath = envPath
      ? path.resolve(directory, envPath)
      : path.join(os.homedir(), ".config", "opencode", CONFIG_FILENAME)
    const defaultYaml = generateDefaultYaml()
    await fs.writeFile(defaultPath, defaultYaml, "utf8")
    log.info(`默认配置已生成: ${defaultPath}`)

    const raw = yaml.load(defaultYaml)
    rawConfig = raw
    configPath = defaultPath
  } else {
    rawConfig = found.raw
    configPath = found.filepath
  }

  // 3. Schema 校验
  const { valid, errors } = validateSchema(rawConfig)
  if (!valid) {
    log.warn(`配置校验告警:\n  ${errors.join("\n  ")}`)
  }

  // 4. 规范化
  const cfg = normalizeConfig(rawConfig)

  // 5. 自动发现
  if (cfg.enabled && cfg.autoDiscovery) {
    try {
      const opencodeCfg = await readOpencodeConfig(directory)
      if (opencodeCfg) {
        const results = analyzeSensitiveValues(opencodeCfg, rawConfig)
        if (results.length > 0) {
          const addedCount = await writeDiscoveryReport(configPath, rawConfig, results)
          const uncovered = results.filter((r) => !r.covered)
          if (addedCount > 0) {
            log.info(`自动发现: 生成 ${addedCount} 条新规则（共 ${results.length} 个敏感值，${results.length - uncovered.length} 已覆盖）`)
          } else if (uncovered.length > 0) {
            log.info(`自动发现: 共 ${results.length} 个敏感值（${results.length - uncovered.length} 已覆盖，${uncovered.length} 未覆盖，规则已存在跳过）`)
          } else {
            log.info(`自动发现: ${results.length} 个敏感值，全部已被规则覆盖`)
          }
        }
      }
    } catch (err) {
      log.warn(`自动发现失败: ${err.message}`)
    }
  }

  return { ...cfg, loadedFrom: configPath }
}

/**
 * 从配置路径派生 placeholder-id。
 * @param {string} path 如 "providers.myminimaxi.apiKey"
 * @returns {string} 如 "MYMINIMAXI_KEY"
 */
function derivePlaceholderId(path) {
  let name = String(path ?? "")
  // 从 provider.xxx 或 providers.xxx 中提取 xxx 作为规则名，忽略中间层级
  // 支持 provider.myminimaxi.options.apiKey → MYMINIMAXI_KEY
  const providerPrefix = name.match(/^providers?\.[^.]+/)
  if (providerPrefix) {
    name = providerPrefix[0].split(".")[1]
  }
  const clean = name.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").toUpperCase()
  if (!clean) return "CUSTOM_KEY"
  return clean + "_KEY"
}

/**
 * 从值的开头提取通用正则 pattern（不暴露完整原文）。
 * 取前 6 字符作为固定前缀，剩余部分用通用字符类 + 长度量词。
 * @param {string} value
 * @returns {string}
 */
function generatePattern(value) {
  const v = String(value ?? "")
  // 取到第一个非字母数字字符及其之前的内容作为前缀（如 "sk-xxx" → "sk-"）
  const m = v.match(/^([a-zA-Z0-9]*[-_])/)
  const prefix = m ? m[1] : v.slice(0, Math.min(4, v.length))
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const remainLen = v.length - prefix.length
  return escaped + "[A-Za-z0-9_-]{" + remainLen + "}"
}

/**
 * 将 auto-discovery 完整扫描报告写入 YAML 配置文件。
 * - 已覆盖的值 → 注释中标 ✅ 及匹配规则
 * - 未覆盖的值 → 生成新正则规则追加到 patterns.regex（跳过已有 placeholder-id）
 *   每条规则前带 # auto-generated 注释说明数据来源
 * @param {string} configPath
 * @param {object} rawConfig 原始配置对象（用于检查已有规则）
 * @param {Array<{ path: string, covered: boolean, ruleName: string|null, ruleDescription: string|null, value: string }>} results
 * @returns {Promise<number>} 新增规则数
 */
async function writeDiscoveryReport(configPath, rawConfig, results) {
  if (results.length === 0) return 0

  // ---- 1. 生成新规则 ----
  const existingIds = new Set(
    (rawConfig?.patterns?.regex ?? []).map((r) => {
      const id = r.placeholderId ?? r["placeholder-id"]
      return id ? String(id).trim().toUpperCase() : null
    }).filter(Boolean),
  )

  const newRules = []
  for (const r of results) {
    if (r.covered) continue
    const id = derivePlaceholderId(r.path)
    if (!existingIds.has(id)) {
      newRules.push({
        path: r.path,
        id,
        pattern: generatePattern(r.value),
      })
      existingIds.add(id)
      // 标记为已覆盖（报告中将显示 ✅ 并指向新规则）
      r.covered = true
      r.ruleName = id
      r.ruleDescription = `auto-generated: ${r.path}`
    }
  }

  // ---- 2. 写入 YAML ----
  const content = await fs.readFile(configPath, "utf8")

  // 2a. 在 regex: 列表末尾追加新规则（基于行定位，不受字段顺序影响）
  let yamlContent = content
  if (newRules.length > 0) {
    const lines = yamlContent.split("\n")
    const regexIdx = lines.findIndex((l) => /^\s*regex:/.test(l))
    if (regexIdx >= 0) {
      const indent = lines[regexIdx].match(/^\s*/)[0]       // regex: 行缩进
      const itemIndent = indent + "  "                       // 列表项缩进（如 "    "）
      const valIndent = itemIndent + "  "                     // 属性值缩进（如 "      "）

      // 按 YAML 列表缩进生成新规则文本
      const newLines = []
      for (const nr of newRules) {
        newLines.push(`${itemIndent}# auto-generated for: opencode.json → ${nr.path}`)
        newLines.push(`${itemIndent}- pattern: "${nr.pattern}"`)
        newLines.push(`${valIndent}placeholder-id: "${nr.id}"`)
      }

      if (/^\s*regex:\s*\[\]\s*$/.test(lines[regexIdx])) {
        // 空列表 → 展开为多行
        lines[regexIdx] = indent + "regex:"
        lines.splice(regexIdx + 1, 0, ...newLines)
      } else {
        // 非空列表 → 找到列表末尾（下一个缩进 <= indent 的同级键）
        let endIdx = regexIdx + 1
        while (endIdx < lines.length) {
          const line = lines[endIdx]
          if (line.trim() === "") { endIdx++; continue }
          const lineIndent = line.match(/^\s*/)[0]
          if (lineIndent.length <= indent.length) break
          endIdx++
        }
        lines.splice(endIdx, 0, ...newLines)
      }
      yamlContent = lines.join("\n")
    }
  }

  // 2b. 插入/更新扫描报告注释
  // 先解析文件中已有的报告条目，按 path 索引
  const existingReportPaths = new Set()
  const reportLineRegex = /^#\s+\[([^\]]+)\]\s+([✅❌])\s+/
  for (const line of yamlContent.split("\n")) {
    const m = line.match(reportLineRegex)
    if (m) existingReportPaths.add(m[1])
  }

  // 过滤出报告中尚未记录的条目
  const newReportLines = results
    .filter((r) => !existingReportPaths.has(r.path))
    .map(({ path, value, covered, ruleName, ruleDescription }) => {
      const val = String(value ?? "")
      if (covered) {
        const desc = ruleDescription || ruleName || "?"
        return `#   [${path}]  ✅  已匹配 ${desc}`
      }
      const prefix = val.length > 8 ? val.slice(0, 6) + "..." : val
      return `#   [${path}]  ❌  以 "${prefix}" 开头，约 ${val.length} 字符`
    })

  if (newReportLines.length > 0) {
    // 更新已有报告的头部/尾部信息（重新统计）
    const uncovered = results.filter((r) => !r.covered)
    const footer = uncovered.length > 0
      ? "为未覆盖的值添加对应 pattern（无需暴露原文），重启 Opencode 后自动消除。"
      : "所有敏感值均已被覆盖，无需额外操作。"

    const hasExistingReport = /# ======== auto-discovered: 扫描报告/.test(yamlContent)

    if (!hasExistingReport) {
      // 首次写入：整份报告插入到 patterns: 前面
      const allLines = results.map(({ path, value, covered, ruleName, ruleDescription }) => {
        const val = String(value ?? "")
        if (covered) {
          const desc = ruleDescription || ruleName || "?"
          return `#   [${path}]  ✅  已匹配 ${desc}`
        }
        const prefix = val.length > 8 ? val.slice(0, 6) + "..." : val
        return `#   [${path}]  ❌  以 "${prefix}" 开头，约 ${val.length} 字符`
      })

      const comment = [
        "# ======== auto-discovered: 扫描报告 ========",
        `# 以下是从 opencode.json 中发现的敏感值（共 ${results.length} 个）：`,
        "#",
        ...allLines,
        "#",
        `# 概要: ${results.length - uncovered.length} 个已覆盖 · ${uncovered.length} 个未覆盖`,
        `# ${footer}`,
        "# =========================================",
      ].join("\n")

      yamlContent = yamlContent.replace(
        /^patterns:/m,
        `${comment}\npatterns:`,
      )
    } else {
      // 已有报告：在尾部标记前追加新条目，并更新统计信息
      const insertBefore = "# ========================================="
      const newBlock = [
        ...newReportLines,
      ].join("\n")

      // 追加新条目到报告末尾（在分隔线之前）
      yamlContent = yamlContent.replace(
        insertBefore,
        `${newBlock}\n${insertBefore}`,
      )

      // 更新概要行
      yamlContent = yamlContent.replace(
        /^# 概要: .+$/m,
        `# 概要: ${results.length - uncovered.length} 个已覆盖 · ${uncovered.length} 个未覆盖`,
      )
      yamlContent = yamlContent.replace(
        /^# (所有敏感值均已被覆盖|为未覆盖的值添加对应 pattern).+$/m,
        `# ${footer}`,
      )

      // 更新总数行
      yamlContent = yamlContent.replace(
        /^# 以下是从 opencode\.json 中发现的敏感值（共 \d+ 个）：$/m,
        `# 以下是从 opencode.json 中发现的敏感值（共 ${results.length} 个）：`,
      )
    }
  }

  const tmpPath = configPath + ".tmp"
  await fs.writeFile(tmpPath, yamlContent, "utf8")
  await fs.rename(tmpPath, configPath)

  return newRules.length
}
