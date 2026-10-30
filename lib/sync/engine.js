/**
 * The sync engine: plan → apply → conflicts → merge base.
 *
 * One instance serves one profile. Every mutating operation is serialized on
 * `busy`, always writes a local backup first, and never touches `node_modules`:
 * a pulled manifest change is followed by `pnpm install` (unless disabled) and
 * a "restart required" signal instead.
 *
 * @module dsh-config-sync/sync/engine
 */

import fs from 'node:fs'
import path from 'node:path'

import { createRemote } from './remotes/index.js'
import { createBackup, isValidBackupId, listBackups, restoreBackup } from './backup.js'
import { decryptBytes, encryptBytes, parseEnvelope } from './crypto.js'
import {
  DEFAULT_SCOPE,
  MANIFEST_FILE,
  buildManifest,
  normalizeScope,
  parseManifest,
  remoteFileFor,
  serializeManifest,
  sha256Hex,
} from './manifest.js'
import {
  deviceTag,
  ensureDataDir,
  ensureDevice,
  readJson,
  remoteSettingsFile,
  safeJoin,
  stateFile,
  timestamp,
  writeBytesAtomic,
  writeJsonAtomic,
} from './paths.js'
import { runPnpmInstall } from './pnpm.js'

/** Directions a sync can take. */
export const DIRECTIONS = ['push', 'pull', 'both']

/** Files whose change makes the host need a restart. */
const RESTART_FILES = new Set(['package.json', 'cordis.patch.yml', 'cordis.yml'])

/** Files whose change may require `pnpm install`. */
const PNPM_FILES = new Set(['package.json', 'pnpm-lock.yaml'])

/** Default remote root prefix. */
export const DEFAULT_REMOTE_PATH = 'dsh-config-sync'

/** Guard against a pathological remote file. */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Normalize a direction, falling back to `both`. */
export function normalizeDirection(value, fallback = 'both') {
  return DIRECTIONS.includes(value) ? value : (DIRECTIONS.includes(fallback) ? fallback : 'both')
}

/** POSIX-normalize the configured remote root: no leading/trailing slash, no `..`. */
export function normalizeRemotePath(value, fallback = DEFAULT_REMOTE_PATH) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  const parts = raw.replace(/\\/gu, '/').split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) throw new Error(`remote path may not contain "..": ${raw}`)
  return parts.join('/')
}

/** Stable identity string of a remote configuration, used to invalidate the merge base. */
export function remoteKeyOf(settings) {
  const base = settings.kind === 'webdav'
    ? `webdav|${settings.baseUrl}|${settings.path}`
    : `github|${settings.owner}/${settings.repo}|${settings.branch}|${settings.path}`
  return sha256Hex(Buffer.from(base, 'utf8')).slice(0, 16)
}

/** Human-readable remote root for the UI. */
export function remoteRootOf(settings) {
  if (settings.kind === 'webdav') {
    const base = String(settings.baseUrl ?? '').replace(/\/+$/u, '')
    return settings.path === '' ? base : `${base}/${settings.path}`
  }
  if (settings.kind === 'github') {
    return `${settings.owner}/${settings.repo}@${settings.branch}:${settings.path}`
  }
  return ''
}

/** Read one live config ref, falling back when absent. */
function readRef(config, key, fallback) {
  const ref = config?.[key]
  if (ref !== null && typeof ref === 'object' && typeof ref.get === 'function') {
    const value = ref.get()
    return value === undefined || value === null ? fallback : value
  }
  return ref === undefined || ref === null ? fallback : ref
}

/** Convert stored settings into the adapter's settings shape. */
function adapterSettings(settings) {
  const pathPrefix = normalizeRemotePath(settings.path)
  if (settings.kind === 'github') {
    return {
      kind: 'github',
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch === '' ? 'main' : settings.branch,
      path: pathPrefix,
      token: settings.token,
      ...(typeof settings.apiUrl === 'string' && settings.apiUrl !== '' ? { apiUrl: settings.apiUrl } : {}),
    }
  }
  return {
    kind: 'webdav',
    baseUrl: settings.baseUrl,
    username: settings.username,
    password: settings.password,
    path: pathPrefix,
    ...(Number.isFinite(settings.timeoutMs) ? { timeoutMs: settings.timeoutMs } : {}),
  }
}

