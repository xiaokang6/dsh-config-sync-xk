/**
 * Engine tests against an in-memory remote.
 *
 * These exercise the real planning/apply state machine (merge base, conflicts,
 * backups, the empty-dependencies guard) without any network or adapter
 * dependency: `createRemote` is injected through `remoteFactory`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { SyncEngine } from '../../lib/sync/engine.js'
import { MANIFEST_FILE, parseManifest, serializeManifest, sha256Hex, buildManifest, remoteFileFor } from '../../lib/sync/manifest.js'

const SCOPE = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']
const tempRoots = []

after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

function createMemoryRemote() {
  const store = new Map()
  let counter = 0
  return {
    kind: 'webdav',
    label: 'memory',
    root: 'memory://root',
    store,
    async probe() {
      return { ok: true, latencyMs: 1, detail: '' }
    },
    async read(rel) {
      const hit = store.get(rel)
      if (hit === undefined) return { found: false }
      return { found: true, bytes: Buffer.from(hit.bytes), etag: hit.etag, mtime: Date.now() }
    },
    async write(rel, bytes, opts = {}) {
      const current = store.get(rel)
      if (opts.etag !== undefined && (current === undefined || current.etag !== opts.etag)) {
        throw new Error('etag mismatch')
      }
      const etag = `e${++counter}`
      store.set(rel, { bytes: Buffer.from(bytes), etag })
      return { etag, mtime: Date.now() }
    },
    async remove(rel) {
      store.delete(rel)
    },
    async list(dir) {
      return [...store.keys()].filter((key) => key.startsWith(`${dir}/`)).map((key) => ({ name: path.posix.basename(key), path: key, isDir: false, size: store.get(key).bytes.length }))
    },
    async ensureDir() {},
  }
}

function ref(value) {
  return { get: () => value }
}

function makeEngine({ files = {}, config = {}, remote: injectedRemote } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-sync-engine-'))
  tempRoots.push(root)
  process.env.DSH_HOME = path.join(root, 'dsh')
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  const defaults = {
    'package.json': JSON.stringify({ name: 'p', dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a'] } } }, null, 2) + '\n',
    'cordis.patch.yml': '- id: a\n  config: {}\n',
    'cordis.yml': '[]\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    ...files,
  }
  for (const [rel, content] of Object.entries(defaults)) {
    if (content !== null) fs.writeFileSync(path.join(profileDir, rel), content)
  }
  const remote = injectedRemote ?? createMemoryRemote()
  const logLines = []
  const log = {
    info: (event, detail) => logLines.push({ level: 'info', event, detail }),
    warn: (event, detail) => logLines.push({ level: 'warn', event, detail }),
    error: (event, detail) => logLines.push({ level: 'error', event, detail }),
    tail: () => logLines,
    exportText: () => logLines.map((line) => JSON.stringify(line)).join('\n'),
  }
  const engine = new SyncEngine({
    profileName: 'test',
    profileDir,
    config: {
      scope: ref(SCOPE),
      direction: ref('both'),
      cryptoEnabled: ref(false),
      allowEmptyDependencies: ref(false),
      pnpmInstall: ref(false),
      remotePath: ref('dsh-config-sync'),
      profileDir: ref(''),
      ...config,
    },
    log,
    remoteFactory: () => remote,
  })
  engine.saveSettings({ remote: { kind: 'webdav', baseUrl: 'https://example.com/dav', username: 'u', password: 'p', path: 'root' } })
  return { engine, remote, profileDir, root, logLines }
}

function readRemoteManifest(remote) {
  const hit = remote.store.get(MANIFEST_FILE)
  assert.ok(hit !== undefined, 'remote manifest should exist')
  return parseManifest(hit.bytes)
}

test('first sync pushes every file and the manifest', async () => {
  const { engine, remote } = makeEngine()
  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.deepEqual(report.pushed.sort(), [...SCOPE].sort())
  assert.equal(report.pulled.length, 0)
  assert.equal(report.errors.length, 0)
  assert.equal(report.restartRequired, false)
  const manifest = readRemoteManifest(remote)
  assert.equal(Object.keys(manifest.files).length, SCOPE.length)
  assert.equal(manifest.files['package.json'].sha256, sha256Hex(Buffer.from(fs.readFileSync(path.join(engine.profileDir, 'package.json')))))
  assert.ok(remote.store.has(remoteFileFor('package.json')))
})

test('a second sync is a no-op', async () => {
  const { engine } = makeEngine()
  await engine.sync({ direction: 'both' })
  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.deepEqual(report.pushed, [])
  assert.deepEqual(report.pulled, [])
  assert.deepEqual(report.errors, [])
})

test('a local edit is pushed', async () => {
  const { engine, remote } = makeEngine()
  await engine.sync({ direction: 'both' })
  const edited = fs.readFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), 'utf8') + '# edited\n'
  fs.writeFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), edited)
  const plan = await engine.check({ direction: 'both' }).then((result) => result.plan)
  assert.equal(plan.files.find((item) => item.file === 'cordis.patch.yml').action, 'push')
  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.deepEqual(report.pushed, ['cordis.patch.yml'])
  assert.equal(readRemoteManifest(remote).files['cordis.patch.yml'].sha256, sha256Hex(Buffer.from(edited)))
})

test('a remote change is pulled', async () => {
  const { engine, remote } = makeEngine()
  await engine.sync({ direction: 'both' })
  const remoteNew = '[]\n# from the other device\n'
  const bytes = Buffer.from(remoteNew)
  const manifest = readRemoteManifest(remote)
  manifest.files['cordis.patch.yml'] = { sha256: sha256Hex(bytes), size: bytes.length, remotePath: remoteFileFor('cordis.patch.yml'), etag: 'other' }
  remote.store.set(remoteFileFor('cordis.patch.yml'), { bytes, etag: 'other2' })
  remote.store.set(MANIFEST_FILE, { bytes: Buffer.from(serializeManifest(manifest)), etag: 'm2' })

  const plan = await engine.check({ direction: 'both' }).then((result) => result.plan)
  assert.equal(plan.files.find((item) => item.file === 'cordis.patch.yml').action, 'pull')
  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.deepEqual(report.pulled, ['cordis.patch.yml'])
  assert.equal(fs.readFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), 'utf8'), remoteNew)
  assert.equal(report.restartRequired, true)
})

test('diverged files become conflicts and keep the local file', async () => {
  const { engine, remote } = makeEngine()
  await engine.sync({ direction: 'both' })
  const localNew = '- id: a\n  config: { local: true }\n'
  fs.writeFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), localNew)
  const remoteNew = '- id: a\n  config: { remote: true }\n'
  const bytes = Buffer.from(remoteNew)
  const manifest = readRemoteManifest(remote)
  manifest.files['cordis.patch.yml'] = { sha256: sha256Hex(bytes), size: bytes.length, remotePath: remoteFileFor('cordis.patch.yml'), etag: 'other' }
  remote.store.set(remoteFileFor('cordis.patch.yml'), { bytes, etag: 'other2' })
  remote.store.set(MANIFEST_FILE, { bytes: Buffer.from(serializeManifest(manifest)), etag: 'm2' })

  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.conflicts[0].file, 'cordis.patch.yml')
  assert.equal(fs.readFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), 'utf8'), localNew)
  assert.ok(fs.existsSync(path.join(engine.profileDir, report.conflicts[0].remoteFile)))
  assert.equal(engine.describe().conflicts.length, 1)

  const resolved = await engine.resolveConflict({ file: 'cordis.patch.yml', action: 'use-remote' }).then((result) => result.report)
  assert.equal(resolved.applied, true)
  assert.equal(fs.readFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), 'utf8'), remoteNew)
  assert.equal(engine.describe().conflicts.length, 0)
})

test('a brand-new device adopts the remote on its first sync', async () => {
  const a = makeEngine()
  await a.engine.sync({ direction: 'both' })

  const b = makeEngine({ remote: a.remote, files: { 'cordis.patch.yml': '- id: local-only\n' } })
  const report = await b.engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.equal(report.errors.length, 0)
  assert.deepEqual(report.pulled, ['cordis.patch.yml'])
  assert.equal(report.conflicts.length, 0)
  assert.equal(report.localCopies.length, 1)
  assert.equal(fs.readFileSync(path.join(b.engine.profileDir, 'cordis.patch.yml'), 'utf8'), '- id: a\n  config: {}\n')
  assert.equal(fs.readFileSync(path.join(b.engine.profileDir, report.localCopies[0].copy), 'utf8'), '- id: local-only\n')
})

test('the empty-dependencies guard refuses a destructive pull', async () => {
  const { engine, remote } = makeEngine()
  await engine.sync({ direction: 'both' })
  const emptyManifest = JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n'
  const bytes = Buffer.from(emptyManifest)
  const manifest = readRemoteManifest(remote)
  manifest.files['package.json'] = { sha256: sha256Hex(bytes), size: bytes.length, remotePath: remoteFileFor('package.json'), etag: 'other' }
  remote.store.set(remoteFileFor('package.json'), { bytes, etag: 'other2' })
  remote.store.set(MANIFEST_FILE, { bytes: Buffer.from(serializeManifest(manifest)), etag: 'm2' })

  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.equal(report.pulled.includes('package.json'), false)
  assert.match(report.errors.map((entry) => entry.error).join('\n'), /没有任何依赖/u)
  assert.equal(JSON.parse(fs.readFileSync(path.join(engine.profileDir, 'package.json'), 'utf8')).dependencies.a, '1.0.0')
})

test('direction filters what a sync applies', async () => {
  const { engine, remote } = makeEngine()
  await engine.sync({ direction: 'both' })
  const localNew = '- id: a\n  config: { local: true }\n'
  fs.writeFileSync(path.join(engine.profileDir, 'cordis.patch.yml'), localNew)
  const planPushOnly = await engine.check({ direction: 'push' }).then((result) => result.plan)
  assert.equal(planPushOnly.files.find((item) => item.file === 'cordis.patch.yml').action, 'push')

  const remoteBytes = Buffer.from('[]\n# remote only\n')
  const manifest = readRemoteManifest(remote)
  manifest.files['cordis.yml'] = { sha256: sha256Hex(remoteBytes), size: remoteBytes.length, remotePath: remoteFileFor('cordis.yml'), etag: 'x' }
  remote.store.set(remoteFileFor('cordis.yml'), { bytes: remoteBytes, etag: 'x2' })
  remote.store.set(MANIFEST_FILE, { bytes: Buffer.from(serializeManifest(manifest)), etag: 'm3' })
  const planPullOnly = await engine.check({ direction: 'pull' }).then((result) => result.plan)
  assert.equal(planPullOnly.files.find((item) => item.file === 'cordis.yml').action, 'pull')
  assert.equal(planPullOnly.files.find((item) => item.file === 'cordis.patch.yml').action, 'skipped')
})

test('an encrypted remote round-trips with a passphrase', async () => {
  const { engine, remote } = makeEngine()
  engine.saveSettings({ crypto: { enabled: true, passphrase: 'passphrase123' } })
  const report = await engine.sync({ direction: 'both' }).then((result) => result.report)
  assert.equal(report.errors.length, 0)
  assert.equal(readRemoteManifest(remote).crypto.enabled, true)
  const stored = remote.store.get(remoteFileFor('package.json')).bytes
  assert.ok(stored.toString('utf8').startsWith('{'))
  assert.ok(JSON.parse(stored.toString('utf8')).alg === 'aes-256-gcm')

  // A device with encryption switched on but no passphrase cannot sync at all.
  const fresh = makeEngine({
    remote,
    files: { 'package.json': '{"name":"other","dependencies":{}}\n' },
    config: { cryptoEnabled: ref(true) },
  })
  await assert.rejects(fresh.engine.sync({ direction: 'pull' }), /口令|passphrase/u)

  // A wrong passphrase fails per file, without touching the profile.
  const wrong = makeEngine({ remote, files: { 'cordis.patch.yml': '- id: other\n' } })
  wrong.engine.saveSettings({ crypto: { enabled: true, passphrase: 'wrong-pass' } })
  const failed = await wrong.engine.sync({ direction: 'pull' }).then((result) => result.report)
  assert.match(failed.errors.map((entry) => entry.error).join('\n'), /wrong passphrase|口令不对|解密失败/iu)
  assert.equal(fs.readFileSync(path.join(wrong.engine.profileDir, 'cordis.patch.yml'), 'utf8'), '- id: other\n')
})
