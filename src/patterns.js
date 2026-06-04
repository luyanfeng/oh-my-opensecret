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
  // ---- API Key 规则 ----
  [
    "openai_key",
    {
      description: "OpenAI API Key（sk-... / sk-proj-...）",
      // sk- + 48 chars (legacy), sk-proj- + 32~156 chars (project)
      pattern: String.raw`sk-(?:proj-)?[A-Za-z0-9]{32,156}`,
      placeholderId: "OPENAI_KEY",
    },
  ],
  [
    "openai_org_id",
    {
      description: "OpenAI 组织 ID（org-...）",
      // org- + 24 hex chars
      pattern: String.raw`org-[A-Za-z0-9]{24}`,
      placeholderId: "OPENAI_ORG",
    },
  ],
  [
    "github_token",
    {
      description: "GitHub 令牌（ghp_... / gho_... / github_pat_...）",
      // ghp_/gho_/ghu_/ghs_/ghr_ + 24~36 = 28~40
      // github_pat_ + 可变长度
      pattern: String.raw`(?:gh[pousr]_[A-Za-z0-9]{24,36}|github_pat_[A-Za-z0-9_-]{20,80})`,
      placeholderId: "GITHUB_TOKEN",
    },
  ],
  [
    "aws_key",
    {
      description: "AWS Access Key（AKIA...）",
      pattern: String.raw`AKIA[0-9A-Z]{16}`,
      placeholderId: "AWS_ACCESS_KEY",
    },
  ],
  [
    "anthropic_key",
    {
      description: "Anthropic API Key（sk-ant-...）",
      // 新格式: sk-ant-api03- + 93 chars + AA = 108
      // 旧格式: sk-ant- + 至少 48 chars
      pattern: String.raw`sk-ant-(?:api03-)?[A-Za-z0-9]{48,93}(?:AA)?`,
      placeholderId: "ANTHROPIC_KEY",
    },
  ],
  [
    "google_key",
    {
      description: "Google API Key（AIza...）",
      // AIzaSy + 33 chars = 39（官方）, 也兼容较短测试值
      pattern: String.raw`AIza(?:Sy)?[A-Za-z0-9_-]{28,35}`,
      placeholderId: "GOOGLE_KEY",
    },
  ],
  [
    "stripe_key",
    {
      description: "Stripe API Key（sk_live_... / sk_test_...）",
      // sk_test_ / sk_live_ + 24 chars = 32
      pattern: String.raw`sk_(?:test|live)_[A-Za-z0-9]{24}`,
      placeholderId: "STRIPE_KEY",
    },
  ],
  [
    "hf_token",
    {
      description: "HuggingFace Token（hf_...）",
      // hf_ + 34 chars 或 hf_ + 40 chars
      pattern: String.raw`hf_[A-Za-z0-9]{34}(?:[A-Za-z0-9]{6})?`,
      placeholderId: "HF_TOKEN",
    },
  ],
  [
    "pplx_key",
    {
      description: "Perplexity API Key（pplx-...）",
      pattern: String.raw`pplx-[A-Za-z0-9]{16,48}`,
      placeholderId: "PPLX_KEY",
    },
  ],
  [
    "groq_key",
    {
      description: "Groq API Key（gsk_...）",
      // gsk_ + 40~52 chars（含 _ 和 -）
      pattern: String.raw`gsk_[A-Za-z0-9_\-]{40,52}`,
      placeholderId: "GROQ_KEY",
    },
  ],
  [
    "gitlab_token",
    {
      description: "GitLab 个人访问令牌（glpat-...）",
      // glpat- + 14 chars = 20（官方说 20 字符总长，含前缀）
      pattern: String.raw`glpat-[A-Za-z0-9\-]{14}`,
      placeholderId: "GITLAB_TOKEN",
    },
  ],
  [
    "replicate_key",
    {
      description: "Replicate API Token（r8_...）",
      // r8_ + 37 chars = 40（官方明确说 40 字符）
      pattern: String.raw`r8_[A-Za-z0-9_\-]{37}`,
      placeholderId: "REPLICATE_KEY",
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
  // ---- 国内平台 API Key 规则 ----
  // 注：多数国内平台兼容 OpenAI 格式（sk-xxx），已被 openai_key 规则兜底。
  // 以下规则仅添加有独立格式或常用平台，便于日志区分。
  [
    "bailian_key",
    {
      description: "阿里云百炼 Coding Plan Key（sk-sp-...）",
      // sk-sp- + 32+ chars，兼容 OpenAI 格式
      pattern: String.raw`sk-sp-[A-Za-z0-9]{32,64}`,
      placeholderId: "BAILIAN_KEY",
    },
  ],
  [
    "zhipu_key",
    {
      description: "智谱 GLM API Key（xxx.xxx 双段格式）",
      pattern: String.raw`[A-Za-z0-9]{32,}\.[A-Za-z0-9]{32,}`,
      placeholderId: "ZHIPU_KEY",
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
