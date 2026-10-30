/**
 * Self-upgrade tests: spec parsing, pin comparison, and the two apply paths.
 *
 * Git and pnpm are injected, so nothing here touches the network or a real
 * profile — the assertions are about what the module decides, not about pnpm.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  applyUpdate,
  checkForUpdate,
  lockedCommit,
  parseRefsAdvertisement,
  parseSpec,
  readDependency,
  readSpec,
  remoteCommit,
  resolveRemoteCommit,
  sameCommit,
} from '../../lib/sync/update.js'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

/** Build a throwaway profile with a manifest, a lockfile and an optional checkout. */
function makeProfile({ spec, pinned, linkDir = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-test-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'p', private: true, dependencies: { [PACKAGE_NAME]: spec } }, null, 2)}\n`,
  )
  if (pinned !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n\n  ${PACKAGE_NAME}@https://codeload.github.com/xiaokang6/dsh-config-sync-xk/tar.gz/${pinned}:\n    resolution: {gitHosted: true}\n`,
    )
  }
  if (linkDir !== null) {
    fs.mkdirSync(path.join(linkDir, '.git'), { recursive: true })
  }
  return dir
}

/** A fake `git` runner: `responses` maps a joined command to stdout (or an error). */
function fakeGit(responses) {
  const calls = []
  const run = async (args, options = {}) => {
    calls.push({ args, cwd: options.cwd })
    const key = args.join(' ')
    const answer = responses[key]
    if (answer === undefined) return { ok: false, out: '', err: `unexpected git ${key}` }
    if (typeof answer === 'string') return { ok: true, out: answer, err: '' }
    return answer
  }
  return { run, calls }
}

test('parseSpec recognises every install form', () => {
  assert.equal(parseSpec('link:D:/AI/chajian/dsh-config-sync').form, 'link')
  assert.equal(parseSpec('link:D:/AI/chajian/dsh-config-sync').dir, 'D:/AI/chajian/dsh-config-sync')

  const short = parseSpec('github:xiaokang6/dsh-config-sync-xk')
  assert.deepEqual({ form: short.form, owner: short.owner, repo: short.repo, ref: short.ref }, {
    form: 'git',
    owner: 'xiaokang6',
    repo: 'dsh-config-sync-xk',
    ref: 'main',
  })

  const pinned = parseSpec('github:xiaokang6/dsh-config-sync-xk#dev')
  assert.equal(pinned.ref, 'dev')

  const url = parseSpec('git+https://github.com/xiaokang6/dsh-config-sync-xk.git')
  assert.equal(url.form, 'git')
  assert.equal(url.repo, 'dsh-config-sync-xk')

  assert.equal(parseSpec('^0.1.0').form, 'registry')
  assert.equal(parseSpec('').form, 'registry')
})

