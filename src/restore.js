import { getPlaceholderRegex } from "./session.js"

/**
 * 将字符串中的占位符还原为原文。
 * 若占位符不在映射表中，则保持原样。
 * @param {string} input
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 * @returns {string}
 */
export function restoreText(input, session) {
  const text = String(input ?? "")
  if (!text) return text
  const re = getPlaceholderRegex(session.prefix)
  return text.replace(re, (ph) => session.lookup(ph) ?? ph)
}
