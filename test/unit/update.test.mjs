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
  PACKAGE_NAME,
  applyUpdate,
  checkForUpdate,
  lockedCommit,
  parseSpec,
  readSpec,
  remoteCommit,
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
      `lockfileVersion: '9.0'\n\npackages:\n\n  ${PACKAGE_NAME}@https://codeload.github.com/xiaokang6/dsh-config-sync/tar.gz/${pinned}:\n    resolution: {gitHosted: true}\n`,
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

  const short = parseSpec('github:xiaokang6/dsh-config-sync')
  assert.deepEqual({ form: short.form, owner: short.owner, repo: short.repo, ref: short.ref }, {
    form: 'git',
    owner: 'xiaokang6',
    repo: 'dsh-config-sync',
    ref: 'main',
  })

  const pinned = parseSpec('github:xiaokang6/dsh-config-sync#dev')
  assert.equal(pinned.ref, 'dev')

  const url = parseSpec('git+https://github.com/xiaokang6/dsh-config-sync.git')
  assert.equal(url.form, 'git')
  assert.equal(url.repo, 'dsh-config-sync')

  assert.equal(parseSpec('^0.1.0').form, 'registry')
  assert.equal(parseSpec('').form, 'registry')
})

test('readSpec and lockedCommit read the profile manifest and lockfile', () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync', pinned: OLD })
  assert.equal(readSpec(dir), 'github:xiaokang6/dsh-config-sync')
  assert.equal(lockedCommit(dir, 'xiaokang6', 'dsh-config-sync'), OLD)
  assert.equal(lockedCommit(dir, 'someone', 'else'), undefined)
  assert.equal(readSpec(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-empty-'))), undefined)
})

test('sameCommit tolerates abbreviated ids', () => {
  assert.equal(sameCommit(NEW, NEW), true)
  assert.equal(sameCommit(NEW, NEW.slice(0, 7)), true)
  assert.equal(sameCommit(OLD, NEW), false)
  assert.equal(sameCommit(undefined, NEW), false)
})

test('remoteCommit prefers the ls-remote head and passes a pinned sha through', async () => {
  const remote = { owner: 'xiaokang6', repo: 'dsh-config-sync', ref: 'main' }
  const { run } = fakeGit({ 'ls-remote https://github.com/xiaokang6/dsh-config-sync refs/heads/main': `${NEW}\trefs/heads/main` })
  assert.equal(await remoteCommit(remote, { cwd: os.tmpdir(), run }), NEW)
  assert.equal(await remoteCommit({ ...remote, ref: OLD }, { cwd: os.tmpdir(), run }), OLD)
  const offline = fakeGit({})
  assert.equal(await remoteCommit(remote, { cwd: os.tmpdir(), run: offline.run }), undefined)
})

test('a github install compares the pinned commit with the published head', async () => {
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync', pinned: OLD })
  const upToDate = fakeGit({ 'ls-remote https://github.com/xiaokang6/dsh-config-sync refs/heads/main': `${OLD}\trefs/heads/main` })
  const current = await checkForUpdate({ profileDir: dir, run: upToDate.run })
  assert.equal(current.form, 'git')
  assert.equal(current.upToDate, true)
  assert.equal(current.canApply, true)
  assert.equal(current.pinned, OLD.slice(0, 7))
  assert.equal(current.latest, OLD.slice(0, 7))

  const behind = fakeGit({ 'ls-remote https://github.com/xiaokang6/dsh-config-sync refs/heads/main': `${NEW}\trefs/heads/main` })
  const stale = await checkForUpdate({ profileDir: dir, run: behind.run })
  assert.equal(stale.upToDate, false)
  assert.match(stale.detail, /newer commit/u)

  const offline = await checkForUpdate({ profileDir: dir, run: fakeGit({}).run })
  assert.equal(offline.upToDate, undefined, 'an unchecked ref must not claim to be current')
  assert.equal(offline.canApply, true, 'an offline check still allows trying')
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
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync', pinned: OLD })
  let asked = null
  const fakeUpdate = async (input) => {
    asked = input
    fs.writeFileSync(
      path.join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n\n  ${PACKAGE_NAME}@https://codeload.github.com/xiaokang6/dsh-config-sync/tar.gz/${NEW}:\n    resolution: {gitHosted: true}\n`,
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
  const dir = makeProfile({ spec: 'github:xiaokang6/dsh-config-sync', pinned: OLD })
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
