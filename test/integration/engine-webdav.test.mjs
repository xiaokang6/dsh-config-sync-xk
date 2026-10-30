/**
 * Engine ↔ real WebDAV adapter end-to-end tests.
 *
 * A real `SyncEngine` (with `remoteFactory: createRemote`) talks to the
 * in-memory mock WebDAV server over HTTP; each "device" gets an isolated
 * temporary `$DSH_HOME` + profile directory. Nothing here touches the real
 * `~/.dsh` or the public network.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseEnvelope } from '../../lib/sync/crypto.js'
import { MANIFEST_FILE, remoteFileFor, sha256Hex } from '../../lib/sync/manifest.js'
import { dshHome } from '../../lib/sync/paths.js'
import { createMockWebdav } from '../../lib/sync/remotes/mock/webdav-server.js'
import {
  PROFILE_FILES,
  REMOTE_PATH,
  SCOPE,
  STATE_PROFILE,
  assertFetchIsLocal,
  assertTempIsolation,
  cleanupTempRoot,
  configureWebdav,
  createDevice,
  createTempRoot,
  describe,
  enableCrypto,
  probe,
  readRemoteManifest,
  remoteBytes,
  stateJson,
  syncBoth,
  trackFetch,
} from './helpers.mjs'

/** Passphrase used by the encryption test (never a real secret). */
const PASSPHRASE = 'pull'

/** Fresh server + temp root + fetch tracker; cleaned up after the test. */
async function setup(t, prefix) {
  const root = createTempRoot(prefix)
  const server = await createMockWebdav()
  const tracker = trackFetch()
  t.after(async () => {
    tracker.restore()
    await server.close()
    cleanupTempRoot(root)
  })
  return { root, server, tracker }
}

