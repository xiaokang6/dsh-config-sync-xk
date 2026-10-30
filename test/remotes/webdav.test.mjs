// WebDAV adapter contract tests against the in-memory mock server.
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
import { createMockWebdav } from '../../lib/sync/remotes/mock/webdav-server.js'

const ROOT = 'dsh-config-sync/desktop'
const CJK = /[\u4e00-\u9fff]/
const SECRET_PASSWORD = 'hunter2-secret'
/** Documented probe detail when the remote root does not exist yet. */
const ROOT_MISSING_DETAIL =
  '远端根目录尚不存在（首次同步会自动创建） / remote root does not exist yet (first sync will create it)'

/** @type {Awaited<ReturnType<typeof createMockWebdav>>} */
let server
/** @type {ReturnType<typeof createRemote>} */
let remote

before(async () => {
  server = await createMockWebdav()
  remote = createRemote({
    kind: 'webdav',
    baseUrl: server.url,
    username: server.username,
    password: server.password,
    path: ROOT,
  })
})

after(async () => {
  await server?.close()
})

beforeEach(() => {
  server.reset()
})

/** A URL that is guaranteed to refuse connections (bind, then release the port). */
async function unreachableUrl() {
  const temporary = await createMockWebdav()
  const { port } = new URL(temporary.url)
  await temporary.close()
  return `http://127.0.0.1:${port}/dav/`
}

function webdavRemote(overrides = {}) {
  return createRemote({
    kind: 'webdav',
    baseUrl: server.url,
    username: server.username,
    password: server.password,
    path: ROOT,
    ...overrides,
  })
}

test('exposes the documented remote shape', () => {
  assert.equal(remote.kind, 'webdav')
  assert.equal(remote.label, '坚果云 WebDAV')
  assert.equal(remote.root, `${server.url.replace(/\/+$/, '')}/${ROOT}`)
  for (const method of ['probe', 'read', 'write', 'remove', 'list', 'ensureDir']) {
    assert.equal(typeof remote[method], 'function', `${method} must be a function`)
  }
  assert.ok(!remote.root.includes(server.password))
})

test('probe reports ok on a reachable DAV root', async () => {
  await remote.ensureDir('')
  const result = await remote.probe()
  assert.equal(result.ok, true)
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok(result.latencyMs >= 0)
  assert.equal(result.detail, '')
})

test('probe reports ok:false (not a throw) when the remote root is missing', async () => {
  const result = await remote.probe()
  assert.equal(result.ok, false)
  assert.equal(result.detail, ROOT_MISSING_DETAIL)
  assert.match(result.detail, CJK)
  assert.match(result.detail, /root/i)
  assert.ok(!result.detail.includes(server.password))
})

