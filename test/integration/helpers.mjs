/**
 * Shared harness for engine ↔ real-adapter integration tests.
 *
 * Unlike `test/unit/engine.test.mjs` this does NOT inject a fake remote:
 * every device gets a real `SyncEngine` wired to `createRemote()`, which talks
 * to an in-memory mock WebDAV / GitHub server over real HTTP (127.0.0.1).
 *
 * Isolation rules (each test asserts them):
 *  - every device gets its OWN temporary `$DSH_HOME` and profile directory under
 *    one `mkdtemp()` root — never the real `~/.dsh` and never the repo profile;
 *  - `process.env.DSH_HOME` is set only for the duration of one awaited engine
 *    call (`device.run()`), because `paths.js` resolves it on every call;
 *  - `trackFetch()` records every outbound URL so a test can prove nothing was
 *    requested from the public network.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { SyncEngine } from '../../lib/sync/engine.js'
import { createRemote } from '../../lib/sync/remotes/index.js'
import { MANIFEST_FILE, parseManifest, remoteFileFor, sha256Hex } from '../../lib/sync/manifest.js'

/** Remote root prefix used by every integration test. */
export const REMOTE_PATH = 'dsh-config-sync'
/** Profile name used for the per-profile state file. */
export const STATE_PROFILE = 'integration'
/** The four files the design doc says are synced. */
export const SCOPE = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']

/** A realistic, valid profile payload. */
export const PROFILE_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'profile', dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a'] } } }, null, 2)}\n`,
  'cordis.patch.yml': '- id: a\n  config: {}\n',
  'cordis.yml': '[]\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
})

/** Create the temporary root that holds every device home + profile. */
export function createTempRoot(prefix = 'dsh-config-sync-it-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Remove a temp root (best effort). */
export function cleanupTempRoot(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

/** A minimal logger matching the engine's expectations. */
export function createLogger() {
  const lines = []
  const push = (level) => (event, detail) => lines.push({ level, event, detail })
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), tail: () => lines, exportText: () => lines.map((line) => JSON.stringify(line)).join('\n') }
}

/**
 * Create one simulated device: its own DSH_HOME (device id, remote.json, state,
 * backups) and its own profile directory, plus a real-adapter SyncEngine.
 *
 * @param {{ root: string, label: string, files?: Record<string,string>, config?: object }} options
 */
