/**
 * Unit tests for the local backup store.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBackup, isValidBackupId, listBackups, restoreBackup } from '../../lib/sync/backup.js'
import { ensureDevice, safeJoin, safeName, timestamp } from '../../lib/sync/paths.js'

function withTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-sync-test-'))
  process.env.DSH_HOME = path.join(root, 'dsh')
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  return { root, profileDir }
}

test('safeJoin refuses traversal and absolute paths', () => {
  const { profileDir } = withTempHome()
  assert.equal(safeJoin(profileDir, 'package.json'), path.join(profileDir, 'package.json'))
  assert.throws(() => safeJoin(profileDir, '../escape.json'), /unsafe relative path|escapes/u)
  assert.throws(() => safeJoin(profileDir, '/etc/passwd'), /unsafe relative path/u)
})

test('safeName and timestamp produce filesystem-safe ids', () => {
  assert.equal(safeName('desktop:my profile'), 'desktop_my_profile')
  assert.match(timestamp(new Date('2026-10-30T05:07:08')), /^[0-9]{8}-[0-9]{6}$/u)
})

test('backup round-trips profile files', () => {
  const { profileDir } = withTempHome()
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"v":1}\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')

  const manifest = createBackup({ profileDir, op: 'both', remoteKind: 'webdav', files: ['package.json', 'cordis.patch.yml', 'missing.yml'] })
  assert.ok(isValidBackupId(manifest.id))
  assert.equal(manifest.files.length, 2)
  assert.ok(fs.existsSync(path.join(profileDir, 'package.json')))

  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"v":2}\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'changed\n')

  const listed = listBackups()
  assert.equal(listed[0].id, manifest.id)
  assert.deepEqual(listed[0].files.sort(), ['cordis.patch.yml', 'package.json'])

  const restored = restoreBackup({ profileDir, id: manifest.id })
  assert.deepEqual(restored.restored.sort(), ['cordis.patch.yml', 'package.json'])
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), '{"v":1}\n')
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n')
})

test('invalid backup ids are refused', () => {
  const { profileDir } = withTempHome()
  assert.throws(() => restoreBackup({ profileDir, id: '../evil' }), /invalid backup id/u)
  assert.equal(listBackups().length, 0)
})

test('device identity is stable across calls', () => {
  const { root } = withTempHome()
  const first = ensureDevice()
  const second = ensureDevice()
  assert.equal(first.id, second.id)
  assert.ok(fs.existsSync(path.join(root, 'dsh', 'config-sync', 'device.json')))
})
