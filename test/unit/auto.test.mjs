/**
 * Startup auto-sync policy tests.
 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import {
  DEFAULT_AUTO_SYNC_DELAY_MS,
  MAX_AUTO_SYNC_DELAY_MS,
  autoSyncPlan,
  resetAutoSync,
  scheduleAutoSync,
} from '../../lib/sync/auto.js'

const fullWebdav = {
  kind: 'webdav',
  baseUrl: 'https://dav.jianguoyun.com/dav',
  username: 'a@b.c',
  password: 'secret',
  path: 'dsh-config-sync/desktop',
  direction: 'both',
  autoSyncOnStart: true,
  crypto: { enabled: false, passphrase: '' },
}

test('a configured remote syncs once on boot', () => {
  const decision = autoSyncPlan(fullWebdav)
  assert.equal(decision.run, true)
  assert.equal(decision.reason, 'ok')
  assert.equal(decision.direction, 'both')
  assert.equal(decision.delayMs, DEFAULT_AUTO_SYNC_DELAY_MS)
})

test('the toggle disables it', () => {
  const decision = autoSyncPlan({ ...fullWebdav, autoSyncOnStart: false })
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'disabled')
})

test('an unconfigured or incomplete remote is skipped', () => {
  assert.equal(autoSyncPlan({ ...fullWebdav, kind: '' }).reason, 'remote-not-configured')
  assert.equal(autoSyncPlan({ ...fullWebdav, password: '' }).reason, 'remote-incomplete')
  assert.equal(autoSyncPlan({ ...fullWebdav, username: '' }).reason, 'remote-incomplete')
  assert.equal(autoSyncPlan({ ...fullWebdav, kind: 'github', owner: '', repo: 'r', token: 't' }).reason, 'remote-incomplete')
  assert.equal(autoSyncPlan({ ...fullWebdav, kind: 'github', owner: 'o', repo: 'r', token: 't' }).run, true)
})

test('encryption without a passphrase is skipped (remote would be unreadable)', () => {
  const decision = autoSyncPlan({ ...fullWebdav, crypto: { enabled: true, passphrase: '' } })
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'passphrase-missing')
  assert.equal(autoSyncPlan({ ...fullWebdav, crypto: { enabled: true, passphrase: 'pw' } }).run, true)
})

test('the delay is clamped and defaults are stable', () => {
  assert.equal(autoSyncPlan(fullWebdav, { delayMs: 5000 }).delayMs, 5000)
  assert.equal(autoSyncPlan(fullWebdav, { delayMs: -10 }).delayMs, 0)
  assert.equal(autoSyncPlan(fullWebdav, { delayMs: MAX_AUTO_SYNC_DELAY_MS * 4 }).delayMs, MAX_AUTO_SYNC_DELAY_MS)
  assert.equal(autoSyncPlan(fullWebdav, { delayMs: Number.NaN }).delayMs, DEFAULT_AUTO_SYNC_DELAY_MS)
  assert.equal(autoSyncPlan(null).reason, 'no-settings')
})

afterEach(() => {
  resetAutoSync()
})

test('scheduleAutoSync runs exactly one sync per process boot', async () => {
  const calls = []
  const events = []
  const engine = {
    readSettings: () => ({ ...fullWebdav }),
    getConfig: () => ({ autoSyncDelayMs: 5 }),
    async sync(options) {
      calls.push(options)
      return { ok: true, report: { pushed: [], pulled: [], conflicts: [], errors: [], restartRequired: false } }
    },
  }
  const log = { info: (event) => events.push(event), warn: () => {} }
  const ctx = { effect: (fn) => fn() }
  const first = scheduleAutoSync(ctx, engine, log)
  assert.equal(first.run, true)
  const second = scheduleAutoSync(ctx, engine, log)
  assert.equal(second.run, false)
  assert.equal(second.reason, 'already-scheduled')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].direction, 'both')
  assert.ok(events.includes('auto-sync-scheduled'))
  assert.ok(events.includes('auto-sync-done'))
})

test('scheduleAutoSync skips (and stays retryable) when nothing is configured', () => {
  const events = []
  const engine = {
    readSettings: () => ({ ...fullWebdav, kind: '' }),
    getConfig: () => ({ autoSyncDelayMs: 1 }),
    sync: async () => {
      throw new Error('should not run')
    },
  }
  const log = { info: (event) => events.push(event), warn: () => {} }
  const decision = scheduleAutoSync({ effect: (fn) => fn() }, engine, log)
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'remote-not-configured')
  assert.ok(events.includes('auto-sync-skip'))
})
