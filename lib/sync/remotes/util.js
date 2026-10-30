// Shared helpers for the remote adapter layer. Built-ins only: global fetch,
// AbortSignal.timeout, Buffer. See docs/remote-interface.md.

import {
  RemoteAuthError,
  RemoteConflictError,
  RemoteError,
  RemotePathError,
  RemoteUnavailableError,
} from './errors.js'

/** Default per-request timeout (contract: 15 s). */
export const DEFAULT_TIMEOUT_MS = 15_000

const MAX_TIMEOUT_MS = 600_000
const MAX_DETAIL_CHARS = 200
const MAX_PATH_CHARS = 200

/** Object keys whose values are masked by redact(). */
const SECRET_KEY =
  /^(?:password|passwd|pwd|secret|token|access_?token|refresh_?token|authorization|auth|credential|credentials|passphrase|api_?key|apikey|client_?secret|private_?key)$/i

/**
 * Validate a POSIX path relative to the remote root.
 *
 * Rejects (with RemotePathError) anything that could escape the root: leading
 * `/`, backslashes, `.`/`..` segments, empty segments (`a//b`, `a/`), Windows
 * drive prefixes, NUL bytes and lone surrogates.
 *
 * @param {unknown} input
 * @param {{ allowEmpty?: boolean }} [options] allowEmpty lets '' (and '.') mean
 *   "the remote root itself" — used for list()/ensureDir() of the root.
 * @returns {string} the validated path, unchanged
 */
export function normalizeRelPath(input, options = {}) {
  const allowEmpty = options.allowEmpty === true

  if (typeof input !== 'string') {
    throw new RemotePathError(
      `远端路径必须是字符串 / remote path must be a string: ${describeValue(input)}`,
      { detail: 'not a string' },
    )
  }

  if (input === '') {
    if (allowEmpty) return ''
    throw new RemotePathError('远端路径不能为空 / remote path must not be empty', { detail: 'empty path' })
  }
  if (allowEmpty && (input === '.' || input === './')) return ''

  if (input.startsWith('/')) {
    throw unsafePath(input, '不能以 / 开头 / must not start with "/"')
  }
  if (input.includes('\\')) {
    throw unsafePath(input, '不能包含反斜杠 \\ / must not contain "\\"')
  }
  if (input.includes('\u0000')) {
    throw unsafePath(input, '不能包含 NUL 字节 / must not contain NUL')
  }
  for (const character of input) {
    const codePoint = character.codePointAt(0)
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw unsafePath(input, '包含非法 Unicode 字符 / contains a lone surrogate')
    }
  }

  const segments = input.split('/')
  for (const segment of segments) {
    if (segment === '') {
      throw unsafePath(input, '包含空路径段（// 或结尾 /）/ contains an empty segment')
    }
    if (segment === '.' || segment === '..') {
      throw unsafePath(input, '包含 . 或 .. 路径段 / contains a "." or ".." segment')
    }
  }
  if (/^[A-Za-z]:/.test(segments[0])) {
    throw unsafePath(input, '不能是 Windows 盘符路径 / must not be a Windows drive path')
  }

  return input
}

