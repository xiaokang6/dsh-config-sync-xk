// GitHub Contents API adapter contract tests against the in-memory mock server.
// Run: node --test test/remotes/

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import {
  RemoteAuthError,
  RemoteConflictError,
  RemoteError,
  RemotePathError,
  RemoteUnavailableError,
  createRemote,
} from '../../lib/sync/remotes/index.js'
import { createMockGithub } from '../../lib/sync/remotes/mock/github-server.js'

const ROOT = 'dsh-config-sync/desktop'
const CJK = /[\u4e00-\u9fff]/

/** @type {Awaited<ReturnType<typeof createMockGithub>>} */
let server
/** @type {ReturnType<typeof createRemote>} */
let remote

before(async () => {
  server = await createMockGithub({ token: 'mock-github-token-abc123' })
  remote = createRemote({
    kind: 'github',
    apiUrl: server.apiUrl,
    owner: server.owner,
    repo: server.repo,
    branch: server.branch,
    token: server.token,
    path: ROOT,
  })
})

after(async () => {
  await server?.close()
})

beforeEach(() => {
  server.reset()
})

async function unreachableApiUrl() {
  const temporary = await createMockGithub()
  const { port } = new URL(temporary.apiUrl)
  await temporary.close()
  return `http://127.0.0.1:${port}`
}

function githubRemote(overrides = {}) {
  return createRemote({
    kind: 'github',
    apiUrl: server.apiUrl,
    owner: server.owner,
    repo: server.repo,
    branch: server.branch,
    token: server.token,
    path: ROOT,
    ...overrides,
  })
}

test('exposes the documented remote shape', () => {
  assert.equal(remote.kind, 'github')
  assert.equal(remote.label, 'GitHub')
  assert.equal(remote.root, `${server.apiUrl}/repos/${server.owner}/${server.repo}/contents/${ROOT}?ref=main`)
  for (const method of ['probe', 'read', 'write', 'remove', 'list', 'ensureDir']) {
    assert.equal(typeof remote[method], 'function', `${method} must be a function`)
  }
  assert.ok(!remote.root.includes(server.token))
})

test('probe reports ok and sends the contract headers', async () => {
  const result = await remote.probe()
  assert.equal(result.ok, true)
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(result.detail, '')

  const request = [...server.requests].reverse().find((entry) => entry.method === 'GET' && entry.path === `/repos/${server.owner}/${server.repo}`)
  assert.ok(request, 'probe must call GET /repos/{owner}/{repo}')
  assert.equal(request.headers.authorization, `Bearer ${server.token}`)
  assert.equal(request.headers.accept, 'application/vnd.github+json')
  assert.equal(request.headers['x-github-api-version'], '2022-11-28')
  assert.equal(request.headers['user-agent'], '@xiaokang6/dsh-config-sync/0.1.0')
})

test('probe without a token throws RemoteAuthError', async () => {
  const anonymous = githubRemote({ token: '' })
  await assert.rejects(
    () => anonymous.probe(),
    (error) => {
      assert.ok(error instanceof RemoteAuthError)
      assert.equal(error.code, 'auth')
      assert.equal(error.status, 401)
      assert.match(error.message, CJK)
      assert.ok(!error.message.includes('Bearer'))
      return true
    },
  )
})

test('probe for an unknown repository throws a not_found RemoteError', async () => {
  const wrongRepo = githubRemote({ repo: 'does-not-exist' })
  await assert.rejects(
    () => wrongRepo.probe(),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'not_found')
      assert.equal(error.status, 404)
      assert.match(error.message, CJK)
      return true
    },
  )
})

test('read returns { found: false } for a missing file', async () => {
  assert.deepEqual(await remote.read('missing.json'), { found: false })
})