/** The sync engine for one profile. */
export class SyncEngine {
  /**
   * @param {{ profileName: string, profileDir: string, config: any, log: any, hostManager?: any, version?: string, remoteFactory?: (settings: any) => any }} options
   */
  constructor({ profileName, profileDir, config, log, hostManager = null, version = '0.1.0', remoteFactory = createRemote }) {
    this.profileName = profileName
    this.profileDir = profileDir
    this.config = config
    this.log = log
    this.hostManager = hostManager
    this.version = version
    this.remoteFactory = remoteFactory
    this.device = ensureDevice()
    this.busy = false
    this.pendingRestart = false
    this.lastProbe = null
    ensureDataDir()
  }

  /** Live plugin configuration (volatile refs). */
  getConfig() {
    return {
      scope: readRef(this.config, 'scope', DEFAULT_SCOPE),
      direction: normalizeDirection(readRef(this.config, 'direction', 'both')),
      cryptoEnabled: readRef(this.config, 'cryptoEnabled', false) === true,
      allowEmptyDependencies: readRef(this.config, 'allowEmptyDependencies', false) === true,
      pnpmInstall: readRef(this.config, 'pnpmInstall', true) !== false,
      remotePath: readRef(this.config, 'remotePath', ''),
      profileDir: readRef(this.config, 'profileDir', ''),
      autoSyncOnStart: readRef(this.config, 'autoSyncOnStart', true) !== false,
      autoSyncDelayMs: Math.min(300000, Math.max(0, Number(readRef(this.config, 'autoSyncDelayMs', 15000)) || 0)),
    }
  }

  /** Effective settings: local remote.json over plugin defaults. */
  readSettings() {
    const stored = readJson(remoteSettingsFile(), {}) ?? {}
    const cfg = this.getConfig()
    const defaultPath = `${DEFAULT_REMOTE_PATH}/${this.profileName}`
    const remotePath = normalizeRemotePath(
      typeof stored.path === 'string' && stored.path !== ''
        ? stored.path
        : (typeof cfg.remotePath === 'string' && cfg.remotePath !== '' ? cfg.remotePath : defaultPath),
      defaultPath,
    )
    return {
      kind: stored.kind === 'github' ? 'github' : (stored.kind === 'webdav' ? 'webdav' : ''),
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
      username: typeof stored.username === 'string' ? stored.username : '',
      password: typeof stored.password === 'string' ? stored.password : '',
      owner: typeof stored.owner === 'string' ? stored.owner : '',
      repo: typeof stored.repo === 'string' ? stored.repo : '',
      branch: typeof stored.branch === 'string' && stored.branch !== '' ? stored.branch : 'main',
      token: typeof stored.token === 'string' ? stored.token : '',
      path: remotePath,
      apiUrl: typeof stored.apiUrl === 'string' ? stored.apiUrl : '',
      timeoutMs: Number.isFinite(stored.timeoutMs) ? stored.timeoutMs : undefined,
      crypto: {
        enabled: stored.crypto?.enabled === undefined ? cfg.cryptoEnabled : stored.crypto.enabled === true,
        passphrase: typeof stored.crypto?.passphrase === 'string' ? stored.crypto.passphrase : '',
      },
      scope: normalizeScope(Array.isArray(stored.scope) && stored.scope.length > 0 ? stored.scope : cfg.scope),
      direction: normalizeDirection(stored.direction, cfg.direction),
      allowEmptyDependencies: stored.allowEmptyDependencies === undefined ? cfg.allowEmptyDependencies : stored.allowEmptyDependencies === true,
      pnpmInstall: stored.pnpmInstall === undefined ? cfg.pnpmInstall : stored.pnpmInstall !== false,
      autoSyncOnStart: stored.autoSyncOnStart === undefined ? cfg.autoSyncOnStart : stored.autoSyncOnStart !== false,
    }
  }

  /** Public description for GET /config (secrets reduced to booleans). */
  describeSettings() {
    const s = this.readSettings()
    return {
      remote: {
        kind: s.kind,
        baseUrl: s.baseUrl,
        username: s.username,
        path: s.path,
        owner: s.owner,
        repo: s.repo,
        branch: s.branch,
        hasPassword: s.password !== '',
        hasToken: s.token !== '',
      },
      crypto: { enabled: s.crypto.enabled, hasPassphrase: s.crypto.passphrase !== '' },
      scope: s.scope,
      direction: s.direction,
      allowEmptyDependencies: s.allowEmptyDependencies,
      pnpmInstall: s.pnpmInstall,
      autoSyncOnStart: s.autoSyncOnStart,
    }
  }

