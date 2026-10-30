/**
 * Optional end-to-end encryption for the payloads stored on the remote.
 *
 * Every file is encrypted on its own: a fresh 16-byte salt for scrypt and a
 * fresh 12-byte IV per write, AES-256-GCM with the tag kept in the envelope.
 * The envelope is JSON so a human can see it is encrypted, and the manifest
 * keeps plaintext hashes so planning never needs the passphrase.
 *
 * @module @xiaokang6/dsh-config-sync/sync/crypto
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** Envelope version understood by this plugin. */
export const ENVELOPE_VERSION = 1
/** Cipher used for every payload. */
export const ENVELOPE_ALG = 'aes-256-gcm'
/** Key derivation parameters (memory ≈ 16 MiB). */
export const KDF = { name: 'scrypt', N: 16384, r: 8, p: 1, keyLength: 32 }
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** Whether a parsed JSON value looks like an encryption envelope. */
export function isEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const salt = value.kdf?.salt ?? value.salt
  return value.v === ENVELOPE_VERSION && value.alg === ENVELOPE_ALG
    && typeof value.data === 'string' && typeof value.iv === 'string'
    && typeof value.tag === 'string' && typeof salt === 'string'
}

/** Parse an envelope out of stored bytes; null when they are plaintext. */
export function parseEnvelope(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text)
    return isEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Encrypt one file's bytes into an envelope buffer.
 * @param {Buffer} plain - plaintext bytes.
 * @param {string} passphrase - user passphrase.
 * @returns {Buffer} JSON envelope, UTF-8, no BOM.
 */
export function encryptBytes(plain, passphrase) {
  if (typeof passphrase !== 'string' || passphrase === '') throw new Error('encryption is enabled but no passphrase is set')
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = scryptSync(passphrase, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM })
  const cipher = createCipheriv(ENVELOPE_ALG, key, iv, { authTagLength: TAG_BYTES })
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  }
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
}

/**
 * Decrypt an envelope buffer back to plaintext.
 * @param {Buffer} bytes - stored bytes (envelope or plaintext).
 * @param {string} passphrase - user passphrase.
 * @returns {Buffer} plaintext bytes.
 */
export function decryptBytes(bytes, passphrase) {
  const envelope = parseEnvelope(bytes)
  if (envelope === null) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new Error('remote data is encrypted but no passphrase is set (远端数据已加密，但本机没有设置口令)')
  }
  const salt = Buffer.from(envelope.kdf?.salt ?? envelope.salt, 'base64')
  const iv = Buffer.from(envelope.iv, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  const key = scryptSync(passphrase, salt, KDF.keyLength, {
    N: envelope.kdf?.N ?? KDF.N,
    r: envelope.kdf?.r ?? KDF.r,
    p: envelope.kdf?.p ?? KDF.p,
    maxmem: SCRYPT_MAXMEM,
  })
  try {
    const decipher = createDecipheriv(ENVELOPE_ALG, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
  } catch {
    throw new Error('could not decrypt remote data: wrong passphrase or corrupted payload (解密失败：口令不对或远端数据损坏)')
  }
}

/** True when the stored bytes are an encryption envelope. */
export function looksEncrypted(bytes) {
  return parseEnvelope(bytes) !== null
}