test('write creates a file (sha as etag) and read round-trips the bytes', async () => {
  const payload = Buffer.from('{"schema":1}\n', 'utf8')
  const written = await remote.write('manifest.json', payload)
  assert.match(written.etag, /^[0-9a-f]{40}$/)
  assert.ok(server.files.has(`${ROOT}/manifest.json`))

  const read = await remote.read('manifest.json')
  assert.equal(read.found, true)
  assert.deepEqual(read.bytes, payload)
  assert.equal(read.etag, written.etag)
  assert.equal('mtime' in read, false, 'GitHub has no mtime')

  const putRequest = server.requests.find((entry) => entry.method === 'PUT')
  assert.ok(putRequest)
  assert.equal(putRequest.search, '', 'PUT carries the branch in the body, not the query')
  assert.equal(putRequest.body.branch, 'main')
  assert.equal(putRequest.body.message.includes('config-sync'), true)
  assert.deepEqual(Buffer.from(putRequest.body.content, 'base64'), payload)
})

test('write with the current sha updates the file', async () => {
  const first = await remote.write('notes.txt', Buffer.from('one'))
  const updated = await remote.write('notes.txt', Buffer.from('two'), { etag: first.etag })
  assert.match(updated.etag, /^[0-9a-f]{40}$/)
  assert.notEqual(updated.etag, first.etag)
  assert.equal((await remote.read('notes.txt')).bytes.toString('utf8'), 'two')
})

test('write over an existing file without sha maps 422 to RemoteConflictError', async () => {
  await remote.write('conflict.txt', Buffer.from('a'))
  await assert.rejects(
    () => remote.write('conflict.txt', Buffer.from('b')),
    (error) => {
      assert.ok(error instanceof RemoteConflictError)
      assert.equal(error.code, 'conflict')
      assert.equal(error.status, 422)
      assert.match(error.message, CJK)
      return true
    },
  )
  assert.equal((await remote.read('conflict.txt')).bytes.toString('utf8'), 'a')
})

test('write with a stale sha maps 409 to RemoteConflictError', async () => {
  const first = await remote.write('stale.txt', Buffer.from('a'))
  await remote.write('stale.txt', Buffer.from('b'), { etag: first.etag })
  await assert.rejects(
    () => remote.write('stale.txt', Buffer.from('c'), { etag: first.etag }),
    (error) => {
      assert.ok(error instanceof RemoteConflictError)
      assert.equal(error.status, 409)
      return true
    },
  )
})

test('write with a sha for a missing file maps 422 to RemoteConflictError', async () => {
  await assert.rejects(
    () => remote.write('ghost.txt', Buffer.from('x'), { etag: 'a'.repeat(40) }),
    (error) => {
      assert.ok(error instanceof RemoteConflictError)
      assert.equal(error.status, 422)
      return true
    },
  )
})

test('list returns direct children with root-relative paths; missing dir is []', async () => {
  await remote.write('manifest.json', Buffer.from('{}'))
  await remote.write('files/cordis.patch.yml', Buffer.from('x'))
  await remote.write('files/package.json', Buffer.from('yy'))

  const top = await remote.list('')
  assert.deepEqual(
    top.map((entry) => [entry.path, entry.isDir]),
    [
      ['files', true],
      ['manifest.json', false],
    ],
  )
  assert.equal(top[0].size, 0)
  assert.equal(top[1].size, 2)
  assert.match(top[1].etag, /^[0-9a-f]{40}$/)
  assert.equal('mtime' in top[1], false)

  const files = await remote.list('files')
  assert.deepEqual(
    files.map((entry) => [entry.name, entry.isDir, entry.size]),
    [
      ['cordis.patch.yml', false, 1],
      ['package.json', false, 2],
    ],
  )

  assert.deepEqual(await remote.list('no/such/dir'), [])
})

test('remove deletes a file and ignores a missing path', async () => {
  await remote.write('tmp/x.bin', Buffer.from('x'))
  await remote.remove('tmp/x.bin')
  assert.equal((await remote.read('tmp/x.bin')).found, false)
  assert.ok(!server.files.has(`${ROOT}/tmp/x.bin`))

  const deletesBefore = server.requests.filter((entry) => entry.method === 'DELETE').length
  await remote.remove('tmp/never.txt')
  assert.equal(server.requests.filter((entry) => entry.method === 'DELETE').length, deletesBefore)
})

