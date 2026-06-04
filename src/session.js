import { createHmac, randomBytes } from "node:crypto"

function sanitizeCategory(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return "TEXT"
  const upper = raw.toUpperCase()
  return upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_") || "TEXT"
}

/**
 * 会话内占位符映射管理器。
 *
 * 占位符格式：`#{PREFIX}_{CATEGORY}_{hash12}__`
 * - hash12 = HMAC-SHA256(会话随机 secret, 原文) 前 12 位 hex
 * - 同一会话内同一原文 → 同一占位符（稳定可逆）
 * - 对上游 provider 不可逆
 */
export class PlaceholderSession {
  /**
   * @param {{ prefix: string, ttlMs: number, maxMappings: number, secret?: Uint8Array }} options
   */
  constructor(options) {
    const prefix = String(options?.prefix ?? "__OMOS_")
    this.prefix = prefix
    this.ttlMs = Number.isFinite(options?.ttlMs) ? options.ttlMs : 60 * 60 * 1000
    this.maxMappings = Number.isFinite(options?.maxMappings) ? options.maxMappings : 100000
    this.secret = options?.secret ? Uint8Array.from(options.secret) : randomBytes(32)

    /** @type {Map<string,string>} */
    this.forward = new Map()   // placeholder → original
    /** @type {Map<string,string>} */
    this.reverse = new Map()   // original → placeholder
    /** @type {Map<string,number>} */
    this.created = new Map()   // placeholder → timestamp
  }

  /**
   * 清理过期映射。
   * @param {number} [now=Date.now()]
   */
  cleanup(now = Date.now()) {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return
    for (const [placeholder, createdAt] of this.created) {
      if (now - createdAt <= this.ttlMs) continue
      const original = this.forward.get(placeholder)
      this.forward.delete(placeholder)
      this.created.delete(placeholder)
      if (original !== undefined) this.reverse.delete(original)
    }
  }

  /**
   * 淘汰最早的一条映射（当超过 maxMappings 时）。
   */
  evictOldest() {
    let oldestPlaceholder = ""
    let oldestTime = Infinity
    for (const [placeholder, createdAt] of this.created) {
      if (createdAt < oldestTime) {
        oldestTime = createdAt
        oldestPlaceholder = placeholder
      }
    }
    if (!oldestPlaceholder) return
    const original = this.forward.get(oldestPlaceholder)
    this.forward.delete(oldestPlaceholder)
    this.created.delete(oldestPlaceholder)
    if (original !== undefined) this.reverse.delete(original)
  }

  /**
   * 通过占位符查找原文。
   * @param {string} placeholder
   * @returns {string|undefined}
   */
  lookup(placeholder) {
    return this.forward.get(placeholder)
  }

  /**
   * 通过原文查找占位符。
   * @param {string} original
   * @returns {string|undefined}
   */
  lookupReverse(original) {
    return this.reverse.get(original)
  }

  /**
   * 生成占位符字符串。
   * @param {string} original
   * @param {string} placeholderId
   * @returns {string}
   */
  generatePlaceholder(original, placeholderId) {
    const cat = sanitizeCategory(placeholderId)
    const h = createHmac("sha256", this.secret)
    h.update(String(original))
    const hash12 = h.digest("hex").slice(0, 12)
    return `${this.prefix}${cat}_${hash12}__`
  }

  /**
   * 获取或创建占位符。
   * 同一会话内同一 original 始终映射到同一 placeholder。
   * @param {string} original
   * @param {string} placeholderId
   * @returns {string}
   */
  getOrCreatePlaceholder(original, placeholderId) {
    const cached = this.lookupReverse(original)
    if (cached) return cached

    const now = Date.now()
    this.cleanup(now)

    if (Number.isFinite(this.maxMappings) && this.maxMappings > 0) {
      while (this.forward.size >= this.maxMappings) this.evictOldest()
    }

    const base = this.generatePlaceholder(original, placeholderId)
    const prev = this.forward.get(base)

    if (prev === undefined) {
      // 正常情况：无冲突
      this.forward.set(base, original)
      this.reverse.set(original, base)
      this.created.set(base, now)
      return base
    }

    if (prev === original) {
      // 已存在且一致，更新时间戳
      this.created.set(base, now)
      return base
    }

    // 极低概率：hash12 冲突。追加 _N 后缀
    const withoutSuffix = base.slice(0, -2) // 去掉末尾 "__"
    for (let i = 2; ; i++) {
      const candidate = `${withoutSuffix}_${i}__`
      const existing = this.forward.get(candidate)
      if (existing === undefined) {
        this.forward.set(candidate, original)
        this.reverse.set(original, candidate)
        this.created.set(candidate, now)
        return candidate
      }
      if (existing === original) {
        this.created.set(candidate, now)
        return candidate
      }
    }
  }

  /**
   * 当前映射数量。
   * @returns {number}
   */
  get size() {
    return this.forward.size
  }
}

/**
 * 构建匹配占位符的正则表达式。
 * @param {string} prefix 占位符前缀
 * @returns {RegExp}
 */
export function getPlaceholderRegex(prefix) {
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${escaped}[A-Za-z0-9_]+_[a-f0-9]{12}(?:_\\d+)?__`, "g")
}
