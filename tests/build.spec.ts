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

/**
 * The client artifact's UI contracts. Each marker IS the fix mechanism for a
 * defect that once shipped, so a regression deletes the marker and fails here:
 * the neutral focus ring (global `:focus-visible` is DeepSeek blue and exempts
 * editable controls from pointer suppression), the hover/press tint LAYERED
 * over the opaque trigger base (a background swap was measured invisible), the
 * popup's left-hung default (right-first measuring against the viewport edge
 * slid the surface under the sidebar), and the single combobox match field.
 */
test('build 5. the client artifact keeps the focus, state-layering, geometry and combobox contracts', () => {
  const source = readFileSync(LIB_CLIENT, 'utf8')
  const sheetStart = source.indexOf('[data-path-guard]')
  const sheetEnd = source.indexOf('@keyframes dsh-path-guard-menu-in')
  assert.ok(sheetStart !== -1 && sheetEnd > sheetStart, 'STATE_CSS is missing from the artifact')
  const sheet = source.slice(sheetStart, sheetEnd)

  assert.ok(sheet.includes('[data-path-guard] button:focus-visible'), 'buttons must pin their own focus treatment')
  assert.ok(
    sheet.includes('[data-path-guard] input:focus-visible { outline: none; }'),
    'inputs must SUPPRESS the ring explicitly: merely deleting our rule would expose the global blue one (focus.css:10-13)',
  )
  assert.ok(
    sheet.includes('[data-path-guard] button:focus-visible { outline: none; }'),
    'buttons must suppress the ring the same way',
  )
  assert.ok(!/outline: 2px solid var\(--dsw-alias-label-tertiary\)/.test(source), 'D1: the grey 2px ring read as a white border and must be gone')
  assert.ok(sheet.includes('inset 0 0 0 999px var(--dsw-alias-interactive-bg-hover)'), 'trigger hover must overlay the base, not replace it')
  assert.ok(sheet.includes('inset 0 0 0 999px var(--dsw-alias-interactive-bg-active)'), 'trigger press must overlay the base, not replace it')
  assert.ok(!sheet.includes('button[data-pg-menu]:focus-visible'), 'the menu-only ring override is superseded by the all-buttons rule')
  assert.ok(source.includes("return { side: 'left', width }"), 'popups must hang from the anchor left edge by default')
  assert.ok(!source.includes("rect.right - width >= MENU_EDGE_GAP) return { side: 'right'"), 'the sidebar-blind right-first check must stay deleted')
  assert.ok(source.includes("role: 'combobox'"), 'the tool match field must be a combobox')
  assert.ok(source.includes("role: 'listbox'"), 'the tracked tools list must be a listbox')
  assert.ok(!source.includes('pickRow'), 'the input+picker pair is replaced by the combobox')
})

/**
 * The unified control family and the popup's viewport discipline.
 *
 * Two defects are pinned here. (1) Every fill-in control used to wear the host
 * settings field's `0.5px --dsw-alias-border-l4` stroke — a WHITE border in the
 * dark theme — and marked focus by turning that stroke DeepSeek blue; both are
 * measured facts from the running UI, not style preferences. The controls are
 * now one borderless filled surface, the same family as the menu trigger.
 * (2) A popup must never cross either viewport edge: it hangs from the anchor's
 * LEFT edge by default (the sidebar occupies the viewport's left edge, so a
 * right-hung surface in a left-hand column slid underneath it), flips to the
 * right edge only when growing rightward would leave the viewport, and shrinks
 * as the last resort. The whole strategy is `measureMenu`, shared by the enum
 * menu and the combobox.
 */
test('build 6. the client artifact keeps one borderless control family and popups inside both viewport edges', () => {
  const source = readFileSync(LIB_CLIENT, 'utf8')
  const bare = stripComments(source)

  const control = /const CONTROL = \{[^}]*\}/.exec(source)
  assert.ok(control, 'CONTROL must exist in the artifact')
  for (const declaration of [
    "height: '32px'",
    "padding: '0 8px'",
    "border: 'none'",
    "borderRadius: 'var(--dsw-radius-sm, 8px)'",
    "background: 'var(--dsw-alias-bg-module-platform)'",
  ]) {
    assert.ok(control[0].includes(declaration), `every fill-in control must declare ${declaration}`)
  }
  assert.ok(!control[0].includes('border-l4'), 'the control surface must not keep the 0.5px border-l4 stroke (a white border on the dark theme)')
  assert.ok(!control[0].includes('bg-layer-3'), 'the control surface must not fall back to the host settings field fill')
  assert.ok(!bare.includes('state-business-primary'), 'no control may mark focus with the DeepSeek-blue business tone (comments may still name it)')
  assert.ok(!/'select'/.test(bare), 'no native <select> may remain: the OS paints its list and its selected state')

  // One measurement, two controls: the combobox must reuse measureMenu rather
  // than grow a second, divergent alignment rule.
  const combobox = /function ToolMatchField[\s\S]*?\n        \}/.exec(source)
  assert.ok(combobox, 'ToolMatchField must exist in the artifact')
  assert.ok(combobox[0].includes('measureMenu(anchor.current)'), 'the combobox must align through the shared measureMenu')
  assert.ok(
    source.includes('rect.left + width + MENU_EDGE_GAP <= viewport'),
    'left-hanging is only allowed while the surface stays inside the right edge',
  )
  assert.ok(
    source.includes('rect.right - width >= MENU_EDGE_GAP'),
    'right-hanging is only allowed while the surface stays inside the left edge',
  )
  assert.ok(
    source.includes('viewport - MENU_EDGE_GAP - rect.left'),
    'when neither edge fits a full-width surface it must shrink to the room left of the right edge',
  )
})

