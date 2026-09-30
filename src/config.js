import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yaml from "js-yaml"
import { compileRegexRules } from "./patterns.js"

const CONFIG_FILENAME = "oh-my-opensecret.yaml"
const ENV_CONFIG_PATH = "OPENCODE_SECRET_CONFIG"

/**
 * 解析时长字符串（如 "1h"、"30m"、"1d"）为毫秒数。
 * @param {string} input
 * @returns {number}
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/
const DURATION_UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }

/**
 * 校验时长字符串格式。
 * @param {string} input
 * @param {string} field 字段路径，用于错误信息
 */
function assertDurationFormat(input, field) {
  const raw = String(input).trim()
  if (!DURATION_RE.test(raw)) {
    throw new Error(
      `${field} 格式非法: ${JSON.stringify(raw)} — 合法格式为 数字+单位（ms/s/m/h/d），如 "30m"、"1h"、"7d"`,
    )
  }
}

/**
 * 解析时长字符串为毫秒数。字段缺失时返回默认 1h，字段非法时抛错。
 * @param {string} input
 * @param {string} field 字段路径，用于错误信息
 * @returns {number}
 */
function parseDurationMs(input, field = "session.ttl") {
  if (input === undefined || input === null) return DEFAULT_TTL_MS

  assertDurationFormat(input, field)
  const [, value, unit] = String(input).trim().match(DURATION_RE)
  return Number(value) * DURATION_UNITS[unit]
}

// ---- 配置 Schema 校验 ----

/** 描述实际值的类型，便于用户定位配置错误 */
function typeName(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** 描述实际值（字符串加引号并截断），避免错误信息本身过长 */
function describeValue(value) {
  if (typeof value === "string") {
    const shown = value.length > 40 ? value.slice(0, 40) + "…" : value
    return `${typeName(value)} ${JSON.stringify(shown)}`
  }
  return typeName(value)
}

/**
 * 校验原始配置对象，收集全部错误。
 * 只在「字段缺失」时允许后续补默认值；「字段非法」一律记为错误。
 * @param {any} raw
 * @returns {string[]}
 */
function validateSchema(raw) {
  const errors = []

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [`config must be an object (actual: ${typeName(raw)})`]
  }

  // enabled
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    errors.push(`enabled must be a boolean (actual: ${describeValue(raw.enabled)})`)
  }

  // logging
  if (raw.logging !== undefined && raw.logging !== null) {
    if (typeof raw.logging !== "object" || Array.isArray(raw.logging)) {
      errors.push(`logging must be an object (actual: ${typeName(raw.logging)})`)
    } else {
      const validLevels = ["debug", "info", "warn", "error"]
      if (raw.logging.level !== undefined && !validLevels.includes(raw.logging.level)) {
        errors.push(`logging.level must be one of: ${validLevels.join(", ")} (actual: ${describeValue(raw.logging.level)})`)
      }
      if (raw.logging.file !== undefined && typeof raw.logging.file !== "string") {
        errors.push(`logging.file must be a string (actual: ${typeName(raw.logging.file)})`)
      }
      if (raw.logging.rotation !== undefined && raw.logging.rotation !== null) {
        if (typeof raw.logging.rotation !== "object" || Array.isArray(raw.logging.rotation)) {
          errors.push(`logging.rotation must be an object (actual: ${typeName(raw.logging.rotation)})`)
        } else {
          if (raw.logging.rotation.max_size !== undefined && typeof raw.logging.rotation.max_size !== "string" && typeof raw.logging.rotation.max_size !== "number") {
            errors.push(`logging.rotation.max_size must be a string or number (actual: ${typeName(raw.logging.rotation.max_size)})`)
          }
          if (raw.logging.rotation.max_files !== undefined && (!Number.isInteger(raw.logging.rotation.max_files) || raw.logging.rotation.max_files < 1)) {
            errors.push(`logging.rotation.max_files must be a positive integer (actual: ${describeValue(raw.logging.rotation.max_files)})`)
          }
        }
      }
    }
  }

  // auto_discovery
  if (raw.auto_discovery !== undefined && typeof raw.auto_discovery !== "boolean") {
    errors.push(`auto_discovery must be a boolean (actual: ${describeValue(raw.auto_discovery)})`)
  }

  // placeholder_prefix
  if (raw.placeholder_prefix !== undefined && (typeof raw.placeholder_prefix !== "string" || !raw.placeholder_prefix)) {
    errors.push(`placeholder_prefix must be a non-empty string (actual: ${describeValue(raw.placeholder_prefix)})`)
  }

  // session
  if (raw.session !== undefined && raw.session !== null) {
    if (typeof raw.session !== "object" || Array.isArray(raw.session)) {
      errors.push(`session must be an object (actual: ${typeName(raw.session)})`)
    } else {
      if (raw.session.ttl !== undefined) {
        if (typeof raw.session.ttl !== "string") {
          errors.push(`session.ttl must be a string (actual: ${typeName(raw.session.ttl)})`)
        } else {
          try {
            assertDurationFormat(raw.session.ttl, "session.ttl")
          } catch (err) {
            errors.push(err.message)
          }
        }
      }
      if (raw.session.max_mappings !== undefined && (!Number.isFinite(raw.session.max_mappings) || raw.session.max_mappings < 1)) {
        errors.push(`session.max_mappings must be a positive number (actual: ${describeValue(raw.session.max_mappings)})`)
      }
    }
  }

  // patterns
  if (raw.patterns !== undefined && raw.patterns !== null) {
    if (typeof raw.patterns !== "object" || Array.isArray(raw.patterns)) {
      errors.push(`patterns must be an object (actual: ${typeName(raw.patterns)})`)
    } else {
      for (const key of ["keywords", "regex", "builtin", "exclude"]) {
        const value = raw.patterns[key]
        // 空键（`regex:` 后只有注释）解析为 null，等价于未设置
        if (value !== undefined && value !== null && !Array.isArray(value)) {
          errors.push(`patterns.${key} must be an array (actual: ${typeName(value)})`)
        }
      }
    }
  }

  // 正则规则可编译性
  if (raw.patterns && typeof raw.patterns === "object" && !Array.isArray(raw.patterns)) {
    for (const rule of compileRegexRules(raw.patterns)) {
      const reason = regexCompileError(rule)
      if (reason) {
        errors.push(`patterns.${rule.source === "builtin" ? "builtin" : "regex"} 规则非法（placeholder-id: ${rule.placeholderId}）: ${reason}`)
      }
    }
  }

  return errors
}

