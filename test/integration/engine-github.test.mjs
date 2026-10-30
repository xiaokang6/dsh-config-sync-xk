/**
 * Engine ↔ real GitHub Contents API adapter end-to-end tests.
 *
 * Same harness as engine-webdav.test.mjs, but the engine talks to the in-memory
 * mock GitHub API (via the `apiUrl` override that `adapterSettings()` forwards).
 *
 * These tests pin the GitHub/Contents specifics that WebDAV does not have:
 * a blob-sha etag, a conditional manifest rewrite (the engine passes the read
 * etag back, otherwise GitHub answers 422), and the pull-only rule that leaves
 * an existing remote manifest alone.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseEnvelope } from '../../lib/sync/crypto.js'
import { MANIFEST_FILE, remoteFileFor } from '../../lib/sync/manifest.js'
import { createMockGithub } from '../../lib/sync/remotes/mock/github-server.js'
import {
  PROFILE_FILES,
  REMOTE_PATH,
  SCOPE,
  assertFetchIsLocal,
  assertTempIsolation,
  cleanupTempRoot,
  configureGithub,
  createDevice,
  createTempRoot,
  enableCrypto,
  readRemoteManifest,
  remoteBytes,
  stateJson,
  syncBoth,
  trackFetch,
} from './helpers.mjs'

/** Mock GitHub PAT; never a real token. */
const TOKEN = 'mock-pat'
const PASSPHRASE = 'pull'

/** Fresh GitHub mock + temp root + fetch tracker; cleaned up after the test. */
async function setup(t, prefix) {
  const root = createTempRoot(prefix)
  const server = await createMockGithub({ token: TOKEN })
  const tracker = trackFetch()
  t.after(async () => {
    tracker.restore()
    await server.close()
    cleanupTempRoot(root)
  })
  return { root, server, tracker }
}

/** Assert every mock request carried the bearer token and no report leaked it. */
function assertGithubRequestIsolation(server, tracker) {
  assertFetchIsLocal(tracker, server.apiUrl)
  assert.ok(server.requests.length > 0)
  for (const request of server.requests) {
    assert.equal(request.headers.authorization, `Bearer ${server.token}`, `${request.method} ${request.path} lost its token`)
    assert.ok(request.headers['user-agent'], 'every request carries the adapter user-agent')
  }
}

test('device A pushes every scope file to GitHub and device B pulls identical bytes', async (t) => {
  const initialHome = process.env.DSH_HOME
  const { root, server, tracker } = await setup(t, 'it-github-push-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  assertTempIsolation(deviceA, root)
  await configureGithub(deviceA, server)

  // First push also creates manifest.json, so it is fully clean.
  const first = await syncBoth(deviceA)
  assert.equal(first.ok, true)
  assert.deepEqual([...first.report.pushed].sort(), [...SCOPE].sort())
  assert.deepEqual(first.report.errors, [])
  assert.ok(!JSON.stringify(first.report).includes(TOKEN), 'reports never contain the token')
  assertGithubRequestIsolation(server, tracker)

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
    // GitHub's opaque etag is the blob sha (40 lowercase hex chars).
    assert.match(entry.etag, /^[0-9a-f]{40}$/u)
    assert.equal(entry.etag, server.files.get(key).sha, 'manifest etag must be the blob sha')
    assert.equal(remoteBytes(server, rel).toString('utf8'), deviceA.read(rel))
  }

  // Device B: independent DSH_HOME + empty profile, so everything is a pull.
  const deviceB = createDevice({ root, label: 'b' })
  assertTempIsolation(deviceB, root)
  await configureGithub(deviceB, server)
  const manifestShaBeforeB = server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).sha
  const pull = await syncBoth(deviceB)
  assert.equal(pull.ok, true)
  assert.deepEqual([...pull.report.pulled].sort(), [...SCOPE].sort())
  assert.deepEqual(pull.report.pushed, [])
  assert.deepEqual(pull.report.errors, [])
  for (const rel of SCOPE) assert.equal(deviceB.read(rel), deviceA.read(rel), `${rel} must round-trip byte-for-byte`)
  assert.ok(!JSON.stringify(pull.report).includes(TOKEN))

  // A pull-only run must not rewrite the remote manifest (GitHub would need its sha).
  assert.equal(server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).sha, manifestShaBeforeB)
  assert.equal(readRemoteManifest(server).deviceName, 'dev-a')

  // B's merge base records the remote hashes, so there is nothing left to do.
  const state = stateJson(deviceB)
  assert.equal(state.remoteKind, 'github')
  for (const rel of SCOPE) assert.equal(state.base[rel], manifest.files[rel].sha256)
  const noop = await syncBoth(deviceB)
  assert.equal(noop.ok, true)
  assert.deepEqual(noop.report.pushed, [])
  assert.deepEqual(noop.report.pulled, [])
  assert.deepEqual(noop.report.errors, [])

  assert.ok(fs.existsSync(path.join(deviceB.home, 'config-sync', 'remote.json')))
  assert.equal(process.env.DSH_HOME, initialHome)
  assertGithubRequestIsolation(server, tracker)
})

