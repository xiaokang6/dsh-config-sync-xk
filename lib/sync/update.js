/**
 * In-place upgrade of this plugin's own installation.
 *
 * The settings page has one button for it, so the shape of "upgrade" has to be
 * decided from the profile, not from a script the user has to remember:
 *
 * - `github:` / git URL — the plugin is a snapshot inside the profile and its
 *   commit is pinned in `pnpm-lock.yaml`. Upgrade = `pnpm update dsh-config-sync`;
 *   the pin moving is the proof it worked.
 * - `link:` — the plugin runs a checkout. Upgrade = fast-forward that checkout.
 *   A worktree with uncommitted tracked edits is refused, not stashed: a web
 *   route is the wrong place to move someone's work aside.
 * - registry version — warn and still update; the npm package called
 *   `dsh-config-sync` belongs to an unrelated project, so this is almost never
 *   what the user meant.
 *
 * Nothing here restarts anything: DSH keeps ESM modules in memory, so the panel
 * says "reload" (header refresh button) instead of pretending the new code is
 * live.
 *
 * @module dsh-config-sync/sync/update
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { pnpmEnvForRun, runPnpmUpdate } from './pnpm.js'

/** The package this module upgrades. */
export const PACKAGE_NAME = 'dsh-config-sync'

/** Where the profile keeps its resolved versions. */
const LOCKFILE = 'pnpm-lock.yaml'

/** Git refs shorter than this are not treated as a commit. */
const SHA = /^[0-9a-f]{7,40}$/u

/**
 * Classify a dependency spec.
 * @param {string} spec - the value of `dependencies["dsh-config-sync"]`.
 * @returns {{ form: 'link' | 'git' | 'registry', spec: string, dir?: string, owner?: string, repo?: string, ref?: string }}
 */
export function parseSpec(spec) {
  const text = String(spec ?? '').trim()
  if (text.startsWith('link:')) {
    const dir = text.slice('link:'.length)
    return { form: 'link', spec: text, dir }
  }
  const short = /^github:([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/u.exec(text)
  if (short !== null) return { form: 'git', spec: text, owner: short[1], repo: short[2], ref: short[3] ?? 'main' }
  const url = /^(?:git\+)?https?:\/\/github\.com\/([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/u.exec(text)
  if (url !== null) return { form: 'git', spec: text, owner: url[1], repo: url[2], ref: url[3] ?? 'main' }
  return { form: 'registry', spec: text }
}

/**
 * Read the plugin's dependency spec out of the profile manifest.
 * @param {string} profileDir
 * @returns {string | undefined}
 */
export function readSpec(profileDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const value = manifest?.dependencies?.[PACKAGE_NAME]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The commit the profile's lockfile pinned for `owner/repo`, if any.
 * @param {string} profileDir
 * @param {string} owner
 * @param {string} repo
 * @returns {string | undefined}
 */
export function lockedCommit(profileDir, owner, repo) {
  try {
    const text = fs.readFileSync(path.join(profileDir, LOCKFILE), 'utf8')
    const pattern = new RegExp(`codeload\\.github\\.com/${owner}/${repo}/tar\\.gz/([0-9a-f]{7,40})`, 'u')
    return pattern.exec(text)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Run a git command in `cwd` and collect its output.
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, out: string, err: string }>}
 */
function git(args, { cwd, timeoutMs = 30_000 }) {
  return new Promise((resolvePromise) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ ok: false, out: '', err: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (chunk) => {
      out = (out + chunk.toString()).slice(-64 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      err = (err + chunk.toString()).slice(-64 * 1024)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, out: out.trim(), err: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, out: out.trim(), err: err.trim() })
    })
  })
}

/**
 * Current commit of a ref on GitHub.
 * @param {{ owner: string, repo: string, ref: string }} remote
 * @param {{ cwd: string, run?: typeof git }} options
 * @returns {Promise<string | undefined>}
 */
export async function remoteCommit(remote, { cwd, run = git } = { cwd: process.cwd() }) {
  if (SHA.test(remote.ref)) return remote.ref
  const url = `https://github.com/${remote.owner}/${remote.repo}`
  const result = await run(['ls-remote', url, `refs/heads/${remote.ref}`], { cwd })
  if (!result.ok) return undefined
  const sha = (result.out.split(/\s+/u)[0] ?? '').toLowerCase()
  return SHA.test(sha) ? sha : undefined
}

/** True when two commit ids name the same commit (allowing abbreviation). */
export function sameCommit(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left === right || left.startsWith(right) || right.startsWith(left)
}

/** Short form for display. */
const short = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : sha)

/**
 * Report where the installed copy stands. Read-only: the only side effect is a
 * `git fetch` for a `link:` checkout and a `git ls-remote` for a git install.
 * @param {{ profileDir: string, run?: typeof git }} input
 * @returns {Promise<{
 *   form: 'link' | 'git' | 'registry', spec: string, canApply: boolean,
 *   pinned?: string, latest?: string, upToDate?: boolean, behind?: number,
 *   dirty?: boolean, detail: string,
 * }>}
 */
export async function checkForUpdate({ profileDir, run = git }) {
  const spec = readSpec(profileDir)
  if (spec === undefined) {
    return { form: 'registry', spec: '', canApply: false, detail: `${PACKAGE_NAME} is not a dependency of this profile` }
  }
  const parsed = parseSpec(spec)
  const cwd = profileDir

  if (parsed.form === 'link') {
    const dir = path.resolve(profileDir, String(parsed.dir ?? ''))
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return { form: 'link', spec, canApply: false, detail: `${dir} is not a git checkout` }
    }
    const fetched = await run(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir })
    if (!fetched.ok) {
      return { form: 'link', spec, canApply: false, detail: `git fetch failed in ${dir}: ${fetched.err || fetched.out}` }
    }
    const status = await run(['status', '--porcelain', '--untracked-files=no'], { cwd: dir })
    const behindResult = await run(['rev-list', '--count', 'HEAD..@{upstream}'], { cwd: dir })
    const behind = Number.parseInt(behindResult.ok ? behindResult.out : '', 10)
    const dirty = status.ok && status.out !== ''
    return {
      form: 'link',
      spec,
      canApply: behindResult.ok && !dirty,
      behind: Number.isFinite(behind) ? behind : undefined,
      upToDate: Number.isFinite(behind) ? behind === 0 : undefined,
      dirty,
      detail: dirty
        ? 'the checkout has uncommitted tracked edits — run update.cmd in it instead'
        : behindResult.ok
          ? ''
          : 'this checkout has no upstream branch to compare against',
    }
  }

  if (parsed.form === 'git') {
    const pinned = lockedCommit(profileDir, parsed.owner, parsed.repo)
    const latest = await remoteCommit(parsed, { cwd, run })
    const upToDate = latest === undefined ? undefined : sameCommit(pinned, latest)
    return {
      form: 'git',
      spec,
      canApply: true,
      pinned: short(pinned),
      latest: short(latest),
      upToDate,
      detail:
        latest === undefined
          ? 'could not read the ref on GitHub (offline or proxy) — an update attempt is still allowed'
          : upToDate === true
            ? ''
            : 'a newer commit is published; press 一键升级',
    }
  }

  return {
    form: 'registry',
    spec,
    canApply: true,
    detail: 'the npm package named dsh-config-sync belongs to an unrelated project — prefer github:xiaokang6/dsh-config-sync',
  }
}

