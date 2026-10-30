// GitHub Contents API adapter — GET/PUT/DELETE with sha (blob) conflict mapping.
// Contract: docs/remote-interface.md. Built-ins only (fetch, Buffer).

import { RemoteAuthError, RemoteError } from './errors.js'
import {
  clip,
  conflictError,
  httpRequest,
  mapStatusError,
  normalizeRelPath,
  redact,
  resolveTimeoutMs,
  shortBody,
  toBuffer,
} from './util.js'

export const GITHUB_LABEL = 'GitHub'

const SERVICE = GITHUB_LABEL
const SERVICE_EN = 'GitHub'
export const GITHUB_DEFAULT_API_URL = 'https://api.github.com'
const DEFAULT_BRANCH = 'main'
const USER_AGENT = '@xiaokang6/dsh-config-sync/0.1.0'

function commitMessage(action, rel) {
  return `chore(config-sync): ${action} ${clip(rel, 120)}`
}

/**
 * Create the GitHub Contents API adapter.
 *
 * @param {{ owner?: string, repo?: string, branch?: string, path?: string, token?: string, apiUrl?: string, timeoutMs?: number }} settings
 * @returns {object} remote shape from docs/remote-interface.md
 */
export function createGithubRemote(settings = {}) {
  if (settings === null || typeof settings !== 'object') {
    throw new RemoteError('GitHub 配置无效：需要一个设置对象 / invalid GitHub settings: expected an object', {
      code: 'config',
    })
  }

  const owner = typeof settings.owner === 'string' ? settings.owner.trim() : ''
  const repo = typeof settings.repo === 'string' ? settings.repo.trim() : ''
  if (owner === '' || repo === '') {
    throw new RemoteError('缺少 GitHub 仓库信息（owner/repo）/ missing GitHub owner or repo', {
      code: 'config',
    })
  }
  const branch =
    typeof settings.branch === 'string' && settings.branch.trim() !== ''
      ? settings.branch.trim()
      : DEFAULT_BRANCH
  const token = typeof settings.token === 'string' ? settings.token.trim() : ''
  const rootPath = normalizeRelPath(settings.path ?? '', { allowEmpty: true })
  const timeoutMs = resolveTimeoutMs(settings.timeoutMs)
  const apiUrl = (
    typeof settings.apiUrl === 'string' && settings.apiUrl.trim() !== ''
      ? settings.apiUrl.trim()
      : GITHUB_DEFAULT_API_URL
  ).replace(/\/+$/, '')
  let apiBase
  try {
    apiBase = new URL(apiUrl)
  } catch {
    throw new RemoteError(
      `GitHub API 地址不是合法 URL / invalid GitHub apiUrl: ${redact(shortBody(apiUrl, 80))}`,
      { code: 'config' },
    )
  }
  if (apiBase.protocol !== 'http:' && apiBase.protocol !== 'https:') {
    throw new RemoteError(
      `GitHub API 地址必须以 http(s) 开头 / GitHub apiUrl must be http(s): ${redact(shortBody(apiUrl, 80))}`,
      { code: 'config' },
    )
  }
  if (apiBase.search !== '' || apiBase.hash !== '') {
    throw new RemoteError(
      'GitHub API 地址不能带查询参数或锚点 / GitHub apiUrl must not include a query or hash',
      { code: 'config' },
    )
  }

  const repoUrl = `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const root = `${repoUrl}/contents${rootPath === '' ? '' : `/${rootPath}`}?ref=${encodeURIComponent(branch)}`

  // -- URL + request helpers --------------------------------------------------

  /** Repo-relative path for a remote-root-relative path. */
  function repoPathOf(rel) {
    if (rootPath === '') return rel
    return rel === '' ? rootPath : `${rootPath}/${rel}`
  }

  function contentsUrl(rel, options = {}) {
    const repoPath = repoPathOf(rel)
    const encoded =
      repoPath === '' ? '' : `/${repoPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
    const url = `${repoUrl}/contents${encoded}`
    return options.ref === false ? url : `${url}?ref=${encodeURIComponent(branch)}`
  }

  function headersFor(extra = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...extra,
    }
    if (token !== '') headers.authorization = `Bearer ${token}`
    return headers
  }

  async function gh(method, url, options = {}) {
    const hasBody = options.body !== undefined
    const init = {
      method,
      headers: headersFor(hasBody ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options.headers),
    }
    if (hasBody) init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    return httpRequest(url, init, { timeoutMs, label: SERVICE_EN })
  }

  /** Read a response body once and try to JSON-parse it (also frees the socket). */
  async function jsonOf(response) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      return { text: '', json: undefined }
    }
    if (text === '') return { text: '', json: undefined }
    try {
      return { text, json: JSON.parse(text) }
    } catch {
      return { text, json: undefined }
    }
  }

  // -- error helpers ---------------------------------------------------------

  function authFailure(status, detail = '') {
    return new RemoteAuthError(
      `GitHub 认证失败（HTTP ${status}）：令牌无效、过期或缺少仓库 Contents 读写权限 / GitHub authentication failed (HTTP ${status}): token is invalid, expired, or lacks repo contents permission`,
      { status, detail },
    )
  }

  function notFoundFailure(status, detail = '', what = '') {
    const target = what === '' ? '' : ` ${clip(what, 120)}`
    const error = new RemoteError(
      `GitHub 找不到目标（HTTP ${status}）${target}：仓库、分支或路径不存在 / GitHub target not found (HTTP ${status}): repository, branch or path is missing`,
      { status, code: 'not_found', detail },
    )
    if (detail !== '') error.message = `${error.message} [${detail}]`
    return error
  }

  function statusFailure(status, detail = '') {
    if (status === 401 || status === 403) return authFailure(status, detail)
    if (status === 404 || status === 410) return notFoundFailure(status, detail)
    return mapStatusError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail })
  }

  function notAFile(rel) {
    return new RemoteError(
      `GitHub 目标是目录，不能按文件读取：${clip(rel, 120)} / GitHub target is a directory, not a file: ${clip(rel, 120)}`,
      { code: 'not_a_file' },
    )
  }

  function notADirectory(rel) {
    return new RemoteError(
      `GitHub 目标不是目录：${clip(rel, 120)} / GitHub target is not a directory: ${clip(rel, 120)}`,
      { code: 'not_a_dir' },
    )
  }

  function missingSha(rel) {
    return new RemoteError(
      `GitHub 内容缺少 sha，无法完成操作：${clip(rel, 120)} / missing sha for GitHub content: ${clip(rel, 120)}`,
      { code: 'bad_response' },
    )
  }

  // -- operations ------------------------------------------------------------

  async function probe() {
    const startedAt = performance.now()
    const response = await gh('GET', `${repoUrl}?ref=${encodeURIComponent(branch)}`)
    const latencyMs = Math.round(performance.now() - startedAt)
    const { json, text } = await jsonOf(response)
    const detail = shortBody(redact(json?.message ?? text))
    const status = response.status

    if (status === 401 || status === 403) throw authFailure(status, detail)
    if (status === 404) throw notFoundFailure(status, detail, `${owner}/${repo}`)
    if (status >= 500 || status === 408 || status === 429) throw statusFailure(status, detail)
    if (!response.ok) throw statusFailure(status, detail)

    return { ok: true, latencyMs, detail: '' }
  }

  async function read(path) {
    const rel = normalizeRelPath(path)
    const response = await gh('GET', contentsUrl(rel))
    const { json, text } = await jsonOf(response)
    const detail = shortBody(redact(json?.message ?? text))
    const status = response.status

    // 404: missing path; 409: "Git Repository is empty." — both mean "not there".
    if (status === 404 || status === 409) return { found: false }
    if (status === 401 || status === 403) throw authFailure(status, detail)
    if (!response.ok) throw statusFailure(status, detail)

    if (Array.isArray(json)) throw notAFile(rel)
    if (json === null || typeof json !== 'object') {
      throw new RemoteError(
        `GitHub 返回了无法识别的响应 / unexpected GitHub response for ${clip(rel, 120)}`,
        { code: 'bad_response', status },
      )
    }
    if (json.type !== undefined && json.type !== 'file') throw notAFile(rel)

    const encoding = typeof json.encoding === 'string' ? json.encoding : 'base64'
    const content = typeof json.content === 'string' ? json.content : ''
    let bytes
    if (encoding === 'base64' && content !== '') {
      bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64')
    } else if (Number(json.size) > 0) {
      // GitHub omits `content` for files above ~1 MB (encoding: "none").
      throw new RemoteError(
        `GitHub 未返回文件内容（文件大于 1 MB）：${clip(rel, 120)} / GitHub omitted the content (file over 1 MB): ${clip(rel, 120)}`,
        { code: 'too_large', status },
      )
    } else {
      bytes = Buffer.from(content, 'utf8')
    }

    const result = { found: true, bytes }
    const sha = typeof json.sha === 'string' && json.sha !== '' ? json.sha : undefined
    if (sha !== undefined) result.etag = sha
    return result
  }

  async function write(path, bytes, options = {}) {
    const rel = normalizeRelPath(path)
    const payload = toBuffer(bytes)
    const etag =
      options?.etag === undefined || options?.etag === null ? '' : String(options.etag).trim()

    const body = {
      message: commitMessage('update', rel),
      content: payload.toString('base64'),
      branch,
    }
    if (etag !== '') body.sha = etag

    // The branch travels in the body; no `ref` query on PUT.
    const response = await gh('PUT', contentsUrl(rel, { ref: false }), { body })
    const { json, text } = await jsonOf(response)
    const detail = shortBody(redact(json?.message ?? text))
    const status = response.status

    // 409 = stale sha, 422 = sha missing while the file exists / invalid request.
    if (status === 409 || status === 422) {
      throw conflictError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail, what: rel })
    }
    if (status === 401 || status === 403) throw authFailure(status, detail)
    if (!response.ok) throw statusFailure(status, detail)

    const sha = json?.content?.sha ?? json?.commit?.sha
    const result = {}
    if (typeof sha === 'string' && sha !== '') result.etag = sha
    return result
  }

  async function remove(path, options = {}) {
    const rel = normalizeRelPath(path)
    let sha = options?.etag === undefined || options?.etag === null ? '' : String(options.etag).trim()
    if (sha === '') {
      const current = await read(rel)
      if (current.found !== true) return
      sha = typeof current.etag === 'string' ? current.etag : ''
      if (sha === '') throw missingSha(rel)
    }

    const response = await gh('DELETE', contentsUrl(rel, { ref: false }), {
      body: { message: commitMessage('delete', rel), sha, branch },
    })
    const { json, text } = await jsonOf(response)
    const detail = shortBody(redact(json?.message ?? text))
    const status = response.status

    if (status === 404) return // already gone: deleting a missing path is a no-op
    if (status === 409 || status === 422) {
      throw conflictError(status, { service: SERVICE, serviceEn: SERVICE_EN, detail, what: rel })
    }
    if (status === 401 || status === 403) throw authFailure(status, detail)
    if (!response.ok) throw statusFailure(status, detail)
  }

  async function list(dir = '') {
    const rel = normalizeRelPath(dir, { allowEmpty: true })
    const response = await gh('GET', contentsUrl(rel))
    const { json, text } = await jsonOf(response)
    const detail = shortBody(redact(json?.message ?? text))
    const status = response.status

    if (status === 404 || status === 409) return []
    if (status === 401 || status === 403) throw authFailure(status, detail)
    if (!response.ok) throw statusFailure(status, detail)
    if (!Array.isArray(json)) throw notADirectory(rel)

    const entries = []
    for (const raw of json) {
      if (raw === null || typeof raw !== 'object') continue
      const itemPath = typeof raw.path === 'string' ? raw.path : ''
      let childRel = itemPath
      if (rootPath !== '') {
        if (!itemPath.startsWith(`${rootPath}/`)) continue
        childRel = itemPath.slice(rootPath.length + 1)
      }
      if (childRel === '') continue
      const isDir = raw.type === 'dir'
      const entry = {
        name:
          typeof raw.name === 'string' && raw.name !== ''
            ? raw.name
            : (childRel.split('/').pop() ?? childRel),
        path: childRel,
        isDir,
        size: isDir ? 0 : Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0,
      }
      if (typeof raw.sha === 'string' && raw.sha !== '') entry.etag = raw.sha
      entries.push(entry)
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return entries
  }

  async function ensureDir(dir = '') {
    // GitHub has no directories: they exist only through the files inside them.
    normalizeRelPath(dir, { allowEmpty: true })
    return undefined
  }

  return {
    kind: 'github',
    label: GITHUB_LABEL,
    root,
    probe,
    read,
    write,
    remove,
    list,
    ensureDir,
  }
}
