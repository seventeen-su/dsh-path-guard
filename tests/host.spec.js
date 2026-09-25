/**
 * Host-wiring integration tests: `src/index.js` against a fake Cordis context.
 *
 * These exercise the plugin the way the Harness does — through
 * `ctx.tools.guard()` and the `tools/pre-execute` / `tools/post-execute`
 * waterfalls — without needing a live DSH process.
 *
 * @module dsh-path-guard/tests/host
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config, inject, name } from '../src/index.js'
import { opForCommand, collectPaths, isExoticTool } from '../src/tool-fields.js'
import { buildNeedles, scanCommand, commandOf } from '../src/scan.js'

// `~` rules are expanded with the real home directory by the plugin, so the
// tests must use the same anchor or they would exercise an unmatched rule.
const HOME = homedir()
const WORKSPACE = join(tmpdir(), 'pg-ws')

/**
 * A minimal stand-in for the Cordis context surface this plugin touches.
 * @param {{canonical?: (raw: string) => string}} [options] - resolve override.
 * @returns {object} the fake context plus captured registrations.
 */
function fakeCtx(options = {}) {
  const guards = []
  const listeners = new Map()
  const logs = []
  const canonical = options.canonical ?? (raw => raw)
  return {
    guards,
    listeners,
    logs,
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    },
    tools: { guard: fn => { guards.push(fn); return () => {} } },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    fs: {
      async resolve(raw) {
        return { targetKey: `k:${raw}`, displayPath: canonical(raw) }
      },
      processPath(target) {
        return target.displayPath
      },
    },
  }
}

/**
 * Run one call through the plugin's pre-execute waterfall.
 * @param {object} ctx - the fake context.
 * @param {{name: string, arguments: unknown}} exec - the call.
 * @returns {Promise<object>} the decision the framework would receive.
 */
async function preExecute(ctx, exec) {
  for (const handler of ctx.listeners.get('tools/pre-execute') ?? []) {
    const decision = await handler({ ...exec, agent: undefined, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
    if (decision !== undefined) return decision
  }
  return { kind: 'allow' }
}

/** The base config used by most cases. */
const RULES = [
  { id: 'ssh', path: '~/.ssh', access: 'list', note: '' },
  { id: 'ssh-readme', path: '~/.ssh/README.md', access: 'read', note: '' },
  { id: 'secrets', path: join(tmpdir(), 'pg-secrets'), access: 'none', note: '' },
]

test('exports the manifest surface the Loader needs', () => {
  assert.equal(name, 'path-guard')
  assert.deepEqual(inject, ['tools', 'fs'])
  assert.equal(typeof Config, 'function', 'Config must be a schemastery schema')
  assert.equal(typeof Config.toJSON, 'function')
})

test('a rule list with no rules leaves every tool untouched', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow' })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: '~/.ssh/id_rsa' } })
  assert.equal(decision.kind, 'allow')
})

test('none blocks reading a file under the protected directory', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /访问被拒绝/)
  assert.match(decision.reason, /不要尝试绕过/)
})

test('half access: list lets glob through but not grep', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const glob = await preExecute(ctx, { name: 'glob', arguments: { pattern: '**/*', path: '~/.ssh' } })
  assert.equal(glob.kind, 'allow', 'glob only lists names, which `list` permits')
  const grep = await preExecute(ctx, { name: 'grep', arguments: { pattern: 'KEY', path: '~/.ssh' } })
  assert.equal(grep.kind, 'deny', 'grep returns content, which `list` does not permit')
  assert.match(grep.reason, /仅允许查看文件名/)
})

test('exemption: a more specific rule overrides the broader one', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const readme = await preExecute(ctx, { name: 'read', arguments: { file_path: join(HOME, '.ssh', 'README.md') } })
  assert.equal(readme.kind, 'allow')
  const key = await preExecute(ctx, { name: 'read', arguments: { file_path: join(HOME, '.ssh', 'id_rsa') } })
  assert.equal(key.kind, 'deny')
})

test('half access: read allows reading but refuses writing', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const target = join(HOME, '.ssh', 'README.md')
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: target } })).kind, 'allow')
  const write = await preExecute(ctx, { name: 'write', arguments: { file_path: target, content: 'x' } })
  assert.equal(write.kind, 'deny')
  assert.match(write.reason, /不允许写入或修改/)
})