test('a fresh second device pulls the newest GitHub payload after another device edited it', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-github-pull-latest-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureGithub(deviceA, server)
  await syncBoth(deviceA)

  const key = `${REMOTE_PATH}/${remoteFileFor('cordis.patch.yml')}`
  const originalSha = server.files.get(key).sha
  deviceA.append('cordis.patch.yml', '# edited on A\n')
  const edited = await syncBoth(deviceA)
  // The payload write is a normal conditional PUT (sha from the manifest)…
  assert.equal(edited.ok, true)
  assert.deepEqual(edited.report.errors, [])
  assert.deepEqual(edited.report.pushed, ['cordis.patch.yml'])
  assert.notEqual(server.files.get(key).sha, originalSha)
  assert.equal(remoteBytes(server, 'cordis.patch.yml').toString('utf8'), deviceA.read('cordis.patch.yml'))
  // …and the manifest was refreshed, so a joining device sees the new hash.
  assert.equal(readRemoteManifest(server).files['cordis.patch.yml'].sha256, deviceA.sha('cordis.patch.yml'))

  const deviceB = createDevice({ root, label: 'b' })
  await configureGithub(deviceB, server)
  const pulled = await syncBoth(deviceB)
  assert.equal(pulled.ok, true)
  assert.deepEqual([...pulled.report.pulled].sort(), [...SCOPE].sort())
  assert.equal(deviceB.read('cordis.patch.yml'), deviceA.read('cordis.patch.yml'))
  assertGithubRequestIsolation(server, tracker)
})

test('GitHub manifest.json is refreshed after a push with the blob sha', async (t) => {
  const { root, server } = await setup(t, 'it-github-manifest-')
  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureGithub(deviceA, server)
  await syncBoth(deviceA)

  const manifestKey = `${REMOTE_PATH}/${MANIFEST_FILE}`
  const manifestBefore = readRemoteManifest(server)
  const manifestShaBefore = server.files.get(manifestKey).sha

  deviceA.append('cordis.patch.yml', '# edited on A\n')
  const edited = await syncBoth(deviceA)
  assert.equal(edited.ok, true)
  assert.deepEqual(edited.report.errors, [])
  assert.deepEqual(edited.report.pushed, ['cordis.patch.yml'])

  const manifest = readRemoteManifest(server)
  const payloadKey = `${REMOTE_PATH}/${remoteFileFor('cordis.patch.yml')}`
  assert.notEqual(server.files.get(manifestKey).sha, manifestShaBefore, 'the manifest must be rewritten by a push')
  assert.equal(manifest.deviceName, 'dev-a')
  assert.equal(manifest.files['cordis.patch.yml'].sha256, deviceA.sha('cordis.patch.yml'))
  assert.equal(manifest.files['cordis.patch.yml'].etag, server.files.get(payloadKey).sha)
  // Untouched entries keep their opaque etags.
  for (const rel of SCOPE.filter((item) => item !== 'cordis.patch.yml')) {
    assert.equal(manifest.files[rel].etag, manifestBefore.files[rel].etag)
    assert.equal(manifest.files[rel].sha256, manifestBefore.files[rel].sha256)
  }
})