test('device A pushes every scope file to WebDAV and device B pulls identical bytes', async (t) => {
  const initialHome = process.env.DSH_HOME
  const { root, server, tracker } = await setup(t, 'it-webdav-push-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  assertTempIsolation(deviceA, root)
  await configureWebdav(deviceA, server)

  const first = await syncBoth(deviceA)
  assert.equal(first.ok, true)
  assert.deepEqual([...first.report.pushed].sort(), [...SCOPE].sort())
  assert.deepEqual(first.report.pulled, [])
  assert.deepEqual(first.report.errors, [])

  // Everything went to the mock server, and only to it.
  assertFetchIsLocal(tracker, server.url)
  assert.ok(server.requests.length >= SCOPE.length + 1, 'expected one PUT per file plus the manifest')
  for (const key of server.files.keys()) assert.ok(key.startsWith(`${REMOTE_PATH}/`), `remote key outside the root prefix: ${key}`)

  // Remote layout: <root>/manifest.json + <root>/files/<rel>, etags are opaque+quoted.
  const manifest = readRemoteManifest(server)
  assert.ok(manifest !== null, 'remote manifest must exist')
  assert.equal(manifest.crypto.enabled, false)
  for (const rel of SCOPE) {
    const key = `${REMOTE_PATH}/${remoteFileFor(rel)}`
    assert.ok(server.files.has(key), `missing remote payload for ${rel}`)
    const entry = manifest.files[rel]
    assert.ok(entry, `manifest entry missing for ${rel}`)
    assert.equal(entry.sha256, deviceA.sha(rel))
    assert.equal(entry.remotePath, remoteFileFor(rel))
    assert.equal(entry.size, deviceA.bytes(rel).length)
    assert.match(entry.etag, /^".+"$/, 'WebDAV etags are quoted strings')
    assert.equal(entry.etag, `"${server.files.get(key).etag}"`, 'manifest etag must be the server etag')
    assert.equal(remoteBytes(server, rel).toString('utf8'), deviceA.read(rel))
  }

  // A second sync with no local change is a no-op; a pull-only run no longer
  // rewrites the remote manifest, so its bytes must be untouched.
  const manifestEtagAfterFirst = server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).etag
  const second = await syncBoth(deviceA)
  assert.equal(second.ok, true)
  assert.deepEqual(second.report.pushed, [])
  assert.deepEqual(second.report.pulled, [])
  assert.deepEqual(second.report.errors, [])
  assert.equal(server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).etag, manifestEtagAfterFirst)

  // Device B: independent DSH_HOME and an empty profile, so everything is a pull.
  const deviceB = createDevice({ root, label: 'b' })
  assertTempIsolation(deviceB, root)
  await configureWebdav(deviceB, server)

  const pull = await syncBoth(deviceB)
  assert.equal(pull.ok, true)
  assert.deepEqual([...pull.report.pulled].sort(), [...SCOPE].sort())
  assert.deepEqual(pull.report.pushed, [])
  assert.deepEqual(pull.report.errors, [])
  for (const rel of SCOPE) {
    assert.equal(deviceB.read(rel), deviceA.read(rel), `${rel} must round-trip byte-for-byte`)
  }

  // B's merge base records the remote hashes, so its next sync is a no-op.
  const state = stateJson(deviceB)
  assert.equal(state.remoteKind, 'webdav')
  for (const rel of SCOPE) assert.equal(state.base[rel], manifest.files[rel].sha256)
  const noop = await syncBoth(deviceB)
  assert.deepEqual(noop.report.pushed, [])
  assert.deepEqual(noop.report.pulled, [])
  assert.deepEqual(noop.report.errors, [])

  // Pull-only syncs leave A's manifest exactly as it was (still A's document).
  assert.equal(server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).etag, manifestEtagAfterFirst)
  const manifestAfterB = readRemoteManifest(server)
  assert.equal(manifestAfterB.deviceName, 'dev-a')
  assert.equal(manifestAfterB.syncAt, manifest.syncAt)
  for (const rel of SCOPE) {
    assert.equal(manifestAfterB.files[rel].etag, manifest.files[rel].etag)
    assert.equal(manifestAfterB.files[rel].sha256, manifest.files[rel].sha256)
  }

  // Local bookkeeping lives under B's temporary DSH_HOME (never the real one).
  assert.ok(fs.existsSync(path.join(deviceB.home, 'config-sync', 'remote.json')))
  assert.ok(fs.existsSync(path.join(deviceB.home, 'config-sync', 'state', `${STATE_PROFILE}.json`)))
  assert.ok(fs.readdirSync(path.join(deviceB.home, 'config-sync', 'backups')).length > 0)
  assert.equal(process.env.DSH_HOME, initialHome, 'DSH_HOME must be restored after every engine call')
  assertFetchIsLocal(tracker, server.url)
})

test('a device joining an existing remote adopts it on the first sync and keeps its local version as a .local copy', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-webdav-first-sync-')

  // Device A owns the remote.
  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureWebdav(deviceA, server)
  await syncBoth(deviceA)
  const remoteVersion = deviceA.read('cordis.patch.yml')
  const remoteManifestEtag = server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).etag

  // Device B joins later: three files are identical, one was edited locally, and
  // B has no merge base at all (lastSyncAt 0, empty base).
  const localVersion = '- id: local\n  config: { local: true }\n'
  const deviceB = createDevice({
    root,
    label: 'b',
    files: { ...PROFILE_FILES, 'cordis.patch.yml': localVersion },
  })
  await configureWebdav(deviceB, server)

  const first = await syncBoth(deviceB)
  assert.equal(first.ok, true)
  assert.deepEqual(first.report.errors, [])
  // Adopt the remote instead of a wall of conflicts…
  assert.deepEqual(first.report.pulled, ['cordis.patch.yml'])
  assert.deepEqual(first.report.conflicts, [])
  // …and keep the local version next to it.
  assert.equal(first.report.localCopies.length, 1)
  const localCopy = first.report.localCopies[0]
  assert.equal(localCopy.file, 'cordis.patch.yml')
  assert.equal(localCopy.reason, 'first-sync-adopt-remote')
  assert.match(localCopy.copy, /^cordis\.patch\.yml\.local-dev-b-\d{8}-\d{6}(-\d+)?$/u)
  assert.equal(deviceB.read(localCopy.copy), localVersion, 'the local version is preserved as a .local copy')
  assert.equal(deviceB.read('cordis.patch.yml'), remoteVersion, 'the remote version wins on the first sync')
  assert.equal(deviceB.sha('cordis.patch.yml'), deviceA.sha('cordis.patch.yml'))

  // Still pull-only: B did not rewrite the manifest.
  assert.equal(server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).etag, remoteManifestEtag)
  assert.equal(readRemoteManifest(server).deviceName, 'dev-a')

  // With a merge base recorded, the next sync is a no-op.
  const again = await syncBoth(deviceB)
  assert.equal(again.ok, true)
  assert.deepEqual(again.report.pulled, [])
  assert.deepEqual(again.report.pushed, [])
  assert.deepEqual(again.report.localCopies, [])
  assert.deepEqual(again.report.errors, [])
  assertFetchIsLocal(tracker, server.url)
})

