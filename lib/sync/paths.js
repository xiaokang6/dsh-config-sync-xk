/**
 * Local filesystem locations and small IO helpers for dsh-config-sync.
 *
 * Everything the plugin persists lives under `$DSH_HOME/config-sync` and never
 * inside the profile directory: profile files are the sync *payload*, local
 * bookkeeping (device id, remote credentials, merge base, backups, logs) is
 * per-device state that must never travel.
 *
 * @module dsh-config-sync/sync/paths
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Resolve the DSH home directory, honouring `DSH_HOME`. */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  return explicit !== undefined && explicit.trim() !== ''
    ? path.resolve(explicit)
    : path.join(os.homedir(), '.dsh')
}

/** The plugin's local data directory. */
export function dataDir() {
  return path.join(dshHome(), 'config-sync')
}

/** Create the data directory (idempotent) and return it. */
export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true })
  return dataDir()
}

/** Device identity file. */
export function deviceFile() {
  return path.join(dataDir(), 'device.json')
}

/** Per-device remote settings + secrets file (never synced). */
export function remoteSettingsFile() {
  return path.join(dataDir(), 'remote.json')
}

/** Per-profile merge-base / last-sync state. */
export function stateFile(profileName) {
  return path.join(dataDir(), 'state', `${safeName(profileName)}.json`)
}

/** Directory holding local pre-apply backups. */
export function backupsDir() {
  return path.join(dataDir(), 'backups')
}

/** NDJSON log file. */
export function logFile() {
  return path.join(dataDir(), 'log.ndjson')
}

/** Turn a value into a filesystem-safe file name fragment. */
export function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, '_')
}

/** Read and parse a JSON file, returning `fallback` when it is absent/broken. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON atomically (temp file + rename), UTF-8 without BOM. */
export function writeJsonAtomic(file, value, { mode } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  const body = `${JSON.stringify(value, null, 2)}\n`
  fs.writeFileSync(temp, body, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
  fs.renameSync(temp, file)
}

/** Write bytes atomically (temp file + rename), no encoding conversion. */
export function writeBytesAtomic(file, bytes, { mode } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(temp, bytes, mode === undefined ? undefined : { mode })
  fs.renameSync(temp, file)
}

/**
 * Resolve `rel` under `root`, refusing traversal and symlinked escapes.
 * @param {string} root - absolute root directory.
 * @param {string} rel - POSIX relative path.
 * @returns {string} the absolute target path.
 */
export function safeJoin(root, rel) {
  const normalized = String(rel).replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`unsafe relative path: ${rel}`)
  }
  const target = path.resolve(root, ...normalized.split('/'))
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes the profile directory: ${rel}`)
  }
  return target
}

/** The device identity, created on first use. */
export function ensureDevice() {
  ensureDataDir()
  const file = deviceFile()
  const existing = readJson(file, undefined)
  if (existing !== undefined && typeof existing.id === 'string' && existing.id !== '' && typeof existing.name === 'string') {
    return { id: existing.id, name: existing.name }
  }
  const host = os.hostname().trim() === '' ? 'device' : os.hostname().trim()
  const device = { schema: 1, id: randomUUID(), name: host.slice(0, 48) }
  writeJsonAtomic(file, device)
  return { id: device.id, name: device.name }
}

/** Short, filename-safe device tag used for conflict copies. */
export function deviceTag(device) {
  return safeName(device.name).slice(0, 16) || safeName(device.id).slice(0, 8)
}

/** `yyyyMMdd-HHmmss` in local time, used for backup ids and conflict names. */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** The profile directory's default when the host publishes no profileContext. */
export function defaultProfileDir(profileName) {
  return path.join(dshHome(), 'profiles', profileName)
}
