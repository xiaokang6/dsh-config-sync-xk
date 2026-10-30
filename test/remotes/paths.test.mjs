// Shared remote-layer helpers: path validation, URL joining, redaction,
// timeouts, HTTP/XML parsing and adapter construction guards.
// Run: node --test test/remotes/

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RemoteAuthError,
  RemoteConflictError,
  RemoteError,
  RemotePathError,
  RemoteUnavailableError,
  createRemote,
} from '../../lib/sync/remotes/index.js'
import { parseDavMultistatus } from '../../lib/sync/remotes/webdav.js'
import {
  DEFAULT_TIMEOUT_MS,
  basicAuth,
  joinUrl,
  mapStatusError,
  normalizeRelPath,
  parseHttpDate,
  redact,
  resolveTimeoutMs,
  shortBody,
  toBuffer,
} from '../../lib/sync/remotes/util.js'

const CJK = /[\u4e00-\u9fff]/

// ---------------------------------------------------------------------------
// normalizeRelPath
// ---------------------------------------------------------------------------

test('normalizeRelPath accepts POSIX paths relative to the remote root', () => {
  for (const path of [
    'a.txt',
    'files/package.json',
    'a b/c-d_e.f',
    'files/中文.yml',
    '.hidden/config',
    'manifest.json',
    'a/b/c/d/e',
  ]) {
    assert.equal(normalizeRelPath(path), path)
  }
})

test('normalizeRelPath rejects absolute, traversal and malformed paths', () => {
  const bad = [
    '',
    '/abs.txt',
    '\\\\server\\share',
    'a\\b.txt',
    '..',
    '../escape.txt',
    'a/../b',
    'a/..',
    '.',
    'a/./b',
    'a//b',
    'a/',
    '//a',
    'C:/x.txt',
    'c:relative',
    'a\u0000b',
    '\uD800',
  ]
  for (const path of bad) {
    assert.throws(() => normalizeRelPath(path), RemotePathError, JSON.stringify(path))
  }
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.throws(() => normalizeRelPath(value), RemotePathError)
  }
})

test('normalizeRelPath allowEmpty maps the remote root to ""', () => {
  assert.equal(normalizeRelPath('', { allowEmpty: true }), '')
  assert.equal(normalizeRelPath('.', { allowEmpty: true }), '')
  assert.equal(normalizeRelPath('./', { allowEmpty: true }), '')
  assert.equal(normalizeRelPath('a/b', { allowEmpty: true }), 'a/b')
  assert.throws(() => normalizeRelPath('/a', { allowEmpty: true }), RemotePathError)
  assert.throws(() => normalizeRelPath(undefined, { allowEmpty: true }), RemotePathError)
})