test('treats 坚果云 409 AncestorsNotFound as "missing" for probe/read/list/remove and still writes through it', async (t) => {
  // Emulate 坚果云/SabreDAV: a deep path whose ancestors are missing answers
  // 409 + AncestorsNotFound XML instead of 404.
  const nutstore = await createMockWebdav({ ancestorsNotFound: true })
  t.after(async () => {
    await nutstore.close()
  })
  const adapter = createRemote({
    kind: 'webdav',
    baseUrl: nutstore.url,
    username: nutstore.username,
    password: nutstore.password,
    path: ROOT,
  })

  // Configured root directory does not exist yet (path like dsh-config-sync/desktop).
  const probed = await adapter.probe()
  assert.equal(probed.ok, false, 'a missing root is not an error for probe()')
  assert.equal(probed.detail, ROOT_MISSING_DETAIL)

  assert.deepEqual(await adapter.read('manifest.json'), { found: false })
  assert.deepEqual(await adapter.read('files/package.json'), { found: false })
  assert.deepEqual(await adapter.list(''), [])
  assert.deepEqual(await adapter.list('files'), [])
  await adapter.remove('files/never.txt') // a missing path is a no-op, even as 409

  // write() must MKCOL every missing ancestor, including the configured root prefix.
  const written = await adapter.write('files/manifest.json', Buffer.from('{"schema":1}'))
  assert.equal(typeof written.etag, 'string')
  assert.ok(nutstore.dirs.has('dsh-config-sync'), 'the first root segment must be created')
  assert.ok(nutstore.dirs.has(ROOT), 'the configured root prefix must be created')
  assert.ok(nutstore.dirs.has(`${ROOT}/files`), 'the payload parent directory must be created')
  assert.ok(nutstore.files.has(`${ROOT}/files/manifest.json`))

  // Once the root exists, the 409s are gone.
  assert.equal((await adapter.probe()).ok, true)
  const roundtrip = await adapter.read('files/manifest.json')
  assert.equal(roundtrip.found, true)
  assert.equal(roundtrip.bytes.toString('utf8'), '{"schema":1}')
  assert.deepEqual((await adapter.list('')).map((entry) => [entry.path, entry.isDir]), [['files', true]])

  // Any other 409 (lock conflict) keeps its error semantics.
  nutstore.injectFailure({ status: 409, body: 'LockConflict: the resource is locked' })
  await assert.rejects(
    () => adapter.read('files/manifest.json'),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.status, 409)
      assert.match(error.message, CJK)
      return true
    },
  )
  nutstore.injectFailure({ status: 409, body: 'LockConflict: the resource is locked' })
  await assert.rejects(() => adapter.list('files'), (error) => error instanceof RemoteError && error.status === 409)
  nutstore.injectFailure({ status: 409, body: 'LockConflict: the resource is locked' })
  await assert.rejects(() => adapter.remove('files/manifest.json'), (error) => error instanceof RemoteError && error.status === 409)
})

test('probe throws RemoteAuthError for a wrong password', async () => {
  const bad = webdavRemote({ password: `${server.password}-wrong` })
  await assert.rejects(
    () => bad.probe(),
    (error) => {
      assert.ok(error instanceof RemoteAuthError)
      assert.ok(error instanceof RemoteError)
      assert.equal(error.name, 'RemoteAuthError')
      assert.equal(error.code, 'auth')
      assert.equal(error.status, 401)
      assert.match(error.message, CJK)
      assert.match(error.message, /HTTP 401/)
      assert.ok(!error.message.includes(`${server.password}-wrong`))
      assert.ok(!error.message.includes('Basic '))
      return true
    },
  )
})

test('read throws RemoteAuthError (not found:false) for bad credentials', async () => {
  const bad = webdavRemote({ username: 'nobody' })
  await assert.rejects(() => bad.read('manifest.json'), RemoteAuthError)
})

test('read returns { found: false } for a missing file', async () => {
  assert.deepEqual(await remote.read('missing.txt'), { found: false })
})

test('write auto-creates parent directories and read round-trips the bytes', async () => {
  const payload = Buffer.from('schema: 1\nprofile: desktop\n', 'utf8')
  const written = await remote.write('files/a/config.yml', payload)
  assert.equal(typeof written.etag, 'string')
  assert.ok(written.etag.length > 0)
  assert.equal(typeof written.mtime, 'number')

  assert.ok(server.files.has(`${ROOT}/files/a/config.yml`))
  assert.ok(server.dirs.has(`${ROOT}/files/a`))

  const read = await remote.read('files/a/config.yml')
  assert.equal(read.found, true)
  assert.ok(Buffer.isBuffer(read.bytes))
  assert.deepEqual(read.bytes, payload)
  assert.equal(read.etag, written.etag)
  assert.equal(typeof read.mtime, 'number')
})

test('write with the current etag updates the file and returns a fresh etag', async () => {
  await remote.write('notes.txt', Buffer.from('one'))
  const first = await remote.read('notes.txt')
  const updated = await remote.write('notes.txt', Buffer.from('two'), { etag: first.etag })
  assert.equal(typeof updated.etag, 'string')
  assert.notEqual(updated.etag, first.etag)
  assert.equal((await remote.read('notes.txt')).bytes.toString('utf8'), 'two')
})

