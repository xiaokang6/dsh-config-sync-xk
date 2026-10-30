/**
 * Startup auto-sync policy.
 *
 * "Sync once whenever DSH opens" is a convenience, not a licence to surprise
 * the user: the run is skipped when nothing is configured yet, when the crypto
 * passphrase is missing (the remote cannot be decrypted), and when the user
 * switched it off. The decision is a pure function so it can be tested without
 * a host.
 *
 * @module dsh-config-sync/sync/auto
 */

/** Delay before the boot-time sync: long enough not to slow the shell down. */
export const DEFAULT_AUTO_SYNC_DELAY_MS = 15000

/** Upper bound for the configured delay. */
export const MAX_AUTO_SYNC_DELAY_MS = 300000

/**
 * Decide whether a boot-time sync should run.
 * @param {any} settings - effective settings (`engine.readSettings()`).
 * @param {{ delayMs?: number }} [options]
 * @returns {{ run: boolean, reason: string, delayMs: number, direction?: string }}
 */
export function autoSyncPlan(settings, { delayMs = DEFAULT_AUTO_SYNC_DELAY_MS } = {}) {
  const delay = Number.isFinite(delayMs)
    ? Math.min(MAX_AUTO_SYNC_DELAY_MS, Math.max(0, Math.trunc(delayMs)))
    : DEFAULT_AUTO_SYNC_DELAY_MS
  if (settings === null || typeof settings !== 'object') return { run: false, reason: 'no-settings', delayMs: delay }
  if (settings.autoSyncOnStart !== true) return { run: false, reason: 'disabled', delayMs: delay }
  if (settings.kind === '') return { run: false, reason: 'remote-not-configured', delayMs: delay }
  if (settings.kind === 'webdav'
    && (settings.baseUrl === '' || settings.username === '' || settings.password === '')) {
    return { run: false, reason: 'remote-incomplete', delayMs: delay }
  }
  if (settings.kind === 'github'
    && (settings.owner === '' || settings.repo === '' || settings.token === '')) {
    return { run: false, reason: 'remote-incomplete', delayMs: delay }
  }
  if (settings.crypto?.enabled === true && (settings.crypto.passphrase ?? '') === '') {
    return { run: false, reason: 'passphrase-missing', delayMs: delay }
  }
  return { run: true, reason: 'ok', direction: settings.direction ?? 'both', delayMs: delay }
}

/** One boot-time sync per host process. Reset is exported for tests. */
let autoSyncScheduled = false

/** Test-only: forget that a boot-time sync was scheduled. */
export function resetAutoSync() {
  autoSyncScheduled = false
}

/** Normalize a thrown value into a log message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Schedule the boot-time sync decided by `autoSyncPlan`.
 *
 * The loader may remount the plugin when the user's patch layer changes — and a
 * pulled `cordis.patch.yml` does exactly that — so the module-level flag keeps a
 * remount from starting a second sync in the same boot. The timer is registered
 * through `ctx.effect` so unloading the plugin also cancels it.
 *
 * @param {any} ctx - plugin context (needs `effect`).
 * @param {{ readSettings: () => any, getConfig: () => any, sync: (options: any) => Promise<any> }} engine
 * @param {{ info: Function, warn: Function }} log
 * @returns {{ run: boolean, reason: string, delayMs?: number, direction?: string }}
 */
export function scheduleAutoSync(ctx, engine, log) {
  if (autoSyncScheduled) return { run: false, reason: 'already-scheduled', delayMs: 0 }
  const decision = autoSyncPlan(engine.readSettings(), { delayMs: engine.getConfig().autoSyncDelayMs })
  if (decision.run !== true) {
    log.info('auto-sync-skip', decision)
    return decision
  }
  autoSyncScheduled = true
  log.info('auto-sync-scheduled', { delayMs: decision.delayMs, direction: decision.direction })
  let timer
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
  }
  try {
    ctx.effect(() => {
      timer = setTimeout(() => {
        void (async () => {
          try {
            const result = await engine.sync({ direction: decision.direction })
            log.info('auto-sync-done', {
              ok: result.ok,
              pushed: result.report.pushed,
              pulled: result.report.pulled,
              conflicts: result.report.conflicts.length,
              errors: result.report.errors.length,
              restartRequired: result.report.restartRequired,
            })
          } catch (error) {
            log.warn('auto-sync-failed', { error: messageOf(error) })
          }
        })()
      }, decision.delayMs)
      if (typeof timer.unref === 'function') timer.unref()
      return stop
    }, 'dsh-config-sync: auto sync on start')
  } catch (error) {
    log.warn('auto-sync-schedule-failed', { error: messageOf(error) })
    return { run: false, reason: 'schedule-failed', delayMs: decision.delayMs }
  }
  return decision
}