test('RemotePathError is a RemoteError with code "path" and a bilingual message', () => {
  assert.throws(
    () => normalizeRelPath('../x'),
    (error) => {
      assert.ok(error instanceof RemotePathError)
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'path')
      assert.equal(error.name, 'RemotePathError')
      assert.match(error.message, CJK)
      assert.match(error.message, /unsafe remote path|must not/i)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// joinUrl
// ---------------------------------------------------------------------------

test('joinUrl keeps a single slash and encodes every segment', () => {
  const base = 'https://dav.jianguoyun.com/dav/'
  assert.equal(joinUrl(base, 'a', 'b'), 'https://dav.jianguoyun.com/dav/a/b')
  assert.equal(joinUrl('https://dav.jianguoyun.com/dav', 'a'), 'https://dav.jianguoyun.com/dav/a')
  assert.equal(joinUrl('https://dav.jianguoyun.com/dav/', 'a/b/c'), 'https://dav.jianguoyun.com/dav/a/b/c')
  assert.equal(joinUrl('https://host', 'a b/c#d?e%'), 'https://host/a%20b/c%23d%3Fe%25')
  assert.equal(joinUrl('https://host', '文件/说明.txt'), 'https://host/%E6%96%87%E4%BB%B6/%E8%AF%B4%E6%98%8E.txt')
  assert.equal(joinUrl('https://host', 'a//b'), 'https://host/a/b')
  assert.equal(joinUrl('https://host/', ''), 'https://host')
  assert.equal(`${joinUrl('https://host', '')}/`, 'https://host/')
  assert.equal(joinUrl('https://host', 'dsh-config-sync', 'desktop', 'manifest.json'), 'https://host/dsh-config-sync/desktop/manifest.json')
})

test('joinUrl refuses a missing base', () => {
  assert.throws(() => joinUrl('', 'a'), RemoteError)
  assert.throws(() => joinUrl(undefined, 'a'), RemoteError)
})

// ---------------------------------------------------------------------------
// basicAuth / timeouts / buffers / dates
// ---------------------------------------------------------------------------

test('basicAuth encodes UTF-8 credentials', () => {
  assert.equal(basicAuth('user', 'pass'), `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`)
  assert.equal(basicAuth('me@example.com', 'app-pass'), `Basic ${Buffer.from('me@example.com:app-pass', 'utf8').toString('base64')}`)
  assert.equal(basicAuth('用户', '密码'), `Basic ${Buffer.from('用户:密码', 'utf8').toString('base64')}`)
  assert.match(basicAuth('', ''), /^Basic /)
})

test('resolveTimeoutMs defaults to 15s and honours overrides', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
  assert.equal(resolveTimeoutMs(undefined), 15_000)
  assert.equal(resolveTimeoutMs({}), 15_000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 1000 }), 1000)
  assert.equal(resolveTimeoutMs(2500), 2500)
  assert.equal(resolveTimeoutMs({ timeoutMs: 0 }), 15_000)
  assert.equal(resolveTimeoutMs({ timeoutMs: -5 }), 15_000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 'nope' }), 15_000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 10 ** 9 }), 600_000)
})

test('toBuffer accepts the supported payload types', () => {
  const buffer = Buffer.from('abc')
  assert.equal(toBuffer(buffer), buffer)
  const bytes = new Uint8Array([1, 2, 3])
  assert.deepEqual(toBuffer(bytes), Buffer.from([1, 2, 3]))
  assert.deepEqual(toBuffer(bytes.buffer), Buffer.from([1, 2, 3]))
  assert.deepEqual(toBuffer('中文'), Buffer.from('中文', 'utf8'))
  assert.throws(
    () => toBuffer({ not: 'bytes' }),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'bad_payload')
      return true
    },
  )
})

test('parseHttpDate returns epoch milliseconds or undefined', () => {
  assert.equal(parseHttpDate('Wed, 21 Oct 2015 07:28:00 GMT'), Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))
  assert.equal(parseHttpDate(''), undefined)
  assert.equal(parseHttpDate(undefined), undefined)
  assert.equal(parseHttpDate('not a date'), undefined)
})

test('shortBody collapses whitespace and caps long bodies', () => {
  assert.equal(shortBody('  a\n\n b\tc  '), 'a b c')
  assert.equal(shortBody(undefined), '')
  const long = 'x'.repeat(500)
  const capped = shortBody(long)
  assert.ok(capped.length <= 201)
  assert.ok(capped.endsWith('…'))
})

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

test('redact masks secrets in objects without mutating them', () => {
  const input = {
    kind: 'webdav',
    baseUrl: 'https://dav.example.com/dav/',
    username: 'me@example.com',
    password: 'hunter2',
    token: 'ghp_secret_token',
    authorization: 'Bearer abc123',
    hasPassword: true,
    path: 'dsh-config-sync/desktop',
    nested: { apiKey: 'k-1', passphrase: 'p-1', note: 'keep me' },
  }
  const output = redact(input)
  assert.equal(output.password, '***')
  assert.equal(output.token, '***')
  assert.equal(output.authorization, '***')
  assert.equal(output.nested.apiKey, '***')
  assert.equal(output.nested.passphrase, '***')
  assert.equal(output.nested.note, 'keep me')
  assert.equal(output.username, 'me@example.com')
  assert.equal(output.hasPassword, true)
  assert.equal(output.baseUrl, 'https://dav.example.com/dav/')
  assert.equal(input.password, 'hunter2', 'redact must not mutate its input')
})

