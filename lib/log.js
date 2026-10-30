/**
 * Redacting logger with an in-memory ring buffer and an NDJSON sink.
 *
 * The plugin moves credentials around, so redaction is applied on the way in:
 * anything whose key looks secret (`password`, `token`, `secret`, …) is masked
 * before it can reach memory, the log file, or the HTTP log export.
 *
 * @module @xiaokang6/dsh-config-sync/log
 */

import fs from 'node:fs'
import path from 'node:path'

const SECRET_KEY_RE = /pass(?:word|phrase)|token|secret|credential|authorization|api[-_]?key|cookie/iu

/** Mask one string value, keeping a short prefix so users can tell entries apart. */
export function maskValue(value) {
  const text = String(value)
  if (text === '') return ''
  if (text.length <= 4) return '****'
  return `${text.slice(0, 2)}****${text.slice(-2)}`
}

/** Deep-redact a value for logging. */
export function redact(value, depth = 0) {
  if (depth > 4) return '[deep]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value
      .replace(/("?(?:password|passphrase|token|secret|authorization|api[-_]?key)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
        (_whole, head, secret) => `${head}${maskValue(String(secret).replace(/^["']|["']$/gu, ''))}`)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gu, (_whole, head) => `${head}****`)
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? maskValue(item) : redact(item, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Create the plugin logger.
 * @param {{ file?: string, max?: number }} options - NDJSON sink and ring size.
 */
export function createLogger({ file, max = 500 } = {}) {
  const events = []
  const sink = typeof file === 'string' && file !== '' ? file : undefined

  const append = (event) => {
    if (sink === undefined) return
    try {
      fs.mkdirSync(path.dirname(sink), { recursive: true })
      fs.appendFileSync(sink, `${JSON.stringify(event)}\n`, 'utf8')
      const size = fs.statSync(sink).size
      if (size > 2 * 1024 * 1024) {
        fs.renameSync(sink, `${sink}.1`)
      }
    } catch {
      // Logging must never break a sync.
    }
  }

  const push = (level, event, detail) => {
    const entry = {
      at: Date.now(),
      level,
      event,
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    }
    events.push(entry)
    if (events.length > max) events.shift()
    append(entry)
    return entry
  }

  return {
    info: (event, detail) => push('info', event, detail),
    warn: (event, detail) => push('warn', event, detail),
    error: (event, detail) => push('error', event, detail),
    tail: (count = 100) => events.slice(-Math.max(1, Math.min(count, max))),
    exportText: (count = 200) => events.slice(-Math.max(1, Math.min(count, max))).map((entry) => JSON.stringify(entry)).join('\n'),
    redact,
    file: sink,
  }
}
