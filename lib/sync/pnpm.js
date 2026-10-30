/**
 * Running `pnpm install` against the profile without ever touching
 * `node_modules` by hand.
 *
 * Two tiers, in the same order the host uses: the package manager the host
 * publishes through `profileContext.packageManager` (the Desktop app's bundled
 * pnpm), then a PATH pnpm. Windows needs `cmd.exe /d /s /c` because the shims
 * are `.cmd` files that Node cannot spawn directly.
 *
 * @module dsh-config-sync/sync/pnpm
 */

import { spawn } from 'node:child_process'

const OUTPUT_TAIL_BYTES = 8 * 1024
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'
const CMD_METACHARS = /[\s"&|<>^()%!]/u

/** Quote one argv token for a `cmd.exe /c` command line. */
export function quoteCmdArg(arg) {
  return CMD_METACHARS.test(arg) ? `"${String(arg).replace(/"/gu, '""')}"` : String(arg)
}

/** Validate the host-published package manager invocation, or null. */
export function normalizeHostManager(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.command !== 'string' || value.command.trim() === '') return null
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) return null
  const env = {}
  if (value.env !== null && typeof value.env === 'object' && !Array.isArray(value.env)) {
    for (const [key, item] of Object.entries(value.env)) {
      if (typeof item === 'string') env[key] = item
    }
  }
  return { command: value.command.trim(), args: [...value.args], env }
}

/**
 * Build the spawn plan for `pnpm install`.
 * @param {{ hostManager?: object | null, frozen?: boolean }} input
 * @returns {{ tier: 'host' | 'path', command: string, args: string[], env: Record<string, string>, label: string }}
 */
export function resolvePnpmCommand({ hostManager = null, frozen = false } = {}) {
  const extra = frozen ? ['install', '--frozen-lockfile'] : ['install']
  const host = normalizeHostManager(hostManager)
  if (host !== null) {
    return {
      tier: 'host',
      command: host.command,
      args: [...host.args, ...extra],
      env: { ...host.env },
      label: `${host.command} ${host.args.join(' ')}`.trim(),
    }
  }
  if (process.platform === 'win32') {
    const commandLine = ['pnpm', ...extra].map(quoteCmdArg).join(' ')
    return {
      tier: 'path',
      command: COMSPEC,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      env: {},
      label: ['pnpm', ...extra].join(' '),
    }
  }
  return { tier: 'path', command: 'pnpm', args: extra, env: {}, label: ['pnpm', ...extra].join(' ') }
}

/** Kill a child and its descendants (pnpm spawns helpers on Windows). */
function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      // fall through
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
}

/**
 * Run `pnpm install` in the profile directory.
 * @param {{ profileDir: string, hostManager?: object | null, frozen?: boolean, timeoutMs?: number, log?: any }} input
 * @returns {Promise<{ ran: boolean, ok: boolean, exitCode: number | null, outputTail: string, durationMs: number, command: string, tier: string, timedOut: boolean }>}
 */
export async function runPnpmInstall({ profileDir, hostManager = null, frozen = false, timeoutMs = 15 * 60 * 1000, log }) {
  const plan = resolvePnpmCommand({ hostManager, frozen })
  const startedAt = Date.now()
  let output = ''
  let timedOut = false

  const child = spawn(plan.command, plan.args, {
    cwd: profileDir,
    env: { ...process.env, ...plan.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(process.platform === 'win32' && plan.command === COMSPEC ? { windowsVerbatimArguments: true, shell: false } : { shell: false }),
  })

  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, Math.max(30 * 1000, timeoutMs))
  if (typeof timer.unref === 'function') timer.unref()

  const result = await new Promise((resolvePromise) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, spawnError: error })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, spawnError: null })
    })
  })

  if (result.spawnError !== null && result.spawnError !== undefined) {
    log?.error('pnpm', { message: `could not start pnpm: ${result.spawnError.message}`, tier: plan.tier })
    return {
      ran: false,
      ok: false,
      exitCode: null,
      outputTail: result.spawnError.message,
      durationMs: Date.now() - startedAt,
      command: plan.label,
      tier: plan.tier,
      timedOut: false,
    }
  }

  const ok = result.exitCode === 0 && !timedOut
  log?.info('pnpm', { command: plan.label, tier: plan.tier, exitCode: result.exitCode, timedOut, ok })
  return {
    ran: true,
    ok,
    exitCode: result.exitCode,
    outputTail: output.trim(),
    durationMs: Date.now() - startedAt,
    command: plan.label,
    tier: plan.tier,
    timedOut,
  }
}
