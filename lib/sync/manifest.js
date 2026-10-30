/**
 * Sync manifest: what the remote currently stores, per file.
 *
 * The manifest is the only shared truth about the remote side. It carries the
 * *plaintext* hash of every synced file (so a local hash comparison never needs
 * to download or decrypt anything to build a plan), plus the stored path and,
 * when available, the backend's opaque etag used for optimistic concurrency.
 *
 * @module dsh-config-sync/sync/manifest
 */

import { createHash } from 'node:crypto'

/** Manifest schema version understood by this plugin. */
export const MANIFEST_SCHEMA = 1

/** Remote file name of the manifest, relative to the remote root. */
export const MANIFEST_FILE = 'manifest.json'

/** Encryption algorithm advertised in the manifest. */
export const MANIFEST_ALG = 'aes-256-gcm'

/** Default scope: profile files that define a device's DSH configuration. */
export const DEFAULT_SCOPE = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']

/** Hex SHA-256 of a byte buffer. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** True when a string is a lowercase hex SHA-256. */
export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

/**
 * Validate and normalize a POSIX relative profile path.
 * @param {unknown} input - candidate path.
 * @returns {string | null} the normalized path, or null when unsafe.
 */
export function normalizeRel(input) {
  if (typeof input !== 'string') return null
  const rel = input.replace(/\\/gu, '/').trim()
  if (rel === '' || rel.startsWith('/') || rel.includes('\0')) return null
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  if (parts[0] === 'node_modules' || parts[0] === '.dsh-market' || parts[0] === '.git') return null
  return parts.join('/')
}

/**
 * Normalize the configured scope: validated, de-duplicated, order preserved.
 * @param {unknown} scope - configured array.
 * @returns {string[]} safe relative paths.
 */
export function normalizeScope(scope) {
  const input = Array.isArray(scope) && scope.length > 0 ? scope : DEFAULT_SCOPE
  const out = []
  for (const item of input) {
    const rel = normalizeRel(item)
    if (rel === null) throw new Error(`invalid sync scope entry: ${String(item)}`)
    if (!out.includes(rel)) out.push(rel)
  }
  return out
}

/** Remote path where one profile file's bytes are stored. */
export function remoteFileFor(rel) {
  return `files/${rel}`
}

/** Remote directory that holds every file payload. */
export const REMOTE_FILES_DIR = 'files'

/**
 * Parse and validate a remote manifest.
 * @param {string | Buffer} text - manifest JSON.
 * @returns {{ schema: number, profile: string, deviceId: string, deviceName: string, syncAt: number, crypto: { enabled: boolean, alg: string }, files: Record<string, { sha256: string, size: number, remotePath: string, etag?: string }> }}
 */
export function parseManifest(text) {
  let raw
  try {
    raw = JSON.parse(typeof text === 'string' ? text : text.toString('utf8'))
  } catch (error) {
    throw new Error(`remote manifest is not valid JSON: ${String(error)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('remote manifest is not an object')
  if (raw.schema !== MANIFEST_SCHEMA) throw new Error(`unsupported remote manifest schema: ${String(raw.schema)}`)
  const crypto = raw.crypto ?? { enabled: false, alg: MANIFEST_ALG }
  if (typeof crypto.enabled !== 'boolean') throw new Error('remote manifest crypto.enabled is not a boolean')
  const files = {}
  const rawFiles = raw.files ?? {}
  if (typeof rawFiles !== 'object' || Array.isArray(rawFiles)) throw new Error('remote manifest files is not an object')
  for (const [rel, entry] of Object.entries(rawFiles)) {
    const safeRel = normalizeRel(rel)
    if (safeRel === null) throw new Error(`remote manifest lists an unsafe path: ${rel}`)
    if (entry === null || typeof entry !== 'object') throw new Error(`remote manifest entry for ${rel} is not an object`)
    if (!isSha256(entry.sha256)) throw new Error(`remote manifest entry for ${rel} has an invalid sha256`)
    const remotePath = normalizeRel(entry.remotePath ?? remoteFileFor(safeRel))
    if (remotePath === null) throw new Error(`remote manifest entry for ${rel} has an unsafe remotePath`)
    const size = Number.isInteger(entry.size) && entry.size >= 0 ? entry.size : 0
    files[safeRel] = {
      sha256: entry.sha256,
      size,
      remotePath,
      ...(typeof entry.etag === 'string' && entry.etag !== '' ? { etag: entry.etag } : {}),
      ...(typeof entry.mtime === 'number' ? { mtime: entry.mtime } : {}),
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    profile: typeof raw.profile === 'string' ? raw.profile : '',
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : '',
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
    syncAt: typeof raw.syncAt === 'number' ? raw.syncAt : 0,
    crypto: { enabled: crypto.enabled, alg: MANIFEST_ALG },
    files,
  }
}

/**
 * Build the manifest document to upload.
 * @param {{ profile: string, device: { id: string, name: string }, cryptoEnabled: boolean, files: Record<string, { sha256: string, size: number, remotePath?: string, etag?: string, mtime?: number }> }} input
 */
export function buildManifest({ profile, device, cryptoEnabled, files }) {
  const out = {}
  for (const [rel, entry] of Object.entries(files)) {
    const safeRel = normalizeRel(rel)
    if (safeRel === null) continue
    out[safeRel] = {
      sha256: entry.sha256,
      size: entry.size,
      remotePath: entry.remotePath ?? remoteFileFor(safeRel),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
      ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }),
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    profile,
    deviceId: device.id,
    deviceName: device.name,
    syncAt: Date.now(),
    crypto: { enabled: cryptoEnabled === true, alg: MANIFEST_ALG },
    files: out,
  }
}

/** Serialize a manifest for upload (2-space JSON, trailing newline). */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
