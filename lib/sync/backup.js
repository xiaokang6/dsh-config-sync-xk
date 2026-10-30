/**
 * Local pre-apply backups.
 *
 * Before a sync writes anything into the profile, the files it is about to
 * touch are copied here under `$DSH_HOME/config-sync/backups/<timestamp>-<op>`.
 * Restoring a backup is the manual undo path when a pull turns out wrong.
 *
 * @module dsh-config-sync/sync/backup
 */

import fs from 'node:fs'
import path from 'node:path'
import { backupsDir, readJson, safeJoin, timestamp, writeBytesAtomic, writeJsonAtomic } from './paths.js'
import { sha256Hex } from './manifest.js'

/** Maximum number of backups kept on disk. */
export const MAX_BACKUPS = 20

/** Backup id shape: `yyyyMMdd-HHmmss-<op>`. */
const BACKUP_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$/u

/** True when a string is a valid backup id. */
export function isValidBackupId(id) {
  return typeof id === 'string' && BACKUP_ID_RE.test(id)
}

/**
 * Snapshot the given profile files.
 * @param {{ profileDir: string, op: string, remoteKind: string, files: string[] }} input
 * @returns {{ id: string, at: number, op: string, remoteKind: string, files: Array<{ path: string, sha256: string, size: number }> }}
 */
export function createBackup({ profileDir, op, remoteKind, files }) {
  const id = `${timestamp()}-${String(op || 'sync').replace(/[^a-z0-9_-]/giu, '') || 'sync'}`
  const dir = path.join(backupsDir(), id)
  const dirFiles = path.join(dir, 'files')
  fs.mkdirSync(dirFiles, { recursive: true })
  const entries = []
  for (const rel of files) {
    let bytes
    try {
      bytes = fs.readFileSync(safeJoin(profileDir, rel))
    } catch {
      continue // absent files are simply not backed up
    }
    const target = safeJoin(dirFiles, rel)
    writeBytesAtomic(target, bytes)
    entries.push({ path: rel, sha256: sha256Hex(bytes), size: bytes.length })
  }
  const manifest = { schema: 1, id, at: Date.now(), op: String(op), remoteKind: String(remoteKind), files: entries }
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest)
  pruneBackups()
  return manifest
}

/** List local backups, newest first. */
export function listBackups({ limit = 50 } = {}) {
  const root = backupsDir()
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!isValidBackupId(name)) continue
    const manifest = readJson(path.join(root, name, 'manifest.json'), undefined)
    if (manifest === undefined || manifest === null || typeof manifest !== 'object') continue
    out.push({
      id: name,
      at: typeof manifest.at === 'number' ? manifest.at : 0,
      op: typeof manifest.op === 'string' ? manifest.op : 'sync',
      remoteKind: typeof manifest.remoteKind === 'string' ? manifest.remoteKind : '',
      files: Array.isArray(manifest.files) ? manifest.files.map((file) => file.path).filter((value) => typeof value === 'string') : [],
    })
  }
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  return out.slice(0, Math.max(1, Math.min(limit, 500)))
}

/** Read one backup's manifest. */
export function readBackup(id) {
  if (!isValidBackupId(id)) throw new Error(`invalid backup id: ${String(id)}`)
  const dir = path.join(backupsDir(), id)
  const manifest = readJson(path.join(dir, 'manifest.json'), undefined)
  if (manifest === undefined || manifest === null) throw new Error(`backup not found: ${id}`)
  return { dir, manifest }
}

/**
 * Restore every file listed in a backup, atomically, into the profile.
 * @param {{ profileDir: string, id: string }} input
 * @returns {{ id: string, restored: string[] }}
 */
export function restoreBackup({ profileDir, id }) {
  const { dir, manifest } = readBackup(id)
  const restored = []
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    const rel = typeof entry?.path === 'string' ? entry.path : undefined
    if (rel === undefined) continue
    const source = safeJoin(path.join(dir, 'files'), rel)
    const bytes = fs.readFileSync(source)
    writeBytesAtomic(safeJoin(profileDir, rel), bytes)
    restored.push(rel)
  }
  return { id, restored }
}

/** Delete the oldest backups beyond `MAX_BACKUPS`. */
export function pruneBackups(keep = MAX_BACKUPS) {
  const all = listBackups({ limit: 500 })
  for (const backup of all.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(backupsDir(), backup.id), { recursive: true, force: true })
    } catch {
      // A retained backup is better than a failed sync.
    }
  }
}