/** 正则规则是否可编译，非法时返回原因（用于 schema 校验阶段） */
function regexCompileError(rule) {
  const flags = rule.flags.includes("g") ? rule.flags : "g" + rule.flags
  try {
    // eslint-disable-next-line no-new
    new RegExp(rule.pattern, flags)
    return null
  } catch (err) {
    return `/${rule.pattern}/${rule.flags} — ${err.message}`
  }
}

/**
 * 将原始配置规范化（仅为缺失字段补默认值）。
 * 调用前必须已通过 validateSchema：非法值在此处直接抛错，不做静默兜底。
 * @param {any} raw
 * @returns {NormalizedConfig}
 */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}

  const enabled = cfg.enabled !== false

  // logging
  const logCfg = cfg.logging && typeof cfg.logging === "object" ? cfg.logging : {}
  const rotCfg = logCfg.rotation && typeof logCfg.rotation === "object" ? logCfg.rotation : {}
  const logging = {
    level: logCfg.level ?? "info",
    // ~ 由 logger 的 resolvePath 统一展开，此处原样透传，避免两套实现分歧
    file: logCfg.file ?? "~/.oh-my-opensecret/oh-my-opensecret.log",
    maxSize: rotCfg.max_size ?? "10m",
    maxFiles: rotCfg.max_files ?? 7,
  }
  const autoDiscovery = cfg.auto_discovery !== false
  const prefix = cfg.placeholder_prefix ?? "__OMOS_"

  const session = cfg.session && typeof cfg.session === "object" ? cfg.session : {}
  const ttlMs = parseDurationMs(session.ttl, "session.ttl")
  const maxMappings = session.max_mappings ?? 100000

  const patterns = cfg.patterns && typeof cfg.patterns === "object" ? cfg.patterns : {}

  return {
    enabled,
    logging,
    autoDiscovery,
    prefix,
    ttlMs,
    maxMappings,
    patterns,
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
  # 内置规则仅覆盖通用 PII 类信息，不包含任何平台 API Key。
  # API Key 请在自定义 regex 中添加。
  #
  # 可用内置规则:
  #   email           邮箱地址
  #   china_phone     中国大陆手机号（1xx-xxxx-xxxx）
  #   china_id        中国大陆身份证号（18位数字+X）
  #   uuid            UUID v4 格式
  #   ipv4            IPv4 地址
  #   ipv6            IPv6 地址
  #   mac             MAC 地址（xx:xx:xx:xx:xx:xx 或 xx-xx-xx-xx-xx-xx）
  #   jwt             JWT Token（eyJxxx.eyJxxx.xxx）
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
    - jwt
    - db_connection

  # ---------- 排除列表（豁免）----------
  # 以下内容即使匹配规则也不会被脱敏。
  # 支持 *（匹配任意非空字符序列）和 ?（匹配单个非空字符）通配符：
  #   - "*@test.com"          → 排除所有 @test.com 后缀
  #   - "192.168.??.*"       → 排除 192.168.xx.xx 网段
  #   - "sk-test-*"           → 排除以 sk-test- 开头的值
  # 不含通配符的字符串按精确匹配处理。
  exclude:
    - "example.com"
    - "localhost"
    - "127.0.0.1"
    - "0.0.0.0"
`
}

// ---- 原子写入 ----

/**
 * 以 tmp + rename 方式写文件，避免并发进程互相抢文件、以及写一半留下损坏文件。
 * @param {string} targetPath
 * @param {string} content
 */
async function writeFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmpPath, content, "utf8")
    await fs.rename(tmpPath, targetPath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true })
    throw new Error(`写入文件失败: ${targetPath} — ${err.message}`)
  }
}

// ---- 配置查找 ----

/**
 * 获取 OpenCode 的全局配置目录。
 * 与宿主保持一致：OPENCODE_CONFIG_DIR 优先，其次 XDG_CONFIG_HOME，最后 ~/.config。
 * @returns {string}
 */
function globalOpencodeConfigDir() {
  const envDir = process.env.OPENCODE_CONFIG_DIR
  if (envDir) return path.resolve(String(envDir))
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(String(xdg), "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

/**
 * 获取配置候选路径列表。
 * @param {string} directory 项目根目录
 * @returns {string[]}
 */
export function getConfigCandidates(directory) {
  const dir = String(directory ?? process.cwd())

  const envPath = process.env[ENV_CONFIG_PATH]
  if (envPath) {
    // 环境变量为显式指定：只认该路径，找不到即视为无配置，不静默回落到其它位置
    return [path.resolve(dir, envPath)]
  }

  return [
    path.join(dir, CONFIG_FILENAME),
    path.join(dir, ".opencode", CONFIG_FILENAME),
    path.join(globalOpencodeConfigDir(), CONFIG_FILENAME),
  ]
}

/**
 * 查找并加载配置文件。
 * 文件不存在属正常情况（继续下一个候选）；文件存在但读取/解析失败必须抛错。
 * @param {string} directory
 * @returns {Promise<{ filepath: string, raw: any }|null>}
 */
async function findAndReadConfig(directory) {
  const candidates = getConfigCandidates(directory)
  for (const filepath of candidates) {
    if (!filepath) continue
    if (!existsSync(filepath)) continue

    const content = await fs.readFile(filepath, "utf8")
    const raw = yaml.load(content)
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return { filepath, raw }
    }
    throw new Error(
      `配置文件内容必须是 YAML 映射（key: value），实际解析为 ${typeName(raw)}: ${filepath}`,
    )
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
  const globalDir = globalOpencodeConfigDir()
  const candidates = [
    // 本地项目
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    // 全局 Opencode 配置
    path.join(globalDir, "opencode.json"),
    path.join(globalDir, "opencode.jsonc"),
  ]
  for (const filepath of candidates) {
    if (!existsSync(filepath)) continue
    // 文件存在但读不出/解析不了必须抛错：静默跳过后会漏扫密钥，
    // 新规则不会生成，明文密钥将直接进入 LLM 请求
    const content = await fs.readFile(filepath, "utf8")
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
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
      try {
        parsed = JSON.parse(stripped)
      } catch (err) {
        throw new Error(`opencode 配置解析失败: ${filepath} — ${err.message}`)
      }
    }
    return parsed
  }
  return null
}

// ---- 自动发现 API Key ----

/** 扫描报告块的首行与末行，作为按行定位的锚点 */
const REPORT_HEADER = "# ======== auto-discovered: 扫描报告 ========"
const REPORT_FOOTER = "# ========================================="
const REPORT_HEADER_RE = /^# ======== auto-discovered: 扫描报告/

/**
 * 敏感字段名（全部小写）。匹配时对配置 key 做 toLowerCase() 后比对，
 * 以覆盖 API_KEY / ApiKey / AUTHORIZATION 等大小写变体。
 */
const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "api-key",
  "secret", "secretkey", "secret_key", "secret-key",
  "token", "accesstoken", "access_token", "access-token",
  "authtoken", "auth_token", "auth-token",
  "refreshtoken", "refresh_token", "refresh-token",
  "authorization", "bearer", "credentials", "dsn",
  "password", "passwd",
  "privatekey", "private_key", "private-key",
  "appsecret", "app_secret", "app-secret",
  "clientsecret", "client_secret", "client-secret",
  "clientkey", "client_key", "client-key",
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

    if (typeof value === "string" && value.length >= 8 && SENSITIVE_KEYS.has(key.toLowerCase())) {
      if (!isPlaceholder(value)) {
        results.push({ path: fullPath, value })
      }
    } else if (Array.isArray(value)) {
      // 数组式 provider 配置（如 {"providers":[{"apiKey":"sk-..."}]}）同样要扫描
      value.forEach((item, index) => {
        results.push(...collectSensitiveValues(item, `${fullPath}[${index}]`))
      })
    } else if (value && typeof value === "object") {
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
  // 与运行时脱敏共用 patterns.compileRegexRules，避免两处编译结果不一致
  return compileRegexRules(rawConfig?.patterns).map((rule) => ({
    regex: new RegExp(rule.pattern, rule.flags.includes("g") ? rule.flags : "g" + rule.flags),
    name: rule.placeholderId,
    description: rule.description,
    source: rule.source,
  }))
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
 * 配置非法时抛错中止，不套默认值。
 * @param {string} directory 项目根目录
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} [logger]
 * @returns {Promise<NormalizedConfig & { loadedFrom: string }>}
 */
export async function loadConfig(directory, logger) {
  const noop = () => {}
  const log = logger || { debug: noop, info: noop, warn: noop, error: noop }

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
      : path.join(globalOpencodeConfigDir(), CONFIG_FILENAME)
    const defaultYaml = generateDefaultYaml()
    await fs.mkdir(path.dirname(defaultPath), { recursive: true })
    await writeFileAtomic(defaultPath, defaultYaml)
    log.info(`默认配置已生成: ${defaultPath}`)

    rawConfig = yaml.load(defaultYaml)
    configPath = defaultPath
  } else {
    rawConfig = found.raw
    configPath = found.filepath
  }

  // 3. Schema 校验：非法配置直接抛错中止，不套默认值
  const errors = validateSchema(rawConfig)
  if (errors.length > 0) {
    throw new Error(`配置校验失败 (${configPath}):\n  - ${errors.join("\n  - ")}`)
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
          const newRules = await writeDiscoveryReport(configPath, rawConfig, results)
          const uncovered = results.filter((r) => !r.covered)
          if (newRules.length > 0) {
            // 新规则必须立即对当前进程生效，而不只是落盘。
            // 报告已把这些值判定为「已覆盖、无需额外操作」，若 cfg.patterns 里没有它们，
            // 这些密钥会以明文进入本次会话的 LLM 请求，与报告结论直接矛盾。
            const regexList = Array.isArray(cfg.patterns.regex) ? cfg.patterns.regex : []
            for (const rule of newRules) {
              regexList.push({ pattern: rule.pattern, placeholderId: rule.id })
            }
            cfg.patterns.regex = regexList
            log.info(`自动发现: 生成 ${newRules.length} 条新规则（共 ${results.length} 个敏感值，${results.length - uncovered.length} 已覆盖）`)
          } else if (uncovered.length > 0) {
            log.info(`自动发现: 共 ${results.length} 个敏感值（${results.length - uncovered.length} 已覆盖，${uncovered.length} 未覆盖，规则已存在跳过）`)
          } else {
            log.info(`自动发现: ${results.length} 个敏感值，全部已被规则覆盖`)
          }
        }
      }
    } catch (err) {
      // 报告块损坏属于配置自身不可用，抛错中止加载，不能降级为记日志继续跑：
      // 规则未落盘时新发现的密钥会以明文进入 LLM 请求，而报告仍停留在旧的
      // 「✅ 已覆盖」状态，用户无从察觉。宁可启动失败也不要静默泄漏。
      log.error(`自动发现失败，本次新增规则未写入配置文件: ${err.message}`)
      throw new Error(`自动发现失败，配置未生效: ${err.message}`, { cause: err })
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
  return escaped + "[A-Za-z0-9_-]{" + remainLen + "}(?![A-Za-z0-9_-])"
}

/**
 * 将 auto-discovery 完整扫描报告写入 YAML 配置文件。
 * - 已覆盖的值 → 注释中标 ✅ 及匹配规则
 * - 未覆盖的值 → 生成新正则规则追加到 patterns.regex（跳过已有 placeholder-id）
 *   每条规则前带 # auto-generated 注释说明数据来源
 * @param {string} configPath
 * @param {object} rawConfig 原始配置对象（用于检查已有规则）
 * @param {Array<{ path: string, covered: boolean, ruleName: string|null, ruleDescription: string|null, value: string }>} results
 * @returns {Promise<Array<{path: string, id: string, pattern: string}>>} 本次新增的规则，供调用方注入当前进程
 */
async function writeDiscoveryReport(configPath, rawConfig, results) {
  if (results.length === 0) return []

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
      // pattern 用 JSON.stringify 转义：YAML 双引号标量兼容 JSON 转义，
      // 密钥前 4 字符含 " 或 \ 时手写引号会产出非法 YAML
      const newLines = []
      for (const nr of newRules) {
        newLines.push(`${itemIndent}# auto-generated for: opencode.json → ${nr.path}`)
        newLines.push(`${itemIndent}- pattern: ${JSON.stringify(nr.pattern)}`)
        newLines.push(`${valIndent}placeholder-id: ${JSON.stringify(nr.id)}`)
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

  // 2b. 渲染/更新扫描报告注释
  //
  // 报告块的内容完全由本轮 results 决定，因此每轮整体重算并整体替换旧块，
  // 不做增量追加。增量方案有三个无法收敛的问题：
  //   - 覆盖状态永不更新：更新整块曾被「是否有新路径」守着，已有路径的 ✅/❌ 翻转不会反映
  //   - 概要与实际条目数脱节：概要曾按本轮 results.length 统计，块内却可能累积历史条目
  //   - 陈旧条目只增不减：配置里已不存在的路径（如 provider 改名）会永久留下且永不更新
  const formatReportLine = ({ path, value, covered, ruleName, ruleDescription }) => {
    if (covered) {
      const desc = ruleDescription || ruleName || "?"
      return `#   [${path}]  ✅  已匹配 ${desc}`
    }
    // 绝不写入原文片段（配置文件通常会被提交 git），只提示 key 名与长度
    return `#   [${path}]  ❌  未覆盖，长度 ${String(value ?? "").length} 字符`
  }

  const uncovered = results.filter((r) => !r.covered)
  const reportBlock = [
    REPORT_HEADER,
    `# 以下是从 opencode.json 中发现的敏感值（共 ${results.length} 个）：`,
    "#",
    ...results.map(formatReportLine),
    "#",
    `# 概要: ${results.length - uncovered.length} 个已覆盖 · ${uncovered.length} 个未覆盖`,
    `# ${uncovered.length > 0
      ? "为未覆盖的值添加对应 pattern（无需暴露原文），重启 Opencode 后自动消除。"
      : "所有敏感值均已被覆盖，无需额外操作。"}`,
    REPORT_FOOTER,
  ]

  {
    const lines = yamlContent.split("\n")
    const headerIdx = lines.findIndex((l) => REPORT_HEADER_RE.test(l))

    if (headerIdx < 0) {
      const patternsIdx = lines.findIndex((l) => /^patterns:/.test(l))
      if (patternsIdx < 0) {
        throw new Error(`配置文件缺少 patterns: 字段，无法写入自动发现报告: ${configPath}`)
      }
      lines.splice(patternsIdx, 0, ...reportBlock)
    } else {
      // 块内是纯生成内容，header 到 footer 整段替换。
      // 边界只认 header/footer 两行，不用文件头的分隔线当锚点——
      // 文件头分隔线更长且包含 REPORT_FOOTER 子串，按子串匹配会插错位置。
      const footerIdx = lines.findIndex(
        (l, i) => i > headerIdx && l === REPORT_FOOTER,
      )
      if (footerIdx < 0) {
        throw new Error(`自动发现报告缺少结束行「${REPORT_FOOTER}」，报告块已损坏，请手动删除该注释块: ${configPath}`)
      }
      lines.splice(headerIdx, footerIdx - headerIdx + 1, ...reportBlock)
    }

    yamlContent = lines.join("\n")
  }

  await writeFileAtomic(configPath, yamlContent)

  return newRules
}