test('redact masks secrets inside strings', () => {
  assert.equal(redact('authorization: Bearer abc.def-123'), 'authorization: ***')
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: ***')
  assert.equal(redact('https://user:p%40ss@dav.example.com/dav/'), 'https://user:***@dav.example.com/dav/')
  assert.equal(redact('password=hunter2&token=abc'), 'password=***')
  assert.equal(redact('plain text'), 'plain text')
})

test('redact handles buffers, arrays, null and errors', () => {
  assert.equal(redact(Buffer.from('secret')), '<bytes>')
  assert.deepEqual(redact(['token', { token: 'x' }]), ['token', { token: '***' }])
  assert.equal(redact(null), null)
  assert.equal(redact(undefined), undefined)
  assert.equal(redact({ password: '' }).password, '')
  const error = redact(new Error('request failed with token=abc123'))
  assert.equal(error.name, 'Error')
  assert.ok(!error.message.includes('abc123'))
  assert.match(error.message, /\*\*\*/)
})

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

test('remote error classes carry code/status/detail and bilingual messages', () => {
  const cases = [
    [new RemoteError('基础错误 / base error'), 'remote_error'],
    [new RemoteAuthError('认证失败 / auth failed', { status: 401, detail: 'unauthorized' }), 'auth'],
    [new RemoteConflictError('冲突 / conflict', { status: 412 }), 'conflict'],
    [new RemotePathError('路径错误 / bad path'), 'path'],
    [new RemoteUnavailableError('不可用 / unavailable', { status: 503 }), 'unavailable'],
  ]
  for (const [error, code] of cases) {
    assert.ok(error instanceof RemoteError)
    assert.equal(error.code, code)
    assert.match(error.message, CJK)
    assert.match(error.message, /[A-Za-z]/)
    const json = JSON.parse(JSON.stringify(error.toJSON()))
    assert.equal(json.code, code)
    assert.equal(json.name, error.name)
    if (error.status !== undefined) assert.equal(json.status, error.status)
  }
  const auth = new RemoteAuthError('认证失败 / auth failed', { status: 401, detail: 'd' })
  assert.equal(auth.name, 'RemoteAuthError')
  assert.equal(auth.status, 401)
  assert.equal(auth.detail, 'd')
})

test('mapStatusError maps statuses onto the right subclass', () => {
  assert.ok(mapStatusError(401, { service: 'X', serviceEn: 'X' }) instanceof RemoteAuthError)
  assert.ok(mapStatusError(403, { service: 'X', serviceEn: 'X' }) instanceof RemoteAuthError)
  assert.ok(mapStatusError(500, { service: 'X', serviceEn: 'X' }) instanceof RemoteUnavailableError)
  assert.ok(mapStatusError(429, { service: 'X', serviceEn: 'X' }) instanceof RemoteUnavailableError)
  assert.equal(mapStatusError(404, { service: 'X', serviceEn: 'X' }).code, 'not_found')
  assert.equal(mapStatusError(400, { service: 'X', serviceEn: 'X' }).code, 'remote_error')
  const withDetail = mapStatusError(503, { service: 'WebDAV', serviceEn: 'WebDAV', detail: 'backend down' })
  assert.match(withDetail.message, /backend down/)
  assert.equal(withDetail.detail, 'backend down')
})

// ---------------------------------------------------------------------------
// createRemote guards (no network calls)
// ---------------------------------------------------------------------------

test('createRemote exposes the documented shape and rejects unknown kinds', () => {
  const webdav = createRemote({ kind: 'webdav', baseUrl: 'https://dav.example.com/dav/', username: 'u', password: 'p', path: 'a/b' })
  assert.equal(webdav.kind, 'webdav')
  assert.equal(webdav.label, '坚果云 WebDAV')
  assert.equal(webdav.root, 'https://dav.example.com/dav/a/b')

  const github = createRemote({ kind: 'github', owner: 'o', repo: 'r', token: 't', path: 'a/b' })
  assert.equal(github.kind, 'github')
  assert.equal(github.label, 'GitHub')
  assert.match(github.root, /api\.github\.com\/repos\/o\/r\/contents\/a\/b\?ref=main$/)

  assert.throws(
    () => createRemote({ kind: 'ftp' }),
    (error) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'unsupported_kind')
      assert.match(error.message, CJK)
      return true
    },
  )
  assert.throws(() => createRemote({}), RemoteError)
  assert.throws(() => createRemote(null), RemoteError)
})