test('remove with a stale sha maps 409 to RemoteConflictError', async () => {
  await remote.write('etag.txt', Buffer.from('a'))
  const stale = await remote.read('etag.txt')
  await remote.write('etag.txt', Buffer.from('b'), { etag: stale.etag })
  await assert.rejects(() => remote.remove('etag.txt', { etag: stale.etag }), RemoteConflictError)
  assert.ok(server.files.has(`${ROOT}/etag.txt`))
})

test('ensureDir is a no-op that sends no request', async () => {
  server.injectFailure({ status: 500, remaining: 4 })
  await remote.ensureDir('a/b/c')
  assert.equal(server.requests.length, 0, 'GitHub must not create directories explicitly')
})

test('rejects unsafe paths before any request', async () => {
  const badPaths = ['/abs.txt', '../escape.txt', 'a\\b.txt', 'a//b.txt', 'a/./b.txt', 'a/', 'C:/x.txt']

  for (const bad of badPaths) {
    await assert.rejects(() => remote.read(bad), RemotePathError, `read(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.write(bad, Buffer.from('x')), RemotePathError, `write(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.remove(bad), RemotePathError, `remove(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.list(bad), RemotePathError, `list(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.ensureDir(bad), RemotePathError, `ensureDir(${JSON.stringify(bad)})`)
  }
  assert.equal(server.requests.length, 0, 'no network request may be sent for unsafe paths')

  // '' means "the remote root": allowed for list/ensureDir, rejected for files.
  await assert.rejects(() => remote.read(''), RemotePathError)
  await assert.rejects(() => remote.write('', Buffer.from('x')), RemotePathError)
  await assert.rejects(() => remote.remove(''), RemotePathError)
  assert.equal(server.requests.length, 0)
  assert.deepEqual(await remote.list(''), [])
  await remote.ensureDir('')
})

test('maps 5xx responses to RemoteUnavailableError', async () => {
  server.injectFailure({ status: 502, payload: { message: 'bad gateway' } })
  await assert.rejects(
    () => remote.probe(),
    (error) => {
      assert.ok(error instanceof RemoteUnavailableError)
      assert.equal(error.status, 502)
      assert.match(error.message, CJK)
      return true
    },
  )

  server.injectFailure({ status: 500, payload: { message: 'boom' } })
  await assert.rejects(() => remote.read('manifest.json'), RemoteUnavailableError)

  server.injectFailure({ status: 500, payload: { message: 'boom' } })
  await assert.rejects(() => remote.list(''), RemoteUnavailableError)
})

test('maps network errors to RemoteUnavailableError', async () => {
  const dead = githubRemote({ apiUrl: await unreachableApiUrl(), timeoutMs: 3000 })
  await assert.rejects(
    () => dead.probe(),
    (error) => {
      assert.ok(error instanceof RemoteUnavailableError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, CJK)
      assert.ok(!error.message.includes(server.token))
      return true
    },
  )
})

test('treats an empty repository (409) as missing content', async () => {
  server.injectFailure({ status: 409, payload: { message: 'Git Repository is empty.' } })
  assert.deepEqual(await remote.read('manifest.json'), { found: false })
  server.injectFailure({ status: 409, payload: { message: 'Git Repository is empty.' } })
  assert.deepEqual(await remote.list(''), [])
})

test('read of a directory and list of a file are explicit errors', async () => {
  await remote.write('files/a.txt', Buffer.from('x'))
  await assert.rejects(
    () => remote.read('files'),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'not_a_file')
      return true
    },
  )
  await assert.rejects(
    () => remote.list('files/a.txt'),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'not_a_dir')
      return true
    },
  )
})

test('honours the configured branch and path prefix', async () => {
  const prefixed = githubRemote({ branch: 'sync-branch', path: 'team/cfg' })
  await prefixed.write('manifest.json', Buffer.from('{}'))
  assert.ok(server.files.has('team/cfg/manifest.json'))
  const getRequest = [...server.requests].reverse().find((entry) => entry.method === 'GET')
  if (getRequest !== undefined) assert.match(getRequest.search, /ref=sync-branch/)
  const putRequest = server.requests.find((entry) => entry.method === 'PUT')
  assert.equal(putRequest.body.branch, 'sync-branch')
})
