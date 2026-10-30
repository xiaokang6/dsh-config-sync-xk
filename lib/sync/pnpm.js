/**
 * Running `pnpm install` against the profile without ever touching
 * `node_modules` by hand.
 *
 * Two tiers, in the same order the host uses: the package manager the host
 * publishes through `profileContext.packageManager` (the Desktop app's bundled
 * pnpm), then a PATH pnpm. Windows needs `cmd.exe /d /s /c` because the shims
 * are `.cmd` files that Node cannot spawn directly.
 *
 * Reproducing another device's lockfile can trip the host's supply-chain policy
 * (`minimumReleaseAge`): a package the other machine installed minutes after it
 * was published is "too fresh" here, and pnpm refuses the whole install even
 * though nothing needs to be resolved. The first attempt keeps the policy; a
 * policy-only failure is retried once with the release-age window relaxed, and
 * the result says so (`policyRelaxed`) so the UI can report it.
 *
 * @module dsh-config-sync/sync/pnpm
 */

import { spawn } from 'node:child_process'

const OUTPUT_TAIL_BYTES = 8 * 1024
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'
const CMD_METACHARS = /[\s"&|<>^()%!]/u

/** Release-age policy failures pnpm reports when a lockfile is too fresh. */
const RELEASE_AGE_RE = /MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge|minimum-release-age/iu

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
 * Whether `pnpm install` output is a supply-chain release-age refusal.
 * @param {string} output
 * @returns {boolean}
 */
export function isReleaseAgeViolation(output) {
  return typeof output === 'string' && RELEASE_AGE_RE.test(output)
}

/**
 * Argv for `pnpm install`.
 * @param {{ frozen?: boolean, relaxReleaseAge?: boolean }} input
 * @returns {string[]}
 */
export function pnpmInstallArgs({ frozen = false, relaxReleaseAge = false } = {}) {
  const args = ['install']
  if (frozen) args.push('--frozen-lockfile')
  // pnpm 11/12 read the flag; the env in pnpmEnvForRun carries it for versions
  // that ignore unknown flags silently.
  if (relaxReleaseAge) args.push('--config.minimumReleaseAge=0')
  return args
}

/**
 * Environment for a pnpm child. `CI` keeps pnpm from prompting on a TTY-less
 * host; `PNPM_CONFIG_MINIMUM_RELEASE_AGE` is the version-proof spelling of the
 * release-age override.
 * @param {{ relaxReleaseAge?: boolean }} input
 * @returns {Record<string, string>}
 */
export function pnpmEnvForRun({ relaxReleaseAge = false } = {}) {
  return relaxReleaseAge
    ? { CI: 'true', PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' }
    : { CI: 'true' }
}

/**
 * Build the spawn plan for `pnpm install`.
 * @param {{ hostManager?: object | null, frozen?: boolean, relaxReleaseAge?: boolean }} input
 * @returns {{ tier: 'host' | 'path', command: string, args: string[], env: Record<string, string>, label: string }}
 */
export function resolvePnpmCommand({ hostManager = null, frozen = false, relaxReleaseAge = false } = {}) {
  const extra = pnpmInstallArgs({ frozen, relaxReleaseAge })
  const host = normalizeHostManager(hostManager)
  if (host !== null) {
    return {
      tier: 'host',
      command: host.command,
      args: [...host.args, ...extra],
      env: { ...host.env },
      label: `${host.command} ${host.args.join(' ')} ${extra.join(' ')}`.trim(),
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

/** Run one pnpm attempt and normalize its result. */
async function runOnce({ profileDir, hostManager, frozen, relaxReleaseAge, timeoutMs }) {
  const plan = resolvePnpmCommand({ hostManager, frozen, relaxReleaseAge })
  const startedAt = Date.now()
  let output = ''
  let timedOut = false

  const child = spawn(plan.command, plan.args, {
    cwd: profileDir,
    env: { ...process.env, ...plan.env, ...pnpmEnvForRun({ relaxReleaseAge }) },
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
    return {
      ran: false,
      ok: false,
      exitCode: null,
      outputTail: result.spawnError.message,
      durationMs: Date.now() - startedAt,
      command: plan.label,
      tier: plan.tier,
      timedOut: false,
      relaxReleaseAge,
    }
  }
  return {
    ran: true,
    ok: result.exitCode === 0 && !timedOut,
    exitCode: result.exitCode,
    outputTail: output.trim(),
    durationMs: Date.now() - startedAt,
    command: plan.label,
    tier: plan.tier,
    timedOut,
    relaxReleaseAge,
  }
}

/**
 * Run `pnpm install` in the profile directory.
 * @param {{ profileDir: string, hostManager?: object | null, frozen?: boolean, timeoutMs?: number, log?: any }} input
 * @returns {Promise<{ ran: boolean, ok: boolean, exitCode: number | null, outputTail: string, durationMs: number, command: string, tier: string, timedOut: boolean, policyRelaxed: boolean }>}
 */
export async function runPnpmInstall({ profileDir, hostManager = null, frozen = false, timeoutMs = 15 * 60 * 1000, log }) {
  const first = await runOnce({ profileDir, hostManager, frozen, relaxReleaseAge: false, timeoutMs })
  if (first.ok !== true && first.ran === true && isReleaseAgeViolation(first.outputTail)) {
    log?.warn('pnpm', {
      policy: 'release-age',
      detail: 'lockfile reproduces a package the host policy calls too fresh; retrying with minimumReleaseAge=0',
    })
    const second = await runOnce({ profileDir, hostManager, frozen, relaxReleaseAge: true, timeoutMs })
    log?.info('pnpm', {
      command: second.command,
      tier: second.tier,
      exitCode: second.exitCode,
      timedOut: second.timedOut,
      ok: second.ok,
      policyRelaxed: true,
    })
    return { ...second, policyRelaxed: true }
  }
  log?.info('pnpm', {
    command: first.command,
    tier: first.tier,
    exitCode: first.exitCode,
    timedOut: first.timedOut,
    ok: first.ok,
    policyRelaxed: false,
  })
  return { ...first, policyRelaxed: false }
}