function unsafePath(input, reason) {
  const shown = clip(String(redact(input)), MAX_PATH_CHARS)
  return new RemotePathError(
    `远端路径不安全，已拒绝「${shown}」：${reason} / unsafe remote path rejected: ${shown}`,
    { detail: reason },
  )
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Join a base URL with POSIX path segments. Every generated segment is
 * `encodeURIComponent`-encoded; separators stay single. A trailing slash on the
 * base (坚果云 hands out `https://dav.jianguoyun.com/dav/`) is trimmed, so
 * `joinUrl('https://h/dav/', 'a b/c')` → `https://h/dav/a%20b/c`.
 *
 * @param {string} base
 * @param {...(string|string[]|undefined|null)} parts
 * @returns {string}
 */
export function joinUrl(base, ...parts) {
  let output = String(base ?? '').trim()
  if (output === '') {
    throw new RemoteError('缺少远端地址 / missing remote base URL', { code: 'config' })
  }
  output = output.replace(/\/+$/, '')

  for (const part of parts.flat(Infinity)) {
    if (part === undefined || part === null || part === '') continue
    const encoded = String(part)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    if (encoded === '') continue
    output += `/${encoded}`
  }
  return output
}

/** HTTP Basic authorization header value (UTF-8 credentials). */
export function basicAuth(username = '', password = '') {
  const raw = `${username ?? ''}:${password ?? ''}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/**
 * Effective request timeout: `settings.timeoutMs` when it is a positive finite
 * number, otherwise the 15 s default.
 */
export function resolveTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const candidate = value !== null && typeof value === 'object' ? value.timeoutMs : value
  const ms = Number(candidate)
  if (!Number.isFinite(ms) || ms <= 0) return fallback
  return Math.min(Math.round(ms), MAX_TIMEOUT_MS)
}

/**
 * Mask credentials in a log value (or a string). Masks object keys such as
 * `password` / `token` / `authorization`, `Bearer …` / `Basic …` header values,
 * URL userinfo and `key=value` secret pairs. Buffers become `<bytes>`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (typeof value === 'symbol') return String(value)
  if (typeof value === 'function') return '[function]'
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '<bytes>'
  if (depth > 8) return '[depth-limit]'
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code,
      status: value.status,
      message: redactString(value.message),
    }
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? maskSecret(item) : redact(item, depth + 1)
    }
    return out
  }
  return String(value)
}

function maskSecret(value) {
  if (value === undefined || value === null) return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  if (value === '') return ''
  return '***'
}

function redactString(value) {
  return String(value)
    .replace(/\b((?:proxy-)?authorization)\b(\s*[:=]\s*)(?:bearer|basic)?\s*[^\s,;}]*/gi, '$1$2***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/(\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:***@')
    .replace(/\b(password|passwd|token|secret|passphrase|api[_-]?key)\b(\s*[:=]\s*)("?)(?!\*)[^\s"',;]+/gi, '$1$2$3***')
}

/** Collapse whitespace and cap a server body so it is log-safe. */
export function shortBody(value, maxChars = MAX_DETAIL_CHARS) {
  if (value === undefined || value === null) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** Clip an arbitrary string for display. */
export function clip(value, maxChars = MAX_DETAIL_CHARS) {
  const text = String(value ?? '')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** Parse an HTTP/WebDAV date header into epoch milliseconds. */
export function parseHttpDate(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : undefined
}

/** Accept Buffer/Uint8Array/ArrayBuffer/string for write payloads. */
export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  throw new RemoteError(
    '写入内容必须是 Buffer、Uint8Array 或字符串 / write payload must be a Buffer, Uint8Array or string',
    { code: 'bad_payload' },
  )
}

/**
 * fetch() with the configured timeout. Network, DNS and timeout failures become
 * RemoteUnavailableError (the message never includes credentials).
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function httpRequest(url, init = {}, options = {}) {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs)
  const label = options.label ?? '远端 / remote'
  let response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new RemoteUnavailableError(
      `${label} 无法连接远端（网络错误或请求超时 ${timeoutMs}ms）/ ${label} cannot reach the remote (network error or timeout after ${timeoutMs}ms)`,
      { code: 'unavailable', detail: describeNetworkError(cause), cause },
    )
  }
  return response
}

function describeNetworkError(cause) {
  const name = cause?.name ?? ''
  const inner = cause?.cause
  const code = inner?.code ?? cause?.code
  let detail
  if (name === 'TimeoutError' || inner?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    detail = 'timeout / 请求超时'
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    detail = 'dns / 域名解析失败'
  } else if (code === 'ECONNREFUSED') {
    detail = 'ECONNREFUSED / 连接被拒绝'
  } else if (code === 'ECONNRESET' || code === 'EPIPE') {
    detail = 'ECONNRESET / 连接被重置'
  } else if (code === 'UND_ERR_SOCKET') {
    detail = 'socket error / 套接字错误'
  } else {
    detail = inner?.message ?? cause?.message ?? String(cause)
  }
  return shortBody(redactString(detail))
}

/** Read and redact a response body for an error `detail` field. */
export async function readDetail(response, maxChars = MAX_DETAIL_CHARS) {
  try {
    const text = await response.text()
    return shortBody(redact(text), maxChars)
  } catch {
    return ''
  }
}

/**
 * Map a non-2xx HTTP status to the matching RemoteError subclass.
 *
 * @param {number} status
 * @param {{ service?: string, serviceEn?: string, detail?: string }} [options]
 * @returns {RemoteError}
 */
export function mapStatusError(status, options = {}) {
  const service = options.service ?? '远端'
  const serviceEn = options.serviceEn ?? 'remote'
  const detail = shortBody(redact(options.detail ?? ''))
  const info = { status, detail }
  let error
  if (status === 401 || status === 403) {
    error = new RemoteAuthError(
      `${service} 认证失败（HTTP ${status}）：凭据无效或权限不足 / ${serviceEn} authentication failed (HTTP ${status}): invalid credentials or insufficient permission`,
      info,
    )
  } else if (status >= 500 || status === 408 || status === 429) {
    error = new RemoteUnavailableError(
      `${service} 暂时不可用（HTTP ${status}）：请稍后重试 / ${serviceEn} temporarily unavailable (HTTP ${status}): retry later`,
      info,
    )
  } else if (status === 404 || status === 410) {
    error = new RemoteError(
      `${service} 找不到目标（HTTP ${status}）：路径、仓库或分支可能不存在 / ${serviceEn} target not found (HTTP ${status}): path, repository or branch may be missing`,
      { ...info, code: 'not_found' },
    )
  } else {
    error = new RemoteError(
      `${service} 请求失败（HTTP ${status}） / ${serviceEn} request failed (HTTP ${status})`,
      info,
    )
  }
  if (detail !== '') error.message = `${error.message} [${detail}]`
  return error
}

/**
 * Build a RemoteConflictError (etag/sha precondition failed).
 *
 * @param {number} status
 * @param {{ service?: string, serviceEn?: string, detail?: string, what?: string }} [options]
 * @returns {RemoteConflictError}
 */
export function conflictError(status, options = {}) {
  const service = options.service ?? '远端'
  const serviceEn = options.serviceEn ?? 'remote'
  const detail = shortBody(redact(options.detail ?? ''))
  const target = options.what ? ` ${clip(redact(options.what), MAX_PATH_CHARS)}` : ''
  const error = new RemoteConflictError(
    `${service} 内容冲突（HTTP ${status}）${target}：远端版本已变化，请重新读取后再写入 / ${serviceEn} content conflict (HTTP ${status})${target}: the remote changed, read again before writing`,
    { status, detail },
  )
  if (detail !== '') error.message = `${error.message} [${detail}]`
  return error
}
