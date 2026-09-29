/**
 * `src/resource.js` — resource identity + capability resolution.
 *
 * Covers the nine required cases from the task spec plus the heuristic edges the
 * module deliberately draws: what it calls a path, what it refuses to call one,
 * and what it reports as undecidable.
 *
 * The legacy table is imported as a NAMESPACE on purpose: if the wiring step
 * removes `PATH_TOOLS`, the equivalence check below skips instead of turning the
 * whole file into a module-resolution error.
 *
 * @module dsh-path-guard/tests/resource
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as legacy from '../src/tool-fields.ts'
import {
  CAPABILITY,
  KNOWN_TOOLS,
  OPAQUE_TOOLS,
  isGoverned,
  policyAccessFor,
  resolveResources,
} from '../src/resource.ts'

/** The legacy field spec as these comparisons read it (src/tool-fields.ts `PATH_TOOLS`). */
interface FieldSpec {
  field: string
  op: string
  each?: string | undefined
  root?: boolean | undefined
}

/** A modelled entry as these comparisons read it (src/resource.ts `KNOWN_TOOLS`). */
interface ModelledEntry {
  search?: unknown
  paths: Array<{
    field: string
    each?: string | undefined
    root?: boolean | undefined
    byCommand?: boolean | undefined
    capability?: string | undefined
  }>
}

/** Deep-freeze a fixture the way the Harness hands arguments to a tool. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/**
 * The resources of a single unnamed-tool call, for terse assertions.
 * @param {unknown} args - the tool arguments.
 * @returns {Array<object>} the resolved resources.
 */
const resourcesOf = (args: unknown) => resolveResources('third_party_tool', deepFreeze(args)).resources

// ---------------------------------------------------------------------------
// 1. known tools: mapping and behaviour identical to the legacy table
// ---------------------------------------------------------------------------

test('1a. read / read_image / lsp name file_path and need READ', () => {
  for (const name of ['read', 'read_image', 'lsp']) {
    assert.deepEqual(resolveResources(name, { file_path: 'D:/proj/a.txt' }), {
      known: true,
      capability: CAPABILITY.READ,
      resources: [{ value: 'D:/proj/a.txt', capability: CAPABILITY.READ, field: 'file_path' }],
      opaque: false,
    })
  }
})

test('1b. write / edit name file_path and need WRITE', () => {
  for (const name of ['write', 'edit']) {
    const result = resolveResources(name, deepFreeze({ file_path: 'D:/proj/a.txt' }))
    assert.equal(result.known, true)
    assert.equal(result.capability, CAPABILITY.WRITE)
    assert.deepEqual(result.resources, [
      { value: 'D:/proj/a.txt', capability: CAPABILITY.WRITE, field: 'file_path' },
    ])
  }
})

test('1c. present walks files[].path and needs EXPORT', () => {
  const result = resolveResources('present', { files: [{ path: 'D:/out/a.md' }, { path: ' ' }, {}] })
  assert.equal(result.known, true)
  assert.equal(result.capability, CAPABILITY.EXPORT)
  assert.deepEqual(result.resources, [
    { value: 'D:/out/a.md', capability: CAPABILITY.EXPORT, field: 'files[].path' },
  ])
})

test('1d. glob enumerates its root, grep reads it', () => {
  const glob = resolveResources('glob', { path: 'D:/proj' })
  assert.equal(glob.capability, CAPABILITY.ENUMERATE)
  assert.deepEqual(glob.resources, [
    { value: 'D:/proj', capability: CAPABILITY.ENUMERATE, field: 'path' },
  ])
  const grep = resolveResources('grep', { path: 'D:/proj' })
  assert.equal(grep.capability, CAPABILITY.READ)
  assert.deepEqual(grep.resources, [
    { value: 'D:/proj', capability: CAPABILITY.READ, field: 'path' },
  ])
})

test('1e. a search tool with no path yields no resource and keeps its capability', () => {
  // The session-workspace fallback for `root: true` fields needs the session and
  // therefore stays the caller's job (KNOWN_TOOLS[..].paths[0].root marks it).
  const result = resolveResources('glob', {})
  assert.equal(result.known, true)
  assert.equal(result.capability, CAPABILITY.ENUMERATE)
  assert.deepEqual(result.resources, [])
  assert.equal(KNOWN_TOOLS.glob.paths[0]!.root, true)
  assert.equal(KNOWN_TOOLS.grep.paths[0]!.root, true)
})