test('createRemote validates WebDAV settings', () => {
  assert.throws(() => createRemote({ kind: 'webdav' }), (error) => error instanceof RemoteError && error.code === 'config')
  assert.throws(() => createRemote({ kind: 'webdav', baseUrl: 'not-a-url' }), RemoteError)
  assert.throws(() => createRemote({ kind: 'webdav', baseUrl: 'ftp://host/dav/' }), RemoteError)
  assert.throws(() => createRemote({ kind: 'webdav', baseUrl: 'https://host/dav/?x=1' }), RemoteError)
  assert.throws(
    () => createRemote({ kind: 'webdav', baseUrl: 'https://host/dav/', path: '../escape' }),
    RemotePathError,
  )
  const rootless = createRemote({ kind: 'webdav', baseUrl: 'https://dav.example.com/dav/', username: 'u', password: 'p' })
  assert.equal(rootless.root, 'https://dav.example.com/dav')
})

test('createRemote validates GitHub settings', () => {
  assert.throws(() => createRemote({ kind: 'github', repo: 'r', token: 't' }), (error) => error instanceof RemoteError && error.code === 'config')
  assert.throws(() => createRemote({ kind: 'github', owner: 'o', token: 't' }), RemoteError)
  assert.throws(() => createRemote({ kind: 'github', owner: 'o', repo: 'r', token: 't', apiUrl: 'nope' }), RemoteError)
  assert.throws(() => createRemote({ kind: 'github', owner: 'o', repo: 'r', token: 't', path: 'a\\b' }), RemotePathError)
  const defaults = createRemote({ kind: 'github', owner: 'o', repo: 'r', token: 't' })
  assert.match(defaults.root, /ref=main$/)
})

// ---------------------------------------------------------------------------
// WebDAV XML parsing
// ---------------------------------------------------------------------------

test('parseDavMultistatus tolerates d:, D: and default-namespace bodies', () => {
  const bodies = [
    `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/root/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>root</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/root/a%20b.txt</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>12</d:getcontentlength>
      <d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified>
      <d:getetag>&quot;etag-1&quot;</d:getetag>
      <d:displayname>a b.txt</d:displayname>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`,
    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/root/a%20b.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>12</D:getcontentlength><D:getetag>"etag-1"</D:getetag></D:prop></D:propstat></D:response></D:multistatus>`,
    `<multistatus xmlns="DAV:"><response><href>/dav/root/a%20b.txt</href><propstat><prop><resourcetype/><getcontentlength>12</getcontentlength><getetag>"etag-1"</getetag></prop></propstat></response></multistatus>`,
  ]

  for (const body of bodies) {
    const entries = parseDavMultistatus(body)
    assert.ok(entries.length >= 1)
    const file = entries.find((entry) => entry.pathname.endsWith('a b.txt'))
    assert.ok(file, 'the percent-encoded href must be decoded')
    assert.equal(file.isDir, false)
    assert.equal(file.size, 12)
    assert.equal(file.etag, '"etag-1"')
    if (entries.length === 2) {
      const root = entries[0]
      assert.equal(root.isDir, true)
      assert.equal(root.pathname, '/dav/root/')
    }
  }
})

test('parseDavMultistatus handles absolute URLs, entities and garbage', () => {
  const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response>
  <d:href>https://dav.example.com/dav/x?a=1&amp;b=2</d:href>
  <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>0</d:getcontentlength></d:prop></d:propstat>
</d:response></d:multistatus>`
  const [entry] = parseDavMultistatus(body)
  assert.equal(entry.pathname, '/dav/x')
  assert.equal(entry.size, 0)
  assert.deepEqual(parseDavMultistatus(''), [])
  assert.deepEqual(parseDavMultistatus('<html>not dav</html>'), [])
})
