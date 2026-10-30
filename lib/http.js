/**
 * Minimal HTTP helpers shared by the plugin's routes: JSON/plain responses, a
 * size-capped body reader, and the same-origin guard that protects every
 * profile write.
 *
 * The guard mirrors the host's own rule: loopback (or a host-declared authority)
 * in `Host`, no cross-site fetch, and a present `Origin` must match the `Host`.
 * An absent `Origin` is allowed — the Desktop proxy strips it.
 *
 * @module dsh-config-sync/http
 */

/** Maximum accepted JSON body (bytes). */
export const MAX_BODY_BYTES = 64 * 1024

/** Write a JSON response with no-store caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Write a plain-text response. */
export function sendText(response, status, text) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  response.end(text)
}

/** Read and parse a JSON request body. */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大（request body too large）')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON（request body is not valid JSON）')
  }
}

/** Parse a bare host[:port] authority, or null. */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === String(value).toLowerCase() ? url : null
  } catch {
    return null
  }
}

/** True when a Host header names a loopback authority. */
export function loopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** True when a Host header matches one of the host-declared authorities. */
export function trustedAuthority(host, trustedHosts) {
  const target = parseAuthority(host)
  if (target === null) return false
  return (Array.isArray(trustedHosts) ? trustedHosts : []).some((entry) => {
    const candidate = parseAuthority(entry)
    if (candidate === null) return false
    return candidate.port === '' ? candidate.hostname === target.hostname : candidate.host === target.host
  })
}

/** Resolve the host's declared authorities from the optional `connection` service. */
export function trustedHostsOf(ctx) {
  try {
    const connection = ctx.get?.('connection')
    return Array.isArray(connection?.trustedHosts) ? connection.trustedHosts.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Same-origin guard for mutating routes.
 * @param {import('node:http').IncomingMessage} request
 * @param {any} ctx - plugin context (for the optional connection service)
 * @returns {boolean} true when the request may proceed.
 */
export function isSameOrigin(request, ctx) {
  const headers = request.headers ?? {}
  const host = headers.host
  if (typeof host === 'string' && host !== '' && !loopbackAuthority(host) && !trustedAuthority(host, trustedHostsOf(ctx))) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Whether this process is the official Desktop host.
 *
 * The Desktop host terminates browser authentication in its own proxy and
 * publishes a `pluginManager` service; the market plugin learned the same
 * lesson (#648): running the host's request gate there could refuse the app's
 * own page for a check that has never been measured against that proxy. On a
 * plain `dsh web` deployment there is no `pluginManager`, so the gate applies.
 *
 * @param {any} ctx - plugin context.
 * @returns {boolean}
 */
export function isOfficialDesktop(ctx) {
  try {
    if (ctx.get?.('pluginManager') !== undefined) return true
    return /dsh-desktop-host[\\/]lib[\\/]index\.js/u.test((Array.isArray(process.argv) ? process.argv : []).join(' '))
  } catch {
    return /dsh-desktop-host[\\/]lib[\\/]index\.js/u.test((Array.isArray(process.argv) ? process.argv : []).join(' '))
  }
}

/**
 * Ask the host's own request gate, when it has one.
 * @returns {number | undefined} a status code when the host refuses the request.
 */
export function hostRejection(ctx, request) {
  try {
    const connection = ctx.get?.('connection')
    const gate = connection?.requestRejection
    if (typeof gate !== 'function') return undefined
    const status = gate.call(connection, request)
    return Number.isInteger(status) ? status : undefined
  } catch {
    return 403
  }
}
