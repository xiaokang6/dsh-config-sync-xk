# Remote adapter contract (v1)

`lib/sync/remotes/index.js` exports `createRemote(settings)` and returns one of
the two adapters. The sync engine only ever talks to this shape.

## Settings

```js
// WebDAV (坚果云: baseUrl https://dav.jianguoyun.com/dav/, password = app password)
{ kind: 'webdav', baseUrl: string, username: string, password: string, path: string }
// GitHub (fine-grained PAT with repo contents read/write)
{ kind: 'github', owner: string, repo: string, branch?: string, path: string, token: string }
```

`path` is the remote root prefix, POSIX and relative (e.g. `dsh-config-sync/desktop`).
Tests may add `apiUrl` (github) / `timeoutMs` (both).

## Shape

```js
{
  kind: 'webdav' | 'github',
  label: '坚果云 WebDAV' | 'GitHub',
  root: string, // human-readable absolute root, for the UI/log

  probe(): Promise<{ ok: boolean, latencyMs: number, detail: string }>,

  // read: 404 => { found: false } (never throws for absence)
  //      401/403 => throw RemoteAuthError
  read(path): Promise<{ found: false } | {
    found: true, bytes: Buffer, etag?: string, mtime?: number,
  }>,

  // write: creates missing parent directories
  //        opts.etag present and remote etag differs => throw RemoteConflictError
  write(path, bytes, { etag }?): Promise<{ etag?: string, mtime?: number }>,

  // remove: deleting a missing path is a no-op
  remove(path, { etag }?): Promise<void>,

  // non-recursive listing; a missing directory yields []
  list(dir): Promise<Array<{
    name: string, path: string, isDir: boolean, size: number,
    mtime?: number, etag?: string,
  }>>,

  ensureDir(dir): Promise<void>,
}
```

## Error classes (`lib/sync/remotes/errors.js`, exported)

- `RemoteError` — base: `{ code: string, status?: number, detail?: string }`,
  message is user-facing (中文 + English).
- `RemoteAuthError extends RemoteError` — bad/unauthorized credentials.
- `RemoteConflictError extends RemoteError` — etag/sha precondition failed.
- `RemotePathError extends RemoteError` — unsafe/relative path rejected.
- `RemoteUnavailableError extends RemoteError` — network/DNS/timeout/5xx.

## Rules

- **No npm dependencies.** Node >= 20: global `fetch`, `AbortSignal.timeout`,
  `Buffer`, `node:test` in tests.
- `path`/`dir` arguments are POSIX, relative to the remote root: no leading `/`,
  no `\`, no `..`, no empty segments. Every adapter validates with a shared
  `normalizeRelPath()` (in `lib/sync/remotes/util.js`) and throws
  `RemotePathError` otherwise.
- URL building must encode every path segment (`encodeURIComponent`) and never
  let a segment escape the root.
- Timeouts: default 15 s per request, `settings.timeoutMs` override. Retry
  nothing by default; report failures with the HTTP status and a short body.
- Log lines never include credentials; `redact()` in `util.js` masks
  `password`/`token`/`Authorization`.

## WebDAV specifics

- Basic auth from `settings.username`/`password`.
- `probe()`: `PROPFIND` `Depth: 0` on the root (207 = ok). A `401` is
  `RemoteAuthError`; a `404` means the root does not exist yet (still `ok:false`
  with detail, or create it in `ensureDir`).
- `list(dir)`: `PROPFIND` `Depth: 1`; parse `<d:href>`,
  `<d:getcontentlength>`, `<d:getlastmodified>`, `<d:getetag>`,
  `<d:resourcetype><d:collection/>`. Tolerate `D:`/`d:`/default namespace forms.
  The collection's own href is excluded; only its children are returned.
- `write()`: `PUT` with `content-type: application/octet-stream`; with
  `opts.etag` send `If-Match`; `412` → `RemoteConflictError`.
- `ensureDir()`: `MKCOL` segment by segment; `405`/`409`/`301` mean "exists".
- `remove()`: `DELETE`; `404` is success.
- 坚果云 quirks: base URL may end with `/dav/`; join carefully and keep a
  single-slash separator.

## GitHub specifics

- Base `settings.apiUrl ?? 'https://api.github.com'`; headers:
  `authorization: Bearer <token>`, `accept: application/vnd.github+json`,
  `x-github-api-version: 2022-11-28`, `user-agent: dsh-config-sync/0.1.0`.
- `probe()`: `GET /repos/{owner}/{repo}` → 200 ok; 401/403 auth error; 404 error.
- `read(path)`: `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}`;
  file answer has `content` (base64), `sha`, `size`; 404 → `{found:false}`.
- `write(path, bytes, {etag})`: `PUT /repos/{owner}/{repo}/contents/{path}` with
  `{ message, content: base64, branch, ...(etag ? { sha: etag } : {}) }`.
  GitHub answers `422` when the file exists but no `sha` was supplied, and `409`
  for a stale `sha` → map both to `RemoteConflictError`; retry-once policy is the
  engine's, not the adapter's. Return `{etag: response.content.sha}`.
- `list(dir)`: `GET /repos/{owner}/{repo}/contents/{dir}?ref={branch}`; a 404 for
  a directory means empty (`[]`); entries have `name`, `path`, `sha`, `size`,
  `type` (`file`/`dir`).
- `remove(path)`: list/read the file for its `sha`, then
  `DELETE /repos/{owner}/{repo}/contents/{path}` with `{message, sha, branch}`.
- `ensureDir()`: no-op (GitHub creates directories implicitly).
- Branch defaults to `main`; every request carries `ref`/`branch`.

## Mocks + tests (required)

- `lib/sync/remotes/mock/webdav-server.js` — in-memory WebDAV:
  `createMockWebdav({ port = 0 })` → `{ url, files, close(), reset() }`
  implementing PROPFIND/GET/PUT/DELETE/MKCOL against a `Map<path,{bytes,etag,mtime}>`.
- `lib/sync/remotes/mock/github-server.js` — in-memory GitHub Contents API:
  `createMockGithub({ owner = 'o', repo = 'r', token = 't' })` →
  `{ apiUrl, files, close(), reset() }` implementing the four operations above
  (including sha conflict behaviour and 401 without the token).
- `test/remotes/webdav.test.mjs`, `test/remotes/github.test.mjs`,
  `test/remotes/paths.test.mjs` — `node:test` + `node:assert/strict`.
  Cover: probe ok/auth-fail, read present/404, write+read roundtrip, etag
  conflict, list (dir, missing dir, file+dir mix), remove, ensureDir idempotent,
  path traversal/absolute rejection, 5xx mapping, GitHub create/update/delete/
  list/404, no-token 401.
- Run: `cd D:\AI\chajian\dsh-config-sync; node --test test/remotes/` (must pass).