test('write and edit are refused under none', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: target, content: 'x' } })).kind, 'deny')
  assert.equal((await preExecute(ctx, { name: 'edit', arguments: { file_path: target, old_string: 'a', new_string: 'b' } })).kind, 'deny')
})

test('the resolved canonical path decides, so a symlink cannot evade the rule', async () => {
  // The lexical argument points somewhere harmless; resolve reports the real
  // location under the protected directory. This is the whole reason the
  // decision lives in the async pre-execute instead of the sync guard.
  const real = join(tmpdir(), 'pg-secrets', 'id_rsa')
  const ctx = fakeCtx({ canonical: () => real })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'innocent-link') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /pg-secrets/)
})

test('a search tool without a path checks the session workspace root', async () => {
  const ctx = fakeCtx({ canonical: () => join(tmpdir(), 'pg-secrets') })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const exec = { name: 'glob', arguments: { pattern: '**/*' }, agent: { session: { header: { cwd: join(tmpdir(), 'pg-secrets') } } }, signal: new AbortController().signal }
  const decision = await ctx.listeners.get('tools/pre-execute')[0](exec, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
})

test('present reads files[].path', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const decision = await preExecute(ctx, {
    name: 'present',
    arguments: { files: [{ path: join(tmpdir(), 'pg-secrets', 'k.txt') }] },
  })
  assert.equal(decision.kind, 'deny')
})

test('str_replace_editor grades by command: view reads, insert writes', async () => {
  assert.equal(opForCommand({ command: 'view' }), 'read')
  assert.equal(opForCommand({ command: 'str_replace' }), 'write')
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const target = join(HOME, '.ssh', 'README.md')
  assert.equal((await preExecute(ctx, { name: 'str_replace_editor', arguments: { command: 'view', path: target } })).kind, 'allow')
  assert.equal((await preExecute(ctx, { name: 'str_replace_editor', arguments: { command: 'insert', path: target } })).kind, 'deny')
})

test('an unknown tool with no known path field is left alone', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  assert.equal((await preExecute(ctx, { name: 'todo_write', arguments: { todos: [] } })).kind, 'allow')
})

test('guard refuses exotic tools by default, and allows them when configured', () => {
  const strict = fakeCtx()
  apply(strict, { enabled: true, rules: [], defaultAccess: 'allow', exoticTools: 'deny', selfProtection: false })
  assert.equal(typeof strict.guards[0]({ name: 'run_code', arguments: {} }), 'string')
  assert.equal(typeof strict.guards[0]({ name: 'mcp__filesystem__read_file', arguments: {} }), 'string')
  assert.equal(strict.guards[0]({ name: 'read', arguments: {} }), undefined)

  const lax = fakeCtx()
  apply(lax, { enabled: true, rules: [], defaultAccess: 'allow', exoticTools: 'allow', selfProtection: false })
  assert.equal(lax.guards[0]({ name: 'run_code', arguments: {} }), undefined)
})

test('guard keeps plugin_manager usable except against this plugin itself', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const guard = ctx.guards[0]
  assert.equal(guard({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }), undefined)
  assert.equal(guard({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'some-other-plugin' } }), undefined)
  assert.match(guard({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'path-guard', enabled: false } }), /自我保护/)
  assert.match(guard({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'dsh-path-guard' } }), /自我保护/)
})

test('guard scans shell command text for protected paths', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  const guard = ctx.guards[0]
  const protectedFile = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.match(guard({ name: 'pwsh', arguments: { command: `Get-Content '${protectedFile}'` } }), /pg-secrets/)
  assert.match(guard({ name: 'bash', arguments: { command: `cat ${protectedFile.replaceAll('\\', '/')}` } }), /pg-secrets/)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), undefined)
})

test('shell: deny refuses every shell call; shell: off refuses nothing', () => {
  const deny = fakeCtx()
  apply(deny, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'deny', selfProtection: false })
  assert.match(deny.guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), /访问被拒绝/)

  const off = fakeCtx()
  apply(off, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'off', selfProtection: false })
  assert.equal(off.guards[0]({ name: 'pwsh', arguments: { command: `Get-Content '${join(tmpdir(), 'pg-secrets', 'k.txt')}'` } }), undefined)
})

