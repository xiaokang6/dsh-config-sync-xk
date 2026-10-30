/**
 * In-place upgrade of this plugin's own installation.
 *
 * The settings page has one button for it, so the shape of "upgrade" has to be
 * decided from the profile, not from a script the user has to remember:
 *
 * - `github:` / git URL — the plugin is a snapshot inside the profile and its
 *   commit is pinned in `pnpm-lock.yaml`. Upgrade = `pnpm update <package>`;
 *   the pin moving is the proof it worked.
 * - `link:` — the plugin runs a checkout. Upgrade = fast-forward that checkout.
 *   A worktree with uncommitted tracked edits is refused, not stashed: a web
 *   route is the wrong place to move someone's work aside.
 * - registry version — warn and still update; the npm package called
 *   `dsh-config-sync` belongs to an unrelated project, so this is almost never
 *   what the user meant.
 *
 * The dependency key is not necessarily the current package name: installs made
 * before the move under `@xiaokang6` still carry the unscoped key, so every read
 * and write goes through {@link resolveDependencyName} rather than assuming one.
 *
 * Nothing here restarts anything: DSH keeps ESM modules in memory, so the panel
 * says "reload" (header refresh button) instead of pretending the new code is
 * live.
 *
 * @module @xiaokang6/dsh-config-sync/sync/update
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { pnpmEnvForRun, runPnpmUpdate } from './pnpm.js'

/** The package this module upgrades. */
export const PACKAGE_NAME = '@xiaokang6/dsh-config-sync'

/**
 * The name this plugin used before it moved under a scope. Profiles installed
 * from the old repository keep this dependency key, and an upgrade must keep
 * working there instead of reporting "not a dependency".
 */
export const LEGACY_PACKAGE_NAME = 'dsh-config-sync'

/** Every dependency key this plugin answers to, current name first. */
export const PACKAGE_NAMES = [PACKAGE_NAME, LEGACY_PACKAGE_NAME]

/** Where the profile keeps its resolved versions. */
const LOCKFILE = 'pnpm-lock.yaml'

/** Git refs shorter than this are not treated as a commit. */
const SHA = /^[0-9a-f]{7,40}$/u

/**
 * Classify a dependency spec.
 * @param {string} spec - the value of `dependencies["@xiaokang6/dsh-config-sync"]`.
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
 * The dependency key this profile installed the plugin under, if any.
 *
 * A profile installed before the scope move still keys the dependency by the
 * old unscoped name, and `pnpm update` has to be given the key that is actually
 * there. Current name wins when a profile somehow carries both.
 *
 * @param {object | undefined} manifest - the profile's parsed `package.json`.
 * @returns {string | undefined}
 */
export function resolveDependencyName(manifest) {
  const dependencies = manifest?.dependencies
  if (dependencies === null || typeof dependencies !== 'object') return undefined
  for (const name of PACKAGE_NAMES) {
    if (typeof dependencies[name] === 'string') return name
  }
  return undefined
}

/**
 * Read the plugin's dependency key and spec out of the profile manifest.
 * @param {string} profileDir
 * @returns {{ name: string, spec: string } | undefined}
 */
export function readDependency(profileDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const name = resolveDependencyName(manifest)
    return name === undefined ? undefined : { name, spec: manifest.dependencies[name] }
  } catch {
    return undefined
  }
}

/**
 * Read the plugin's dependency spec out of the profile manifest.
 * @param {string} profileDir
 * @returns {string | undefined}
 */
export function readSpec(profileDir) {
  return readDependency(profileDir)?.spec
}

/**
 * The commit the profile's lockfile pinned for `owner/repo`, if any.
 *
 * pnpm records a git install in more than one shape: a `codeload…/tar.gz/<sha>`
 * URL for the `github:` shortcut, and a `git+https://…/<repo>.git#<sha>` spec for
 * a direct git URL. Reading only the first form is how a pinned install ends up
 * looking "newer version available" forever, so both are matched.
 *
 * @param {string} profileDir
 * @param {string} owner
 * @param {string} repo
 * @returns {string | undefined}
 */
