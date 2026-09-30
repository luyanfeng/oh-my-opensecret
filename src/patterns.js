/**
 * 内置规则：常见敏感信息的正则匹配模式。
 * 目标是"低配置成本 + 尽量覆盖"，不追求 100% 精准。
 *
 * pattern 支持 /regex/flags 字面量语法和内联 (?i)(?m)(?s) 前缀。
 */
const BUILTIN = new Map([
  [
    "email",
    {
      description: "邮箱地址",
      pattern: String.raw`/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i`,
      placeholderId: "EMAIL",
    },
  ],
  [
    "china_phone",
    {
      description: "中国大陆手机号（1xx-xxxx-xxxx）",
      pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
      placeholderId: "CHINA_PHONE",
    },
  ],
  [
    "china_id",
    {
      description: "中国大陆身份证号（18位数字+X）",
      pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
      placeholderId: "CHINA_ID",
    },
  ],
  [
    "uuid",
    {
      description: "UUID v4 格式",
      pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
      placeholderId: "UUID",
    },
  ],
  [
    "ipv4",
    {
      description: "IPv4 地址（点分十进制）",
      pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`,
      placeholderId: "IPV4",
    },
  ],
  [
    "ipv6",
    {
      description: "IPv6 地址（全写: 8组4位hex）",
      pattern: String.raw`/(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/`,
      placeholderId: "IPV6",
    },
  ],
  [
    "mac",
    {
      description: "MAC 地址（xx:xx:xx:xx:xx:xx 或 xx-xx-xx-xx-xx-xx）",
      pattern: String.raw`/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2}/i`,
      placeholderId: "MAC",
    },
  ],
  [
    "jwt",
    {
      description: "JWT Token（eyJxxx.eyJxxx.xxx）",
      pattern: String.raw`eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+`,
      placeholderId: "JWT",
    },
  ],
  [
    "db_connection",
    {
      description: "数据库连接字符串（mysql/postgres/mongodb/redis://user:pass@）",
      pattern: String.raw`(?:mysql|postgres|mongodb|redis)://[^:]+:[^@]+@`,
      placeholderId: "DB_CONNECTION",
    },
  ],
])

function sanitizeCategory(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return "TEXT"
  const upper = raw.toUpperCase()
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_")
  if (!safe) return "TEXT"
  return safe
}

/**
 * 从 pattern 中提取正则标志。
 *
 * 支持两种方式（可叠加）：
 *   - /pattern/flags 字面量语法（flags 在最后一个 / 之后）
 *   - (?i) (?m) (?s) 内联前缀
 *
 * @param {string} pattern
 * @returns {{ pattern: string, flags: string }}
 */
function parsePatternFlags(pattern) {
  let p = String(pattern ?? "")
  let f = ""

  // 1. 提取 /pattern/flags 字面量语法
  const literalMatch = p.match(/^\/(.+)\/([gimsuvy]*)$/s)
  if (literalMatch) {
    p = literalMatch[1]
    f = literalMatch[2]
  }

  // 2. 提取 (?i) (?m) (?s) 内联前缀
  for (;;) {
    if (p.startsWith("(?i)")) { p = p.slice(4); if (!f.includes("i")) f += "i"; continue }
    if (p.startsWith("(?m)")) { p = p.slice(4); if (!f.includes("m")) f += "m"; continue }
    if (p.startsWith("(?s)")) { p = p.slice(4); if (!f.includes("s")) f += "s"; continue }
    break
  }

  return { pattern: p, flags: f }
}

/**
 * 编译正则规则（自定义 + 内置）为统一结构。
 *
 * 运行时脱敏（buildPatternSet）与 auto-discovery 覆盖判定
 * （config.js expandPatternsWithMeta）必须共用本函数，否则两侧对
 * `/regex/flags` 与 `(?i)` 内联前缀的解析结果会不一致。
 *
 * @param {object} raw 原始 patterns 配置
 * @returns {Array<{ pattern: string, flags: string, placeholderId: string, source: "custom"|"builtin", description: string }>}
 */
function compileRegexRules(raw) {
  const patterns = raw && typeof raw === "object" ? raw : {}
  const rules = []

  const custom = Array.isArray(patterns.regex) ? patterns.regex : []
  for (const x of custom) {
    if (!x || typeof x !== "object") continue
    const source = String(x.pattern ?? "").trim()
    if (!source) continue
    // YAML 中可能是 placeholder-id，JS 对象中可能是 placeholderId
    const placeholderId = sanitizeCategory(x.placeholderId ?? x["placeholder-id"])
    const parsed = parsePatternFlags(source)
    rules.push({
      pattern: parsed.pattern,
      flags: parsed.flags,
      placeholderId,
      source: "custom",
      description: placeholderId,
    })
  }

  const builtin = Array.isArray(patterns.builtin) ? patterns.builtin : []
  for (const name of builtin) {
    const key = String(name ?? "").trim()
    if (!key) continue
    const rule = BUILTIN.get(key)
    if (!rule) continue
    const parsed = parsePatternFlags(rule.pattern)
    rules.push({
      pattern: parsed.pattern,
      flags: parsed.flags,
      placeholderId: sanitizeCategory(rule.placeholderId),
      source: "builtin",
      description: rule.description || key,
    })
  }

  return rules
}

/**
 * 将简单的 glob 模式（仅支持 * 和 ?）转换为 RegExp。
 * - `*` 匹配任意非空字符序列（类似 shell glob，不跨多行）
 * - `?` 匹配单个非空字符
 * - 其余字符按字面匹配（已转义）
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  let src = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*") {
      src += "[^\\r\\n]+"
    } else if (ch === "?") {
      src += "[^\\r\\n]"
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp("^" + src + "$")
}

/**
 * 从用户配置构建完整的模式集。
 * @param {object} raw 原始 patterns 配置
 * @returns {{ keywords: Array<{value:string,placeholderId:string}>, regex: Array<{pattern:string,flags:string,placeholderId:string}>, exclude: { exact: Set<string>, glob: Array<{raw:string,re:RegExp}> } }}
 */
export function buildPatternSet(raw) {
  const patterns = raw && typeof raw === "object" ? raw : {}

  const keywords = Array.isArray(patterns.keywords) ? patterns.keywords : []
  const exclude = Array.isArray(patterns.exclude) ? patterns.exclude : []

  const keywordRules = keywords
    .map((x) => {
      if (!x || typeof x !== "object") return null
      const value = String(x.value ?? "").trim()
      if (!value) return null
      return { value, placeholderId: sanitizeCategory(x.placeholderId ?? x["placeholder-id"]) }
    })
    .filter(Boolean)

  const regexRules = compileRegexRules(patterns).map((r) => ({
    pattern: r.pattern,
    flags: r.flags,
    placeholderId: r.placeholderId,
  }))

  // exclude 支持精确字符串和 glob 模式（含 * 或 ?）
  const exactSet = new Set()
  const globRules = []
  for (const x of exclude) {
    const s = String(x ?? "")
    if (!s) continue
    if (/[*?]/.test(s)) {
      globRules.push({ raw: s, re: globToRegex(s) })
    } else {
      exactSet.add(s)
    }
  }

  return {
    keywords: keywordRules,
    regex: regexRules,
    exclude: { exact: exactSet, glob: globRules },
  }
}

export { BUILTIN, parsePatternFlags, compileRegexRules }