test('self-protection makes the profile composition readable but not writable', async () => {
  const profileDir = join(tmpdir(), 'pg-profile')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  try {
    const ctx = fakeCtx()
    apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
    const patch = join(profileDir, 'cordis.patch.yml')
    assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: patch } })).kind, 'allow')
    assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: patch, content: '' } })).kind, 'deny')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('disabled means disabled', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false, rules: RULES, defaultAccess: 'allow' })
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })).kind, 'allow')
  assert.equal(ctx.guards[0]({ name: 'run_code', arguments: {} }), undefined)
})

test('invalid rules are reported and skipped instead of breaking activation', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [{ path: '', access: 'nope' }], defaultAccess: 'allow', selfProtection: false })
  assert.ok(ctx.logs.some(([level]) => level === 'warn'))
})

test('post-execute passes unrelated tools and untouched results straight through', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const passthrough = { kind: 'accept' }
  assert.equal(await handler({ name: 'read', arguments: {} }, { isError: false, value: {} }, async () => passthrough), passthrough)

  // glob with nothing protected in it: no change, so the downstream decision wins.
  const clean = { root: '.', paths: ['src/a.js'] }
  assert.equal(await handler({ name: 'glob', arguments: {} }, { isError: false, value: clean }, async () => passthrough), passthrough)
})

test('post-execute redacts glob paths under a protected directory', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const protectedRoot = join(tmpdir(), 'pg-secrets')
  // Search results carry workdir-relative paths when the hit is inside the
  // workdir, so absolute inputs here stand in for the mixed real case.
  const value = { root: protectedRoot, paths: [join(protectedRoot, 'a.txt'), join(protectedRoot, 'b.txt')] }
  const decision = await handler({ name: 'glob', arguments: {} }, { isError: false, value }, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.value.paths, [])
})

test('post-execute withholds an unrecognized structure when rules exist (fail-closed)', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const decision = await handler({ name: 'grep', arguments: {} }, { isError: false, value: { unexpected: true } }, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'block')
})

test('post-execute never touches a failed result', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const passthrough = { kind: 'accept' }
  const decision = await handler({ name: 'grep', arguments: {} }, { isError: true, error: { message: 'x' }, value: undefined }, async () => passthrough)
  assert.equal(decision, passthrough)
})

test('tool-fields helpers behave', () => {
  assert.equal(isExoticTool('mcp__x__y'), true)
  assert.equal(isExoticTool('cordis_inspect_query'), false)
  assert.deepEqual(collectPaths({ files: [{ path: 'a' }, { path: ' ' }, {}] }, { field: 'files', each: 'path' }), ['a'])
  assert.deepEqual(collectPaths({ path: 'a' }, { field: 'path' }), ['a'])
  assert.deepEqual(collectPaths({}, { field: 'path' }), [])
  assert.equal(commandOf({ command: 'x' }), 'x')
  assert.equal(commandOf({ text: 'y' }), 'y')
  assert.equal(commandOf({}), undefined)
})

test('the shell scanner finds home spellings and ignores short needles', () => {
  const needles = buildNeedles([{ path: join(HOME, '.ssh'), access: 'none' }], { home: HOME, windows: false })
  assert.ok(needles.length >= 2)
  assert.ok(scanCommand(`type ${join(HOME, '.ssh', 'id_rsa')}`, needles, false))
  assert.ok(scanCommand('cat ~/.ssh/id_rsa', needles, false))
  assert.ok(scanCommand('cat $HOME/.ssh/id_rsa', needles, false))
  assert.equal(scanCommand('cat ./notes.txt', needles, false), undefined)
  // Each surviving path yields a slash and a backslash spelling.
  assert.equal(buildNeedles([{ path: 'D:/a', access: 'none' }], { home: HOME }).length, 2, 'both separator spellings')
  assert.equal(buildNeedles([{ path: 'D:/', access: 'none' }], { home: HOME }).length, 0, 'too-short needles are dropped')
})
