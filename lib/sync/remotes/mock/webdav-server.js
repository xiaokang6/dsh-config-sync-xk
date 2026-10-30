// In-memory WebDAV server for the adapter tests (docs/remote-interface.md).
// Implements PROPFIND / GET / HEAD / PUT / DELETE / MKCOL over a
// Map<path, { bytes, etag, mtime }> plus a Set of explicit collections.
// Test-only helper: no external dependencies, no persistence.

import http from 'node:http'
import { randomBytes } from 'node:crypto'

const DEFAULT_BASE_PATH = '/dav'
const DEFAULT_USERNAME = 'user'
const DEFAULT_PASSWORD = 'pass'
const BASIC_REALM = 'mock-webdav'

/**
 * @param {{
 *   port?: number,
 *   username?: string,
 *   password?: string,
 *   basePath?: string,
 *   xmlPrefix?: string, // 'd' (default), 'D' or '' for a default-namespace body
 *   ancestorsNotFound?: boolean, // emulate 坚果云: missing ancestors => 409 AncestorsNotFound
 *   bareEtags?: boolean, // emulate 坚果云: unquoted ETags compared verbatim on If-Match
 * }} [options]
 * @returns {Promise<{
 *   url: string, files: Map<string, { bytes: Buffer, etag: string, mtime: number }>,
 *   dirs: Set<string>, requests: Array<object>, username: string, password: string,
 *   basePath: string, ancestorsNotFound: boolean, bareEtags: boolean,
 *   close: () => Promise<void>, reset: () => void,
 *   injectFailure: (spec?: object) => object, clearFailure: () => void,
 * }>}
 */
