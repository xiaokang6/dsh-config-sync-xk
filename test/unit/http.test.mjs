/**
 * Tests for the same-origin guard used by every mutating route.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isOfficialDesktop, isSameOrigin, loopbackAuthority, readJsonBody, trustedAuthority } from '../../lib/http.js'

function request(headers) {
  return { headers }
}

const ctx = { get: () => undefined }
const ctxWithTrusted = { get: (name) => (name === 'connection' ? { trustedHosts: ['dsh.example.org:8080'] } : undefined) }

test('loopback authorities are recognized', () => {
  assert.equal(loopbackAuthority('127.0.0.1:51913'), true)
  assert.equal(loopbackAuthority('localhost'), true)
  assert.equal(loopbackAuthority('[::1]:3080'), true)
  assert.equal(loopbackAuthority('evil.com'), false)
  assert.equal(loopbackAuthority('localhost.evil.com'), false)
  assert.equal(loopbackAuthority(undefined), false)
})

test('declared trusted authorities are recognized', () => {
  assert.equal(trustedAuthority('dsh.example.org:8080', ['dsh.example.org:8080']), true)
  assert.equal(trustedAuthority('dsh.example.org:9090', ['dsh.example.org:8080']), false)
  assert.equal(trustedAuthority('dsh.example.org', ['dsh.example.org']), true)
  assert.equal(trustedAuthority('dsh.example.org:1', ['dsh.example.org']), true)
})

test('same-origin guard allows loopback and absent origin', () => {
  assert.equal(isSameOrigin(request({ host: '127.0.0.1:51913' }), ctx), true)
  assert.equal(isSameOrigin(request({ host: 'localhost:51913', origin: 'http://localhost:51913' }), ctx), true)
  assert.equal(isSameOrigin(request({ host: '127.0.0.1:51913' }), ctxWithTrusted), true)
  assert.equal(isSameOrigin(request({ host: 'dsh.example.org:8080' }), ctxWithTrusted), true)
})

test('same-origin guard refuses foreign, cross-site and mismatched origins', () => {
  assert.equal(isSameOrigin(request({ host: 'evil.com' }), ctx), false)
  assert.equal(isSameOrigin(request({ host: '127.0.0.1:51913', 'sec-fetch-site': 'cross-site' }), ctx), false)
  assert.equal(isSameOrigin(request({ host: '127.0.0.1:51913', origin: 'http://evil.com' }), ctx), false)
  assert.equal(isSameOrigin(request({ host: '127.0.0.1:51913', origin: 'null' }), ctx), false)
  assert.equal(isSameOrigin(request({ host: 'dsh.example.org' }), ctxWithTrusted), false)
})

test('the official Desktop host is detected so its gate is skipped', () => {
  assert.equal(isOfficialDesktop({ get: (name) => (name === 'pluginManager' ? {} : undefined) }), true)
  const argvFallback = /dsh-desktop-host/u.test(process.argv.join(' '))
  assert.equal(isOfficialDesktop({ get: () => undefined }), argvFallback)
  assert.equal(isOfficialDesktop({ get: () => { throw new Error('no service') } }), argvFallback)
})

test('readJsonBody parses and caps bodies', async () => {
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"a":1}')
    },
  }
  assert.deepEqual(await readJsonBody(body), { a: 1 })
  const empty = {
    async *[Symbol.asyncIterator]() {},
  }
  assert.deepEqual(await readJsonBody(empty), {})
  await assert.rejects(readJsonBody({
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{')
    },
  }), /not valid JSON/u)
})