test('a local edit is pushed with If-Match and pulled by the other device', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-webdav-edit-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  const deviceB = createDevice({ root, label: 'b' })
  await configureWebdav(deviceA, server)
  await configureWebdav(deviceB, server)
  await syncBoth(deviceA)
  await syncBoth(deviceB)

  const before = readRemoteManifest(server).files['cordis.patch.yml']
  deviceA.append('cordis.patch.yml', '# edited on A\n')
  const edited = await syncBoth(deviceA)
  assert.equal(edited.ok, true)
  assert.deepEqual(edited.report.pushed, ['cordis.patch.yml'])
  assert.deepEqual(edited.report.errors, [])

  const after = readRemoteManifest(server).files['cordis.patch.yml']
  assert.notEqual(after.etag, before.etag, 'a successful conditional PUT must return a fresh etag')
  assert.equal(after.sha256, deviceA.sha('cordis.patch.yml'))
  assert.equal(remoteBytes(server, 'cordis.patch.yml').toString('utf8'), deviceA.read('cordis.patch.yml'))

  // The adapter really used the manifest etag as If-Match on the payload PUT.
  const payloadPut = server.requests
    .filter((request) => request.method === 'PUT' && request.path.endsWith(`/${remoteFileFor('cordis.patch.yml')}`))
    .pop()
  assert.ok(payloadPut, 'expected a payload PUT for cordis.patch.yml')
  assert.equal(payloadPut.headers['if-match'], before.etag)

  const pulled = await syncBoth(deviceB)
  assert.equal(pulled.ok, true)
  assert.deepEqual(pulled.report.pulled, ['cordis.patch.yml'])
  assert.equal(deviceB.read('cordis.patch.yml'), deviceA.read('cordis.patch.yml'))

  const noop = await syncBoth(deviceB)
  assert.deepEqual(noop.report.pushed, [])
  assert.deepEqual(noop.report.pulled, [])
  assert.deepEqual(noop.report.errors, [])
  assertFetchIsLocal(tracker, server.url)
})

