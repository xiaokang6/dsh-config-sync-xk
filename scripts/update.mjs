#!/usr/bin/env node
/**
 * One-command upgrade for dsh-config-sync, whatever form it was installed in.
 *
 *   npm run update          # upgrade, then tell you how to reload the host
 *   npm run update:check    # report only: nothing is changed
 *
 * The profile's `package.json` decides what "upgrade" means, so the same command
 * works on a development machine and on a machine that has no checkout at all:
 *
 * - `link:` — the plugin runs *this* checkout. Upgrade = fetch + fast-forward,
 *   `pnpm install` in the profile when `package.json`/`pnpm-lock.yaml` moved, and
 *   keep the `@deepseek-ai/*` peer links alive: a plugin reached through a
 *   symlink is imported from its real path, where the host's own packages are
 *   not on the resolution path.
 * - `github:` / git URL — the plugin is a snapshot inside the profile, pinning a
 *   commit in `pnpm-lock.yaml`. Upgrade = `pnpm update dsh-config-sync`, which
 *   re-resolves the ref; no checkout, no local path, nothing to remember. This is
 *   the form to use on every machine that is not actively developing the plugin.
 *
 * Local edits are never dropped: in link mode a dirty tree is stashed before the
 * fast-forward and restored after it, and a failed restore is reported without
 * touching HEAD.
 *
 * Either way the running host keeps ESM modules in memory, so the last step is
 * always a reload: the header refresh button, or restarting DeepSeek Harness.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-config-sync'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(here, '..')
const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check') || argv.includes('--dry-run')
const flagValue = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
}

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileName = flagValue('--profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const profileDir = path.resolve(
  flagValue('--profile-dir') ?? process.env.DSH_PROFILE_DIR ?? path.join(dshHome, 'profiles', profileName),
)

/** Peer packages a `link:` plugin must be able to resolve from its real path. */
const PEER_PACKAGES = ['@deepseek-ai/schemastery', '@deepseek-ai/cordis']

const log = (message) => console.log(message)
const fail = (message) => {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Run a command, capturing output. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoDir,
    encoding: 'utf8',
    ...(options.stdio === 'inherit' ? { stdio: 'inherit' } : {}),
  })
  if (result.error !== undefined) return { ok: false, status: -1, out: '', err: result.error.message }
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    out: String(result.stdout ?? '').trim(),
    err: String(result.stderr ?? '').trim(),
  }
}

/** Run a shell line: the only way to start pnpm, which is a `.cmd` shim on Windows. */
function shell(line, options = {}) {
  const result = spawnSync(line, {
    cwd: options.cwd ?? repoDir,
    shell: true,
    stdio: options.stdio ?? 'inherit',
  })
  return { ok: (result.status ?? 1) === 0, status: result.status ?? 1 }
}

/** Run git and return trimmed stdout, failing with a readable message. */
function git(...args) {
  const result = run('git', args)
  if (!result.ok) fail(`git ${args.join(' ')} failed:\n${result.err || result.out}`)
  return result.out
}

/** The pnpm the app ships, so the profile is built by the same version. */
function profilePnpmInstall() {
  const runtimePnpm = path.join(
    path.dirname(process.execPath),
    '..',
    'runtime',
    'primary-runtime',
    'dependencies',
    'pnpm',
    'bin',
    'pnpm.mjs',
  )
  if (process.env.DSH_PNPM !== undefined && process.env.DSH_PNPM !== '') return shell(`"${process.env.DSH_PNPM}" install`, { cwd: profileDir })
  if (fs.existsSync(runtimePnpm)) return shell(`"${process.execPath}" "${runtimePnpm}" install`, { cwd: profileDir })
  return shell('pnpm install', { cwd: profileDir })
}

/** Upgrade the profile's copy in place (git/registry install forms). */
function profilePnpmUpdate() {
  const result = shell(`pnpm update ${PACKAGE_NAME}`, { cwd: profileDir, stdio: 'inherit' })
  return result.ok
}

