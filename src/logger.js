import * as fs from "node:fs"
import * as path from "node:path"
import os from "node:os"

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 }

/**
 * 展开路径中的 ~ 为 $HOME。
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  if (!p || typeof p !== "string") return ""
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 把外部传入的级别名映射为内部数值。非法值抛错，不做静默回退。
 * @param {string|undefined} level
 * @returns {number}
 */
function normalizeLevel(level) {
  if (level === undefined || level === null) return LEVELS.info
  if (typeof level === "string" && level in LEVELS) return LEVELS[level]
  throw new Error(
    `未知的日志级别 ${JSON.stringify(level)}，合法值: ${Object.keys(LEVELS).join(" | ")}`,
  )
}

/**
 * 解析文件大小字符串（如 "10m", "100k", "1g"）为字节数。
 * 无法解析或单位未知时抛错，不做静默回退。
 * @param {string|number} s
 * @returns {number}
 */
function parseSize(s) {
  if (typeof s === "number") {
    if (!Number.isFinite(s) || s <= 0) {
      throw new Error(`日志大小非法 ${JSON.stringify(s)}，必须为正数`)
    }
    return s
  }
  const raw = String(s)
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i)
  if (!m) {
    throw new Error(`无法解析日志大小 ${JSON.stringify(raw)}，格式示例: "10m" / "100k" / "1g"`)
  }
  const units = { b: 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }
  const u = (m[2] || "b").toLowerCase()
  if (!(u in units)) {
    throw new Error(
      `未知的日志大小单位 ${JSON.stringify(m[2])}（来自 ${JSON.stringify(raw)}），合法值: b | k | m | g`,
    )
  }
  return Math.round(parseFloat(m[1]) * units[u])
}

/**
 * 文件日志记录器，仅支持写入文件，支持大小/日期滚动和自动清理。
 *
 * 日志文件形式：
 *   oh-my-opensecret.log              ← 当前写入
 *   oh-my-opensecret.2026-06-04.1.log ← 滚动后的历史文件
 *
 * Rotation 触发条件：
 *   - 文件大小超过 maxSize
 *   - 日期变更
 *
 * 清理：超过 maxFiles 个历史文件时，删除最旧的。
 */
export class Logger {
  /**
   * @param {{
   *   level?: string,
   *   filePath?: string,
   *   prefix?: string,
   *   maxSize?: number|string,
   *   maxFiles?: number,
   * }} opts
   */
  constructor(opts = {}) {
    this.prefix = opts.prefix ?? "[oh-my-opensecret]"

    /** @type {fs.WriteStream|null} */
    this._fileStream = null
    /** 上次写入时的日期（YYYY-MM-DD） */
    this._currentDate = ""
    /** 目录是否已创建 */
    this._dirEnsured = false

    this.applyConfig({
      level: opts.level,
      file: opts.filePath,
      maxSize: opts.maxSize,
      maxFiles: opts.maxFiles,
    })
  }

  /**
   * 用配置文件的 `logging` 段覆盖当前设置：级别名 → 数值、路径展开 `~`、大小字符串 → 字节数。
   * 这是设置这些字段的唯一入口 —— 直接写 `logger.level` / `logger.filePath` / `logger.maxSize`
   * 会把原始字符串塞进去，导致级别过滤与按大小滚动静默失效。
   * @param {{ level?: string, file?: string, maxSize?: string|number, maxFiles?: number }} logging
   */
  applyConfig(logging) {
    // 先全部归一化再赋值：任一字段非法时抛错，且已生效的配置保持原样不被部分改写
    const level = normalizeLevel(logging?.level)
    const filePath = resolvePath(logging?.file ?? "")
    const maxSize = parseSize(logging?.maxSize ?? "10m")
    const maxFiles = logging?.maxFiles ?? 7
    this.level = level
    this.filePath = filePath
    this.maxSize = maxSize
    this.maxFiles = maxFiles
  }