export async function createMockWebdav(options = {}) {
  const config = options ?? {}
  const username = config.username ?? DEFAULT_USERNAME
  const password = config.password ?? DEFAULT_PASSWORD
  const basePath = normalizeBasePath(config.basePath ?? DEFAULT_BASE_PATH)
  const xmlPrefix = config.xmlPrefix ?? 'd'
  const ancestorsNotFound = config.ancestorsNotFound === true
  const bareEtags = config.bareEtags === true
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`

  /** @type {Map<string, { bytes: Buffer, etag: string, mtime: number }>} */
  const files = new Map()
  /** @type {Set<string>} explicit collections (the root is implicit) */
  const dirs = new Set()
  const requests = []
  /** @type {{ status: number, body: string, match: string|null, remaining: number }|null} */
  let fault = null

  // -- XML helpers -----------------------------------------------------------

  const tag = (name) => (xmlPrefix === '' ? name : `${xmlPrefix}:${name}`)
  const namespaceAttr = xmlPrefix === '' ? 'xmlns="DAV:"' : `xmlns:${xmlPrefix}="DAV:"`

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  function encodeHref(rel, isDir) {
    const encoded = rel === '' ? '' : rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    const root = basePath === '' ? '' : basePath
    const path = encoded === '' ? `${root}/` : `${root}/${encoded}`
    return isDir && !path.endsWith('/') ? `${path}/` : path
  }

  function entryXml(rel, isDir) {
    const meta = files.get(rel)
    const name = rel === '' ? '/' : (rel.split('/').pop() ?? rel)
    const collection = isDir ? `<${tag('collection')}/>` : ''
    const lines = [
      `<${tag('response')}>`,
      `<${tag('href')}>${xmlEscape(encodeHref(rel, isDir))}</${tag('href')}>`,
      `<${tag('propstat')}><${tag('prop')}>`,
      `<${tag('resourcetype')}>${collection}</${tag('resourcetype')}>`,
      `<${tag('displayname')}>${xmlEscape(name)}</${tag('displayname')}>`,
    ]
    if (!isDir && meta !== undefined) {
      lines.push(`<${tag('getcontentlength')}>${meta.bytes.length}</${tag('getcontentlength')}>`)
      lines.push(`<${tag('getlastmodified')}>${new Date(meta.mtime).toUTCString()}</${tag('getlastmodified')}>`)
      lines.push(`<${tag('getetag')}>${xmlEscape(formatEtag(meta.etag))}</${tag('getetag')}>`)
    }
    lines.push(
      `</${tag('prop')}><${tag('status')}>HTTP/1.1 200 OK</${tag('status')}></${tag('propstat')}>`,
      `</${tag('response')}>`,
    )
    return lines.join('')
  }

  function multistatusXml(entries) {
    const body = entries.map(([rel, isDir]) => entryXml(rel, isDir)).join('')
    return `<?xml version="1.0" encoding="utf-8"?><${tag('multistatus')} ${namespaceAttr}>${body}</${tag('multistatus')}>`
  }

  // -- storage helpers -------------------------------------------------------

  function parentOf(rel) {
    const index = rel.lastIndexOf('/')
    return index === -1 ? '' : rel.slice(0, index)
  }

  function collectionExists(rel) {
    if (rel === '') return true
    if (dirs.has(rel)) return true
    for (const dir of dirs) if (dir.startsWith(`${rel}/`)) return true
    for (const file of files.keys()) if (file.startsWith(`${rel}/`)) return true
    return false
  }

  function childEntries(rel) {
    const prefix = rel === '' ? '' : `${rel}/`
    /** @type {Map<string, boolean>} */
    const children = new Map()
    for (const dir of dirs) {
      if (dir === rel || !dir.startsWith(prefix)) continue
      const rest = dir.slice(prefix.length)
      if (rest !== '' && !rest.includes('/')) children.set(dir, true)
    }
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      if (rest !== '' && !rest.includes('/')) children.set(file, false)
    }
    return [...children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  function normalizeEtag(value) {
    return String(value).trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
  }

  /** Emit an ETag the way this server does: quoted (RFC 7232) or bare (坚果云). */
  function formatEtag(etag) {
    return bareEtags ? String(etag) : `"${etag}"`
  }

  /**
   * Compare an `If-Match`/`If-None-Match` header against the current ETag.
   *
   * A conformant server parses the quoted entity-tag form, so `"abc"` and `abc`
   * compare equal. 坚果云 keeps its ETag unquoted and compares the header value
   * verbatim, so a client that adds the RFC quotes never matches — `bareEtags`
   * reproduces exactly that.
   */
  function etagWanted(headerValue, currentEtag) {
    const wanted = String(headerValue)
      .split(',')
      .map((value) => (bareEtags ? value.trim() : normalizeEtag(value)))
      .filter((value) => value !== '')
    return wanted.includes('*') || wanted.includes(bareEtags ? currentEtag : normalizeEtag(currentEtag))
  }

  /** True when every ancestor collection of `rel` exists (the root is implicit). */
  function ancestorsExist(rel) {
    if (rel === '') return true
    const parts = rel.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      if (!collectionExists(parts.slice(0, index).join('/'))) return false
    }
    return true
  }

  /**
   * Emulate 坚果云/SabreDAV: a request for a deep path whose ancestor
   * collections are missing answers 409 `AncestorsNotFound` instead of 404.
   */
  function sendAncestorsNotFound(response) {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">',
      '<s:exception>Sabre\\DAV\\Exception\\Conflict</s:exception>',
      '<s:message>AncestorsNotFound: The ancestors of this location do not exist.</s:message>',
      '</d:error>',
    ].join('\n')
    return send(response, 409, body, { 'content-type': 'application/xml; charset=utf-8' })
  }

  // -- HTTP helpers ----------------------------------------------------------

  function send(response, status, body = '', extraHeaders = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
    response.writeHead(status, { 'content-length': String(buffer.length), ...extraHeaders })
    response.end(buffer)
  }

  function sendJson(response, status, payload) {
    const buffer = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buffer.length) })
    response.end(buffer)
  }

  async function readBody(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  function decodeRel(pathname) {
    if (basePath !== '') {
      if (pathname === basePath || pathname === `${basePath}/`) return ''
      if (!pathname.startsWith(`${basePath}/`)) return null
      return decodeSegments(pathname.slice(basePath.length + 1))
    }
    return decodeSegments(pathname.replace(/^\/+/, ''))
  }

  function decodeSegments(raw) {
    const path = raw.replace(/\/+$/, '')
    if (path === '') return ''
    try {
      return path.split('/').map((segment) => decodeURIComponent(segment)).join('/')
    } catch {
      return null
    }
  }

  // -- request handlers ------------------------------------------------------

  function handlePropfind(request, response, rel) {
    const meta = files.get(rel)
    if (meta === undefined && !collectionExists(rel)) return send(response, 404, 'not found')
    const depth = String(request.headers.depth ?? '1').trim()
    /** @type {Array<[string, boolean]>} */
    const entries = []
    if (meta !== undefined) {
      entries.push([rel, false])
    } else {
      entries.push([rel, true])
      if (depth !== '0') entries.push(...childEntries(rel))
    }
    return send(response, 207, multistatusXml(entries), { 'content-type': 'application/xml; charset=utf-8' })
  }

  function handleGet(request, response, rel) {
    const meta = files.get(rel)
    if (meta === undefined) return send(response, collectionExists(rel) ? 405 : 404, '')
    const headers = {
      'content-type': 'application/octet-stream',
      etag: formatEtag(meta.etag),
      'last-modified': new Date(meta.mtime).toUTCString(),
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { ...headers, 'content-length': String(meta.bytes.length) })
      response.end()
      return
    }
    return send(response, 200, meta.bytes, headers)
  }

  function handlePut(request, response, rel, body) {
    if (rel === '') return send(response, 405, 'cannot PUT the collection root')
    if (files.get(rel) === undefined && collectionExists(rel)) return send(response, 409, 'a collection exists at that path')
    const parent = parentOf(rel)
    if (parent !== '' && !collectionExists(parent)) return send(response, 409, 'parent collection missing')

    const existing = files.get(rel)
    const ifMatch = request.headers['if-match']
    if (ifMatch !== undefined) {
      if (existing === undefined) return send(response, 412, 'precondition failed')
      if (!etagWanted(ifMatch, existing.etag)) return send(response, 412, 'precondition failed')
    }
    const ifNoneMatch = request.headers['if-none-match']
    if (ifNoneMatch !== undefined && String(ifNoneMatch).trim() === '*' && existing !== undefined) {
      return send(response, 412, 'precondition failed')
    }

    const etag = randomBytes(8).toString('hex')
    const mtime = Date.now()
    files.set(rel, { bytes: body, etag, mtime })
    return send(response, existing === undefined ? 201 : 204, '', {
      etag: formatEtag(etag),
      'last-modified': new Date(mtime).toUTCString(),
    })
  }

  function handleDelete(request, response, rel) {
    if (rel === '') return send(response, 405, 'refusing to delete the collection root')
    const meta = files.get(rel)
    if (meta !== undefined) {
      const ifMatch = request.headers['if-match']
      if (ifMatch !== undefined && !etagWanted(ifMatch, meta.etag)) return send(response, 412, 'precondition failed')
      files.delete(rel)
      return send(response, 204, '')
    }
    if (collectionExists(rel)) {
      for (const key of [...files.keys()]) if (key === rel || key.startsWith(`${rel}/`)) files.delete(key)
      for (const dir of [...dirs]) if (dir === rel || dir.startsWith(`${rel}/`)) dirs.delete(dir)
      return send(response, 204, '')
    }
    return send(response, 404, 'not found')
  }

  function handleMkcol(request, response, rel) {
    if (rel === '') return send(response, 405, 'collection already exists')
    if (files.get(rel) !== undefined || collectionExists(rel)) return send(response, 405, 'resource already exists')
    const parent = parentOf(rel)
    if (parent !== '' && !collectionExists(parent)) return send(response, 409, 'parent collection missing')
    dirs.add(rel)
    return send(response, 201, 'created')
  }

  async function handle(request, response) {
    let url
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    } catch {
      return send(response, 400, 'bad request')
    }
    const body = await readBody(request)
    requests.push({ method: request.method ?? '', path: url.pathname, search: url.search, headers: { ...request.headers } })

    if (fault !== null && fault.remaining > 0 && (fault.match === null || url.pathname.includes(fault.match))) {
      fault.remaining -= 1
      return send(response, fault.status, fault.body, { 'content-type': 'text/plain; charset=utf-8' })
    }

    if ((request.headers.authorization ?? '') !== expectedAuthorization) {
      return send(response, 401, 'unauthorized / 认证失败', { 'www-authenticate': `Basic realm="${BASIC_REALM}"` })
    }

    const rel = decodeRel(url.pathname)
    if (rel === null) return send(response, 404, 'not found')

    // 坚果云 quirk: deep paths whose ancestors are missing answer 409, not 404.
    if (ancestorsNotFound && !ancestorsExist(rel)) return sendAncestorsNotFound(response)

    switch (request.method) {
      case 'OPTIONS':
        return send(response, 200, '', { dav: '1, 2', allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL' })
      case 'PROPFIND':
        return handlePropfind(request, response, rel)
      case 'GET':
      case 'HEAD':
        return handleGet(request, response, rel)
      case 'PUT':
        return handlePut(request, response, rel, body)
      case 'DELETE':
        return handleDelete(request, response, rel)
      case 'MKCOL':
        return handleMkcol(request, response, rel)
      default:
        return send(response, 405, 'method not allowed')
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { message: `mock failure: ${error?.message ?? String(error)}` })
      else response.end()
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(config.port ?? 0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = address !== null && typeof address === 'object' ? address.port : (config.port ?? 0)
  const url = `http://127.0.0.1:${actualPort}${basePath === '' ? '' : basePath}/`

  return {
    url,
    files,
    dirs,
    requests,
    username,
    password,
    basePath,
    ancestorsNotFound,
    bareEtags,
    close: async () => {
      if (!server.listening) return
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
    reset: () => {
      files.clear()
      dirs.clear()
      requests.length = 0
      fault = null
    },
    injectFailure: (spec = {}) => {
      const remaining =
        Number.isFinite(spec.remaining) ? spec.remaining : Number.isFinite(spec.count) ? spec.count : 1
      fault = {
        status: spec.status ?? 500,
        body: spec.body ?? '',
        match: spec.match ?? null,
        remaining,
      }
      return fault
    },
    clearFailure: () => {
      fault = null
    },
  }
}

function normalizeBasePath(value) {
  let path = String(value ?? '').trim()
  if (path === '') return ''
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/+$/, '')
  return path === '/' ? '' : path
}
