/**
 * Unit tests for the AES-256-GCM envelope.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { decryptBytes, encryptBytes, isEnvelope, parseEnvelope } from '../../lib/sync/crypto.js'

test('encrypt/decrypt round-trips arbitrary bytes', () => {
  const plain = Buffer.from('模型配置：magpie + cline-pass\n', 'utf8')
  const envelope = encryptBytes(plain, 'correct horse battery staple')
  assert.ok(envelope.length > plain.length)
  const parsed = parseEnvelope(envelope)
  assert.ok(parsed !== null)
  assert.ok(isEnvelope(parsed))
  assert.equal(parsed.alg, 'aes-256-gcm')
  assert.deepEqual(decryptBytes(envelope, 'correct horse battery staple'), plain)
})

test('two writes use different salts and IVs', () => {
  const plain = Buffer.from('same content')
  const a = parseEnvelope(encryptBytes(plain, 'pw'))
  const b = parseEnvelope(encryptBytes(plain, 'pw'))
  assert.notEqual(a.kdf.salt, b.kdf.salt)
  assert.notEqual(a.iv, b.iv)
})

test('wrong passphrase fails with a clear message', () => {
  const envelope = encryptBytes(Buffer.from('secret config'), 'right')
  assert.throws(() => decryptBytes(envelope, 'wrong'), /wrong passphrase|口令不对|解密失败/iu)
})

test('plaintext bytes pass through untouched', () => {
  const plain = Buffer.from('plain')
  assert.deepEqual(decryptBytes(plain, ''), plain)
  assert.equal(parseEnvelope(plain), null)
})

test('encryption requires a passphrase', () => {
  assert.throws(() => encryptBytes(Buffer.from('x'), ''), /no passphrase/u)
})