test('readSpec and lockedCommit read the profile manifest and lockfile', () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync-xk', pinned: OLD })
  assert.equal(readSpec(dir), 'github:xiaokang6/dsh-config-sync-xk')
  assert.equal(lockedCommit(dir, 'xiaokang6', 'dsh-config-sync-xk'), OLD)
  assert.equal(lockedCommit(dir, 'someone', 'else'), undefined)
  assert.equal(readSpec(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-empty-'))), undefined)
})

test('sameCommit tolerates abbreviated ids', () => {
  assert.equal(sameCommit(NEW, NEW), true)
  assert.equal(sameCommit(NEW, NEW.slice(0, 7)), true)
  assert.equal(sameCommit(OLD, NEW), false)
  assert.equal(sameCommit(undefined, NEW), false)
})

/** A `fetchText` stub: `routes` maps a URL substring to a canned answer. */
function fakeFetch(routes) {
  const calls = []
  const fetchText = async (url) => {
    calls.push(url)
    const key = Object.keys(routes).find((needle) => url.includes(needle))
    if (key === undefined) return { ok: false, status: 0, body: '', contentType: '', error: `no route for ${url}` }
    const answer = routes[key]
    return typeof answer === 'function' ? answer(url) : answer
  }
  return { fetchText, calls }
}

/** Offline stub: the HTTPS routes fail, so only the git route can answer. */
const offlineFetch = { fetchText: async () => ({ ok: false, status: 0, body: '', contentType: '', error: 'offline' }) }

/** A GitHub smart-HTTP ref advertisement carrying `sha`. */
function advertisement(sha, refs = ['refs/heads/main']) {
  return ['001e# service=git-upload-pack', '', ...refs.map((ref) => `003f${sha} ${ref}`)].join('\n')
}

test('remoteCommit prefers the ls-remote head and passes a pinned sha through', async () => {
  const remote = { owner: 'xiaokang6', repo: 'dsh-config-sync-xk', ref: 'main' }
  const { run } = fakeGit({ 'ls-remote https://github.com/xiaokang6/dsh-config-sync-xk refs/heads/main': `${NEW}\trefs/heads/main` })
  assert.equal(await remoteCommit(remote, { cwd: os.tmpdir(), run, fetch: offlineFetch.fetchText }), NEW)
  assert.equal(await remoteCommit({ ...remote, ref: OLD }, { cwd: os.tmpdir(), run }), OLD)
  const offline = fakeGit({})
  assert.equal(await remoteCommit(remote, { cwd: os.tmpdir(), run: offline.run, fetch: offlineFetch.fetchText }), undefined)
})

test('a github install compares the pinned commit with the published head', async () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync-xk', pinned: OLD })

  const current = await checkForUpdate({
    profileDir: dir,
    fetch: fakeFetch({ '/info/refs': { ok: true, status: 200, body: advertisement(OLD), contentType: 'application/x-git-upload-pack-advertisement' } }).fetchText,
    run: fakeGit({}).run,
  })
  assert.equal(current.form, 'git')
  assert.equal(current.upToDate, true)
  assert.equal(current.canApply, true)
  assert.equal(current.pinned, OLD.slice(0, 7))
  assert.equal(current.latest, OLD.slice(0, 7))
  assert.equal(current.via, 'refs', 'the ref lookup happens over HTTPS, not through git')

  const stale = await checkForUpdate({
    profileDir: dir,
    fetch: fakeFetch({ '/info/refs': { ok: true, status: 200, body: advertisement(NEW), contentType: 'application/x-git-upload-pack-advertisement' } }).fetchText,
    run: fakeGit({}).run,
  })
  assert.equal(stale.upToDate, false)
  assert.match(stale.detail, /newer commit/u)

  const unreachable = await checkForUpdate({ profileDir: dir, fetch: offlineFetch.fetchText, run: fakeGit({}).run })
  assert.equal(unreachable.upToDate, undefined, 'an unchecked ref must not claim to be current')
  assert.equal(unreachable.canApply, true, 'an offline check still allows trying')
  assert.match(unreachable.detail, /could not read the ref on GitHub/u)
  assert.match(unreachable.detail, /offline/u, 'the detail carries each attempt, not just "unreachable"')
})

test('an unreadable pin is unknown, not "an update is waiting"', async () => {
  const dir = makeProfile({ spec: 'git+https://github.com/xiaokang6/dsh-config-sync-xk.git' })
  const check = await checkForUpdate({
    profileDir: dir,
    fetch: fakeFetch({ '/info/refs': { ok: true, status: 200, body: advertisement(NEW), contentType: 'application/x-git-upload-pack-advertisement' } }).fetchText,
    run: fakeGit({}).run,
  })
  assert.equal(check.upToDate, undefined)
  assert.match(check.detail, /pinned commit could not be read/u)
})

test('lockedCommit reads the git+https lock form too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-lock-'))
  fs.writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      @xiaokang6/dsh-config-sync:',
      '        specifier: git+https://github.com/xiaokang6/dsh-config-sync-xk.git',
      `        version: git+https://github.com/xiaokang6/dsh-config-sync-xk.git#${NEW}`,
      '',
    ].join('\n'),
  )
  assert.equal(lockedCommit(dir, 'xiaokang6', 'dsh-config-sync-xk'), NEW)
})

test('the ref advertisement is validated before it is believed', () => {
  assert.equal(parseRefsAdvertisement(advertisement(OLD), 'main'), OLD)
  assert.equal(parseRefsAdvertisement(advertisement(OLD, ['refs/tags/v1', 'refs/heads/dev']), 'dev'), OLD)
  assert.equal(parseRefsAdvertisement(advertisement(OLD, ['refs/tags/v1']), 'v1'), OLD)
  assert.equal(parseRefsAdvertisement(`${OLD} HEAD\n${advertisement(OLD)}`, undefined), OLD)
  assert.equal(parseRefsAdvertisement('<html>this mirror is offline</html>', 'main'), undefined)
  assert.equal(parseRefsAdvertisement('', 'main'), undefined)
  assert.equal(parseRefsAdvertisement(advertisement(OLD, ['refs/heads/other']), 'main'), undefined)
})

