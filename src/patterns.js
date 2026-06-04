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
      description: "MAC 地址（xx:xx:xx:xx:xx:xx）",
      pattern: String.raw`/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i`,
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
 * 从用户配置构建完整的模式集。
 * @param {object} raw 原始 patterns 配置
 * @returns {{ keywords: Array<{value:string,placeholderId:string}>, regex: Array<{pattern:string,placeholderId:string}>, exclude: Set<string> }}
 */
export function buildPatternSet(raw) {
  const patterns = raw && typeof raw === "object" ? raw : {}

  const keywords = Array.isArray(patterns.keywords) ? patterns.keywords : []
  const regex = Array.isArray(patterns.regex) ? patterns.regex : []
  const builtin = Array.isArray(patterns.builtin) ? patterns.builtin : []
  const exclude = Array.isArray(patterns.exclude) ? patterns.exclude : []

  const keywordRules = keywords
    .map((x) => {
      if (!x || typeof x !== "object") return null
      const value = String(x.value ?? "").trim()
      if (!value) return null
      return { value, placeholderId: sanitizeCategory(x.placeholderId) }
    })
    .filter(Boolean)

  const regexRules = []
  for (const x of regex) {
    if (!x || typeof x !== "object") continue
    const pattern = String(x.pattern ?? "").trim()
    if (!pattern) continue
    // YAML 中可能是 placeholder-id，JS 对象中可能是 placeholderId
    const pid = x.placeholderId ?? x["placeholder-id"]
    const placeholderId = sanitizeCategory(pid)
    const parsed = parsePatternFlags(pattern)
    regexRules.push({ pattern: parsed.pattern, placeholderId })
  }

  for (const name of builtin) {
    const key = String(name ?? "").trim()
    if (!key) continue
    const rule = BUILTIN.get(key)
    if (!rule) continue
    regexRules.push({ pattern: rule.pattern, placeholderId: rule.placeholderId })
  }

  const excludeSet = new Set(exclude.map((x) => String(x ?? "")))

  return {
    keywords: keywordRules,
    regex: regexRules,
    exclude: excludeSet,
  }
}

export { BUILTIN, parsePatternFlags }