export function lockedCommit(profileDir, owner, repo) {
  let text
  try {
    text = fs.readFileSync(path.join(profileDir, LOCKFILE), 'utf8')
  } catch {
    return undefined
  }
  const slug = `${owner}/${repo}`
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const patterns = [
    new RegExp(`codeload\\.github\\.com/${escaped}/tar\\.gz/([0-9a-f]{7,40})`, 'u'),
    new RegExp(`git\\+https?://github\\.com/${escaped}(?:\\.git)?#([0-9a-f]{7,40})`, 'u'),
    new RegExp(`https?://github\\.com/${escaped}(?:\\.git)?#([0-9a-f]{7,40})`, 'u'),
  ]
  for (const pattern of patterns) {
    const found = pattern.exec(text)
    if (found !== null) return found[1]
  }
  return undefined
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
 * Resolve the current commit of a ref over HTTPS, the way the plugin market does
 * it, and only fall back to the `git` binary.
 *
 * Two measurements drive this order. `git ls-remote` needs git on the host's
 * PATH *and* git's own proxy configuration (`~/.gitconfig` `http.proxy`), neither
 * of which a plugin should assume; a plain HTTPS request needs neither. Node's
 * global `fetch` in turn ignores `HTTP(S)_PROXY` — so when a proxy is configured
 * for the host we borrow undici's fetch with `EnvHttpProxyAgent`, exactly like
 * `dshmarket/lib/net.js`, and otherwise use the global one.
 *
 * The primary HTTPS route is GitHub's smart-HTTP ref advertisement
 * (`/info/refs?service=git-upload-pack`) — the same bytes `git ls-remote` reads,
 * with no API rate limit — then the REST API, then the git binary.
 *
 * @module @xiaokang6/dsh-config-sync/sync/update
 */

/** Proxy environment variable names, in the order undici honours them. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/** The ref advertisement `git ls-remote` itself fetches. */
function refsUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}/info/refs?service=git-upload-pack`
}

/** REST fallback: the commit object of a branch or tag. */
function commitUrl(owner, repo, ref) {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
}

/**
 * GET a URL as text. When a proxy is configured for the host, undici's own fetch
 * is used with `EnvHttpProxyAgent`; undici is optional, so a profile without it
 * still gets the direct request (and a readable error if that fails).
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string, string> }} options
 * @returns {Promise<{ ok: boolean, status: number, body: string, contentType: string, error?: string }>}
 */
async function fetchText(url, { timeoutMs = 10_000, headers = {} } = {}) {
  const proxy = PROXY_VARS.map((name) => process.env[name]).find((value) => typeof value === 'string' && value !== '')
  let implementation = globalThis.fetch
  let dispatcher
  if (proxy !== undefined) {
    try {
      const undici = await import('undici')
      dispatcher = new undici.EnvHttpProxyAgent()
      implementation = undici.fetch
    } catch {
      // Global fetch ignores the proxy; the request below may still succeed.
    }
  }
  if (typeof implementation !== 'function') return { ok: false, status: 0, body: '', contentType: '', error: 'no fetch implementation' }
  const init = {
    headers: { accept: '*/*', 'user-agent': PACKAGE_NAME, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (dispatcher !== undefined) init.dispatcher = dispatcher
  try {
    const response = await implementation(url, init)
    const body = await response.text()
    return {
      ok: response.ok === true,
      status: response.status,
      body,
      contentType: String(response.headers?.get?.('content-type') ?? ''),
    }
  } catch (error) {
    return { ok: false, status: 0, body: '', contentType: '', error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      await dispatcher?.close?.()
    } catch {
      // dispatcher already gone
    }
  }
}

/** Escape a literal for a RegExp. */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Commit a smart-HTTP ref advertisement advertises for `ref`.
 *
 * Mirrors answer a failed upstream with their own HTML and status 200, so the
 * payload is validated (service prelude + a 40-hex ref line) before anything is
 * believed — the same guard `dshmarket/lib/accelerate.js` uses.
 *
 * @param {string} body - the advertisement.
 * @param {string | undefined} ref - branch or tag name; undefined means HEAD.
 * @returns {string | undefined}
 */
export function parseRefsAdvertisement(body, ref) {
  const text = String(body ?? '')
  if (text.includes('text/html') || !text.includes('# service=git-upload-pack')) return undefined
  if (!/[0-9a-f]{40} (?:HEAD|refs\/(?:heads|tags)\/)/u.test(text)) return undefined
  if (ref === undefined) {
    const head = /([0-9a-f]{40}) HEAD/u.exec(text)
    return head?.[1]
  }
  const name = escapeRegExp(ref)
  for (const pattern of [
    new RegExp(`([0-9a-f]{40}) refs/heads/${name}$`, 'mu'),
    new RegExp(`([0-9a-f]{40}) refs/tags/${name}(?:\\^\\{\\})?$`, 'mu'),
  ]) {
    const found = pattern.exec(text)
    if (found !== null) return found[1]
  }
  return undefined
}

/**
 * Resolve a ref's commit, trying HTTPS first and the `git` binary last.
 * @param {{ owner: string, repo: string, ref: string }} remote
 * @param {{
 *   cwd?: string, run?: typeof git, fetch?: typeof fetchText, timeoutMs?: number,
 * }} options
 * @returns {Promise<{ sha?: string, via?: 'refs' | 'api' | 'git' | 'pinned', errors: string[] }>}
 */
export async function resolveRemoteCommit(remote, { cwd = process.cwd(), run = git, fetch: fetchImpl = fetchText, timeoutMs = 10_000 } = {}) {
  if (SHA.test(remote.ref)) return { sha: remote.ref.toLowerCase(), via: 'pinned', errors: [] }
  const errors = []

  const refs = await fetchImpl(refsUrl(remote.owner, remote.repo), { timeoutMs })
  if (refs.ok) {
    const sha = parseRefsAdvertisement(refs.body, remote.ref)
    if (sha !== undefined) return { sha: sha.toLowerCase(), via: 'refs', errors }
    errors.push('info/refs answered without that ref')
  } else {
    errors.push(`info/refs: ${refs.error ?? `HTTP ${refs.status}`}`)
  }

  const api = await fetchImpl(commitUrl(remote.owner, remote.repo, remote.ref), { timeoutMs, headers: { accept: 'application/vnd.github+json' } })
  if (api.ok) {
    try {
      const sha = String(JSON.parse(api.body)?.sha ?? '').toLowerCase()
      if (SHA.test(sha)) return { sha, via: 'api', errors }
      errors.push('the GitHub API answer carried no commit sha')
    } catch {
      errors.push('the GitHub API answer was not JSON')
    }
  } else {
    errors.push(`api: ${api.error ?? `HTTP ${api.status}`}`)
  }

  const gitResult = await run(['ls-remote', `https://github.com/${remote.owner}/${remote.repo}`, `refs/heads/${remote.ref}`], { cwd })
  if (gitResult.ok) {
    const sha = (gitResult.out.split(/\s+/u)[0] ?? '').toLowerCase()
    if (SHA.test(sha)) return { sha, via: 'git', errors }
    errors.push('git ls-remote answered without a commit')
  } else {
    errors.push(`git: ${gitResult.err || gitResult.out || 'not available'}`)
  }

  return { errors }
}