test('1f. str_replace_editor splits on command: view reads, everything else writes', () => {
  assert.equal(resolveResources('str_replace_editor', { command: 'view', path: 'D:/a.txt' }).capability, CAPABILITY.READ)
  for (const args of [{ command: 'str_replace', path: 'D:/a.txt' }, { command: 'create', path: 'D:/a.txt' }, { path: 'D:/a.txt' }, {}]) {
    const result = resolveResources('str_replace_editor', args)
    assert.equal(result.capability, CAPABILITY.WRITE)
    assert.deepEqual(result.resources.map(resource => resource.field), args.path === undefined ? [] : ['path'])
  }
})

test('1g. a known tool never carries a fail-closed reason', () => {
  for (const name of Object.keys(KNOWN_TOOLS)) {
    assert.equal(resolveResources(name, { file_path: 'D:/x', path: 'D:/x' }).reason, undefined, name)
  }
})

test('1h. the known table is byte-identical to the legacy static table', t => {
  const PATH_TOOLS = legacy.PATH_TOOLS as unknown as Record<string, { paths: FieldSpec[]; search?: unknown }>
  if (PATH_TOOLS === undefined) {
    t.diagnostic('遗留 PATH_TOOLS 已移除，跳过等价校验（上面的硬编码断言仍然生效）')
    return
  }
  const expected = {
    read: CAPABILITY.READ,
    read_image: CAPABILITY.READ,
    write: CAPABILITY.WRITE,
    edit: CAPABILITY.WRITE,
    lsp: CAPABILITY.READ,
    present: CAPABILITY.EXPORT,
    glob: CAPABILITY.ENUMERATE,
    grep: CAPABILITY.READ,
    str_replace_editor: 'by-command',
  }
  assert.deepEqual(Object.keys(KNOWN_TOOLS).sort(), Object.keys(PATH_TOOLS).sort())
  for (const [name, old] of Object.entries(PATH_TOOLS)) {
    const mine = KNOWN_TOOLS[name] as ModelledEntry
    assert.equal(mine.search, old.search, `${name}.search`)
    assert.equal(mine.paths.length, old.paths.length, `${name}.paths.length`)
    old.paths.forEach((field, index) => {
      const got = mine.paths[index]
      assert.equal(got!.field, field.field, `${name}[${index}].field`)
      assert.equal(got!.each, field.each, `${name}[${index}].each`)
      assert.equal(got!.root, field.root, `${name}[${index}].root`)
      assert.equal(got!.byCommand === true, field.op === 'by-command', `${name}[${index}].byCommand`)
      assert.equal(got!.capability ?? 'by-command', (expected as Record<string, string>)[name], `${name}[${index}].capability`)
      if (field.op === 'by-command') return
      // The capability vocabulary must project back onto the exact legacy rung.
      assert.equal(policyAccessFor(got!.capability), field.op, `${name}: 能力投影必须回到遗留 op`)
    })
  }
})

test('1i. modelled values match the legacy collectPaths() exactly', t => {
  const PATH_TOOLS = legacy.PATH_TOOLS as unknown as Record<string, { paths: FieldSpec[]; search?: unknown }>
  if (PATH_TOOLS === undefined || typeof legacy.collectPaths !== 'function') {
    t.diagnostic('遗留 collectPaths 已移除，跳过')
    return
  }
  const samples = {
    read: [{ file_path: ' a ' }, { file_path: '   ' }, {}, { file_path: 42 }],
    present: [{ files: [{ path: 'a' }, { path: ' ' }, {}] }, { files: 'a' }, { files: [] }],
    glob: [{ path: 'D:/proj' }, {}],
    grep: [{ path: 'D:/proj' }, {}],
  }
  for (const [name, cases] of Object.entries(samples)) {
    for (const args of cases) {
      const expected = legacy.collectPaths(args, PATH_TOOLS[name]!.paths[0]!)
      const actual = resolveResources(name, deepFreeze(args)).resources.map(resource => resource.value)
      assert.deepEqual(actual, expected, `${name} ${JSON.stringify(args)}`)
    }
  }
})

test('1j. command detection matches the legacy opForCommand()', t => {
  if (typeof legacy.opForCommand !== 'function') {
    t.diagnostic('遗留 opForCommand 已移除，跳过')
    return
  }
  for (const args of [{ command: 'view' }, { command: 'create' }, { command: 'str_replace' }, {}]) {
    assert.equal(resolveResources('str_replace_editor', args).capability, legacy.opForCommand(args))
  }
})