  /** Persist settings coming from the UI. Empty secret strings clear a stored secret. */
  saveSettings(input) {
    if (input === null || typeof input !== 'object') throw new Error('settings body must be an object')
    const previous = readJson(remoteSettingsFile(), {}) ?? {}
    const next = { ...previous }
    if (input.remote !== undefined) {
      const remote = input.remote
      if (remote === null || typeof remote !== 'object') throw new Error('remote settings must be an object')
      if (remote.kind !== undefined) {
        if (remote.kind !== 'webdav' && remote.kind !== 'github' && remote.kind !== '') {
          throw new Error('remote.kind must be "webdav" or "github" (远端类型只能是 webdav 或 github)')
        }
        next.kind = remote.kind
      }
      for (const key of ['baseUrl', 'username', 'owner', 'repo', 'branch']) {
        if (typeof remote[key] === 'string') next[key] = remote[key].trim()
      }
      if (typeof remote.path === 'string') next.path = normalizeRemotePath(remote.path)
      if (typeof remote.apiUrl === 'string') next.apiUrl = remote.apiUrl.trim()
      if (typeof remote.password === 'string') next.password = remote.password
      if (typeof remote.token === 'string') next.token = remote.token
    }
    if (input.crypto !== undefined) {
      const crypto = input.crypto
      if (crypto === null || typeof crypto !== 'object') throw new Error('crypto settings must be an object')
      const previousCrypto = previous.crypto ?? {}
      next.crypto = { ...previousCrypto }
      if (typeof crypto.enabled === 'boolean') next.crypto.enabled = crypto.enabled
      if (typeof crypto.passphrase === 'string') next.crypto.passphrase = crypto.passphrase
    }
    if (input.scope !== undefined) next.scope = normalizeScope(input.scope)
    if (input.direction !== undefined) next.direction = normalizeDirection(input.direction)
    if (typeof input.allowEmptyDependencies === 'boolean') next.allowEmptyDependencies = input.allowEmptyDependencies
    if (typeof input.pnpmInstall === 'boolean') next.pnpmInstall = input.pnpmInstall
    if (typeof input.autoSyncOnStart === 'boolean') next.autoSyncOnStart = input.autoSyncOnStart
    const merged = { ...next }
    if (merged.kind === 'webdav') {
      merged.baseUrl = typeof merged.baseUrl === 'string' ? merged.baseUrl.trim().replace(/\/+$/u, '') : ''
      if (merged.baseUrl !== '' && !/^https?:\/\//iu.test(merged.baseUrl)) throw new Error('WebDAV Base URL 必须以 http:// 或 https:// 开头')
    }
    if (merged.crypto?.enabled === true && (merged.crypto.passphrase ?? '') === '') {
      throw new Error('已开启加密，但还没有设置口令（encryption is enabled but no passphrase is set）')
    }
    writeJsonAtomic(remoteSettingsFile(), merged, { mode: 0o600 })
    // Re-check what the merged settings now mean, so an invalid combination
    // fails the save instead of failing a later sync.
    this.readSettings()
    this.log.info('settings', { kind: merged.kind, path: merged.path })
    return this.describeSettings()
  }

  /** Settings that must be usable for a network operation. */
  requireRemoteSettings() {
    const s = this.readSettings()
    if (s.kind === '') throw new Error('还没有配置远端（请先在设置页填写坚果云 WebDAV 或 GitHub 参数）')
    if (s.kind === 'webdav') {
      if (s.baseUrl === '' || s.username === '' || s.password === '') {
        throw new Error('WebDAV 配置不完整：需要 Base URL、用户名和应用密码')
      }
    } else {
      if (s.owner === '' || s.repo === '' || s.token === '') {
        throw new Error('GitHub 配置不完整：需要 owner、repo 和 Token')
      }
    }
    if (s.crypto.enabled && s.crypto.passphrase === '') throw new Error('远端加密已开启，但本机没有口令')
    return s
  }

  /** Build an adapter from the current settings. */
  createRemote(settings = this.requireRemoteSettings()) {
    return this.remoteFactory(adapterSettings(settings))
  }

  /** Read the per-profile state (merge base), invalidating it when the remote changed. */
  readState(settings) {
    const raw = readJson(stateFile(this.profileName), {}) ?? {}
    const key = remoteKeyOf(settings)
    const sameRemote = raw.remoteKey === key
    return {
      schema: 1,
      remoteKey: key,
      remoteKind: settings.kind,
      base: sameRemote && raw.base !== null && typeof raw.base === 'object' ? raw.base : {},
      conflicts: sameRemote && Array.isArray(raw.conflicts) ? raw.conflicts : [],
      lastSyncAt: sameRemote && Number.isFinite(raw.lastSyncAt) ? raw.lastSyncAt : 0,
      lastOk: sameRemote ? raw.lastOk === true : false,
      lastDirection: sameRemote && DIRECTIONS.includes(raw.lastDirection) ? raw.lastDirection : 'both',
      staleBase: !sameRemote && raw.base !== undefined,
    }
  }

  /** Persist the per-profile state. */
  writeState(state) {
    writeJsonAtomic(stateFile(this.profileName), {
      schema: 1,
      remoteKey: state.remoteKey,
      remoteKind: state.remoteKind,
      base: state.base ?? {},
      conflicts: state.conflicts ?? [],
      lastSyncAt: state.lastSyncAt ?? 0,
      lastOk: state.lastOk === true,
      lastDirection: state.lastDirection ?? 'both',
    })
  }

  /** Read every scope file from the profile. */
  readLocalFiles(scope) {
    const out = {}
    for (const rel of scope) {
      const abs = safeJoin(this.profileDir, rel)
      try {
        const bytes = fs.readFileSync(abs)
        out[rel] = { sha256: sha256Hex(bytes), size: bytes.length }
      } catch {
        // absent
      }
    }
    return out
  }

  /** GET /status payload (no network). */
  describe() {
    const s = this.readSettings()
    const state = this.readState(s)
    return {
      version: this.version,
      profile: { name: this.profileName, dir: this.profileDir },
      device: { id: this.device.id, name: this.device.name },
      remote: {
        kind: s.kind,
        label: s.kind === 'webdav' ? '坚果云 WebDAV' : (s.kind === 'github' ? 'GitHub' : '未配置'),
        root: remoteRootOf(s),
        configured: s.kind !== '' && (s.kind === 'webdav'
          ? s.baseUrl !== '' && s.username !== '' && s.password !== ''
          : s.owner !== '' && s.repo !== '' && s.token !== ''),
        hasPassword: s.password !== '',
        hasToken: s.token !== '',
        probe: this.lastProbe,
      },
      scope: s.scope,
      crypto: { enabled: s.crypto.enabled, hasPassphrase: s.crypto.passphrase !== '' },
      direction: s.direction,
      busy: this.busy,
      pendingRestart: this.pendingRestart,
      lastSync: state.lastSyncAt === 0 ? null : { at: state.lastSyncAt, remote: state.remoteKind, ok: state.lastOk },
      conflicts: state.conflicts,
      backups: listBackups({ limit: 10 }),
    }
  }

  /** Probe the remote; never throws for a probe failure. */
  async probe() {
    const settings = this.requireRemoteSettings()
    const remote = this.createRemote(settings)
    const startedAt = Date.now()
    try {
      const result = await remote.probe()
      this.lastProbe = { ok: result.ok === true, latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : Date.now() - startedAt, detail: result.detail ?? '', at: Date.now() }
    } catch (error) {
      this.lastProbe = { ok: false, latencyMs: Date.now() - startedAt, detail: errorMessage(error), at: Date.now() }
    }
    this.log.info('probe', this.lastProbe)
    return { ok: true, probe: this.lastProbe }
  }

  /**
   * Build a plan without writing anything.
   * @param {string} direction
   * @param {{ remote?: any, settings?: any }} [prepared]
   */
  async buildPlan(direction, prepared) {
    const settings = prepared?.settings ?? this.requireRemoteSettings()
    const remote = prepared?.remote ?? this.createRemote(settings)
    const dir = normalizeDirection(direction, settings.direction)
    const state = this.readState(settings)
    // A device joining an existing remote has no merge base for anything: its
    // own profile was composed locally, the remote one came from another
    // machine. Treating that as a conflict for every file would make the first
    // run on a new device a wall of conflicts, so the remote is adopted once —
    // with the local version kept as a `.local-*` copy next to it.
    const firstSync = Object.keys(state.base).length === 0 && state.lastSyncAt === 0
    const local = this.readLocalFiles(settings.scope)

    const manifestResult = await remote.read(MANIFEST_FILE)
    const manifest = manifestResult.found === true ? parseManifest(manifestResult.bytes) : null
    if (manifest !== null && manifest.crypto.enabled !== settings.crypto.enabled) {
      throw new Error(manifest.crypto.enabled
        ? '远端数据是加密的，但本机没开加密：请打开加密并填入口令后再同步（remote is encrypted; enable encryption locally with the same passphrase）'
        : '本机开了加密，但远端数据是明文：请关闭加密或先上传（local encryption is on but the remote is plaintext）')
    }
    const remoteFiles = manifest?.files ?? {}

    const files = []
    for (const rel of settings.scope) {
      const l = local[rel]
      const r = remoteFiles[rel]
      const baseSha = typeof state.base[rel] === 'string' ? state.base[rel] : undefined
      let action = 'same'
      let reason = ''
      if (l === undefined && r === undefined) {
        action = 'same'
        reason = 'absent'
      } else if (l === undefined) {
        if (baseSha === r.sha256) { action = 'skipped'; reason = 'deleted-locally' } else { action = 'pull' }
      } else if (r === undefined) {
        if (baseSha === l.sha256) { action = 'skipped'; reason = 'deleted-remotely' } else { action = 'push' }
      } else if (l.sha256 === r.sha256) {
        action = 'same'
      } else if (baseSha === undefined) {
        if (dir === 'push') {
          action = 'push'
        } else if (firstSync) {
          action = 'pull'
          reason = 'first-sync-adopt-remote'
        } else {
          action = 'conflict'
          reason = 'diverged-without-base'
        }
      } else if (l.sha256 === baseSha) {
        action = 'pull'
      } else if (r.sha256 === baseSha) {
        action = 'push'
      } else {
        action = 'conflict'
        reason = 'both-changed'
      }
      if (dir === 'push' && action === 'pull') { action = 'skipped'; reason = 'direction-push' }
      if (dir === 'pull' && action === 'push') { action = 'skipped'; reason = 'direction-pull' }
      files.push({
        file: rel,
        localSha: l?.sha256 ?? null,
        remoteSha: r?.sha256 ?? null,
        baseSha: baseSha ?? null,
        action,
        ...(reason === '' ? {} : { reason }),
        ...(reason === 'first-sync-adopt-remote' ? { preserveLocalCopy: true } : {}),
        ...(r?.remotePath === undefined ? {} : { remotePath: r.remotePath }),
        ...(r?.etag === undefined ? {} : { remoteEtag: r.etag }),
      })
    }
    const summary = { push: 0, pull: 0, conflict: 0, same: 0, skipped: 0 }
    for (const item of files) summary[item.action] = (summary[item.action] ?? 0) + 1
    return {
      direction: dir,
      files,
      summary,
      manifest,
      manifestEtag: manifestResult.etag,
      state,
      settings,
    }
  }

  /** Decrypt (when needed) and validate one remote payload. */
  async fetchPlain(remote, settings, item) {
    const remotePath = item.remotePath ?? remoteFileFor(item.file)
    const result = await remote.read(remotePath)
    if (result.found !== true) throw new Error(`远端缺少 ${item.file} 的文件内容（manifest lists it but ${remotePath} is missing）`)
    const bytes = result.bytes
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${item.file} 超过 4 MiB，拒绝同步`)
    if (settings.crypto.enabled) {
      if (parseEnvelope(bytes) === null) throw new Error(`远端 ${item.file} 不是加密信封，但本机已开启加密`)
      return decryptBytes(bytes, settings.crypto.passphrase)
    }
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  }

  /** Refuse dangerous pulls before any write happens. */
  assertPullSafe(rel, bytes) {
    const settings = this.readSettings()
    if (rel === 'package.json') {
      let parsed
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw new Error('远端 package.json 不是合法 JSON，已拒绝写入')
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('远端 package.json 结构异常，已拒绝写入')
      const incoming = Object.keys(parsed.dependencies ?? {}).length
      let current = 0
      try {
        const local = JSON.parse(fs.readFileSync(safeJoin(this.profileDir, rel), 'utf8'))
        current = Object.keys(local.dependencies ?? {}).length
      } catch {
        current = 0
      }
      if (incoming === 0 && current > 0 && settings.allowEmptyDependencies !== true) {
        throw new Error('远端 package.json 没有任何依赖，而本机有：已拒绝覆盖（避免插件被清空）。如确需覆盖，请在设置里允许空依赖')
      }
    }
  }

  /** Write the remote version next to the local one and remember the conflict. */
  writeConflictCopy(rel, bytes) {
    return this.writeSiblingCopy(rel, bytes, 'remote')
  }

  /** Write `bytes` next to `rel` as `<name>.<kind>-<device>-<timestamp>`. */
  writeSiblingCopy(rel, bytes, kind) {
    const target = safeJoin(this.profileDir, rel)
    const dir = path.dirname(target)
    const base = path.basename(target)
    const tag = `${deviceTag(this.device)}-${timestamp()}`
    let candidate = path.join(dir, `${base}.${kind}-${tag}`)
    let seq = 1
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base}.${kind}-${tag}-${seq}`)
      seq += 1
    }
    writeBytesAtomic(candidate, bytes)
    return path.posix.join(path.posix.dirname(rel), path.basename(candidate))
  }

  /** Delete a conflict copy (best effort). */
  removeConflictCopy(rel) {
    try {
      fs.rmSync(safeJoin(this.profileDir, rel), { force: true })
    } catch {
      // already gone
    }
  }

  /** POST /check */
  async check({ direction } = {}) {
    const plan = await this.buildPlan(direction)
    return { plan: { direction: plan.direction, files: plan.files, summary: plan.summary } }
  }

  /** POST /sync */
  async sync({ direction, dryRun = false } = {}) {
    if (this.busy) throw new Error('另一个同步正在进行，请稍后再试（another sync is already running）')
    this.busy = true
    try {
      const settings = this.requireRemoteSettings()
      const remote = this.createRemote(settings)
      const plan = await this.buildPlan(direction, { remote, settings })
      if (dryRun === true) return { report: { direction: plan.direction, dryRun: true, plan: { files: plan.files, summary: plan.summary } } }

      const state = plan.state
      const report = {
        direction: plan.direction,
        pushed: [],
        pulled: [],
        conflicts: [],
        localCopies: [],
        skipped: plan.files.filter((item) => item.action === 'skipped').map((item) => ({ file: item.file, reason: item.reason ?? '' })),
        errors: [],
        backupId: '',
        restartRequired: false,
        pnpm: { ran: false, ok: true, outputTail: '' },
        manifestSyncAt: 0,
      }

      const backup = createBackup({ profileDir: this.profileDir, op: plan.direction, remoteKind: settings.kind, files: settings.scope })
      report.backupId = backup.id
      this.log.info('sync-start', { direction: plan.direction, backup: backup.id, files: plan.files.length })

      const conflicts = Array.isArray(state.conflicts) ? state.conflicts.slice() : []

      // ── pulls + conflicts ────────────────────────────────────────────────
      for (const item of plan.files) {
        if (item.action !== 'pull' && item.action !== 'conflict') continue
        try {
          const plain = await this.fetchPlain(remote, settings, item)
          if (item.action === 'pull') {
            this.assertPullSafe(item.file, plain)
            if (item.preserveLocalCopy === true) {
              try {
                const localBytes = fs.readFileSync(safeJoin(this.profileDir, item.file))
                const copy = this.writeSiblingCopy(item.file, localBytes, 'local')
                report.localCopies.push({ file: item.file, copy, reason: 'first-sync-adopt-remote' })
                this.log.info('first-sync-local-copy', { file: item.file, copy })
              } catch {
                // No local version (race) — nothing to preserve.
              }
            }
            writeBytesAtomic(safeJoin(this.profileDir, item.file), plain)
            report.pulled.push(item.file)
            this.log.info('pull', { file: item.file, bytes: plain.length })
          } else {
            const copy = this.writeConflictCopy(item.file, plain)
            conflicts.push({ file: item.file, remoteFile: copy, at: Date.now(), remoteKind: settings.kind })
            report.conflicts.push({ file: item.file, remoteFile: copy })
            this.log.warn('conflict', { file: item.file, copy })
          }
        } catch (error) {
          report.errors.push({ file: item.file, error: errorMessage(error) })
          this.log.error('pull-failed', { file: item.file, error: errorMessage(error) })
        }
      }

      // ── pushes ───────────────────────────────────────────────────────────
      const pushedEtags = {}
      for (const item of plan.files) {
        if (item.action !== 'push') continue
        try {
          const abs = safeJoin(this.profileDir, item.file)
          const bytes = fs.readFileSync(abs)
          if (sha256Hex(bytes) !== item.localSha) throw new Error('文件在同步过程中被修改，已跳过（file changed during sync）')
          const stored = settings.crypto.enabled ? encryptBytes(bytes, settings.crypto.passphrase) : bytes
          const result = await remote.write(remoteFileFor(item.file), stored, item.remoteEtag === undefined ? {} : { etag: item.remoteEtag })
          if (result?.etag !== undefined) pushedEtags[item.file] = result.etag
          report.pushed.push(item.file)
          this.log.info('push', { file: item.file, bytes: stored.length })
        } catch (error) {
          report.errors.push({ file: item.file, error: errorMessage(error) })
          this.log.error('push-failed', { file: item.file, error: errorMessage(error) })
        }
      }

      // ── manifest ─────────────────────────────────────────────────────────
      const remoteEntries = { ...(plan.manifest?.files ?? {}) }
      for (const rel of report.pushed) {
        const abs = safeJoin(this.profileDir, rel)
        const bytes = fs.readFileSync(abs)
        remoteEntries[rel] = {
          sha256: sha256Hex(bytes),
          size: bytes.length,
          remotePath: remoteFileFor(rel),
          ...(pushedEtags[rel] === undefined ? {} : { etag: pushedEtags[rel] }),
        }
      }
      let manifestSyncAt = 0
      // A pull-only run leaves the remote manifest exactly as it was; rewriting
      // it would only bump syncAt. On GitHub an update PUT needs the blob sha,
      // which is the read etag we cache in the plan — pass it back so a second
      // push on the same remote can actually update manifest.json.
      let manifestConsistent = true
      if (report.pushed.length > 0 || plan.manifest === null) {
        const manifest = buildManifest({ profile: this.profileName, device: this.device, cryptoEnabled: settings.crypto.enabled, files: remoteEntries })
        try {
          await remote.write(
            MANIFEST_FILE,
            Buffer.from(serializeManifest(manifest), 'utf8'),
            plan.manifestEtag === undefined ? {} : { etag: plan.manifestEtag },
          )
          manifestSyncAt = manifest.syncAt
          report.manifestSyncAt = manifestSyncAt
        } catch (error) {
          manifestConsistent = false
          const message = error?.code === 'conflict'
            ? '远端 manifest 在同步期间被另一台设备更新，请再点一次同步 / the remote manifest changed concurrently — run the sync again'
            : errorMessage(error)
          report.errors.push({ file: MANIFEST_FILE, error: message })
          this.log.error('manifest-failed', { error: message })
        }
      }

      // ── merge base ───────────────────────────────────────────────────────
      // A failed manifest write leaves the remote description stale; keeping
      // the previous base is what makes the next sync re-push instead of
      // mis-reading the stale manifest as somebody else's change.
      const nextBase = manifestConsistent ? {} : { ...state.base }
      for (const rel of settings.scope) {
        const abs = safeJoin(this.profileDir, rel)
        let localSha = null
        try {
          localSha = sha256Hex(fs.readFileSync(abs))
        } catch {
          localSha = null
        }
        const entry = remoteEntries[rel]
        if (entry !== undefined) {
          if (localSha === null) nextBase[rel] = entry.sha256
          else if (localSha === entry.sha256) nextBase[rel] = localSha
        }
      }
      // ── pnpm install ─────────────────────────────────────────────────────
      const needsPnpm = settings.pnpmInstall === true && report.pulled.some((file) => PNPM_FILES.has(file))
      if (needsPnpm) {
        const frozen = report.pulled.includes('pnpm-lock.yaml')
        const result = await runPnpmInstall({ profileDir: this.profileDir, hostManager: this.hostManager, frozen, log: this.log })
        report.pnpm = { ran: result.ran, ok: result.ok, outputTail: result.outputTail, command: result.command, exitCode: result.exitCode, policyRelaxed: result.policyRelaxed === true }
        if (result.ran !== true || result.ok !== true) {
          report.errors.push({ file: 'pnpm install', error: result.ran === true ? `pnpm install 失败（exit ${String(result.exitCode)}）` : '无法启动 pnpm，请手动在 profile 目录执行 pnpm install' })
        }
      }

      const ok = report.errors.length === 0
      this.writeState({
        remoteKey: state.remoteKey,
        remoteKind: settings.kind,
        base: nextBase,
        conflicts,
        lastSyncAt: Date.now(),
        lastOk: ok,
        lastDirection: plan.direction,
      })

      report.restartRequired = report.pulled.some((file) => RESTART_FILES.has(file)) || report.pnpm.ran === true
      this.pendingRestart = report.restartRequired
      this.log.info('sync-done', { ok, pushed: report.pushed, pulled: report.pulled, conflicts: report.conflicts.length, errors: report.errors.length })
      return { report, ok }
    } finally {
      this.busy = false
    }
  }

  /** POST /conflict */
  async resolveConflict({ file, action } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('file is required')
    if (action !== 'use-local' && action !== 'use-remote') throw new Error('action must be "use-local" or "use-remote"')
    if (this.busy) throw new Error('another sync is running')
    this.busy = true
    try {
      const settings = this.readSettings()
      const state = this.readState(settings)
      const index = state.conflicts.findIndex((entry) => entry.file === file)
      if (index < 0) throw new Error(`没有找到该文件的冲突记录：${file}`)
      const conflict = state.conflicts[index]
      const conflicts = state.conflicts.slice()
      if (action === 'use-local') {
        this.removeConflictCopy(conflict.remoteFile)
        conflicts.splice(index, 1)
        this.writeState({ ...state, conflicts })
        this.log.info('conflict-resolved', { file, action: 'use-local' })
        return { report: { file, action, applied: false } }
      }
      const bytes = fs.readFileSync(safeJoin(this.profileDir, conflict.remoteFile))
      this.assertPullSafe(file, bytes)
      createBackup({ profileDir: this.profileDir, op: 'conflict', remoteKind: settings.kind, files: [file] })
      writeBytesAtomic(safeJoin(this.profileDir, file), bytes)
      this.removeConflictCopy(conflict.remoteFile)
      conflicts.splice(index, 1)
      const base = { ...state.base, [file]: sha256Hex(bytes) }
      const restartRequired = RESTART_FILES.has(file)
      let pnpm = { ran: false, ok: true, outputTail: '' }
      if (settings.pnpmInstall === true && PNPM_FILES.has(file)) {
        const result = await runPnpmInstall({ profileDir: this.profileDir, hostManager: this.hostManager, frozen: false, log: this.log })
        pnpm = { ran: result.ran, ok: result.ok, outputTail: result.outputTail, command: result.command, exitCode: result.exitCode, policyRelaxed: result.policyRelaxed === true }
      }
      this.writeState({ ...state, base, conflicts })
      this.pendingRestart = restartRequired || pnpm.ran === true
      this.log.info('conflict-resolved', { file, action: 'use-remote' })
      return { report: { file, action, applied: true, restartRequired: this.pendingRestart, pnpm } }
    } finally {
      this.busy = false
    }
  }

  /** GET /backups */
  listBackups(limit = 50) {
    return { backups: listBackups({ limit }) }
  }

  /** POST /backups/restore */
  async restoreLocalBackup({ id } = {}) {
    if (this.busy) throw new Error('another sync is running')
    if (!isValidBackupId(id)) throw new Error('invalid backup id')
    this.busy = true
    try {
      const settings = this.readSettings()
      createBackup({ profileDir: this.profileDir, op: 'restore', remoteKind: settings.kind, files: settings.scope })
      const result = restoreBackup({ profileDir: this.profileDir, id })
      const restartRequired = result.restored.some((file) => RESTART_FILES.has(file))
      this.pendingRestart = restartRequired
      this.log.info('backup-restored', { id, files: result.restored })
      return { report: { id, restored: result.restored, restartRequired } }
    } finally {
      this.busy = false
    }
  }
}

/** Normalize an unknown thrown value into a message. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
