/**
 * Unit tests for the pnpm runner's argv/env building and policy detection.
 * (The spawn path itself is exercised by the integration tests and on a real
 * profile; these keep the release-age retry honest.)
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isReleaseAgeViolation,
  normalizeHostManager,
  pnpmEnvForRun,
  pnpmInstallArgs,
  quoteCmdArg,
} from '../../lib/sync/pnpm.js'

test('install argv carries the frozen flag and the release-age override', () => {
  assert.deepEqual(pnpmInstallArgs({}), ['install'])
  assert.deepEqual(pnpmInstallArgs({ frozen: true }), ['install', '--frozen-lockfile'])
  assert.deepEqual(pnpmInstallArgs({ frozen: true, relaxReleaseAge: true }), [
    'install',
    '--frozen-lockfile',
    '--config.minimumReleaseAge=0',
  ])
  assert.deepEqual(pnpmInstallArgs({ relaxReleaseAge: true }), ['install', '--config.minimumReleaseAge=0'])
})

test('the relaxed environment sets both the CI guard and the policy override', () => {
  assert.deepEqual(pnpmEnvForRun({}), { CI: 'true' })
  assert.deepEqual(pnpmEnvForRun({ relaxReleaseAge: true }), {
    CI: 'true',
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
  })
})

test('release-age failures are recognized', () => {
  assert.equal(isReleaseAgeViolation('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification'), true)
  assert.equal(isReleaseAgeViolation('within the minimumReleaseAge cutoff'), true)
  assert.equal(isReleaseAgeViolation('Lockfile is up to date'), false)
  assert.equal(isReleaseAgeViolation(''), false)
  assert.equal(isReleaseAgeViolation(undefined), false)
})

test('cmd quoting and host-manager validation', () => {
  assert.equal(quoteCmdArg('simple'), 'simple')
  assert.equal(quoteCmdArg('a b'), '"a b"')
  assert.equal(quoteCmdArg('a"b'), '"a""b"')
  assert.deepEqual(normalizeHostManager({ command: ' node ', args: ['x'], env: { A: '1', N: 2 } }), {
    command: 'node',
    args: ['x'],
    env: { A: '1' },
  })
  assert.equal(normalizeHostManager({ command: '', args: [] }), null)
  assert.equal(normalizeHostManager({ command: 'node', args: [1] }), null)
})