/** owner/repo/ref out of a git-style dependency spec, or undefined. */
function gitRemoteOf(spec) {
  const short = /^github:([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/u.exec(spec)
  if (short !== null) return { owner: short[1], repo: short[2], ref: short[3] ?? 'main' }
  const url = /^(?:git\+)?https?:\/\/github\.com\/([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/u.exec(spec)
  if (url !== null) return { owner: url[1], repo: url[2], ref: url[3] ?? 'main' }
  return undefined
}

/** Commit the profile's lockfile pinned for `owner/repo`, or undefined. */
function lockedCommit(owner, repo) {
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml')
  if (!fs.existsSync(lockPath)) return undefined
  const text = fs.readFileSync(lockPath, 'utf8')
  const pattern = new RegExp(`codeload\\.github\\.com/${owner}/${repo}/tar\\.gz/([0-9a-f]{7,40})`, 'u')
  return pattern.exec(text)?.[1]
}

/** Current commit of the spec's ref on GitHub, or undefined when offline. */
function remoteCommit(remote) {
  if (/^[0-9a-f]{7,40}$/u.test(remote.ref)) return remote.ref
  const result = run('git', ['ls-remote', `https://github.com/${remote.owner}/${remote.repo}`, `refs/heads/${remote.ref}`])
  if (!result.ok) return undefined
  const sha = result.out.split(/\s+/u)[0] ?? ''
  return /^[0-9a-f]{7,40}$/u.test(sha) ? sha : undefined
}

const short = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : sha)
const sameCommit = (left, right) =>
  typeof left === 'string' && typeof right === 'string' && (left === right || left.startsWith(right) || right.startsWith(left))

function reloadHint() {
  log('\nnext: reload the host so it drops the cached modules —')
  log('  • press the refresh button at the top right of the DSH window, or')
  log('  • restart DeepSeek Harness')
  log('  (the panel then shows the new version; nothing else to configure)')
}

// -- 0. what is installed in this profile? ----------------------------------

const manifestPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(manifestPath)) fail(`profile not found: ${profileDir} (pass --profile-dir <dir>)`)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const spec = manifest?.dependencies?.[PACKAGE_NAME]
if (typeof spec !== 'string') {
  fail(`${PACKAGE_NAME} is not a dependency of ${profileDir} — install it first (node scripts/install.mjs, or a "github:" dependency)`)
}

const linkMode = spec.startsWith('link:')
const gitInstall = /^(?:github:|git\+|https?:\/\/)/u.test(spec)
const remote = gitInstall ? gitRemoteOf(spec) : undefined

log(`profile: ${profileDir}`)
log(`install: ${linkMode ? `link: → ${spec.slice(5)}` : `${spec} (snapshot inside the profile)`}`)

// -- A. installed from a git spec: upgrade the snapshot ---------------------

if (!linkMode) {
  if (!gitInstall) {
    log('\n⚠ the dependency is a registry version. The npm package named')
    log(`  "${PACKAGE_NAME}" belongs to a different project, so this is almost`)
    log('  certainly not the plugin you want — use "github:xiaokang6/dsh-config-sync".')
  }
  const pinned = remote === undefined ? undefined : lockedCommit(remote.owner, remote.repo)
  const latest = remote === undefined ? undefined : remoteCommit(remote)
  if (pinned !== undefined) log(`pinned:  ${short(pinned)}`)
  if (latest !== undefined) log(`github:  ${short(latest)}  (refs/heads/${remote.ref})`)

  if (latest === undefined) {
    // Offline, rate-limited, or the ref is gone: never claim "up to date" from a
    // check that did not happen, and never claim an update that was not seen.
    log('\n· could not read the ref on GitHub (offline? proxy?)')
    log(`  the pinned commit ${short(pinned ?? 'unknown')} is what runs now; an update attempt is still allowed`)
    if (checkOnly) process.exit(0)
  } else if (sameCommit(pinned, latest)) {
    log('\n✓ already up to date')
    reloadHint()
    process.exit(0)
  } else if (checkOnly) {
    log('\n--check: an update is available — run "npm run update" (or "pnpm update dsh-config-sync" in the profile).')
    process.exit(0)
  }
  log('\n• updating the profile copy (pnpm update)')
  if (!profilePnpmUpdate()) fail(`pnpm update ${PACKAGE_NAME} failed in ${profileDir}`)
  const updated = remote === undefined ? undefined : lockedCommit(remote.owner, remote.repo)
  log(
    updated === undefined
      ? '• done (could not re-read the pinned commit)'
      : updated === pinned
        ? `• still pinned at ${short(updated)} — the registry may not have the new commit yet; retry later`
        : `• ${short(pinned)} → ${short(updated)}`,
  )
  reloadHint()
  process.exit(0)
}

// -- B. link: install: bring this checkout current --------------------------

if (!fs.existsSync(path.join(repoDir, '.git'))) {
  fail(`${repoDir} is not a git checkout, but the profile links to a checkout`)
}

const tracked = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
const upstream = tracked.ok && tracked.out !== '' ? tracked.out.trim() : 'origin/main'
git('fetch', '--quiet', '--prune', 'origin')

const behind = Number(git('rev-list', '--count', `HEAD..${upstream}`).trim() || '0')
log(`checkout: ${repoDir}`)
log(`current:  ${git('log', '-1', '--format=%h %s').trim()}`)

if (behind === 0) {
  log(`\n✓ already up to date with ${upstream}`)
  reloadHint()
  process.exit(0)
}

const incoming = git('log', '--oneline', `HEAD..${upstream}`).trim()
const changed = git('diff', '--name-only', `HEAD..${upstream}`).split('\n').filter((line) => line !== '')
const depsChanged =
  changed.includes('package.json') || changed.includes('pnpm-lock.yaml') || changed.includes('pnpm-workspace.yaml')

log(`\n${behind} new commit(s) on ${upstream}:`)
for (const line of incoming.split('\n')) log(`  ${line}`)
if (checkOnly) {
  log(`\n--check: nothing changed.${depsChanged ? ' This update also needs "pnpm install" in the profile.' : ''}`)
  process.exit(0)
}

// Tracked edits only: an untracked file that the incoming commits also add makes
// `git merge` fail loudly (the honest outcome) instead of turning the stash pop
// into a conflict that has to be untangled by hand.
const dirty = git('status', '--porcelain', '--untracked-files=no').trim() !== ''
if (dirty) {
  git('stash', 'push', '--quiet')
  log('\n• local edits stashed')
}

const pulled = run('git', ['merge', '--ff-only', upstream])
if (!pulled.ok) {
  if (dirty) run('git', ['stash', 'pop', '--quiet'])
  fail(`fast-forward to ${upstream} failed — resolve it by hand in ${repoDir}:\n${pulled.err || pulled.out}`)
}
log(`• fast-forwarded to ${git('log', '-1', '--format=%h %s').trim()}`)

if (dirty) {
  const popped = run('git', ['stash', 'pop', '--quiet'])
  log(
    popped.ok
      ? '• local edits restored'
      : '• ⚠ local edits need a hand: "git stash list" still has them — run "git stash pop" and resolve',
  )
}

if (depsChanged) {
  if (!profilePnpmInstall().ok) fail(`dependency install failed in ${profileDir} — run "pnpm install" there by hand`)
  log('• profile dependencies installed (package.json changed)')
} else {
  log('• dependencies unchanged — no pnpm install needed')
}

for (const packageName of PEER_PACKAGES) {
  const linkPath = path.join(repoDir, 'node_modules', ...packageName.split('/'))
  if (fs.existsSync(linkPath)) continue
  const stablePath = path.join(dshHome, 'profiles', 'node_modules', ...packageName.split('/'))
  if (!fs.existsSync(stablePath)) continue
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    fs.symlinkSync(stablePath, linkPath, 'junction')
    log(`• restored peer link ${packageName}`)
  } catch (error) {
    log(`• ⚠ could not link ${packageName} (${error.message}); create it by hand or the host import will fail`)
  }
}

reloadHint()
