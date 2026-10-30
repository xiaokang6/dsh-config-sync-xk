/**
 * The browser half registers itself under the package name, and the shell keys
 * its whole module table by that id (`dsh-client-modules`: a bundle that loads
 * without registering its id throws, and styles are torn down by
 * `data-plugin`). Nothing else in the suite looks at `client/client.js`, so a
 * renamed package could ship a bundle the host refuses to load — this test is
 * the guard for that.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const bundlePath = path.join(root, 'client', 'client.js')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** The `react` the shell seeds into the module table, stubbed to plain objects. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'Fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** Load the bundle exactly as the shell does and return what it registered. */
function loadBundle() {
  const registrations = new Map()
  const styles = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (definition) => registrations.set(definition.id, definition) } },
    document: {
      querySelector: () => null,
      createElement: () => {
        const element = { dataset: {}, style: {}, textContent: '' }
        styles.push(element)
        return element
      },
      head: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    console,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), context, { filename: 'client.js' })
  return { registrations, styles }
}

/** Apply a registered bundle against a recording plugin context. */
function applyBundle(definition) {
  const exports = definition.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`client bundle required an unexpected module: ${name}`)
  })
  const slots = []
  const dictionaries = []
  exports.apply({
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
      register: (namespace, dict) => dictionaries.push({ namespace, langs: Object.keys(dict) }),
    },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (contribution, render) => slots.push({ ...contribution, render }),
    },
  })
  return { exports, slots, dictionaries }
}

test('the browser bundle registers under the package name', () => {
  const { registrations } = loadBundle()
  assert.deepEqual([...registrations.keys()], [manifest.name])
})

test('the registered bundle applies and contributes both slots', () => {
  const { registrations, styles } = loadBundle()
  const [definition] = registrations.values()
  const { exports, slots, dictionaries } = applyBundle(definition)

  assert.equal(exports.name, manifest.name, 'exports.name must equal the load id')
  // Spread into a host-realm array: values from the vm context carry that
  // realm's Array.prototype, which deepStrictEqual rejects on identity.
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
  assert.deepEqual(
    slots.map((slot) => slot.name),
    ['settings.plugins.tab', 'plugins.item'],
  )
  for (const slot of slots) {
    assert.equal(typeof slot.render, 'function')
    assert.equal(typeof slot.label(), 'string')
  }
  // The locale namespace is part of the plugin's on-disk identity (stored
  // settings key it), so it stays unscoped across the rename.
  assert.deepEqual(dictionaries, [{ namespace: 'config-sync', langs: ['zh', 'en'] }])

  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, manifest.name, 'styles are torn down by this exact value')
  assert.equal(styles[0].dataset.pluginCss, `${manifest.name}/panel.css`)
})

test('the panel dictionaries name the package the way package.json does', () => {
  const { registrations } = loadBundle()
  const [definition] = registrations.values()
  const { exports } = applyBundle(definition)
  const { zh, en } = exports.dictionaries

  for (const [lang, dict] of Object.entries({ zh, en })) {
    const updateKeys = Object.keys(dict).filter((key) => key.startsWith('update'))
    assert.ok(updateKeys.length >= 12, `${lang} carries the update card's strings`)
    // A bare `dsh-config-sync` in a user-facing string would name the unrelated
    // npm package, so every mention must carry the scope.
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string' || !value.includes('dsh-config-sync')) continue
      assert.ok(value.includes(manifest.name), `${lang}.${key} names the current package`)
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en stay in sync')
})