// ---------------------------------------------------------------------------
// 2. opaque tools
// ---------------------------------------------------------------------------

test('2a. shell and script tools are opaque, need EXECUTE and expose no resource', () => {
  const names = legacy.SHELL_TOOLS === undefined
    ? ['bash', 'pwsh', 'terminal_open', 'terminal_send']
    : [...legacy.SHELL_TOOLS]
  for (const name of [...names, 'workflow']) {
    assert.deepEqual(resolveResources(name, deepFreeze({ command: 'cat ~/.ssh/id_rsa', script: 'x' })), {
      known: true,
      capability: CAPABILITY.EXECUTE,
      resources: [],
      opaque: true,
    }, name)
  }
})

test('2b. the opaque set stays in step with the legacy shell / script sets', t => {
  if (legacy.SHELL_TOOLS === undefined) {
    t.diagnostic('遗留 SHELL_TOOLS 已移除，跳过')
    return
  }
  for (const name of legacy.SHELL_TOOLS) assert.equal(OPAQUE_TOOLS.has(name), true, name)
  if (typeof legacy.isScriptTool === 'function') {
    for (const name of ['workflow']) assert.equal(OPAQUE_TOOLS.has(name), legacy.isScriptTool(name), name)
  }
})

// ---------------------------------------------------------------------------
// 3-6. the required unmodelled-tool cases
// ---------------------------------------------------------------------------

test('3. unknown + { file_path: "C:/x.txt" } is reported with a fail-closed reason', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ file_path: 'C:/x.txt' }))
  assert.equal(result.known, false)
  assert.deepEqual(result.resources, [
    { value: 'C:/x.txt', capability: CAPABILITY.WRITE, field: 'file_path' },
  ])
  assert.equal(typeof result.reason, 'string')
  assert.match(result.reason!, /未被建模/)
  assert.match(result.reason!, /file_path/)
  assert.match(result.reason!, /fail-closed/)
})

test('4. unknown + { query: "hello" } reports nothing (ordinary strings are not paths)', () => {
  assert.deepEqual(resolveResources('third_party_tool', deepFreeze({ query: 'hello' })), {
    known: false,
    capability: CAPABILITY.WRITE,
    resources: [],
    // Lead extension: the two legs are reported separately so that a wiring
    // mistake cannot treat a path-shaped FIELD NAME as evidence. See test 4b.
    actionable: [],
    opaque: false,
  })
})

test('4b. a path-shaped field NAME alone never yields a fail-closed reason', () => {
  // The over-blocking trap from docs/ARCHITECTURE.md §2.2.1: `{dir:'asc'}` matches
  // the name leg, and denying on that would block MIME types (`text/html`) and
  // enum values across every unmodelled tool. Only a path-shaped VALUE may deny.
  const byName = resolveResources('third_party_tool', deepFreeze({ dir: 'asc' }))
  assert.equal(byName.reason, undefined, 'a name-leg match must not be grounds for refusal')
  assert.deepEqual(byName.actionable, [])
  assert.equal(byName.resources.length, 1, 'it is still reported')
  assert.ok(byName.note !== undefined, 'and explained, so the decision is auditable')

  const byValue = resolveResources('third_party_tool', deepFreeze({ dir: 'D:/secrets' }))
  assert.ok(byValue.reason !== undefined, 'a path-shaped value is grounds for refusal')
  assert.equal(byValue.actionable!.length, 1)
})

test('5. unknown + { target: "D:/a/b" } falls back to the strictest capability', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ target: 'D:/a/b' }))
  assert.equal(result.capability, CAPABILITY.WRITE)
  assert.deepEqual(result.resources, [
    { value: 'D:/a/b', capability: CAPABILITY.WRITE, field: 'target' },
  ])
})

test('6. unknown + { path: "~/notes" } recognises the ~ form', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ path: '~/notes' }))
  assert.deepEqual(result.resources, [
    { value: '~/notes', capability: CAPABILITY.WRITE, field: 'path' },
  ])
})

// ---------------------------------------------------------------------------
// 7-8. shapes that must not throw or be missed
// ---------------------------------------------------------------------------

