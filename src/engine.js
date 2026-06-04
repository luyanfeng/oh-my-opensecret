/**
 * 从 ordered 列表中移除被 covered 区间覆盖的部分。
 * @param {number} start
 * @param {number} end
 * @param {Array<{start:number,end:number}>} covered 已覆盖的区间列表（已排序）
 * @returns {Array<{start:number,end:number}>}
 */
function subtractCovered(start, end, covered) {
  if (start >= end) return []
  const out = []
  let cur = start
  for (const c of covered) {
    if (c.end <= cur) continue
    if (c.start >= end) break
    if (c.start > cur) out.push({ start: cur, end: Math.min(c.start, end) })
    if (c.end >= end) { cur = end; break }
    cur = Math.max(cur, c.end)
  }
  if (cur < end) out.push({ start: cur, end })
  return out
}

/**
 * 检查字符串是否已是占位符格式（{PREFIX}_{CATEGORY}_{hash12}__）。
 * @param {string} s
 * @param {string} prefix 占位符前缀（如 "__OMOS_"）
 * @returns {boolean}
 */
function isPlaceholderLike(s, prefix) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${esc}[A-Z]+_[A-Z0-9_]+_[a-f0-9]{12}__$`).test(String(s ?? ""))
}

/**
 * 将一个区间插入 covered 列表并合并重叠区间。
 * @param {Array<{start:number,end:number}>} covered
 * @param {{start:number,end:number}} span
 * @returns {Array<{start:number,end:number}>}
 */
function insertCovered(covered, span) {
  if (span.start >= span.end) return covered
  let i = 0
  for (; i < covered.length; i++) {
    if (covered[i].start > span.start) break
  }
  covered.splice(i, 0, span)
  if (covered.length <= 1) return covered

  const merged = []
  for (const c of covered) {
    const last = merged.at(-1)
    if (!last) { merged.push(c); continue }
    if (c.start <= last.end) {
      if (c.end > last.end) last.end = c.end
      continue
    }
    merged.push(c)
  }
  return merged
}

/**
 * 从 pattern 中提取正则标志（兼容 /pattern/flags 字面量语法）。
 * @param {string} pattern
 * @returns {{ pattern: string, flags: string }}
 */
function parsePatternFlags(pattern) {
  let p = String(pattern ?? "")
  let f = ""
  const literalMatch = p.match(/^\/(.+)\/([gimsuvy]*)$/s)
  if (literalMatch) {
    p = literalMatch[1]
    f = literalMatch[2]
  }
  for (;;) {
    if (p.startsWith("(?i)")) { p = p.slice(4); if (!f.includes("i")) f += "i"; continue }
    if (p.startsWith("(?m)")) { p = p.slice(4); if (!f.includes("m")) f += "m"; continue }
    if (p.startsWith("(?s)")) { p = p.slice(4); if (!f.includes("s")) f += "s"; continue }
    break
  }
  return { pattern: p, flags: f }
}

/**
 * 扫描文本中所有已有占位符的区间。
 * 占位符格式：{PREFIX}_{CATEGORY}_{hash12}__ 或 {PREFIX}_{CATEGORY}_{hash12}_N__
 * @param {string} text
 * @param {string} prefix 占位符前缀（如 "__OMOS_"）
 * @returns {Array<{start:number,end:number}>}
 */
function collectPlaceholderRanges(text, prefix) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`${esc}[A-Z]+_[A-Z0-9_]+_[a-f0-9]{12}(?:_\\d+)?__`, "g")
  const ranges = []
  for (const m of text.matchAll(re)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges
}

/**
 * 对输入文本进行脱敏替换。
 *
 * 策略：
 * 1. keywords 精确匹配（indexOf 扫描）
 * 2. regex 正则匹配（matchAll 全局扫描）
 * 3. 重叠处理：右侧优先排序 → subtractCovered 分割 → insertCovered 合并
 * 4. 从右到左替换，避免 index 偏移
 *
 * @param {string} input 原始文本
 * @param {{ keywords: Array<{value:string,placeholderId:string}>, regex: Array<{pattern:string,placeholderId:string}>, exclude: Set<string> }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, placeholderId: string): string }} session
 * @param {string} [placeholderPrefix] 占位符前缀，用于跳过已脱敏的值
 * @returns {{ text: string, matches: Array<{start:number,end:number,original:string,placeholderId:string,placeholder?:string}> }}
 */
export function redactText(input, patterns, session, placeholderPrefix) {
  const text = String(input ?? "")
  if (!text) return { text, matches: [] }

  /** @type {Array<{start:number,end:number,original:string,placeholderId:string}>} */
  const found = []

  // 预扫描：如果传入了 placeholderPrefix，找出文本中所有已有占位符的区间
  // 后续匹配跳过这些区间，避免二次脱敏
  const skipRanges = placeholderPrefix
    ? collectPlaceholderRanges(text, placeholderPrefix)
    : []

  /** 检查一个区间是否被任何 skipRanges 覆盖 */
  function isInSkipRange(start, end) {
    for (const r of skipRanges) {
      if (start >= r.start && end <= r.end) return true
    }
    return false
  }

  // Keywords 匹配
  for (const rule of patterns.keywords) {
    const needle = rule.value
    if (!needle) continue
    let idx = 0
    for (;;) {
      const pos = text.indexOf(needle, idx)
      if (pos === -1) break
      const start = pos
      const end = pos + needle.length
      const original = text.slice(start, end)
      idx = end
      if (patterns.exclude.has(original)) continue
      if (placeholderPrefix && isPlaceholderLike(original, placeholderPrefix)) continue
      if (isInSkipRange(start, end)) continue
      found.push({ start, end, original, placeholderId: rule.placeholderId })
    }
  }

  // Regex 匹配
  for (const rule of patterns.regex) {
    const parsed = parsePatternFlags(rule.pattern)
    let flags = parsed.flags
    if (!flags.includes("g")) flags = "g" + flags
    let re
    try {
      re = new RegExp(parsed.pattern, flags)
    } catch {
      continue // 跳过无效正则
    }
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue
      const start = m.index ?? -1
      if (start < 0) continue
      const end = start + m[0].length
      const original = text.slice(start, end)
      if (patterns.exclude.has(original)) continue
      if (placeholderPrefix && isPlaceholderLike(original, placeholderPrefix)) continue
      if (isInSkipRange(start, end)) continue
      found.push({ start, end, original, placeholderId: rule.placeholderId })
    }
  }

  if (found.length === 0) return { text, matches: [] }

  // 第一步：按 start ASC, end DESC 排序（外层优先，大范围命中覆盖小范围）
  found.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.end - a.end
  })

  // 处理重叠：外层命中覆盖内层，分割不重叠的独立区间
  const planned = []
  let covered = []
  for (const m of found) {
    const segments = subtractCovered(m.start, m.end, covered)
    for (const seg of segments) {
      if (seg.start < 0 || seg.end > text.length || seg.start >= seg.end) continue
      planned.push({
        start: seg.start,
        end: seg.end,
        original: text.slice(seg.start, seg.end),
        placeholderId: m.placeholderId,
      })
      covered = insertCovered(covered, seg)
    }
  }

  // 第二步：按 start DESC 排序用于替换（从右到左，避免索引偏移）
  planned.sort((a, b) => b.start - a.start)

  let out = text
  for (const m of planned) {
    const placeholder = session.getOrCreatePlaceholder(m.original, m.placeholderId)
    out = out.slice(0, m.start) + placeholder + out.slice(m.end)
    m.placeholder = placeholder
  }

  return { text: out, matches: planned }
}