test('the ref lookup falls back from info/refs to the API and then to git', async () => {
  const remote = { owner: 'xiaokang6', repo: 'dsh-config-sync-xk', ref: 'main' }

  const viaApi = fakeFetch({
    '/info/refs': { ok: false, status: 403, body: '', contentType: '', error: 'HTTP 403' },
    '/commits/main': { ok: true, status: 200, body: JSON.stringify({ sha: NEW }), contentType: 'application/json' },
  })
  const apiResult = await resolveRemoteCommit(remote, { cwd: os.tmpdir(), run: fakeGit({}).run, fetch: viaApi.fetchText })
  assert.equal(apiResult.via, 'api')
  assert.equal(apiResult.sha, NEW)
  assert.deepEqual(viaApi.calls.map((url) => (url.includes('/info/refs') ? 'refs' : 'api')), ['refs', 'api'])

  const viaGit = fakeGit({ 'ls-remote https://github.com/xiaokang6/dsh-config-sync-xk refs/heads/main': `${OLD}\trefs/heads/main` })
  const gitResult = await resolveRemoteCommit(remote, { cwd: os.tmpdir(), run: viaGit.run, fetch: offlineFetch.fetchText })
  assert.equal(gitResult.via, 'git')
  assert.equal(gitResult.sha, OLD)
  assert.equal(gitResult.errors.length, 2, 'both HTTPS failures are reported')

  const nothing = await resolveRemoteCommit(remote, { cwd: os.tmpdir(), run: fakeGit({}).run, fetch: offlineFetch.fetchText })
  assert.equal(nothing.sha, undefined)
  assert.equal(nothing.errors.length, 3)
})

test('a link install reports the checkout state and refuses a dirty worktree', async () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-checkout-'))
  const dir = makeProfile({ spec: `link:${checkout}`, linkDir: checkout })

  const clean = fakeGit({
    'fetch --quiet --prune origin': '',
    'status --porcelain --untracked-files=no': '',
    'rev-list --count HEAD..@{upstream}': '2',
  })
  const behind = await checkForUpdate({ profileDir: dir, run: clean.run })
  assert.equal(behind.form, 'link')
  assert.equal(behind.behind, 2)
  assert.equal(behind.upToDate, false)
  assert.equal(behind.canApply, true)

  const dirty = fakeGit({
    'fetch --quiet --prune origin': '',
    'status --porcelain --untracked-files=no': ' M lib/sync/engine.js',
    'rev-list --count HEAD..@{upstream}': '1',
  })
  const held = await checkForUpdate({ profileDir: dir, run: dirty.run })
  assert.equal(held.dirty, true)
  assert.equal(held.canApply, false)
  assert.match(held.detail, /uncommitted/u)
})

test('applying to a github install reports the pin moving and asks for a reload', async () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync-xk', pinned: OLD })
  let asked = null
  const fakeUpdate = async (input) => {
    asked = input
    fs.writeFileSync(
      path.join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n\n  ${PACKAGE_NAME}@https://codeload.github.com/xiaokang6/dsh-config-sync-xk/tar.gz/${NEW}:\n    resolution: {gitHosted: true}\n`,
    )
    return { ran: true, ok: true, outputTail: 'Done', policyRelaxed: false }
  }
  const result = await applyUpdate({ profileDir: dir, update: fakeUpdate })
  assert.equal(asked.packageName, PACKAGE_NAME)
  assert.equal(asked.profileDir, dir)
  assert.equal(result.ok, true)
  assert.equal(result.restartRequired, true)
  assert.equal(result.detail, `${OLD.slice(0, 7)} → ${NEW.slice(0, 7)}`)
})

test('a failed pnpm update keeps the failure readable and does not ask for a reload', async () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync-xk', pinned: OLD })
  const result = await applyUpdate({
    profileDir: dir,
    update: async () => ({ ran: true, ok: false, outputTail: 'ERR_PNPM_FETCH_404  GET https://codeload.github.com/…' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.restartRequired, false)
  assert.match(result.detail, /ERR_PNPM_FETCH_404/u)
})

test('a link install fast-forwards, and refuses without touching anything when dirty', async () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-ff-'))
  const dir = makeProfile({ spec: `link:${checkout}`, linkDir: checkout })

  const clean = fakeGit({
    'status --porcelain --untracked-files=no': '',
    'rev-parse --short HEAD': OLD.slice(0, 12),
    'merge --ff-only @{upstream}': 'Fast-forward',
  })
  const applied = await applyUpdate({ profileDir: dir, run: clean.run })
  assert.equal(applied.ok, true)
  assert.equal(applied.form, 'link')
  assert.equal(applied.restartRequired, false, 'HEAD did not move in the fake run')

  const dirty = fakeGit({ 'status --porcelain --untracked-files=no': ' M package.json' })
  const refused = await applyUpdate({ profileDir: dir, run: dirty.run })
  assert.equal(refused.ok, false)
  assert.equal(refused.ran, false)
  assert.deepEqual(dirty.calls.map((call) => call.args[0]), ['status'], 'a dirty checkout must not be merged')
})

test('a profile that does not depend on the plugin is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-none-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","private":true}\n')
  const check = await checkForUpdate({ profileDir: dir, run: fakeGit({}).run })
  assert.equal(check.canApply, false)
  const applied = await applyUpdate({ profileDir: dir })
  assert.equal(applied.ok, false)
  assert.match(applied.detail, new RegExp(PACKAGE_NAME, 'u'))
})

