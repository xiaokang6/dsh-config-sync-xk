#!/usr/bin/env node
/**
 * Add dsh-config-sync to a DSH profile: a `link:` dependency plus the bundle row.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <name>] [--profile-dir <dir>] [--dry-run] [--install]
 *
 * The profile directory defaults to $DSH_PROFILE_DIR, then
 * $DSH_HOME/profiles/<profile>, then ~/.dsh/profiles/desktop. The script never
 * edits cordis.patch.yml: the plugin's own bundle patch mounts the host half,
 * and its settings live in the settings page.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const runInstall = argv.includes('--install')
const flagValue = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
}

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileName = flagValue('--profile') ?? 'desktop'
const profileDir = path.resolve(
  flagValue('--profile-dir') ?? process.env.DSH_PROFILE_DIR ?? path.join(dshHome, 'profiles', profileName),
)

const manifestPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`profile not found: ${manifestPath}`)
  process.exit(1)
}

const profile = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const spec = `link:${packageDir.replaceAll('\\', '/')}`

profile.dependencies ??= {}
profile.dependencies[manifest.name] = spec
profile.dsh ??= {}
profile.dsh.profile ??= {}
profile.dsh.profile.bundles ??= []
if (!profile.dsh.profile.bundles.includes(manifest.name)) {
  profile.dsh.profile.bundles.push(manifest.name)
}

console.log(`profile:  ${profileDir}`)
console.log(`package:  ${spec}`)
console.log(`bundles:  ${profile.dsh.profile.bundles.join(', ')}`)

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  process.exit(0)
}

const backup = `${manifestPath}.bak-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`
fs.copyFileSync(manifestPath, backup)
// UTF-8 without BOM: a BOM makes app-boot reject the profile manifest.
fs.writeFileSync(manifestPath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8' })
console.log(`\nupdated ${manifestPath} (backup: ${path.basename(backup)})`)

if (runInstall) {
  const pnpm = process.env.DSH_PNPM ?? 'pnpm'
  const result = spawnSync(pnpm, ['install'], { cwd: profileDir, stdio: 'inherit', shell: false })
  if (result.error !== undefined) {
    console.error(`could not run ${pnpm}: ${result.error.message}`)
    console.error(`run it manually: cd ${profileDir} && pnpm install`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

console.log('\nnext:')
console.log(`  1. cd ${profileDir}`)
console.log('  2. pnpm install')
console.log('  3. restart DeepSeek Harness (or touch cordis.patch.yml to hot-recompose)')