test('7a. arrays of objects and nested objects are dug out', () => {
  assert.deepEqual(resourcesOf({ files: [{ path: 'C:/a' }, { path: 'D:/b' }] }), [
    { value: 'C:/a', capability: CAPABILITY.WRITE, field: 'files[].path' },
    { value: 'D:/b', capability: CAPABILITY.WRITE, field: 'files[].path' },
  ])
  assert.deepEqual(resourcesOf({ config: { output: { dir: 'C:/out' } } }), [
    { value: 'C:/out', capability: CAPABILITY.LIST, field: 'config.output.dir' },
  ])
  assert.deepEqual(resourcesOf({ payload: [{ nested: [{ path: 'C:/deep' }] }] }), [
    { value: 'C:/deep', capability: CAPABILITY.WRITE, field: 'payload[].nested[].path' },
  ])
})

test('7b. an array of bare strings uses the array name as the field', () => {
  assert.deepEqual(resourcesOf({ files: ['C:/a'] }), [
    { value: 'C:/a', capability: CAPABILITY.WRITE, field: 'files[]' },
  ])
  // `files` is itself a path-named field, so the name leg reports every
  // non-blank item, not only the ones whose shape looks like a path.
  assert.deepEqual(resourcesOf({ files: ['notes'] }), [
    { value: 'notes', capability: CAPABILITY.WRITE, field: 'files[]' },
  ])
})

test('7c. arguments that are not objects never throw', () => {
  for (const args of [undefined, null, 'str', 42, true, [], {}, deepFreeze({}), Object.freeze([])]) {
    assert.doesNotThrow(() => resolveResources('third_party_tool', args), String(args))
    assert.doesNotThrow(() => resolveResources('read', args), String(args))
    assert.deepEqual(resolveResources('third_party_tool', args).resources, [], String(args))
    assert.deepEqual(resolveResources('read', args).resources, [], String(args))
  }
})

test('7d. a non-string tool name is treated as unmodelled, not as a crash', () => {
  for (const name of [undefined, null, 42, {}, '']) {
    const result = resolveResources(name, deepFreeze({ path: 'C:/x' }))
    assert.equal(result.known, false)
    assert.equal(result.resources.length, 1)
    assert.equal(typeof result.reason, 'string')
  }
})

test('7e. a cyclic or absurdly nested argument does not hang', () => {
  const cyclic: { path: string; self?: unknown } = { path: 'C:/x' }
  cyclic.self = cyclic
  const looped = resolveResources('third_party_tool', cyclic)
  assert.deepEqual(looped.resources, [{ value: 'C:/x', capability: CAPABILITY.WRITE, field: 'path' }])

  let deep: Record<string, unknown> = { path: 'C:/deep' }
  for (let i = 0; i < 20; i += 1) deep = { nested: deep }
  const truncated = resolveResources('third_party_tool', deep)
  assert.deepEqual(truncated.resources, [])
  assert.match(truncated.reason!, /嵌套超过 16 层/)
})

test('7f. deeply frozen arguments are read, never mutated', () => {
  const args = deepFreeze({ files: [{ path: 'C:/x' }], nested: { target: 'D:/y' } })
  const before = JSON.stringify(args)
  resolveResources('third_party_tool', args)
  assert.equal(JSON.stringify(args), before)
})

// ---------------------------------------------------------------------------
// 9. isGoverned
// ---------------------------------------------------------------------------

test('9a. every modelled and every opaque tool is governed', () => {
  for (const name of Object.keys(KNOWN_TOOLS)) assert.equal(isGoverned(name), true, name)
  for (const name of OPAQUE_TOOLS) assert.equal(isGoverned(name), true, name)
})

test('9b. unmodelled tools are governed when their NAME reads as filesystem work', () => {
  for (const name of ['read_file_from_disk', 'vault_write_path', 'copy_directory', 'my_fs_reader', 'list_folder_contents']) {
    assert.equal(isGoverned(name), true, name)
  }
})

test('9c. an unmodelled tool with no resource wording is not governed', () => {
  for (const name of ['weather_lookup', 'ask_user_question', 'send_email', 'cordis_inspect_query', '']) {
    assert.equal(isGoverned(name), false, name)
  }
})

test('9d. non-string tool names are not governed', () => {
  for (const name of [undefined, null, 42, {}, []]) assert.equal(isGoverned(name), false, String(name))
})