/**
 * Current commit of a ref on GitHub (sha only; `resolveRemoteCommit` carries why).
 * @param {{ owner: string, repo: string, ref: string }} remote
 * @param {{ cwd: string, run?: typeof git, fetch?: typeof fetchText }} options
 * @returns {Promise<string | undefined>}
 */
export async function remoteCommit(remote, options) {
  return (await resolveRemoteCommit(remote, options)).sha
}

/** True when two commit ids name the same commit (allowing abbreviation). */
export function sameCommit(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left === right || left.startsWith(right) || right.startsWith(left)
}

/** Short form for display. */
const short = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : sha)

/**
 * Report where the installed copy stands. Read-only: the only side effects are a
 * `git fetch` for a `link:` checkout and one HTTPS (or, as a last resort, `git
 * ls-remote`) ref lookup for a git install.
 * @param {{ profileDir: string, run?: typeof git, fetch?: typeof fetchText, timeoutMs?: number }} input
 * @returns {Promise<{
 *   form: 'link' | 'git' | 'registry', spec: string, canApply: boolean,
 *   pinned?: string, latest?: string, upToDate?: boolean, behind?: number,
 *   dirty?: boolean, via?: string, detail: string,
 * }>}
 */
export async function checkForUpdate({ profileDir, run = git, fetch: fetchImpl = fetchText, timeoutMs = 10_000 }) {
  const dependency = readDependency(profileDir)
  if (dependency === undefined) {
    return { form: 'registry', spec: '', canApply: false, detail: `${PACKAGE_NAME} is not a dependency of this profile` }
  }
  const { spec } = dependency
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
    const resolved = await resolveRemoteCommit(parsed, { cwd, run, fetch: fetchImpl, timeoutMs })
    const latest = resolved.sha
    // Never turn "could not read" into a verdict: an unread pin or an unreachable
    // ref is unknown, not "up to date" and not "an update is waiting".
    const upToDate = pinned === undefined || latest === undefined ? undefined : sameCommit(pinned, latest)
    const detail = latest === undefined
      ? `could not read the ref on GitHub — ${resolved.errors.join('; ')} (an update attempt is still allowed)`
      : pinned === undefined
        ? 'the pinned commit could not be read from pnpm-lock.yaml — press 一键升级 to be sure'
        : upToDate === true
          ? ''
          : 'a newer commit is published; press 一键升级'
    return {
      form: 'git',
      spec,
      canApply: true,
      pinned: short(pinned),
      latest: short(latest),
      upToDate,
      ...(resolved.via === undefined ? {} : { via: resolved.via }),
      detail,
    }
  }

  return {
    form: 'registry',
    spec,
    canApply: true,
    detail: 'the npm package named dsh-config-sync belongs to an unrelated project — prefer github:xiaokang6/dsh-config-sync-xk',
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
  const dependency = readDependency(profileDir)
  if (dependency === undefined) {
    return { ran: false, ok: false, form: 'none', restartRequired: false, outputTail: '', detail: `${PACKAGE_NAME} is not a dependency of this profile` }
  }
  const { name, spec } = dependency
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
  log?.info('update-start', { form: parsed.form, name, spec })
  // The key that is actually in package.json: `pnpm update` matches by key, and
  // a profile installed before the scope move still carries the old one.
  const result = await update({ profileDir, hostManager, packageName: name, log })
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
