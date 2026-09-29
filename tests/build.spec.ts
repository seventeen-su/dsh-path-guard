/**
 * Build-artifact smoke test.
 *
 * `install_bundle` never builds a package: DSH loads whatever `package.json`
 * `exports` points at, so the committed `lib/` tree **is** the product. A
 * missing or unloadable artifact therefore means "installs fine, breaks on
 * first use" — which is exactly what this file exists to catch, at the same
 * granularity the loader uses:
 *
 *   - `lib/index.js`         the Host half (`exports["."]`)
 *   - `lib/client/client.js` the Web half (`exports["./client"]`), loaded as a
 *                            CLASSIC script through `window.__ModuleLoader__`
 *
 * No git, no timestamps: the assertions are about content and loadability.
 *
 * @module dsh-path-guard/tests/build
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script, createContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LIB_INDEX = join(ROOT, 'lib', 'index.js')
const LIB_FS_GUARD = join(ROOT, 'lib', 'fs-guard.js')
const LIB_CLIENT = join(ROOT, 'lib', 'client', 'client.js')

/** Comment-free source: the artifact's own comments *mention* `export {}` to explain why it is banned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('build 1. the committed artifacts exist', () => {
  for (const [path, exported] of [
    [LIB_INDEX, 'exports["."]'],
    [LIB_CLIENT, 'exports["./client"]'],
  ] as const) {
    assert.ok(
      existsSync(path),
      `missing ${path} (${exported}): install_bundle does not build, so a missing artifact ships a broken package`,
    )
  }
})

test('build 2. lib/index.js loads and exports the plugin surface the Loader needs', async () => {
  const mod = (await import(pathToFileURL(LIB_INDEX).href)) as Record<string, unknown>
  for (const key of ['apply', 'Config', 'name', 'inject', 'unwrap']) {
    assert.ok(key in mod, `lib/index.js must export ${key}`)
  }
  assert.equal(mod.name, 'path-guard')
  assert.deepEqual(mod.inject, ['tools', 'fs'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.unwrap, 'function')
  assert.equal(typeof mod.Config, 'function', 'Config must stay a schemastery schema (callable)')
})

test('build 3. the authoritative write-veto module loads from lib and keeps its constructor contract', async () => {
  // Importing it at all proves there is no top-level throw in the emitted module.
  const fsGuard = (await import(pathToFileURL(LIB_FS_GUARD).href)) as { createFsGuard?: unknown }
  assert.equal(typeof fsGuard.createFsGuard, 'function', 'lib/fs-guard.js must export createFsGuard')
  const create = fsGuard.createFsGuard as (deps?: unknown) => { writeIntent: unknown; editIntent: unknown }

  // The module validates its own wiring at construction time; that behaviour must
  // survive compilation, because a silent mis-wire here is a fail-open write path.
  assert.throws(() => create(undefined), TypeError, 'a missing deps bag must throw at construction, not later')

  const handlers = create({
    decide: () => ({ access: 'write' }),
    actorIsAgent: () => false,
    FsError: class extends Error {},
  })
  assert.equal(typeof handlers.writeIntent, 'function')
  assert.equal(typeof handlers.editIntent, 'function')
})

test('build 4. lib/client/client.js is a classic script the loader can parse and register', () => {
  const source = readFileSync(LIB_CLIENT, 'utf8')

  // The Web loader injects this file with <script src> (no type="module"), so an
  // ESM-only artifact dies with a parse-time SyntaxError and the settings page
  // silently never registers — the failure mode this assertion pins.
  assert.doesNotThrow(
    () => new Script(source),
    'a classic-script parse must succeed; a module-only artifact never registers',
  )

  // No top-level import/export statement either (comment-free view).
  for (const [index, line] of stripComments(source).split(/\r?\n/).entries()) {
    assert.ok(
      !/^\s*(import|export)\b/.test(line),
      `classic script must not contain a top-level module statement (line ${index + 1}): ${line.trim()}`,
    )
  }

  // And it must actually hand a factory to the loader façade, under this bundle's id.
  const registrations: Array<{ id?: unknown; factory?: unknown }> = []
  const context = createContext({
    window: { __ModuleLoader__: { load: (registration: { id?: unknown; factory?: unknown }) => registrations.push(registration) } },
  })
  new Script(source).runInContext(context)
  assert.equal(registrations.length, 1, 'the artifact must register exactly one bundle')
  assert.equal(registrations[0]!.id, 'dsh-path-guard')
  assert.equal(typeof registrations[0]!.factory, 'function')

  const factory = registrations[0]!.factory as (require: (specifier: string) => unknown) => Record<string, unknown>
  const plugin = factory(() => ({ createElement: () => undefined }))
  assert.equal(typeof plugin.apply, 'function', 'the client half must expose apply')
  // Spread into this realm's array first: the artifact ran in a vm context, and
  // deepStrictEqual compares prototypes across realms.
  assert.deepEqual([...(plugin.inject as string[])], ['slots', 'locale', 'configForms'])
})
