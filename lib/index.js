/**
 * @xiaokang6/dsh-config-sync — host half.
 *
 * Mounts one SyncEngine for the active profile and exposes it on the host's
 * `webServer` seam under `/dsh-config-sync/*`. The browser half
 * (`client/client.js`) is the settings page that drives these routes.
 *
 * The plugin deliberately owns no state in the profile: credentials, merge base,
 * backups and logs live under `$DSH_HOME/config-sync`, so they never travel with
 * a sync and never end up in a profile backup.
 *
 * @module @xiaokang6/dsh-config-sync
 */

import path from 'node:path'

import z from '@deepseek-ai/schemastery'

import { createLogger } from './log.js'
import { registerRoutes } from './routes.js'
import { DEFAULT_SCOPE } from './sync/manifest.js'
import { DEFAULT_REMOTE_PATH, SyncEngine } from './sync/engine.js'
import { scheduleAutoSync } from './sync/auto.js'
import { defaultProfileDir, dshHome, ensureDataDir, logFile } from './sync/paths.js'
import { normalizeHostManager } from './sync/pnpm.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'config-sync'

/** Services the host half needs to mount its routes. */
export const inject = ['webServer']

/**
 * Plugin configuration (lives in the user's patch layer, keyed `config-sync`).
 * Remote credentials are NOT here: they live in `$DSH_HOME/config-sync/remote.json`
 * (0600) so a synced `cordis.patch.yml` never carries a password or a token.
 */
export const Config = z.object({
  profileDir: z
    .string()
    .description('Optional override of the profile directory to sync; empty means the active profile.')
    .default(''),
  scope: z
    .array(z.string())
    .description('Profile-relative files to sync. Defaults to package.json / cordis.patch.yml / cordis.yml / pnpm-lock.yaml.')
    .default(DEFAULT_SCOPE),
  direction: z
    .string()
    .description('Default sync direction: push | pull | both.')
    .default('both'),
  cryptoEnabled: z
    .boolean()
    .description('Encrypt remote payloads with a passphrase (the passphrase itself lives in the local settings file).')
    .default(false),
  allowEmptyDependencies: z
    .boolean()
    .description('Allow a pulled package.json with zero dependencies to overwrite a non-empty one (dangerous; disabled by default).')
    .default(false),
  pnpmInstall: z
    .boolean()
    .description('Run pnpm install after pulling package.json / pnpm-lock.yaml.')
    .default(true),
  remotePath: z
    .string()
    .description('Default remote root prefix. Empty means dsh-config-sync/<profile>.')
    .default(''),
  autoSyncOnStart: z
    .boolean()
    .description('Run one sync shortly after DSH boots (default on; also toggleable from the settings page).')
    .default(true),
  autoSyncDelayMs: z
    .number()
    .description('Boot-time sync delay in milliseconds (default 15000, clamped to 0..300000).')
    .default(15000),
})

/**
 * Resolve the active profile: launcher `profileContext` first (Desktop and
 * `dsh web` publish it), then `--profile`, then the conventional directory.
 * @param {any} ctx - plugin context.
 * @param {any} config - plugin configuration refs.
 * @returns {{ name: string, dir: string }}
 */
export function resolveProfile(ctx, config) {
  const read = (refKey) => {
    const ref = config?.[refKey]
    if (ref !== null && typeof ref === 'object' && typeof ref.get === 'function') return ref.get()
    return ref
  }
  let launched
  try {
    launched = ctx.get('profileContext')
  } catch {
    launched = undefined
  }
  let profileName = typeof launched?.name === 'string' && launched.name !== '' ? launched.name : undefined
  if (profileName === undefined) {
    const argv = Array.isArray(process.argv) ? process.argv : []
    const flag = argv.indexOf('--profile')
    if (flag >= 0 && typeof argv[flag + 1] === 'string' && argv[flag + 1] !== '') profileName = argv[flag + 1]
  }
  profileName = profileName ?? 'desktop'

  const configuredDir = read('profileDir')
  if (typeof configuredDir === 'string' && configuredDir.trim() !== '') {
    return { name: profileName, dir: path.resolve(configuredDir.trim()) }
  }
  if (typeof launched?.dir === 'string' && path.isAbsolute(launched.dir)) {
    return { name: profileName, dir: launched.dir }
  }
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { name: profileName, dir: path.resolve(fromEnv.trim()) }
  }
  return { name: profileName, dir: defaultProfileDir(profileName) }
}

/**
 * Build the engine for a context (also used by tests).
 * @param {{ ctx: any, config: any, logger?: any }} input
 * @returns {{ engine: SyncEngine, profile: { name: string, dir: string }, log: any }}
 */
export function createEngine({ ctx, config, logger }) {
  ensureDataDir()
  const log = logger ?? createLogger({ file: logFile() })
  const profile = resolveProfile(ctx, config)
  const hostManager = normalizeHostManager(readHostPackageManager(ctx))
  const engine = new SyncEngine({
    profileName: profile.name,
    profileDir: profile.dir,
    config,
    log,
    hostManager,
    version: '0.1.0',
  })
  return { engine, profile, log }
}

/** Read the host-published package manager invocation, if any. */
function readHostPackageManager(ctx) {
  try {
    const launched = ctx.get('profileContext')
    return launched?.packageManager ?? null
  } catch {
    return null
  }
}

/**
 * Mount the plugin into a context.
 * @param {any} ctx - plugin context.
 * @param {any} config - plugin configuration refs.
 */
export function apply(ctx, config) {
  const { engine, profile, log } = createEngine({ ctx, config })

  // Sync once per boot (after the shell settled). Skipped when the remote is
  // not configured yet, when the passphrase is missing, or when disabled.
  scheduleAutoSync(ctx, engine, log)

  ctx.inject(['webServer'], (hostCtx) => {
    let webServer
    try {
      webServer = hostCtx.get('webServer')
    } catch {
      webServer = undefined
    }
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log.warn('mount', { error: 'webServer service is not available; dsh-config-sync routes are not mounted' })
      return
    }
    hostCtx.effect(() => {
      const disposers = registerRoutes({ webServer, ctx: hostCtx, engine, log })
      log.info('mounted', { profile: profile.name, dir: profile.dir, routes: disposers.length, dshHome: dshHome() })
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // route already gone
          }
        }
      }
    }, 'dsh-config-sync: routes')
  })
}

export default { name, inject, Config, apply }