test('diverged edits become a conflict; use-remote resolves it', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-webdav-conflict-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  const deviceB = createDevice({ root, label: 'b' })
  await configureWebdav(deviceA, server)
  await configureWebdav(deviceB, server)
  await syncBoth(deviceA)
  await syncBoth(deviceB)

  deviceA.append('cordis.patch.yml', '# from A\n')
  const pushedA = await syncBoth(deviceA)
  assert.deepEqual(pushedA.report.pushed, ['cordis.patch.yml'])
  const remoteVersion = deviceA.read('cordis.patch.yml')

  deviceB.append('cordis.patch.yml', '# from B\n')
  const localVersion = deviceB.read('cordis.patch.yml')
  const conflicted = await syncBoth(deviceB)
  assert.equal(conflicted.report.conflicts.length, 1)
  assert.equal(conflicted.report.conflicts[0].file, 'cordis.patch.yml')
  assert.deepEqual(conflicted.report.pushed, [])
  assert.deepEqual(conflicted.report.pulled, [])
  assert.deepEqual(conflicted.report.errors, [])
  assert.deepEqual(conflicted.report.localCopies, [], 'only a first sync keeps local copies')

  // Local file is untouched; the remote version is saved next to it.
  assert.equal(deviceB.read('cordis.patch.yml'), localVersion)
  const copy = conflicted.report.conflicts[0].remoteFile
  assert.match(copy, /^cordis\.patch\.yml\.remote-dev-b-\d{8}-\d{6}(-\d+)?$/u)
  assert.equal(deviceB.read(copy), remoteVersion)
  assert.equal((await describe(deviceB)).conflicts.length, 1)

  const resolved = await deviceB.run(() => deviceB.engine.resolveConflict({ file: 'cordis.patch.yml', action: 'use-remote' }))
  assert.equal(resolved.report.applied, true)
  assert.equal(deviceB.read('cordis.patch.yml'), remoteVersion)
  assert.equal(deviceB.exists(copy), false, 'the conflict copy is removed after resolving')
  assert.equal((await describe(deviceB)).conflicts.length, 0)

  // Both devices settled: nothing left to push or pull.
  for (const device of [deviceA, deviceB]) {
    const settled = await syncBoth(device)
    assert.deepEqual(settled.report.pushed, [])
    assert.deepEqual(settled.report.pulled, [])
    assert.deepEqual(settled.report.errors, [])
  }
  assertFetchIsLocal(tracker, server.url)
})

test('an encrypted remote round-trips with the right passphrase and fails closed on a wrong one', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-webdav-crypto-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureWebdav(deviceA, server)
  await enableCrypto(deviceA, PASSPHRASE)
  const pushed = await syncBoth(deviceA)
  assert.equal(pushed.ok, true)
  assert.deepEqual(pushed.report.errors, [])
  assert.deepEqual([...pushed.report.pushed].sort(), [...SCOPE].sort())

  const manifest = readRemoteManifest(server)
  assert.equal(manifest.crypto.enabled, true)
  for (const rel of SCOPE) {
    const stored = remoteBytes(server, rel)
    assert.ok(parseEnvelope(stored) !== null, `${rel} must be stored as an AES-256-GCM envelope`)
    assert.notEqual(stored.toString('utf8'), deviceA.read(rel), `${rel} must not be stored in plaintext`)
    // The manifest still advertises the plaintext hash, so planning needs no passphrase.
    assert.equal(manifest.files[rel].sha256, sha256Hex(deviceA.bytes(rel)))
    assert.match(manifest.files[rel].etag, /^".+"$/)
  }

  // Device B decrypts with the same passphrase.
  const deviceB = createDevice({ root, label: 'b' })
  await configureWebdav(deviceB, server)
  await enableCrypto(deviceB, PASSPHRASE)
  const pulled = await syncBoth(deviceB)
  assert.equal(pulled.ok, true)
  assert.deepEqual([...pulled.report.pulled].sort(), [...SCOPE].sort())
  assert.deepEqual(pulled.report.errors, [])
  for (const rel of SCOPE) {
    assert.equal(deviceB.read(rel), deviceA.read(rel))
    assert.equal(parseEnvelope(deviceB.bytes(rel)), null, `${rel} must be plaintext locally`)
  }

  // Device C: wrong passphrase -> per-file errors, no local change, no payload write.
  const deviceC = createDevice({ root, label: 'c', files: { 'cordis.patch.yml': '# sentinel\n' } })
  await configureWebdav(deviceC, server)
  await enableCrypto(deviceC, 'wrong-passphrase')
  const payloadEtagsBefore = Object.fromEntries(SCOPE.map((rel) => [rel, server.files.get(`${REMOTE_PATH}/${remoteFileFor(rel)}`).etag]))
  const manifestBefore = readRemoteManifest(server)
  const failed = await syncBoth(deviceC)
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.report.pulled, [])
  assert.deepEqual(failed.report.pushed, [])
  assert.deepEqual(failed.report.conflicts, [])
  assert.deepEqual(failed.report.localCopies, [], 'a failed decrypt must not produce a local copy')
  assert.ok(failed.report.errors.length >= 1)
  assert.match(failed.report.errors.map((entry) => entry.error).join('\n'), /解密|口令|passphrase|decrypt/iu)
  assert.equal(deviceC.read('cordis.patch.yml'), '# sentinel\n', 'a failed decrypt must not touch local files')
  assert.deepEqual(deviceC.files(), ['cordis.patch.yml'])
  for (const rel of SCOPE) {
    assert.equal(server.files.get(`${REMOTE_PATH}/${remoteFileFor(rel)}`).etag, payloadEtagsBefore[rel], `${rel} payload must not be rewritten`)
    assert.equal(readRemoteManifest(server).files[rel].sha256, manifestBefore.files[rel].sha256)
  }
  assertFetchIsLocal(tracker, server.url)
})