test('9e. governed covers every surface the legacy governs() covered', t => {
  if (typeof legacy.isExoticTool !== 'function') {
    t.diagnostic('遗留 isExoticTool 已移除，跳过')
    return
  }
  const names = [
    ...Object.keys(legacy.PATH_TOOLS ?? {}),
    ...(legacy.SHELL_TOOLS === undefined ? [] : legacy.SHELL_TOOLS),
    'workflow', 'run_code', 'ralph', 'subagent_codex', 'subagent_claude_code', 'subagent_acp',
    'mcp__filesystem__read_file', 'cua_driver_click', 'plugin_manager',
  ]
  for (const name of names) assert.equal(isGoverned(name), true, name)
  // The legacy exotic surface must never become ungoverned.
  for (const name of ['run_code', 'ralph', 'mcp__x__y', 'cua_driver_x']) {
    if (legacy.isExoticTool(name)) assert.equal(isGoverned(name), true, name)
  }
})

// ---------------------------------------------------------------------------
// heuristics: value shapes
// ---------------------------------------------------------------------------

test('H1. absolute / home / env / file-URL value shapes are recognised', () => {
  const cases = [
    ['C:/x.txt', 'C:/x.txt'],
    ['C:\\x.txt', 'C:\\x.txt'],
    ['C:relative-name', 'C:relative-name'],
    ['\\\\server\\share\\notes.txt', '\\\\server\\share\\notes.txt'],
    ['\\\\?\\C:\\x', '\\\\?\\C:\\x'],
    ['/etc/passwd', '/etc/passwd'],
    ['/', '/'],
    ['~/notes', '~/notes'],
    ['~other/notes', '~other/notes'],
    ['$HOME/.ssh/id_rsa', '$HOME/.ssh/id_rsa'],
    ['${HOME}/notes', '${HOME}/notes'],
    ['%USERPROFILE%\\notes', '%USERPROFILE%\\notes'],
    ['file:///C:/x.txt', 'file:///C:/x.txt'],
    ['./a.txt', './a.txt'],
    ['../secrets', '../secrets'],
    ['.\\a.txt', '.\\a.txt'],
    ['./my docs/a.txt', './my docs/a.txt'],
  ]
  for (const [value] of cases) {
    const resources = resourcesOf({ location: value })
    assert.equal(resources.length, 1, `${value} 应被识别为路径`)
    assert.equal(resources[0]!.value, value)
    assert.equal(resources[0]!.capability, CAPABILITY.WRITE, `${value} 无能力线索时按最严`)
  }
})

test('H2. leading/trailing blanks are stripped from a reported value', () => {
  assert.deepEqual(resourcesOf({ path: '  C:/x.txt  ' }), [
    { value: 'C:/x.txt', capability: CAPABILITY.WRITE, field: 'path' },
  ])
})

test('H3. relative paths are only reported when they are obvious', () => {
  for (const value of ['src/index.js', 'a/b/c', 'docs\\guide\\intro.md', 'node_modules/.bin']) {
    assert.equal(resourcesOf({ location: value }).length, 1, `${value} 应被识别`)
  }
  // Documented narrow edge: one separator, no dot-segment and no extension is
  // indistinguishable from an enum or a MIME type, so it is NOT reported by the
  // value leg. A path-NAMED field still catches it (see H4).
  for (const value of ['a/b', 'docs/guide', 'text/html', 'read/write']) {
    assert.deepEqual(resourcesOf({ location: value }), [], `${value} 不应被误判`)
  }
})

test('H4. ordinary strings are never mistaken for paths', () => {
  for (const value of ['hello', 'application/json', '2026/09/30', '1/2', 'https://example.com/a/b', '/^a$/', '/[a-z]+/', 'v1.2.3']) {
    assert.deepEqual(resourcesOf({ query: value }), [], `${value} 不应被误判`)
  }
})

test('H5. the field-NAME leg catches bare names a value shape cannot', () => {
  assert.deepEqual(resourcesOf({ path: 'notes' }), [
    { value: 'notes', capability: CAPABILITY.WRITE, field: 'path' },
  ])
  assert.deepEqual(resourcesOf({ filename: 'report.pdf' }), [
    { value: 'report.pdf', capability: CAPABILITY.WRITE, field: 'filename' },
  ])
  assert.deepEqual(resourcesOf({ file_path: 'a' }), [
    { value: 'a', capability: CAPABILITY.WRITE, field: 'file_path' },
  ])
})

test('H6. whole-token naming avoids the profile/file trap', () => {
  // `profile` ends in "file" but is not a path field, and `asc` is not a path.
  assert.deepEqual(resourcesOf({ profile: 'default', sort: 'asc' }), [])
  // ... while a genuine compound still matches.
  assert.equal(resourcesOf({ targetpath: 'notes' }).length, 1)
  assert.equal(resourcesOf({ workdir: 'notes' }).length, 1)
})