/**
 * The five client defects of task-23, each locked to its MECHANISM.
 *
 * C1 the two client components must be defined OUTSIDE the section component:
 *    a component function created in a render body is a new element type every
 *    render, so React remounts the subtree and the input the user is typing in
 *    is replaced (the "one character and the caret is gone" report). Locked
 *    structurally: their definitions must precede `function PathGuardSection`.
 * C2 the focus ring must be the neutral GREY: `--dsw-alias-brand-primary` is
 *    near-black on light but near-white (rgb(249,250,251)) on dark, which reads
 *    as a white border on a fill-in control.
 * C3 below the host's 560px breakpoint both tables stack: cells become labelled
 *    blocks fed by `data-label`, so nothing overflows the page.
 * C4 an anchor whose centre is in the RIGHT half right-aligns; the edge fits
 *    still bound both sides afterwards.
 * C5 the config form is resolved per render and rebound on an identity change —
 *    never cached once, which left the page bound to a dead instance after a
 *    hot reload.
 */
test('build 7. the five client defects stay fixed: identity, ring colour, stacking, side rule, form rebinding', () => {
  const source = readFileSync(LIB_CLIENT, 'utf8')
  const bare = stripComments(source)
  const sheetStart = source.indexOf('[data-path-guard]')
  const sheetEnd = source.indexOf('@keyframes dsh-path-guard-menu-in')
  const sheet = source.slice(sheetStart, sheetEnd)

  // C1 — hoisted components.
  for (const name of ['function MenuControl', 'function ToolMatchField']) {
    const at = source.indexOf(name)
    assert.ok(at !== -1, `${name} must exist in the artifact`)
    assert.ok(
      at < source.indexOf('function PathGuardSection'),
      `${name} must be defined OUTSIDE the section component, or every render remounts it and the focused input is replaced`,
    )
  }

  // C2 (superseded by D1) — no ring at all on our controls; suppression is explicit.
  assert.ok(!/outline: 2px solid/.test(sheet), 'no control may draw an outline ring: both the grey and the brand tone were rejected')
  assert.ok(sheet.includes('input:focus-visible { outline: none; }'), 'the input ring must be suppressed explicitly, not merely deleted')
  assert.ok(sheet.includes('button:focus-visible { outline: none; }'), 'the button ring must be suppressed explicitly too')

  // D2 — the rule/trust lists are FLEX rows, so they wrap on their own CONTAINER's
  // width (a media query cannot see the panel/sidebar squeezing the column), and
  // every field declares the `min-width: 0` that makes wrapping possible at all.
  assert.ok(bare.includes('flexWrap: \'wrap\''), 'each rule row must be a wrapping flex row')
  assert.ok(bare.includes("flex: '1 1 160px'"), 'every field must take the same 160px basis so the columns still line up on wide containers')
  assert.ok(bare.includes('minWidth: 0'), 'every field needs min-width: 0, or the flex item refuses to shrink and overflows instead of wrapping')
  assert.ok(!source.includes('data-pg-stack'), 'the media-query table stack is superseded by the flex rows')
  assert.ok(!source.includes('@media (max-width: 560px)'), 'the list layout must not depend on a viewport breakpoint')
  assert.ok(!bare.includes("'table'") && !bare.includes('borderCollapse'), 'the tables must stay gone: their percentage columns were the overflow')
  const rowLabels = (bare.match(/rowLabel/g) ?? []).length
  assert.ok(rowLabels >= 8, `each field carries its own label (7 fields + the style declaration), found ${rowLabels}`)

  // D3 — the action buttons are the FILLED standard style (ui-shortcuts
  // Reference.module.css:32-36), not the host Button's outlined variant, and their
  // hover/press stays a tint OVER the opaque fill instead of a background swap.
  const button = /const SM_BUTTON = \{[\s\S]*?\n    \}/.exec(source)
  assert.ok(button, 'SM_BUTTON must exist in the artifact')
  assert.ok(button[0].includes("border: 'none'"), 'action buttons must have no border')
  assert.ok(button[0].includes("background: 'var(--dsw-alias-bg-module-platform)'"), 'action buttons must sit on the module fill')
  assert.ok(button[0].includes('inset 0 0 0 999px transparent'), 'the tint baseline must be present so the hover fade can interpolate')
  assert.ok(!/button:not\(\[data-pg-primary\]\)[^{]*\{ background: var\(--dsw-alias-interactive-bg-hover\) !important/.test(sheet), 'no button may hover by swapping its background')

  // C4 — position first, then the two edge fits.
  assert.ok(
    /const preferRight = rect\.left \+ \(rect\.right - rect\.left\) \/ 2 > viewport \/ 2/.test(source),
    'the side must be chosen from the anchor centre against the viewport half, before any overflow test',
  )
  assert.ok(
    source.indexOf('const preferRight') < source.indexOf('rect.left + width + MENU_EDGE_GAP <= viewport'),
    'the position test must run BEFORE the overflow checks',
  )

  // C5 — resolve per render, rebind on service arrival, never cache once.
  assert.ok(source.includes('function useConfigForm'), 'the form must be resolved through a rebinding hook')
  assert.ok(
    source.includes('previous === next ? previous : next'),
    'a replaced Form instance (same namespace, new object) must be adopted, or the page stays bound to a dead one',
  )
  assert.ok(source.includes("ctx.inject(['configForms']"), 'a late-arriving configForms service must trigger a re-resolve')
  assert.ok(!source.includes('const form = ctx.configForms.get'), 'the one-shot form cache must stay deleted')
})
