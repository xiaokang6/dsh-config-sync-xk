/**
 * `/dsh-config-sync/*` HTTP routes.
 *
 * Registered as exact routes on the host `webServer` seam, so the settings page
 * can talk to the plugin without any extra port. Every mutating route runs the
 * same-origin guard first: the loopback/TLS boundary of the host is the only
 * authentication DSH web has, and a page on another origin must not be able to
 * drive a profile write.
 *
 * @module @xiaokang6/dsh-config-sync/routes
 */

import { hostRejection, isOfficialDesktop, isSameOrigin, readJsonBody, sendJson, sendText } from './http.js'
import { errorMessage } from './sync/engine.js'
import { applyUpdate, checkForUpdate } from './sync/update.js'

/**
 * Register every route.
 * @param {{ webServer: any, ctx: any, engine: any, log: any }} input
 * @returns {Array<() => void>} disposers
 */
export function registerRoutes({ webServer, ctx, engine, log }) {
  const disposers = []

  const register = (route) => {
    const dispose = webServer.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  const guarded = (handler) => async (request, response) => {
    if (!isSameOrigin(request, ctx)) {
      sendJson(response, 403, { ok: false, error: 'untrusted origin (只接受本机同源请求)' })
      return
    }
    // The Desktop host ends browser auth in its own proxy (#648); asking the
    // host gate again there can refuse the app's own page. Plain `dsh web`
    // deployments keep the gate.
    const rejection = isOfficialDesktop(ctx) ? undefined : hostRejection(ctx, request)
    if (rejection !== undefined) {
      sendJson(response, rejection, { ok: false, error: 'the host refused this request (宿主拒绝了该请求)' })
      return
    }
    try {
      await handler(request, response)
    } catch (error) {
      const message = errorMessage(error)
      log.error('route', { error: message, path: request.url })
      sendJson(response, 400, { ok: false, error: message })
    }
  }

  register({
    kind: 'exact',
    path: '/dsh-config-sync/status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(response, 200, { ok: true, ...engine.describe(), logTail: log.tail(50) })
    },
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/config',
    handler: guarded(async (request, response) => {
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, ...engine.describeSettings() })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(request)
      const config = engine.saveSettings(body)
      sendJson(response, 200, { ok: true, config })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/probe',
    handler: guarded(async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const result = await engine.probe()
      sendJson(response, 200, { ok: true, probe: result.probe })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/check',
    handler: guarded(async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(request)
      const result = await engine.check({ direction: body.direction })
      sendJson(response, 200, { ok: true, plan: result.plan })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/sync',
    handler: guarded(async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(request)
      const result = await engine.sync({ direction: body.direction, dryRun: body.dryRun === true })
      sendJson(response, result.ok === false ? 409 : 200, { ok: result.ok !== false, report: result.report })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/conflict',
    handler: guarded(async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(request)
      const result = await engine.resolveConflict({ file: body.file, action: body.action })
      sendJson(response, 200, { ok: true, report: result.report })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/backups',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(response, 200, { ok: true, ...engine.listBackups(50) })
    },
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/backups/restore',
    handler: guarded(async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(request)
      const result = await engine.restoreLocalBackup({ id: body.id })
      sendJson(response, 200, { ok: true, report: result.report })
    }),
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/logs',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let tail = 200
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const value = Number(url.searchParams.get('tail'))
        if (Number.isFinite(value) && value > 0) tail = Math.min(Math.trunc(value), 2000)
      } catch {
        // default tail
      }
      sendText(response, 200, `${log.exportText(tail)}\n`)
    },
  })

  register({
    kind: 'exact',
    path: '/dsh-config-sync/update',
    /**
     * Upgrade this plugin's own installation. GET only looks (a fetch/`ls-remote`
     * at most); POST is the profile write and therefore carries the same-origin
     * guard the other mutating routes do.
     */
    handler: async (request, response) => {
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, update: await checkForUpdate({ profileDir: engine.profileDir }) })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!isSameOrigin(request, ctx)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin (只接受本机同源请求)' })
        return
      }
      const rejection = isOfficialDesktop(ctx) ? undefined : hostRejection(ctx, request)
      if (rejection !== undefined) {
        sendJson(response, rejection, { ok: false, error: 'the host refused this request (宿主拒绝了该请求)' })
        return
      }
      try {
        const result = await applyUpdate({ profileDir: engine.profileDir, hostManager: engine.hostManager, log })
        sendJson(response, result.ok === false ? 409 : 200, { ok: result.ok !== false, update: result })
      } catch (error) {
        const message = errorMessage(error)
        log.error('update', { error: message })
        sendJson(response, 400, { ok: false, error: message })
      }
    },
  })

  log.info('routes', { count: disposers.length })
  return disposers
}