test('two diverged GitHub devices become a conflict; use-remote resolves it and both sides refresh the manifest', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-github-conflict-')
  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  const deviceB = createDevice({ root, label: 'b' })
  await configureGithub(deviceA, server)
  await configureGithub(deviceB, server)
  await syncBoth(deviceA)
  await syncBoth(deviceB)

  // Both devices now have a merge base, so this is a real divergence.
  assert.equal(stateJson(deviceB).base['cordis.patch.yml'], deviceB.sha('cordis.patch.yml'))

  deviceA.append('cordis.patch.yml', '# from A\n')
  const pushedA = await syncBoth(deviceA)
  assert.equal(pushedA.ok, true)
  assert.deepEqual(pushedA.report.errors, [])
  const remoteVersion = deviceA.read('cordis.patch.yml')
  assert.equal(readRemoteManifest(server).deviceName, 'dev-a')
  assert.equal(readRemoteManifest(server).files['cordis.patch.yml'].sha256, deviceA.sha('cordis.patch.yml'))

  deviceB.append('cordis.patch.yml', '# from B\n')
  const localVersion = deviceB.read('cordis.patch.yml')
  const conflicted = await syncBoth(deviceB)
  assert.equal(conflicted.report.conflicts.length, 1)
  assert.equal(conflicted.report.conflicts[0].file, 'cordis.patch.yml')
  assert.match(conflicted.report.conflicts[0].remoteFile, /^cordis\.patch\.yml\.remote-dev-b-\d{8}-\d{6}(-\d+)?$/u)
  assert.deepEqual(conflicted.report.pushed, [])
  assert.deepEqual(conflicted.report.pulled, [])
  assert.deepEqual(conflicted.report.errors, [])
  assert.deepEqual(conflicted.report.localCopies, [])
  assert.equal(deviceB.read('cordis.patch.yml'), localVersion, 'the local version is kept')
  assert.equal(deviceB.read(conflicted.report.conflicts[0].remoteFile), remoteVersion)

  const copy = conflicted.report.conflicts[0].remoteFile
  const resolved = await deviceB.run(() => deviceB.engine.resolveConflict({ file: 'cordis.patch.yml', action: 'use-remote' }))
  assert.equal(resolved.report.applied, true)
  assert.equal(deviceB.read('cordis.patch.yml'), remoteVersion)
  assert.equal(deviceB.exists(copy), false)
  assert.equal((await deviceB.run(() => deviceB.engine.describe())).conflicts.length, 0)

  // Both devices settled.
  for (const device of [deviceA, deviceB]) {
    const settled = await syncBoth(device)
    assert.equal(settled.ok, true)
    assert.deepEqual(settled.report.pushed, [])
    assert.deepEqual(settled.report.pulled, [])
    assert.deepEqual(settled.report.errors, [])
  }

  // Manifest refresh keeps working from either device (this is what used to 422).
  deviceB.append('cordis.patch.yml', '# from B after resolve\n')
  const pushedB = await syncBoth(deviceB)
  assert.equal(pushedB.ok, true)
  assert.deepEqual(pushedB.report.errors, [])
  assert.deepEqual(pushedB.report.pushed, ['cordis.patch.yml'])
  const manifestAfterB = readRemoteManifest(server)
  assert.equal(manifestAfterB.deviceName, 'dev-b')
  assert.equal(manifestAfterB.files['cordis.patch.yml'].sha256, deviceB.sha('cordis.patch.yml'))

  const pulledA = await syncBoth(deviceA)
  assert.equal(pulledA.ok, true)
  assert.deepEqual(pulledA.report.pulled, ['cordis.patch.yml'])
  assert.equal(deviceA.read('cordis.patch.yml'), deviceB.read('cordis.patch.yml'))

  deviceA.append('cordis.patch.yml', '# from A after resolve\n')
  const pushedA2 = await syncBoth(deviceA)
  assert.equal(pushedA2.ok, true)
  assert.deepEqual(pushedA2.report.errors, [])
  assert.deepEqual(pushedA2.report.pushed, ['cordis.patch.yml'])
  const manifestAfterA = readRemoteManifest(server)
  assert.equal(manifestAfterA.deviceName, 'dev-a')
  assert.equal(manifestAfterA.files['cordis.patch.yml'].sha256, deviceA.sha('cordis.patch.yml'))

  const pulledB = await syncBoth(deviceB)
  assert.equal(pulledB.ok, true)
  assert.deepEqual(pulledB.report.pulled, ['cordis.patch.yml'])
  assert.equal(deviceB.read('cordis.patch.yml'), deviceA.read('cordis.patch.yml'))
  assertGithubRequestIsolation(server, tracker)
})