/**
 * Apply the upgrade. The caller reloads the host afterwards; nothing here can.
 * @param {{
 *   profileDir: string, hostManager?: object | null, log?: any,
 *   run?: typeof git, update?: typeof runPnpmUpdate,
 * }} input
 * @returns {Promise<{
 *   ran: boolean, ok: boolean, form: string, pinBefore?: string, pinAfter?: string,
 *   restartRequired: boolean, outputTail: string, detail: string,
 * }>}
 */
export async function applyUpdate({ profileDir, hostManager = null, log, run = git, update = runPnpmUpdate }) {
  const spec = readSpec(profileDir)
  if (spec === undefined) {
    return { ran: false, ok: false, form: 'none', restartRequired: false, outputTail: '', detail: `${PACKAGE_NAME} is not a dependency of this profile` }
  }
  const parsed = parseSpec(spec)

  if (parsed.form === 'link') {
    const dir = path.resolve(profileDir, String(parsed.dir ?? ''))
    const status = await run(['status', '--porcelain', '--untracked-files=no'], { cwd: dir })
    if (!status.ok || status.out !== '') {
      return {
        ran: false,
        ok: false,
        form: 'link',
        restartRequired: false,
        outputTail: status.out,
        detail: 'uncommitted tracked edits in the checkout — run update.cmd there instead',
      }
    }
    const before = await run(['rev-parse', '--short', 'HEAD'], { cwd: dir })
    const merged = await run(['merge', '--ff-only', '@{upstream}'], { cwd: dir })
    const after = await run(['rev-parse', '--short', 'HEAD'], { cwd: dir })
    const moved = before.out !== after.out
    return {
      ran: true,
      ok: merged.ok,
      form: 'link',
      pinBefore: short(before.out),
      pinAfter: short(after.out),
      restartRequired: moved,
      outputTail: `${merged.out}\n${merged.err}`.trim().slice(-4000),
      detail: merged.ok
        ? moved
          ? `${short(before.out)} → ${short(after.out)}`
          : 'already current'
        : merged.err || merged.out,
    }
  }

  const pinBefore = parsed.form === 'git' ? lockedCommit(profileDir, parsed.owner, parsed.repo) : undefined
  log?.info('update-start', { form: parsed.form, spec })
  const result = await update({ profileDir, hostManager, packageName: PACKAGE_NAME, log })
  const pinAfter = parsed.form === 'git' ? lockedCommit(profileDir, parsed.owner, parsed.repo) : undefined
  const moved = pinBefore !== pinAfter
  log?.info('update-done', { ok: result.ok, moved, pinBefore: short(pinBefore), pinAfter: short(pinAfter) })
  return {
    ran: result.ran === true,
    ok: result.ok === true,
    form: parsed.form,
    pinBefore: short(pinBefore),
    pinAfter: short(pinAfter),
    restartRequired: moved,
    outputTail: String(result.outputTail ?? '').slice(-4000),
    detail: result.ok !== true
      ? String(result.outputTail ?? '').slice(-400) || 'pnpm update failed'
      : moved
        ? `${short(pinBefore)} → ${short(pinAfter)}`
        : parsed.form === 'git'
          ? `still pinned at ${short(pinAfter)} — GitHub may not have a newer commit yet`
          : 'already current',
  }
}

/** Environment used by the pnpm child; exported so tests can assert it. */
export { pnpmEnvForRun }