test('H7. capability is inferred from the field name, write > read > list, else WRITE', () => {
  const cases: Array<[string, string, string]> = [
    ['write_path', 'C:/x', CAPABILITY.WRITE],
    ['create_dir', 'C:/x', CAPABILITY.WRITE],
    ['delete_file', 'C:/x', CAPABILITY.WRITE],
    ['remove_target', 'C:/x', CAPABILITY.WRITE],
    ['save_to', 'C:/x', CAPABILITY.WRITE],
    ['read_path', 'C:/x', CAPABILITY.READ],
    ['load_file', 'C:/x', CAPABILITY.READ],
    ['get_target', 'C:/x', CAPABILITY.READ],
    ['list_dir', 'C:/x', CAPABILITY.LIST],
    ['scan_path', 'C:/x', CAPABILITY.LIST],
    ['target', 'C:/x', CAPABILITY.WRITE],
    ['file_path', 'C:/x', CAPABILITY.WRITE],
    ['cwd', 'C:/x', CAPABILITY.WRITE],
  ]
  for (const [key, value, expected] of cases) {
    const resources = resourcesOf({ [key]: value })
    assert.equal(resources.length, 1, key)
    assert.equal(resources[0]!.capability, expected, key)
  }
})

test('H8. the call capability is the strictest of its resources', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ read_path: 'C:/a', write_path: 'C:/b' }))
  assert.equal(result.capability, CAPABILITY.WRITE)
  assert.deepEqual(result.resources.map(resource => resource.capability), [CAPABILITY.READ, CAPABILITY.WRITE])
})

// ---------------------------------------------------------------------------
// heuristics: opaque program fields
// ---------------------------------------------------------------------------

test('O1. command-shaped fields on an unmodelled tool are opaque and need EXECUTE', () => {
  for (const key of ['command', 'cmd', 'commandLine', 'script', 'shell', 'program', 'exec']) {
    const result = resolveResources('third_party_tool', deepFreeze({ [key]: 'ls -la' }))
    assert.equal(result.opaque, true, key)
    assert.equal(result.capability, CAPABILITY.EXECUTE, key)
    assert.deepEqual(result.resources, [], key)
  }
})

test('O2. a "code" field is only a program when the value looks like one', () => {
  const country = resolveResources('third_party_tool', deepFreeze({ code: 'US' }))
  assert.equal(country.opaque, false)
  assert.equal(country.capability, CAPABILITY.WRITE)
  const program = resolveResources('third_party_tool', deepFreeze({ code: 'const p = 1' }))
  assert.equal(program.opaque, true)
  assert.equal(program.capability, CAPABILITY.EXECUTE)
})

test('O3. a path-named field is never reclassified as a program', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ script_path: '/tmp/x.js' }))
  assert.equal(result.opaque, false)
  assert.deepEqual(result.resources, [
    { value: '/tmp/x.js', capability: CAPABILITY.WRITE, field: 'script_path' },
  ])
})

test('O4. a program field holding a path is reported as both', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ command: 'D:/tools/x.exe' }))
  assert.equal(result.opaque, true)
  assert.equal(result.capability, CAPABILITY.EXECUTE)
  assert.deepEqual(result.resources, [
    { value: 'D:/tools/x.exe', capability: CAPABILITY.WRITE, field: 'command' },
  ])
})

test('O5. an unmodelled command field with no path still fails closed on capability', () => {
  const result = resolveResources('third_party_tool', deepFreeze({ command: 'ls -la' }))
  assert.equal(result.known, false)
  assert.equal(result.reason, undefined)
  assert.equal(result.opaque, true)
})

// ---------------------------------------------------------------------------
// policyAccessFor
// ---------------------------------------------------------------------------

test('P1. every capability projects onto the policy ladder', () => {
  assert.equal(policyAccessFor(CAPABILITY.LIST), 'list')
  assert.equal(policyAccessFor(CAPABILITY.ENUMERATE), 'list')
  assert.equal(policyAccessFor(CAPABILITY.READ), 'read')
  assert.equal(policyAccessFor(CAPABILITY.EXPORT), 'list')
  assert.equal(policyAccessFor(CAPABILITY.WRITE), 'write')
  assert.equal(policyAccessFor(CAPABILITY.EXECUTE), 'write')
  // Unknown input must not silently become the loosest rung.
  assert.equal(policyAccessFor('nonsense'), 'write')
  assert.equal(policyAccessFor(undefined), 'write')
})