test('an encrypted GitHub remote round-trips between devices (payload level)', async (t) => {
  const { root, server, tracker } = await setup(t, 'it-github-crypto-')

  const deviceA = createDevice({ root, label: 'a', files: PROFILE_FILES })
  await configureGithub(deviceA, server)
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
    assert.notEqual(stored.toString('utf8'), deviceA.read(rel))
    // Manifest hashes are plaintext hashes, so planning needs no passphrase.
    assert.equal(manifest.files[rel].sha256, deviceA.sha(rel))
    assert.match(manifest.files[rel].etag, /^[0-9a-f]{40}$/u)
  }

  const deviceB = createDevice({ root, label: 'b' })
  await configureGithub(deviceB, server)
  await enableCrypto(deviceB, PASSPHRASE)
  const manifestShaBeforeB = server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).sha
  const pulled = await syncBoth(deviceB)
  assert.equal(pulled.ok, true)
  assert.deepEqual(pulled.report.errors, [])
  assert.deepEqual([...pulled.report.pulled].sort(), [...SCOPE].sort())
  assert.deepEqual(pulled.report.localCopies, [])
  for (const rel of SCOPE) {
    assert.equal(deviceB.read(rel), deviceA.read(rel))
    assert.equal(parseEnvelope(deviceB.bytes(rel)), null, `${rel} must be plaintext locally`)
  }
  // Pull-only: the encrypted manifest is left as A wrote it.
  assert.equal(server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`).sha, manifestShaBeforeB)
  assert.equal(readRemoteManifest(server).crypto.enabled, true)
  assertGithubRequestIsolation(server, tracker)
})

test('the GitHub harness keeps all state under the temp DSH_HOME and off the public network', async (t) => {
  const initialHome = process.env.DSH_HOME
  const { root, server, tracker } = await setup(t, 'it-github-isolation-')
  const device = createDevice({ root, label: 'iso', files: PROFILE_FILES })

  assertTempIsolation(device, root)
  assert.notEqual(path.resolve(device.home), path.resolve(path.join(os.homedir(), '.dsh')))
  await configureGithub(device, server)
  await syncBoth(device)
  assert.equal(process.env.DSH_HOME, initialHome, 'DSH_HOME must be restored after every engine call')

  for (const url of tracker.urls) assert.equal(new URL(url).hostname, '127.0.0.1', `unexpected host: ${url}`)
  assertFetchIsLocal(tracker, server.apiUrl)
  for (const key of server.files.keys()) assert.ok(key.startsWith(`${REMOTE_PATH}/`))
  assert.deepEqual(device.files(), [...SCOPE].sort())
})
