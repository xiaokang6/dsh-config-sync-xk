/**
 * Unit tests for the manifest helpers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SCOPE,
  buildManifest,
  normalizeScope,
  normalizeRel,
  parseManifest,
  remoteFileFor,
  serializeManifest,
  sha256Hex,
} from '../../lib/sync/manifest.js'

test('sha256Hex is stable', () => {
  assert.equal(sha256Hex(Buffer.from('hello')), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
})

test('normalizeRel rejects traversal and reserved trees', () => {
  assert.equal(normalizeRel('cordis.patch.yml'), 'cordis.patch.yml')
  assert.equal(normalizeRel('sub/dir/file.json'), 'sub/dir/file.json')
  assert.equal(normalizeRel('../evil'), null)
  assert.equal(normalizeRel('/abs'), null)
  assert.equal(normalizeRel('a/../b'), null)
  assert.equal(normalizeRel('node_modules/x'), null)
  assert.equal(normalizeRel(''), null)
  assert.equal(normalizeRel('a\\b'), 'a/b')
})

test('normalizeScope de-duplicates and validates', () => {
  const scope = normalizeScope(['package.json', 'package.json', 'cordis.patch.yml'])
  assert.deepEqual(scope, ['package.json', 'cordis.patch.yml'])
  assert.deepEqual(normalizeScope(undefined), DEFAULT_SCOPE)
  assert.throws(() => normalizeScope(['../secret']), /invalid sync scope/u)
})

test('manifest round-trips through serialize/parse', () => {
  const bytes = Buffer.from('{"a":1}\n')
  const manifest = buildManifest({
    profile: 'desktop',
    device: { id: 'dev-1', name: 'laptop' },
    cryptoEnabled: false,
    files: { 'package.json': { sha256: sha256Hex(bytes), size: bytes.length, etag: 'e1' } },
  })
  const parsed = parseManifest(serializeManifest(manifest))
  assert.equal(parsed.profile, 'desktop')
  assert.equal(parsed.deviceId, 'dev-1')
  assert.equal(parsed.crypto.enabled, false)
  assert.equal(parsed.files['package.json'].sha256, sha256Hex(bytes))
  assert.equal(parsed.files['package.json'].remotePath, remoteFileFor('package.json'))
  assert.equal(parsed.files['package.json'].etag, 'e1')
})

test('parseManifest rejects unsafe or malformed documents', () => {
  const good = buildManifest({
    profile: 'p',
    device: { id: 'd', name: 'n' },
    cryptoEnabled: true,
    files: { 'cordis.yml': { sha256: 'a'.repeat(64), size: 3 } },
  })
  assert.equal(parseManifest(JSON.stringify(good)).crypto.enabled, true)
  assert.throws(() => parseManifest('not json'), /not valid JSON/u)
  assert.throws(() => parseManifest(JSON.stringify({ schema: 99 })), /unsupported remote manifest schema/u)
  assert.throws(() => parseManifest(JSON.stringify({ ...good, files: { '../x': { sha256: 'a'.repeat(64), size: 1 } } })), /unsafe path/u)
  assert.throws(() => parseManifest(JSON.stringify({ ...good, files: { 'cordis.yml': { sha256: 'nope', size: 1 } } })), /invalid sha256/u)
})