test('a profile installed under the pre-scope name still upgrades', async () => {
  // The dependency key is whatever the profile holds, not what the package is
  // called today: `pnpm update` matches by key, so passing the new name to an
  // old profile would fail with "no such dependency" and strand that machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-legacy-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'p', private: true, dependencies: { [LEGACY_PACKAGE_NAME]: 'github:xiaokang6/dsh-config-sync-xk' } }, null, 2)}\n`,
  )
  assert.deepEqual(readDependency(dir), { name: LEGACY_PACKAGE_NAME, spec: 'github:xiaokang6/dsh-config-sync-xk' })
  assert.equal(readSpec(dir), 'github:xiaokang6/dsh-config-sync-xk')

  let asked = null
  const result = await applyUpdate({
    profileDir: dir,
    update: async (input) => {
      asked = input
      return { ran: true, ok: true, outputTail: 'Done' }
    },
  })
  assert.equal(asked.packageName, LEGACY_PACKAGE_NAME, 'pnpm must be given the key the profile actually has')
  assert.equal(result.ok, true)
})

test('the current name wins when a profile carries both keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-both-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'p',
        private: true,
        dependencies: {
          [LEGACY_PACKAGE_NAME]: 'github:xiaokang6/dsh-config-sync-xk',
          [PACKAGE_NAME]: 'github:xiaokang6/dsh-config-sync-xk',
        },
      },
      null,
      2,
    )}\n`,
  )
  assert.deepEqual(readDependency(dir), { name: PACKAGE_NAME, spec: 'github:xiaokang6/dsh-config-sync-xk' })
})

test('the upgrade script reads the pin exactly as the panel does', () => {
  // `scripts/update.mjs` used to carry its own copy of this reader, and that copy
  // knew only the `codeload…/tar.gz/<sha>` shape. A profile installed with
  // `dsh plugin … add github:…` pins `git+https://…#<sha>` instead, so the script
  // reported "an update is available" for a profile that was exactly current —
  // while the panel, reading through this module, correctly said "up to date".
  // The script now imports this function; this test holds that wiring in place
  // by running it and by comparing its answer with the module's for every lock
  // shape pnpm writes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-script-'))
  const lockShapes = [
    `  ${PACKAGE_NAME}@https://codeload.github.com/xiaokang6/dsh-config-sync-xk/tar.gz/${NEW}:\n    resolution: {gitHosted: true}\n`,
    `  ${PACKAGE_NAME}@git+https://github.com/xiaokang6/dsh-config-sync-xk.git#${NEW}:\n    resolution: {commit: ${NEW}, repo: https://github.com/xiaokang6/dsh-config-sync-xk.git, type: git}\n`,
    `  ${PACKAGE_NAME}@https://github.com/xiaokang6/dsh-config-sync-xk.git#${NEW}:\n    resolution: {commit: ${NEW}, type: git}\n`,
  ]
  const scriptText = fs.readFileSync(new URL('../../scripts/update.mjs', import.meta.url), 'utf8')
  assert.match(
    scriptText,
    /lockedCommit as lockedCommitIn/u,
    'the script must import the shared reader instead of keeping a second copy',
  )
  for (const shape of lockShapes) {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\npackages:\n\n${shape}`)
    assert.equal(lockedCommit(dir, 'xiaokang6', 'dsh-config-sync-xk'), NEW, `lock shape not read: ${shape.trim()}`)
  }
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\npackages:\n\n")
  assert.equal(lockedCommit(dir, 'xiaokang6', 'dsh-config-sync-xk'), undefined, 'an unpinned lockfile has no pin')
})