export function createDevice({ root, label, files = {}, config = {} }) {
  const home = path.join(root, `home-${label}`)
  const profileDir = path.join(root, `profile-${label}`)
  fs.mkdirSync(path.join(home, 'config-sync'), { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  // Deterministic identity so conflict copies carry a known device tag.
  fs.writeFileSync(
    path.join(home, 'config-sync', 'device.json'),
    `${JSON.stringify({ schema: 1, id: randomUUID(), name: `dev-${label}` })}\n`,
  )
  for (const [rel, content] of Object.entries(files)) {
    if (content === undefined || content === null) continue
    const abs = path.join(profileDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  const logger = createLogger()
  const engineConfig = {
    scope: [...SCOPE],
    direction: 'both',
    cryptoEnabled: false,
    allowEmptyDependencies: false,
    pnpmInstall: false, // tests must never spawn pnpm
    remotePath: REMOTE_PATH,
    profileDir: '',
    ...config,
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let engine
  try {
    engine = new SyncEngine({
      profileName: STATE_PROFILE,
      profileDir,
      config: engineConfig,
      log: logger,
      remoteFactory: (settings) => createRemote(settings), // the REAL adapters
    })
  } finally {
    restoreHome(previousHome)
  }

  const abs = (rel) => path.join(profileDir, ...rel.split('/'))

  return {
    label,
    home,
    profileDir,
    engine,
    logLines: logger.lines,
    /** Run one engine operation with DSH_HOME pointed at this device. */
    async run(fn) {
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = home
      try {
        return await fn()
      } finally {
        restoreHome(previous)
      }
    },
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    bytes: (rel) => fs.readFileSync(abs(rel)),
    sha: (rel) => sha256Hex(fs.readFileSync(abs(rel))),
    exists: (rel) => fs.existsSync(abs(rel)),
    write(rel, content) {
      const target = abs(rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    },
    append(rel, content) {
      fs.appendFileSync(abs(rel), content)
    },
    /** Relative POSIX paths of every file in the profile directory. */
    files() {
      return listFiles(profileDir)
    },
  }
}

function restoreHome(previous) {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
}

function listFiles(root, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else out.push(rel)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

/** Point a device at the mock WebDAV server (stores real remote.json). */
export async function configureWebdav(device, server, overrides = {}) {
  return device.run(() =>
    device.engine.saveSettings({
      remote: {
        kind: 'webdav',
        baseUrl: server.url,
        username: server.username,
        password: server.password,
        path: REMOTE_PATH,
        ...overrides,
      },
    }),
  )
}

/** Point a device at the mock GitHub Contents API (apiUrl override). */
export async function configureGithub(device, server, overrides = {}) {
  return device.run(() =>
    device.engine.saveSettings({
      remote: {
        kind: 'github',
        owner: server.owner,
        repo: server.repo,
        branch: server.branch,
        token: server.token,
        apiUrl: server.apiUrl,
        path: REMOTE_PATH,
        ...overrides,
      },
    }),
  )
}

/** Enable remote encryption for one device. */
export async function enableCrypto(device, passphrase) {
  return device.run(() => device.engine.saveSettings({ crypto: { enabled: true, passphrase } }))
}

/** `engine.sync({ direction: 'both' })`, with DSH_HOME scoped to the device. */
export async function syncBoth(device) {
  return device.run(() => device.engine.sync({ direction: 'both' }))
}

/** `engine.probe()`, with DSH_HOME scoped to the device. */
export async function probe(device) {
  return device.run(() => device.engine.probe())
}

/** `engine.describe()`, with DSH_HOME scoped to the device. */
export async function describe(device) {
  return device.run(() => device.engine.describe())
}

// ---------------------------------------------------------------------------
// Remote / local assertions helpers
// ---------------------------------------------------------------------------

/** The manifest stored on the mock remote, parsed; null when absent. */
export function readRemoteManifest(server) {
  const hit = server.files.get(`${REMOTE_PATH}/${MANIFEST_FILE}`)
  return hit === undefined ? null : parseManifest(hit.bytes)
}

/** Stored bytes of one payload on the mock remote. */
export function remoteBytes(server, rel) {
  const hit = server.files.get(`${REMOTE_PATH}/${remoteFileFor(rel)}`)
  return hit === undefined ? undefined : hit.bytes
}

/** The per-profile state file this device wrote under its temporary DSH_HOME. */
export function stateJson(device) {
  const file = path.join(device.home, 'config-sync', 'state', `${STATE_PROFILE}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Assert the device's local state lives in the temporary root, not a real home. */
export function assertTempIsolation(device, root) {
  const resolvedRoot = path.resolve(root)
  const resolvedHome = path.resolve(device.home)
  const resolvedProfile = path.resolve(device.profileDir)
  assert.ok(resolvedHome.startsWith(`${resolvedRoot}${path.sep}`), `DSH_HOME must be under the temp root: ${resolvedHome}`)
  assert.ok(resolvedProfile.startsWith(`${resolvedRoot}${path.sep}`), `profile must be under the temp root: ${resolvedProfile}`)
  assert.notEqual(resolvedHome, path.resolve(path.join(os.homedir(), '.dsh')), 'DSH_HOME must not be the real ~/.dsh')
}

/** Record every fetch URL, delegating to the real fetch. */
export function trackFetch() {
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    urls.push(String(url))
    return original(input, init)
  }
  return {
    urls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** Assert every recorded request went to the mock server origin (no real network). */
export function assertFetchIsLocal(tracker, serverUrl) {
  const origin = new URL(serverUrl).origin
  assert.ok(tracker.urls.length > 0, 'expected at least one HTTP request to the mock server')
  for (const url of tracker.urls) {
    assert.ok(
      url === origin || url.startsWith(`${origin}/`),
      `unexpected network request outside the mock server: ${url}`,
    )
  }
}