  /**
   * 写入日志条目。
   * @param {"debug"|"info"|"warn"|"error"} level
   * @param  {...any} args
   */
  log(level, ...args) {
    const lvl = LEVELS[level]
    if (lvl === undefined || lvl < this.level) return
    if (!this.filePath) return

    const ts = new Date().toLocaleString("zh-CN", { hour12: false })
    const label = level.toUpperCase()
    const safeArgs = args.map((a) =>
      typeof a === "string"
        ? a.replace(
            /(sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/]{40,})/g,
            "<redacted>",
          )
        : a,
    )
    const message = `${ts} [${label}] ${this.prefix} ${safeArgs.join(" ")}`
    this._writeFile(message + "\n")
  }

  debug(...args) { this.log("debug", ...args) }
  info(...args) { this.log("info", ...args) }
  warn(...args) { this.log("warn", ...args) }
  error(...args) { this.log("error", ...args) }

  /** @returns {Promise<void>} 等待缓冲区写入完成 */
  flush() {
    return new Promise((resolve) => {
      if (this._fileStream) {
        this._fileStream.end(resolve)
        this._fileStream = null
      } else {
        resolve()
      }
    })
  }

  // ---- internal ----

  _writeFile(line) {
    try {
      this._ensureDir()
      this._checkRotate()
      if (!this._fileStream) {
        this._fileStream = fs.createWriteStream(this.filePath, { flags: "a" })
      }
      this._fileStream.write(line)
    } catch {
      // 写入失败静默忽略
    }
  }

  /** 确保日志目录存在 */
  _ensureDir() {
    if (this._dirEnsured) return
    const dir = path.dirname(this.filePath)
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this._dirEnsured = true
  }

  _checkRotate() {
    const today = new Date().toISOString().slice(0, 10)
    let needRotate = false

    // 日期变更
    if (this._currentDate && this._currentDate !== today) {
      needRotate = true
    }

    // 文件大小超限
    if (!needRotate) {
      try {
        const st = fs.statSync(this.filePath)
        if (st.size >= this.maxSize) {
          needRotate = true
        }
      } catch {
        // 文件尚不存在
      }
    }

    if (needRotate) {
      this._doRotate(today)
    }

    this._currentDate = today
  }

  _doRotate(today) {
    if (this._fileStream) {
      this._fileStream.end()
      this._fileStream = null
    }

    const dir = path.dirname(this.filePath)
    const ext = path.extname(this.filePath)
    const base = path.basename(this.filePath, ext)

    // 查找今天的最大序号
    const prefix = `${base}.${today}.`
    let maxSeq = 0
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith(ext)) {
          const seq = parseInt(f.slice(prefix.length, -ext.length || undefined), 10)
          if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
        }
      }
    } catch { /* dir 还不存在 */ }

    // 重命名当前文件
    try {
      fs.renameSync(this.filePath, path.join(dir, `${base}.${today}.${maxSeq + 1}${ext}`))
    } catch (err) {
      this._reportFault(`日志滚动重命名失败（滚动与历史清理将停止）`, err)
    }

    this._prune(dir, base, ext)
  }

  _prune(dir, base, ext) {
    try {
      const files = fs.readdirSync(dir)
      const pattern = new RegExp(
        `^${escapeRegex(base)}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+${escapeRegex(ext)}$`,
      )
      const rotated = files.filter((f) => pattern.test(f)).sort().reverse()
      if (rotated.length > this.maxFiles) {
        for (const f of rotated.slice(this.maxFiles)) {
          try {
            fs.unlinkSync(path.join(dir, f))
          } catch (err) {
            this._reportFault(`历史日志删除失败（磁盘占用会持续增长）: ${f}`, err)
          }
        }
      }
    } catch { /* 忽略 */ }
  }

  /**
   * logger 自身的故障无法写进日志文件（会递归），只能落到 stderr。
   * @param {string} what
   * @param {unknown} err
   */
  _reportFault(what, err) {
    const detail = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[oh-my-opensecret] ${what}: ${detail}\n`)
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function createLogger(opts = {}) {
  return new Logger(opts)
}
