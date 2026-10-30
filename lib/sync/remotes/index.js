// Remote adapter factory. The sync engine only ever talks to the shape described
// in docs/remote-interface.md, never to WebDAV/GitHub details.
//
//   import { createRemote, RemoteAuthError } from './remotes/index.js'
//   const remote = createRemote({ kind: 'webdav', baseUrl, username, password, path })
//
// Errors are re-exported here so callers can `instanceof` them without a second
// import path.

import { RemoteError } from './errors.js'
import { createGithubRemote, GITHUB_LABEL } from './github.js'
import { createWebdavRemote, WEBDAV_LABEL } from './webdav.js'

export {
  RemoteError,
  RemoteAuthError,
  RemoteConflictError,
  RemotePathError,
  RemoteUnavailableError,
} from './errors.js'

export { GITHUB_LABEL, WEBDAV_LABEL }

/**
 * Create the adapter selected by `settings.kind`.
 *
 * @param {{
 *   kind?: 'webdav' | 'github',
 *   baseUrl?: string, username?: string, password?: string,
 *   owner?: string, repo?: string, branch?: string, token?: string, apiUrl?: string,
 *   path?: string, timeoutMs?: number,
 * }} settings
 * @returns {{
 *   kind: string, label: string, root: string,
 *   probe: () => Promise<{ ok: boolean, latencyMs: number, detail: string }>,
 *   read: (path: string) => Promise<object>,
 *   write: (path: string, bytes: unknown, options?: { etag?: string }) => Promise<object>,
 *   remove: (path: string, options?: { etag?: string }) => Promise<void>,
 *   list: (dir?: string) => Promise<Array<object>>,
 *   ensureDir: (dir?: string) => Promise<void>,
 * }}
 */
export function createRemote(settings = {}) {
  const kind = settings !== null && typeof settings === 'object' ? settings.kind : undefined
  if (kind === 'webdav') return createWebdavRemote(settings)
  if (kind === 'github') return createGithubRemote(settings)
  throw new RemoteError(
    `不支持的远端类型「${String(kind ?? '')}」：只能是 webdav 或 github / unsupported remote kind: ${String(kind ?? '')} (expected "webdav" or "github")`,
    { code: 'unsupported_kind' },
  )
}
