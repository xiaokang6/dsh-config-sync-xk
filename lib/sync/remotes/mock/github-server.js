// In-memory GitHub Contents API server for the adapter tests
// (docs/remote-interface.md). Implements GET/PUT/DELETE contents, the repo
// probe endpoint, sha conflict behaviour and 401 without the token.
// Test-only helper: no external dependencies, no persistence.

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_OWNER = 'o'
const DEFAULT_REPO = 'r'
const DEFAULT_TOKEN = 't'
const DEFAULT_BRANCH = 'main'
const REQUIRED_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-config-sync/0.1.0',
}

/**
 * @param {{
 *   port?: number, owner?: string, repo?: string, token?: string, branch?: string,
 *   strictHeaders?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string, files: Map<string, { bytes: Buffer, sha: string, mtime: number }>,
 *   requests: Array<object>, owner: string, repo: string, branch: string, token: string,
 *   close: () => Promise<void>, reset: () => void,
 *   injectFailure: (spec?: object) => object, clearFailure: () => void,
 * }>}
 */
export async function createMockGithub(options = {}) {
  const config = options ?? {}
  const owner = config.owner ?? DEFAULT_OWNER
  const repo = config.repo ?? DEFAULT_REPO
  const token = config.token ?? DEFAULT_TOKEN
  const branch = config.branch ?? DEFAULT_BRANCH
  const strictHeaders = config.strictHeaders !== false

  /** @type {Map<string, { bytes: Buffer, sha: string, mtime: number }>} */
  const files = new Map()
  const requests = []
  /** @type {{ status: number, payload: object, match: string|null, remaining: number }|null} */
  let fault = null

  const repoBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const contentsBase = `${repoBase}/contents`

  // -- helpers ---------------------------------------------------------------

  function sendJson(response, status, payload) {
    const buffer = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(buffer.length),
    })
    response.end(buffer)
  }

  async function readBody(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  function baseName(path) {
    const index = path.lastIndexOf('/')
    return index === -1 ? path : path.slice(index + 1)
  }

  function isDirectory(rel) {
    if (rel === '') return true
    for (const path of files.keys()) if (path.startsWith(`${rel}/`)) return true
    return false
  }

  function childEntries(rel) {
    const prefix = rel === '' ? '' : `${rel}/`
    /** @type {Map<string, boolean>} */
    const children = new Map()
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      children.set(path, false)
    }
    // Implicit directories: any deeper file implies its ancestors are dirs.
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const index = rest.indexOf('/')
      if (index === -1) continue
      const dirPath = `${prefix}${rest.slice(0, index)}`
      children.set(dirPath, true)
    }
    return [...children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  function dirSha(path) {
    return createHash('sha1').update(`dir:${path}`).digest('hex')
  }

  function base64WithLines(bytes) {
    const encoded = bytes.toString('base64')
    const lines = []
    for (let index = 0; index < encoded.length; index += 60) lines.push(encoded.slice(index, index + 60))
    return `${lines.join('\n')}\n`
  }

  function filePayload(path) {
    const meta = files.get(path)
    if (meta === undefined) return undefined
    return {
      name: baseName(path),
      path,
      sha: meta.sha,
      size: meta.bytes.length,
      type: 'file',
      content: base64WithLines(meta.bytes),
      encoding: 'base64',
      download_url: `${origin}/raw/${path.split('/').map(encodeURIComponent).join('/')}`,
    }
  }

  function dirPayload(path) {
    return {
      name: baseName(path),
      path,
      sha: dirSha(path),
      size: 0,
      type: 'dir',
    }
  }

  function matchRoute(pathname) {
    if (pathname === repoBase || pathname === `${repoBase}/`) return { kind: 'repo', rel: '' }
    if (pathname === contentsBase || pathname === `${contentsBase}/`) return { kind: 'contents', rel: '' }
    if (!pathname.startsWith(`${contentsBase}/`)) return null
    const raw = pathname.slice(contentsBase.length + 1).replace(/\/+$/, '')
    if (raw === '') return { kind: 'contents', rel: '' }
    try {
      return { kind: 'contents', rel: raw.split('/').map((segment) => decodeURIComponent(segment)).join('/') }
    } catch {
      return null
    }
  }

  // -- contents handlers -----------------------------------------------------

  function getContents(response, rel) {
    const meta = files.get(rel)
    if (meta !== undefined) return sendJson(response, 200, filePayload(rel))
    if (isDirectory(rel)) {
      return sendJson(
        response,
        200,
        childEntries(rel).map(([path, isDir]) => (isDir ? dirPayload(path) : filePayload(path))),
      )
    }
    return sendJson(response, 404, { message: 'Not Found' })
  }

  function putContents(response, rel, body) {
    if (rel === '') return sendJson(response, 422, { message: 'Invalid request: a path is required' })
    if (body === null || typeof body !== 'object') {
      return sendJson(response, 422, { message: 'Invalid request: a JSON body is required' })
    }
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      return sendJson(response, 422, { message: 'Invalid request: "message" is required' })
    }
    if (typeof body.content !== 'string') {
      return sendJson(response, 422, { message: 'Invalid request: "content" is required' })
    }
    if (/[^A-Za-z0-9+/=\s]/.test(body.content)) {
      return sendJson(response, 422, { message: 'Invalid request: "content" is not valid base64' })
    }
    if (isDirectory(rel)) {
      return sendJson(response, 422, { message: `Invalid request: "${rel}" is a directory` })
    }

    const existing = files.get(rel)
    if (existing !== undefined) {
      if (typeof body.sha !== 'string' || body.sha === '') {
        return sendJson(response, 422, { message: 'Invalid request: "sha" wasn\'t supplied.' })
      }
      if (body.sha !== existing.sha) return sendJson(response, 409, { message: 'sha does not match' })
    } else if (typeof body.sha === 'string' && body.sha !== '') {
      // GitHub refuses a sha for a file that does not exist yet.
      return sendJson(response, 422, {
        message: 'Invalid request: "sha" supplied for a file that does not exist',
      })
    }

    const bytes = Buffer.from(body.content, 'base64')
    const sha = randomBytes(20).toString('hex')
    files.set(rel, { bytes, sha, mtime: Date.now() })
    return sendJson(response, existing === undefined ? 201 : 200, {
      content: filePayload(rel),
      commit: {
        sha: randomBytes(20).toString('hex'),
        message: body.message,
        branch: typeof body.branch === 'string' && body.branch !== '' ? body.branch : branch,
      },
    })
  }

  function deleteContents(response, rel, body) {
    if (body === null || typeof body !== 'object') {
      return sendJson(response, 422, { message: 'Invalid request: a JSON body is required' })
    }
    const existing = files.get(rel)
    if (existing === undefined) return sendJson(response, 404, { message: 'Not Found' })
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      return sendJson(response, 422, { message: 'Invalid request: "message" is required' })
    }
    if (typeof body.sha !== 'string' || body.sha === '') {
      return sendJson(response, 422, { message: 'Invalid request: "sha" wasn\'t supplied.' })
    }
    if (body.sha !== existing.sha) return sendJson(response, 409, { message: 'sha does not match' })
    files.delete(rel)
    return sendJson(response, 200, {
      commit: {
        sha: randomBytes(20).toString('hex'),
        message: body.message,
        branch: typeof body.branch === 'string' && body.branch !== '' ? body.branch : branch,
      },
    })
  }

  // -- request handling ------------------------------------------------------

  async function handle(request, response) {
    let url
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    } catch {
      return sendJson(response, 400, { message: 'bad request' })
    }
    const rawBody = await readBody(request)
    let parsedBody
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'))
      } catch {
        parsedBody = undefined
      }
    }
    requests.push({
      method: request.method ?? '',
      path: url.pathname,
      search: url.search,
      headers: { ...request.headers },
      body: parsedBody,
    })

    if (fault !== null && fault.remaining > 0 && (fault.match === null || url.pathname.includes(fault.match))) {
      fault.remaining -= 1
      return sendJson(response, fault.status, fault.payload)
    }

    if (token !== '' && (request.headers.authorization ?? '') !== `Bearer ${token}`) {
      return sendJson(response, 401, {
        message: 'Bad credentials',
        documentation_url: 'https://docs.github.com/rest',
      })
    }

    if (strictHeaders) {
      const wrong = []
      for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
        if ((request.headers[name] ?? '') !== expected) wrong.push(name)
      }
      if (wrong.length > 0) {
        return sendJson(response, 400, { message: `mock: missing or wrong headers: ${wrong.join(', ')}` })
      }
    }

    const route = matchRoute(url.pathname)
    if (route === null) return sendJson(response, 404, { message: 'Not Found' })

    if (route.kind === 'repo') {
      if (request.method !== 'GET') return sendJson(response, 405, { message: 'Method Not Allowed' })
      return sendJson(response, 200, {
        name: repo,
        full_name: `${owner}/${repo}`,
        private: true,
        default_branch: branch,
      })
    }

    switch (request.method) {
      case 'GET':
        return getContents(response, route.rel)
      case 'PUT':
        return putContents(response, route.rel, parsedBody)
      case 'DELETE':
        return deleteContents(response, route.rel, parsedBody)
      default:
        return sendJson(response, 405, { message: 'Method Not Allowed' })
    }
  }

  let origin = 'http://127.0.0.1:0'

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
  const apiUrl = `http://127.0.0.1:${actualPort}`
  origin = apiUrl

  return {
    apiUrl,
    files,
    requests,
    owner,
    repo,
    branch,
    token,
    close: async () => {
      if (!server.listening) return
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
    reset: () => {
      files.clear()
      requests.length = 0
      fault = null
    },
    injectFailure: (spec = {}) => {
      const remaining =
        Number.isFinite(spec.remaining) ? spec.remaining : Number.isFinite(spec.count) ? spec.count : 1
      fault = {
        status: spec.status ?? 500,
        payload: spec.payload ?? { message: spec.body ?? 'mock failure' },
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
