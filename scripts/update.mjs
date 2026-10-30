#!/usr/bin/env node
/**
 * One-command upgrade for the `link:`-installed copy of dsh-config-sync.
 *
 *   npm run update                  # fetch, fast-forward, install deps if they changed
 *   node scripts/update.mjs --check # report what an update would do, change nothing
 *
 * A `link:` install runs the code in this repository, so "upgrading the plugin"
 * is exactly "getting this checkout current" — plus two things that are easy to
 * forget and annoying to diagnose:
 *
 * 1. `package.json` / `pnpm-lock.yaml` moving means the profile still needs
 *    `pnpm install`; skipping it leaves a plugin that imports fine but pulls a
 *    dependency that is not there.
 * 2. A plugin imported through `link:` is imported from its **real** path, where
 *    the host's own `@deepseek-ai/*` packages are not on the resolution path.
 *    The peer links this script maintains are what keep that import working.
 *
 * The running host keeps ESM modules in memory, so the last step is always a
 * reload: the header refresh button, or restarting DeepSeek Harness.
 *
 * Local edits are never dropped: a dirty tree is stashed before the fast-forward
 * and restored after it, and a failed restore is reported without touching HEAD.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

/** Run a command, capturing output; `shell` is only for Windows `.cmd` shims. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoDir,
    encoding: 'utf8',
    shell: options.shell === true,
    ...(options.stdio === 'inherit' ? { stdio: 'inherit' } : {}),
  })
  if (result.error !== undefined) return { ok: false, status: -1, out: '', err: result.error.message }
  const out = String(result.stdout ?? '').trim()
  const err = String(result.stderr ?? '').trim()
  return { ok: (result.status ?? 1) === 0, status: result.status ?? 1, out, err }
}

/** Run git and return trimmed stdout, throwing a readable message on failure. */
function git(...args) {
  const result = run('git', args)
  if (!result.ok) fail(`git ${args.join(' ')} failed:\n${result.err || result.out}`)
  return result.out
}

// -- 0. sanity ---------------------------------------------------------------

if (!fs.existsSync(path.join(repoDir, '.git'))) {
  fail(`${repoDir} is not a git checkout — a published install upgrades with "dsh plugin install dsh-config-sync" instead`)
}
if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
  fail(`profile not found: ${profileDir} (pass --profile-dir <dir>)`)
}

const tracked = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
const upstream = tracked.ok && tracked.out !== '' ? tracked.out.trim() : 'origin/main'
git('fetch', '--quiet', '--prune', 'origin')

const behind = Number(git('rev-list', '--count', `HEAD..${upstream}`).trim() || '0')
const head = git('log', '-1', '--format=%h %s').trim()

log(`repository: ${repoDir}`)
log(`profile:    ${profileDir}`)
log(`current:    ${head}`)

if (behind === 0) {
  log(`\n✓ already up to date with ${upstream}`)
  log('  (a running host still needs a reload after a manual code change)')
  process.exit(0)
}

const incoming = git('log', '--oneline', `HEAD..${upstream}`).trim()
const changed = git('diff', '--name-only', `HEAD..${upstream}`).split('\n').filter((line) => line !== '')
const depsChanged =
  changed.includes('package.json') || changed.includes('pnpm-lock.yaml') || changed.includes('pnpm-workspace.yaml')

log(`\n${behind} new commit(s) on ${upstream}:`)
for (const line of incoming.split('\n')) log(`  ${line}`)
if (checkOnly) {
  log(`\n--check: nothing changed. ${depsChanged ? 'This update also needs "pnpm install" in the profile.' : ''}`.trim())
  process.exit(0)
}

// -- 1. keep local edits, fast-forward --------------------------------------

// Tracked edits only: an untracked file that the incoming commits also add makes
// `git merge` fail loudly (which is the honest outcome) instead of turning the
// stash pop into a conflict that has to be untangled by hand.
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

// -- 2. dependencies --------------------------------------------------------

if (depsChanged) {
  /** Prefer the pnpm the app ships, so the profile is built by the same version. */
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
  // A shell line, not argv: on Windows pnpm is a `.cmd` shim that only a shell
  // can start, and this is the one place where the command is not a plain binary.
  const shell = (line) => spawnSync(line, { cwd: profileDir, shell: true, stdio: 'inherit' })
  let installed
  if (process.env.DSH_PNPM !== undefined && process.env.DSH_PNPM !== '') installed = shell(`"${process.env.DSH_PNPM}" install`)
  else if (fs.existsSync(runtimePnpm)) installed = shell(`"${process.execPath}" "${runtimePnpm}" install`)
  else installed = shell('pnpm install')
  if ((installed.status ?? 1) !== 0) fail(`dependency install failed in ${profileDir} — run "pnpm install" there by hand`)
  log('• profile dependencies installed (package.json changed)')
} else {
  log('• dependencies unchanged — no pnpm install needed')
}

// -- 3. peer links a link: import needs -------------------------------------

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

// -- 4. make the running host pick it up ------------------------------------

log('\nnext: reload the host so it drops the cached modules —')
log('  • press the refresh button at the top right of the DSH window, or')
log('  • restart DeepSeek Harness')
log('  (the panel then shows the new version; nothing else to configure)')