test('probe() through the engine reports WebDAV health and auth failures', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-webdav-probe-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureWebdav(deviceA, server)
  // Create the remote root first: a probe of a never-synced root is ok:false by contract.
  const seeded = await syncBoth(deviceA)
  assert.equal(seeded.ok, true)
  const healthy = await probe(deviceA)
  assert.equal(healthy.ok, true)
  assert.equal(healthy.probe.ok, true)
  assert.equal(typeof healthy.probe.latencyMs, 'number')
  assert.equal(healthy.probe.detail, '')

  const wrong = createDevice({ root, label: 'wrong', files: PROFILE_FILES })
  await configureWebdav(wrong, server, { password: 'definitely-not-it' })
  const unhealthy = await probe(wrong)
  assert.equal(unhealthy.ok, true, 'the engine never throws for a failed probe; it reports it')
  assert.equal(unhealthy.probe.ok, false)
  assert.match(unhealthy.probe.detail, /认证|auth/iu)
  assert.ok(!unhealthy.probe.detail.includes('definitely-not-it'), 'probe details never echo credentials')

  assertFetchIsLocal(tracker, server.url)
})

test('the harness keeps all state under the temp DSH_HOME and off the public network', async (t) => {
  const initialHome = process.env.DSH_HOME
  const { root, server, tracker } = await setup(t, 'it-webdav-isolation-')
  const device = createDevice({ root, label: 'iso', files: PROFILE_FILES })

  assertTempIsolation(device, root)
  assert.notEqual(path.resolve(device.home), path.resolve(path.join(os.homedir(), '.dsh')))
  // paths.js resolves DSH_HOME per call: inside device.run() it is the temp home…
  assert.equal(await device.run(() => dshHome()), device.home)
  // …and it is restored immediately afterwards.
  assert.equal(process.env.DSH_HOME, initialHome)

  await configureWebdav(device, server)
  await syncBoth(device)
  assert.equal(process.env.DSH_HOME, initialHome)

  const dataDir = path.join(device.home, 'config-sync')
  for (const relative of ['device.json', 'remote.json', `state/${STATE_PROFILE}.json`]) {
    assert.ok(fs.existsSync(path.join(dataDir, ...relative.split('/'))), `${relative} must be under the temp DSH_HOME`)
  }
  assert.deepEqual(device.files(), [...SCOPE].sort(), 'the temp profile only holds the synced files')

  for (const url of tracker.urls) assert.equal(new URL(url).hostname, '127.0.0.1', `unexpected host: ${url}`)
  assertFetchIsLocal(tracker, server.url)
  for (const key of server.files.keys()) assert.ok(key.startsWith(`${REMOTE_PATH}/`))
  // The mock recorded every request; the harness never used the real DSH home.
  assert.ok(server.requests.length > 0)
  assert.ok(!path.resolve(dataDir).startsWith(`${path.resolve(os.homedir(), '.dsh')}${path.sep}`))
})
