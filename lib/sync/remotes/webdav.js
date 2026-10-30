// 坚果云 (Nutstore) WebDAV adapter — PROPFIND/GET/PUT/DELETE/MKCOL + Basic auth.
// Contract: docs/remote-interface.md. Built-ins only (fetch, Buffer).

import { RemoteAuthError, RemoteError } from './errors.js'
import {
  basicAuth,
  conflictError,
  httpRequest,
  joinUrl,
  mapStatusError,
  normalizeRelPath,
  parseHttpDate,
  readDetail,
  redact,
  resolveTimeoutMs,
  shortBody,
  toBuffer,
} from './util.js'

export const WEBDAV_LABEL = '坚果云 WebDAV'

const SERVICE = WEBDAV_LABEL
const SERVICE_EN = 'Nutstore WebDAV'
const XML_CONTENT_TYPE = 'application/xml; charset=utf-8'
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:displayname/>
  </d:prop>
</d:propfind>`

// ---------------------------------------------------------------------------
// WebDAV XML parsing (tolerant to d:, D: and default-namespace forms)
// ---------------------------------------------------------------------------

/** Decode the XML entities a WebDAV server may use in text nodes. */
function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Text of the first `<tag>` element (any/no namespace prefix) inside `block`. */
function firstTagText(block, tag) {
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    'i',
  )
  const match = pattern.exec(block)
  return match === null ? undefined : decodeXmlEntities(match[1]).trim()
}

/** Normalize an etag header/XML value: undefined for blank, otherwise verbatim. */
function normalizeEtag(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

/**
 * Turn a DAV `href` (absolute path, absolute URL or relative) into a decoded
 * pathname. Percent-encoding is decoded per segment so `%2F` cannot create a
 * path separator.
 *
 * @param {string|undefined} href
 * @returns {string|null}
 */
export function hrefToPathname(href) {
  if (typeof href !== 'string') return null
  let raw = href.trim()
  if (raw === '') return null
  const hashIndex = raw.indexOf('#')
  if (hashIndex !== -1) raw = raw.slice(0, hashIndex)
  const queryIndex = raw.indexOf('?')
  if (queryIndex !== -1) raw = raw.slice(0, queryIndex)

  let pathname
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname
    } catch {
      return null
    }
  } else {
    pathname = raw.startsWith('/') ? raw : `/${raw}`
  }

  return pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/**
 * Parse a WebDAV multistatus body.
 *
 * Handles `<d:response>` / `<D:response>` / `<response xmlns="DAV:">` alike and
 * extracts href, resourcetype, content length, mtime, etag and displayname.
 *
 * @param {string} xml
 * @returns {Array<{
 *   href: string, pathname: string, isDir: boolean,
 *   size?: number, mtime?: number, etag?: string, displayName?: string,
 * }>}
 */
export function parseDavMultistatus(xml) {
  const text = String(xml ?? '')
  const responsePattern =
    /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/gi
  const entries = []
  let match
  while ((match = responsePattern.exec(text)) !== null) {
    const block = match[1]
    const href = firstTagText(block, 'href')
    const pathname = hrefToPathname(href)
    if (pathname === null) continue

    const entry = {
      href: String(href ?? ''),
      pathname,
      isDir: /<(?:[A-Za-z_][\w.-]*:)?collection\b[^>]*\/?>/i.test(block),
    }
    const sizeText = firstTagText(block, 'getcontentlength')
    if (sizeText !== undefined) {
      const size = Number.parseInt(sizeText, 10)
      if (Number.isFinite(size) && size >= 0) entry.size = size
    }
    const mtime = parseHttpDate(firstTagText(block, 'getlastmodified'))
    if (mtime !== undefined) entry.mtime = mtime
    const etag = normalizeEtag(firstTagText(block, 'getetag'))
    if (etag !== undefined) entry.etag = etag
    const displayName = firstTagText(block, 'displayname')
    if (displayName) entry.displayName = displayName

    entries.push(entry)
  }
  return entries
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Probe detail when the configured remote root does not exist yet. */
const ROOT_MISSING_DETAIL =
  '远端根目录尚不存在（首次同步会自动创建） / remote root does not exist yet (first sync will create it)'

/**
 * 坚果云 (SabreDAV) answers a request for a deep, non-existent path with
 * `409 AncestorsNotFound` instead of `404`. That is still "the resource is not
 * there" and must not surface as an error: `read()` returns `{found:false}`,
 * `list()` returns `[]`, a delete is a no-op.
 *
 * Any other 409 (lock conflict, …) keeps its error semantics.
 *
 * @param {number} status
 * @param {string} [body] short response body (already redacted is fine)
 * @returns {boolean}
 */
export function isMissingDavResponse(status, body) {
  if (status === 404 || status === 410) return true
  if (status !== 409) return false
  return /ancestors\s*not\s*found|not\s+found|no\s+such|does\s+not\s+exist/iu.test(String(body ?? ''))
}

function normalizePathname(value) {
  let path = String(value ?? '')
  if (path === '') return ''
  path = path.replace(/\/{2,}/g, '/')
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
  return path === '/' ? '' : path
}

/** Decode percent-encoding per segment so hrefs and base paths compare equal. */
function decodePathname(value) {
  return String(value ?? '')
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/**
 * Turn `opts.etag` into an If-Match header value: verbatim, never re-quoted.
 *
 * RFC 7232 writes an entity-tag as `"…"`, so a bare stored validator used to be
 * wrapped before sending. 坚果云 (SabreDAV, unquoted ETags) compares the header
 * value byte-for-byte against its own `abc`, so the quoted `"abc"` never matched
 * and every conditional PUT came back `412 PreconditionFailed / ETag doesn't
 * match` — existing files could be read but never updated. Servers that follow
 * the standard return their ETag already quoted, so passing the stored value
 * through untouched satisfies both.
 */
function ifMatchValue(etag) {
  if (etag === undefined || etag === null) return undefined
  const value = String(etag).trim()
  return value === '' ? undefined : value
}

/**
 * Create the 坚果云 WebDAV adapter.
 *
 * @param {{ baseUrl?: string, username?: string, password?: string, path?: string, timeoutMs?: number }} settings
 * @returns {object} remote shape from docs/remote-interface.md
 */
export function createWebdavRemote(settings = {}) {
  if (settings === null || typeof settings !== 'object') {
    throw new RemoteError('WebDAV 配置无效：需要一个设置对象 / invalid WebDAV settings: expected an object', {
      code: 'config',
    })
  }

  const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : ''
  if (baseUrl === '') {
    throw new RemoteError('缺少 WebDAV 地址（baseUrl）/ missing WebDAV baseUrl', { code: 'config' })
  }
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    throw new RemoteError(
      `WebDAV 地址不是合法 URL / invalid WebDAV baseUrl: ${redact(shortBody(baseUrl, 80))}`,
      { code: 'config' },
    )
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new RemoteError(
      `WebDAV 地址必须以 http:// 或 https:// 开头 / WebDAV baseUrl must be http(s): ${redact(shortBody(baseUrl, 80))}`,
      { code: 'config' },
    )
  }
  if (base.search !== '' || base.hash !== '') {
    throw new RemoteError(
      'WebDAV 地址不能带查询参数或锚点 / WebDAV baseUrl must not include a query or hash',
      { code: 'config' },
    )
  }

  const username = settings.username === undefined || settings.username === null ? '' : String(settings.username)
  const password = settings.password === undefined || settings.password === null ? '' : String(settings.password)
  const rootPath = normalizeRelPath(settings.path ?? '', { allowEmpty: true })
  const timeoutMs = resolveTimeoutMs(settings.timeoutMs)
  const authHeader = basicAuth(username, password)

  const basePath = normalizePathname(decodePathname(base.pathname))
  const rootPathname = normalizePathname(`${basePath}/${rootPath}`)
  const displayBasePath = normalizePathname(base.pathname)
  const root =
    rootPath === ''
      ? `${base.origin}${displayBasePath}`
      : `${base.origin}${displayBasePath}/${rootPath}`

  // -- URL + request helpers --------------------------------------------------

  function fileUrl(rel) {
    return joinUrl(baseUrl, rootPath, rel)
  }

  function dirUrl(rel) {
    return `${fileUrl(rel)}/`
  }

  /** Map a decoded href pathname to a path relative to the remote root. */
  function relativeFromPathname(pathname) {
    const clean = normalizePathname(pathname)
    if (clean === rootPathname) return ''
    if (rootPathname === '') return clean.startsWith('/') ? clean.slice(1) : clean
    if (!clean.startsWith(`${rootPathname}/`)) return null
    return clean.slice(rootPathname.length + 1)
  }

  async function drain(response) {
    try {
      await response.arrayBuffer()
    } catch {
      // ignore: only used to release the connection
    }
  }

  async function dav(method, url, options = {}) {
    return httpRequest(
      url,
      {
        method,
        headers: { authorization: authHeader, ...(options.headers ?? {}) },
        ...(options.body === undefined ? {} : { body: options.body }),
      },
      { timeoutMs, label: SERVICE_EN },
    )
  }

  function authFailure(status, detail = '') {
    return new RemoteAuthError(
      `坚果云 WebDAV 认证失败（HTTP ${status}）：请检查账号与应用密码（不是网页登录密码）/ Nutstore WebDAV authentication failed (HTTP ${status}): check the account and the app password (not the login password)`,
      { status, detail },
    )
  }

  function unavailableFailure(status, detail = '') {
    return mapStatusError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail })
  }

  async function throwForStatus(response) {
    const detail = await readDetail(response)
    const status = response.status
    if (status === 401 || status === 403) throw authFailure(status, detail)
    throw unavailableFailure(status, detail)
  }

  // -- operations ------------------------------------------------------------

  async function probe() {
    const startedAt = performance.now()
    const response = await dav('PROPFIND', dirUrl(''), {
      headers: { depth: '0', 'content-type': XML_CONTENT_TYPE },
      body: PROPFIND_BODY,
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const status = response.status

    if (status === 401 || status === 403) {
      throw authFailure(status, await readDetail(response))
    }
    if (status >= 500 || status === 408 || status === 429) {
      throw unavailableFailure(status, await readDetail(response))
    }
    if (status === 404 || status === 410) {
      await drain(response)
      return { ok: false, latencyMs, detail: ROOT_MISSING_DETAIL }
    }
    if (status === 409) {
      const detail = await readDetail(response)
      // 坚果云 answers a missing deep root with 409 AncestorsNotFound.
      if (isMissingDavResponse(status, detail)) return { ok: false, latencyMs, detail: ROOT_MISSING_DETAIL }
      return {
        ok: false,
        latencyMs,
        detail: `远端返回 HTTP 409，可能不是可用的 WebDAV 服务 / unexpected HTTP 409, not a usable WebDAV endpoint${detail === '' ? '' : ` [${detail}]`}`,
      }
    }
    if (response.ok) {
      await drain(response)
      return { ok: true, latencyMs, detail: '' }
    }
    const detail = await readDetail(response)
    return {
      ok: false,
      latencyMs,
      detail: `远端返回 HTTP ${status}，可能不是可用的 WebDAV 服务 / unexpected HTTP ${status}, not a usable WebDAV endpoint${detail === '' ? '' : ` [${detail}]`}`,
    }
  }

  async function read(path) {
    const rel = normalizeRelPath(path)
    const response = await dav('GET', fileUrl(rel), { headers: { accept: '*/*' } })
    const status = response.status

    if (status === 404 || status === 410) {
      await drain(response)
      return { found: false }
    }
    if (status === 409) {
      const detail = await readDetail(response)
      // 坚果云: a deep path whose ancestors are missing is 409, not 404.
      if (isMissingDavResponse(status, detail)) return { found: false }
      throw mapStatusError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail })
    }
    if (status === 401 || status === 403 || status >= 500 || status === 408 || status === 429) {
      await throwForStatus(response)
    }
    if (!response.ok) await throwForStatus(response)

    const bytes = Buffer.from(await response.arrayBuffer())
    const result = { found: true, bytes }
    const etag = normalizeEtag(response.headers.get('etag'))
    if (etag !== undefined) result.etag = etag
    const mtime = parseHttpDate(response.headers.get('last-modified'))
    if (mtime !== undefined) result.mtime = mtime
    return result
  }

  async function write(path, bytes, options = {}) {
    const rel = normalizeRelPath(path)
    const payload = toBuffer(bytes)
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    await ensureDir(parent)

    const headers = { 'content-type': 'application/octet-stream' }
    const conditional = ifMatchValue(options?.etag)
    if (conditional !== undefined) headers['if-match'] = conditional

    const response = await dav('PUT', fileUrl(rel), { headers, body: payload })
    const status = response.status

    if (status === 412 || status === 428) {
      throw conflictError(status, {
        service: SERVICE,
        serviceEn: SERVICE_EN,
        detail: await readDetail(response),
        what: rel,
      })
    }
    if (status === 401 || status === 403 || status >= 500 || status === 408 || status === 429) {
      await throwForStatus(response)
    }
    if (!response.ok) await throwForStatus(response)
    await drain(response)

    let etag = normalizeEtag(response.headers.get('etag'))
    let mtime = parseHttpDate(response.headers.get('last-modified'))
    if (etag === undefined) {
      // Some DAV servers answer PUT without an ETag; fetch the fresh
      // properties once so the engine can do conditional writes later.
      const stat = await statPath(rel).catch(() => undefined)
      if (stat !== undefined) {
        if (stat.etag !== undefined) etag = stat.etag
        if (mtime === undefined && stat.mtime !== undefined) mtime = stat.mtime
      }
    }

    const result = {}
    if (etag !== undefined) result.etag = etag
    if (mtime !== undefined) result.mtime = mtime
    return result
  }

  async function remove(path, options = {}) {
    const rel = normalizeRelPath(path)
    const headers = {}
    const conditional = ifMatchValue(options?.etag)
    if (conditional !== undefined) headers['if-match'] = conditional

    const response = await dav('DELETE', fileUrl(rel), { headers })
    const status = response.status

    if (status === 404 || status === 410) {
      await drain(response)
      return
    }
    if (status === 409) {
      const detail = await readDetail(response)
      // Deleting a path whose ancestors are missing is still a no-op.
      if (isMissingDavResponse(status, detail)) return
      throw mapStatusError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail })
    }
    if (status === 412 || status === 428) {
      throw conflictError(status, {
        service: SERVICE,
        serviceEn: SERVICE_EN,
        detail: await readDetail(response),
        what: rel,
      })
    }
    if (status === 401 || status === 403 || status >= 500 || status === 408 || status === 429) {
      await throwForStatus(response)
    }
    if (!response.ok) await throwForStatus(response)
    await drain(response)
  }

  async function list(dir = '') {
    const rel = normalizeRelPath(dir, { allowEmpty: true })
    const response = await dav('PROPFIND', dirUrl(rel), {
      headers: { depth: '1', 'content-type': XML_CONTENT_TYPE },
      body: PROPFIND_BODY,
    })
    const status = response.status

    if (status === 404 || status === 410) {
      await drain(response)
      return []
    }
    if (status === 409) {
      const detail = await readDetail(response)
      // 坚果云: listing a deep path whose ancestors are missing is 409, not 404.
      if (isMissingDavResponse(status, detail)) return []
      throw mapStatusError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail })
    }
    if (status === 401 || status === 403 || status >= 500 || status === 408 || status === 429) {
      await throwForStatus(response)
    }
    if (status !== 207 && status !== 200) await throwForStatus(response)

    const xml = await response.text()
    const prefix = rel === '' ? '' : `${rel}/`
    const entries = []
    const seen = new Set()
    for (const raw of parseDavMultistatus(xml)) {
      const childRel = relativeFromPathname(raw.pathname)
      if (childRel === null || childRel === '' || childRel === rel) continue
      if (prefix !== '' && !childRel.startsWith(prefix)) continue
      const name = childRel.slice(prefix.length)
      if (name === '' || name.includes('/')) continue
      if (seen.has(childRel)) continue
      seen.add(childRel)

      const isDir = raw.isDir
      const entry = {
        name,
        path: childRel,
        isDir,
        size: isDir ? 0 : Number.isFinite(raw.size) ? raw.size : 0,
      }
      if (raw.mtime !== undefined) entry.mtime = raw.mtime
      if (raw.etag !== undefined) entry.etag = raw.etag
      entries.push(entry)
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return entries
  }

  async function ensureDir(dir = '') {
    const rel = normalizeRelPath(dir, { allowEmpty: true })
    const segments = rootPath === '' ? [] : rootPath.split('/')
    if (rel !== '') segments.push(...rel.split('/'))

    let current = ''
    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`
      const response = await dav('MKCOL', joinUrl(baseUrl, current))
      const status = response.status
      // 405/409/301 all mean "the collection already exists" for MKCOL.
      if (status === 201 || status === 200 || status === 204 || status === 301 || status === 405 || status === 409) {
        await drain(response)
        continue
      }
      if (status === 401 || status === 403 || status >= 500 || status === 408 || status === 429) {
        await throwForStatus(response)
      }
      await throwForStatus(response)
    }
  }

  /** Best-effort PROPFIND Depth 0 for one resource (internal, never throws). */
  async function statPath(rel) {
    const response = await dav('PROPFIND', fileUrl(rel), {
      headers: { depth: '0', 'content-type': XML_CONTENT_TYPE },
      body: PROPFIND_BODY,
    })
    if (!response.ok) {
      await drain(response)
      return undefined
    }
    const entry = parseDavMultistatus(await response.text())[0]
    if (entry === undefined) return undefined
    return { isDir: entry.isDir, size: entry.size, etag: entry.etag, mtime: entry.mtime }
  }

  return {
    kind: 'webdav',
    label: WEBDAV_LABEL,
    root,
    probe,
    read,
    write,
    remove,
    list,
    ensureDir,
  }
}