test('write with a stale etag throws RemoteConflictError', async () => {
  await remote.write('conflict.txt', Buffer.from('a'))
  const stale = await remote.read('conflict.txt')
  await remote.write('conflict.txt', Buffer.from('b'))
  await assert.rejects(
    () => remote.write('conflict.txt', Buffer.from('c'), { etag: stale.etag }),
    (error) => {
      assert.ok(error instanceof RemoteConflictError)
      assert.equal(error.code, 'conflict')
      assert.equal(error.status, 412)
      assert.match(error.message, CJK)
      return true
    },
  )
  assert.equal((await remote.read('conflict.txt')).bytes.toString('utf8'), 'b')
})

test('list returns direct children only, with type, size and etag', async () => {
  await remote.write('manifest.json', Buffer.from('{}'))
  await remote.write('files/cordis.patch.yml', Buffer.from('x'))
  await remote.write('files/package.json', Buffer.from('yy'))
  await remote.write('files/nested/deep.txt', Buffer.from('zzz'))

  const top = await remote.list('')
  assert.deepEqual(top.map((entry) => entry.path), ['files', 'manifest.json'])
  assert.equal(top[0].isDir, true)
  assert.equal(top[0].size, 0)
  assert.equal(top[1].isDir, false)
  assert.equal(top[1].size, 2)

  const files = await remote.list('files')
  assert.deepEqual(
    files.map((entry) => [entry.name, entry.isDir, entry.size]),
    [
      ['cordis.patch.yml', false, 1],
      ['nested', true, 0],
      ['package.json', false, 2],
    ],
  )
  assert.match(files[0].etag, /^"/)
  assert.equal(typeof files[0].mtime, 'number')
})

test('list of a missing directory is []', async () => {
  assert.deepEqual(await remote.list('no/such/dir'), [])
})

test('remove deletes a file and ignores a missing path', async () => {
  await remote.write('tmp/x.bin', Buffer.from('x'))
  await remote.remove('tmp/x.bin')
  assert.equal((await remote.read('tmp/x.bin')).found, false)
  assert.ok(!server.files.has(`${ROOT}/tmp/x.bin`))
  await remote.remove('tmp/never.txt')
})

test('remove with a stale etag throws RemoteConflictError', async () => {
  await remote.write('etag-remove.txt', Buffer.from('a'))
  const stale = await remote.read('etag-remove.txt')
  await remote.write('etag-remove.txt', Buffer.from('b'))
  await assert.rejects(() => remote.remove('etag-remove.txt', { etag: stale.etag }), RemoteConflictError)
  assert.ok(server.files.has(`${ROOT}/etag-remove.txt`))
})

test('ensureDir is idempotent and creates every level', async () => {
  await remote.ensureDir('a/b/c')
  await remote.ensureDir('a/b/c')
  assert.ok(server.dirs.has(`${ROOT}/a/b/c`))

  const listed = await remote.list('a/b')
  assert.deepEqual(listed.map((entry) => [entry.name, entry.isDir]), [['c', true]])

  const top = await remote.list('')
  assert.deepEqual(top.map((entry) => [entry.path, entry.isDir]), [['a', true]])
})

test('rejects unsafe paths before any request', async () => {
  const before = server.requests.length
  const badPaths = ['/abs.txt', '../escape.txt', 'a/../../escape.txt', 'a\\b.txt', 'a//b.txt', 'a/./b.txt', 'a/', 'C:/x.txt', '\u0000']

  for (const bad of badPaths) {
    await assert.rejects(() => remote.read(bad), RemotePathError, `read(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.write(bad, Buffer.from('x')), RemotePathError, `write(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.remove(bad), RemotePathError, `remove(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.list(bad), RemotePathError, `list(${JSON.stringify(bad)})`)
    await assert.rejects(() => remote.ensureDir(bad), RemotePathError, `ensureDir(${JSON.stringify(bad)})`)
  }
  await assert.rejects(() => remote.read(42), RemotePathError)
  await assert.rejects(() => remote.ensureDir('../x'), RemotePathError)

  assert.equal(server.requests.length, before, 'no network request may be sent for unsafe paths')

  // '' means "the remote root": allowed for list/ensureDir, rejected for files.
  await assert.rejects(() => remote.read(''), RemotePathError)
  await assert.rejects(() => remote.write('', Buffer.from('x')), RemotePathError)
  await assert.rejects(() => remote.remove(''), RemotePathError)
  assert.equal(server.requests.length, before)
  assert.deepEqual(await remote.list(''), [])
  await remote.ensureDir('')
})

test('maps 5xx responses to RemoteUnavailableError', async () => {
  await remote.ensureDir('')
  await remote.write('roundtrip.bin', Buffer.from('ok'))

  server.injectFailure({ status: 503, body: 'backend down' })
  await assert.rejects(
    () => remote.probe(),
    (error) => {
      assert.ok(error instanceof RemoteUnavailableError)
      assert.equal(error.status, 503)
      assert.match(error.message, CJK)
      return true
    },
  )

  server.injectFailure({ status: 500, body: 'boom' })
  await assert.rejects(() => remote.read('roundtrip.bin'), RemoteUnavailableError)

  server.injectFailure({ status: 500, body: 'boom' })
  await assert.rejects(() => remote.list(''), RemoteUnavailableError)

  server.injectFailure({ status: 500, body: 'boom', match: 'roundtrip.bin' })
  await assert.rejects(() => remote.write('roundtrip.bin', Buffer.from('again')), RemoteUnavailableError)
})

test('maps network errors to RemoteUnavailableError', async () => {
  const dead = createRemote({
    kind: 'webdav',
    baseUrl: await unreachableUrl(),
    username: 'user',
    password: 'secret',
    path: ROOT,
    timeoutMs: 3000,
  })
  await assert.rejects(
    () => dead.probe(),
    (error) => {
      assert.ok(error instanceof RemoteUnavailableError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, CJK)
      assert.ok(!error.message.includes('secret'))
      return true
    },
  )
  await assert.rejects(() => dead.read('manifest.json'), RemoteUnavailableError)
})

test('works with a baseUrl that has no trailing slash', async () => {
  await remote.write('slash.txt', Buffer.from('ok'))
  const noSlash = webdavRemote({ baseUrl: server.url.replace(/\/+$/, '') })
  const entry = await noSlash.read('slash.txt')
  assert.equal(entry.found, true)
  assert.equal(entry.bytes.toString('utf8'), 'ok')
})

test('works when the base URL path contains percent-encoded characters', async () => {
  const other = await createMockWebdav({ basePath: '/dav%20x' })
  try {
    const adapter = createRemote({
      kind: 'webdav',
      baseUrl: other.url,
      username: other.username,
      password: other.password,
      path: ROOT,
    })
    await adapter.write('files/a.txt', Buffer.from('encoded'))
    const listed = await adapter.list('')
    assert.deepEqual(listed.map((entry) => [entry.path, entry.isDir]), [['files', true]])
    assert.equal((await adapter.read('files/a.txt')).bytes.toString('utf8'), 'encoded')
  } finally {
    await other.close()
  }
})

test('parses D: and default-namespace multistatus bodies', async () => {
  for (const xmlPrefix of ['D', '']) {
    const other = await createMockWebdav({ xmlPrefix })
    try {
      const adapter = createRemote({
        kind: 'webdav',
        baseUrl: other.url,
        username: other.username,
        password: other.password,
        path: ROOT,
      })
      await adapter.write('ns/manifest.json', Buffer.from('{"a":1}'))
      const listed = await adapter.list('ns')
      assert.deepEqual(listed.map((entry) => entry.name), ['manifest.json'], `xmlPrefix=${JSON.stringify(xmlPrefix)}`)
      const read = await adapter.read('ns/manifest.json')
      assert.equal(read.bytes.toString('utf8'), '{"a":1}')
      assert.match(read.etag, /^"/)
    } finally {
      await other.close()
    }
  }
})

test('error objects expose code/status/detail and never contain credentials', async () => {
  const bad = webdavRemote({ password: SECRET_PASSWORD })
  let caught
  try {
    await bad.probe()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof RemoteError)
  assert.equal(caught.code, 'auth')
  assert.equal(caught.status, 401)
  const serialized = JSON.stringify(caught.toJSON())
  assert.ok(!serialized.includes(SECRET_PASSWORD))
  assert.ok(!serialized.includes('Basic '))
})
