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

import { apply, Config, inject, name, unwrap } from '../src/index.js'
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
  const pushed = []
  const pushedAlways = []
  const canonical = options.canonical ?? (raw => raw)
  const service = options.notifyService === undefined
    ? undefined
    : {
      push: item => { pushed.push(item); return true },
      pushAlways: item => { pushedAlways.push(item); return true },
      ...options.notifyService,
    }
  return {
    guards,
    listeners,
    logs,
    pushed,
    pushedAlways,
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    },
    get(name) {
      if (name === 'desktopNotify') return service
      return options.services === undefined ? undefined : options.services[name]
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

test('self-protection blocks only what can actually disable the guard', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const guard = ctx.guards[0]
  const pm = args => guard({ name: 'plugin_manager', arguments: args })

  // Reading stays available: the model can still see what is installed.
  assert.equal(pm({ action: 'list_plugins' }), undefined)
  assert.equal(pm({ action: 'list_bundles' }), undefined)
  assert.equal(pm({ action: 'list_version_exemptions' }), undefined)

  // Normal plugin management must keep working — the AI installs and toggles
  // plugins like before; only actions that name THIS plugin are refused.
  assert.equal(pm({ action: 'set_plugin', target: 'dsh-desktop-notify', enabled: false }), undefined)
  assert.equal(pm({ action: 'set_bundle', target: 'some-other-plugin', enabled: false }), undefined)
  assert.equal(pm({ action: 'remove_bundle', target: 'some-other-plugin' }), undefined)
  assert.equal(pm({ action: 'install_bundle', target: 'some-npm-package' }), undefined)
  assert.equal(pm({ action: 'install_bundle', target: '@scope/pkg@1.2.3' }), undefined)

  // Naming this plugin (by row id, entry id or bundle name) is refused.
  assert.match(pm({ action: 'set_plugin', target: 'path-guard', enabled: false }), /自我保护/)
  assert.match(pm({ action: 'set_plugin', target: 'include:path-guard', enabled: false }), /自我保护/)
  assert.match(pm({ action: 'remove_bundle', target: 'dsh-path-guard' }), /自我保护/)
  assert.match(pm({ action: 'install_bundle', target: 'dsh-path-guard@1.0.0' }), /自我保护/)

  // Regression (verifier V-5): the model can author a package in the same turn
  // and install it from disk / git / a tarball; its patch layer could then
  // disable the row by id, with a target that names nothing of ours. Only the
  // registry is out of reach within one turn.
  for (const spec of [
    'D:/tmp/copy',
    'D:\\tmp\\copy',
    './relative',
    '../up',
    'file:C:/tmp/pkg',
    'https://example.invalid/x.git',
    'https://example.invalid/x.tgz',
    'github:user/repo',
    'git@github.com:user/repo.git',
    'pkg.tgz',
  ]) {
    assert.match(pm({ action: 'install_bundle', target: spec }), /只接受\*\*注册表上的包名\*\*/, `expected ${spec} to be refused`)
  }

  // Turning self-protection off restores unrestricted management.
  const open = fakeCtx()
  apply(open, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  assert.equal(open.guards[0]({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'D:/tmp/copy' } }), undefined)
  assert.equal(open.guards[0]({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'dsh-path-guard' } }), undefined)
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

// Regression for a real deployment failure: `DSH_PROFILE_DIR` is contributed by
// dsh-shell-env to each shell EXECUTION (shell-env/src/index.ts:158-167), not to
// the Host's own environment. The env-only lookup therefore left self-protection
// silently inert in the live profile — the model could read AND rewrite the very
// patch that carries the policy.
test('self-protection resolves the profile from profileContext, not just the environment', async () => {
  const previous = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  try {
    const patch = join(tmpdir(), 'pg-profile2', 'cordis.patch.yml')
    const ctx = fakeCtx({ services: { profileContext: { patchPath: patch } } })
    apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
    assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: patch } })).kind, 'allow')
    assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: patch, content: '' } })).kind, 'deny')
    // The shell scan must see it too: glob/pwsh never call ctx.fs, so a lexical
    // needle is all that stands between the model and the profile patch.
    assert.match(
      ctx.guards[0]({ name: 'pwsh', arguments: { command: `Get-Content '${patch}'` } }),
      /访问被拒绝/,
    )
  } finally {
    if (previous !== undefined) process.env.DSH_PROFILE_DIR = previous
  }
})

test('an unresolvable profile path is reported loudly instead of failing silently', () => {
  const previous = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  try {
    const ctx = fakeCtx()
    apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
    assert.ok(
      ctx.logs.some(([level, message]) => level === 'error' && String(message).includes('NOT protected')),
      'self-protection that cannot arm itself must say so',
    )
  } finally {
    if (previous !== undefined) process.env.DSH_PROFILE_DIR = previous
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

// ---------------------------------------------------------------------------
// Volatile configuration protocol
//
// A schemastery `.volatile()` field resolves to a frozen `{ get() }` reference
// (vendor/cosmokit/src/volatile.ts:39-45), NOT to a plain value, and the
// reference is updated in place when the user saves the settings page. Reading
// `config.rules` once at activation pinned the policy to boot-time state and
// threw on the shell path; these tests lock the live-read behaviour in.
// ---------------------------------------------------------------------------

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Build the exact reference shape schemastery hands a plugin.
 * @param {unknown} initial - the starting snapshot.
 * @returns {object} a frozen volatile reference.
 */
function ref(initial) {
  let current = initial
  return Object.freeze({ get: () => current, [VOLATILE_WRITE]: value => { current = value } })
}

test('unwrap reads a volatile reference and passes plain values through', () => {
  assert.equal(unwrap(ref('scan')), 'scan')
  assert.equal(unwrap(true), true)
  assert.deepEqual(unwrap(ref([1, 2])), [1, 2])
  assert.equal(unwrap(undefined), undefined)
})

test('wrapped config fields still produce a working policy', async () => {
  const ctx = fakeCtx()
  apply(ctx, {
    enabled: ref(true),
    rules: ref(RULES),
    defaultAccess: ref('allow'),
    selfProtection: ref(false),
  })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(decision.kind, 'deny', 'a wrapped rule list must not be silently dropped')
  // The shell path is where treating the reference as an array used to throw.
  assert.match(ctx.guards[0]({ name: 'pwsh', arguments: { command: `Get-Content '${join(tmpdir(), 'pg-secrets', 'k.txt')}'` } }), /pg-secrets/)
})

test('a live config change is picked up without re-activation', async () => {
  const rules = ref([])
  const ctx = fakeCtx()
  apply(ctx, { enabled: ref(true), rules, defaultAccess: ref('allow'), selfProtection: ref(false) })
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: target } })).kind, 'allow')
  // Exactly what a settings save does: replace the snapshot behind the reference.
  rules[VOLATILE_WRITE](RULES)
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: target } })).kind, 'deny')
})

test('defaultAccess other than allow applies to paths no rule matched', async () => {
  const defaultDeny = fakeCtx()
  apply(defaultDeny, { enabled: true, rules: [], defaultAccess: 'none', selfProtection: false })
  const denied = await preExecute(defaultDeny, { name: 'read', arguments: { file_path: join(tmpdir(), 'anything.txt') } })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /defaultAccess/)

  const defaultAllow = fakeCtx()
  apply(defaultAllow, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  assert.equal((await preExecute(defaultAllow, { name: 'read', arguments: { file_path: join(tmpdir(), 'anything.txt') } })).kind, 'allow')
})

// Regression: the first live activation read `config.rules` as a plain array,
// threw inside the guard, and every shell call in the running Harness failed
// with a stack trace. A security control must fail CLOSED and say so instead.
test('an internal failure fails closed instead of throwing', async () => {
  let reads = 0
  // Succeeds once (activation), then breaks on the first decision.
  const flaky = Object.freeze({
    get: () => {
      reads += 1
      if (reads > 1) throw new Error('boom')
      return []
    },
    [VOLATILE_WRITE]: () => {},
  })
  const ctx = fakeCtx()
  apply(ctx, { enabled: ref(true), rules: flaky, defaultAccess: ref('allow'), selfProtection: ref(false) })

  const guardResult = ctx.guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })
  assert.equal(typeof guardResult, 'string', 'the guard must return a reason, never throw')
  assert.match(guardResult, /内部出错/)
  assert.ok(ctx.logs.some(([level]) => level === 'error'), 'the failure must be logged at error level')

  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'x.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /内部出错/)
})

// ---------------------------------------------------------------------------
// Desktop notification wiring (optional `desktopNotify` service)
// ---------------------------------------------------------------------------

test('a denial notifies through desktopNotify when it is mounted', async () => {
  const ctx = fakeCtx({ notifyService: {} })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(ctx.pushed.length, 1, 'the default `focused` mode rides the focus gate')
  assert.equal(ctx.pushedAlways.length, 0)
  assert.ok(ctx.pushed[0].title.includes('Path Guard'))
  assert.ok(ctx.pushed[0].message.length > 0)
})

test('notify: always bypasses the focus gate, notify: off sends nothing', async () => {
  const always = fakeCtx({ notifyService: {} })
  apply(always, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false, notify: 'always' })
  await preExecute(always, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(always.pushedAlways.length, 1)
  assert.equal(always.pushed.length, 0)

  const off = fakeCtx({ notifyService: {} })
  apply(off, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false, notify: 'off' })
  await preExecute(off, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(off.pushed.length + off.pushedAlways.length, 0)
})

test('guard-side denials notify too, and a missing service is silent', async () => {
  const exotic = fakeCtx({ notifyService: {} })
  apply(exotic, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false, notify: 'always' })
  exotic.guards[0]({ name: 'run_code', arguments: { code: 'x' } })
  assert.equal(exotic.pushedAlways.length, 1)
  assert.match(exotic.pushedAlways[0].message, /run_code/)

  // No `dsh-desktop-notify` in the profile: denials must still work and log.
  const bare = fakeCtx()
  apply(bare, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const decision = await preExecute(bare, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.ok(bare.logs.some(([level]) => level === 'warn'))
})

test('an internal failure notifies as a malfunction', async () => {
  let reads = 0
  const flaky = Object.freeze({
    get: () => {
      reads += 1
      if (reads > 1) throw new Error('boom')
      return []
    },
    [VOLATILE_WRITE]: () => {},
  })
  const ctx = fakeCtx({ notifyService: {} })
  apply(ctx, { enabled: ref(true), rules: flaky, defaultAccess: ref('allow'), selfProtection: ref(false), notify: 'always' })
  ctx.guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })
  // `malfunction` is throttled per extension point and rides the focus gate
  // (`push`), unlike `always: true` denials.
  assert.equal(ctx.pushed.length, 1)
  assert.match(ctx.pushed[0].title, /内部错误/)
  assert.equal(ctx.pushedAlways.length, 0)
})

// ---------------------------------------------------------------------------
// Regressions for the adversarial verification findings (reports/verification.md)
// ---------------------------------------------------------------------------

test('V-2: workflow is scanned as an opaque program, not refused outright', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', exoticTools: 'deny', selfProtection: false })
  const guard = ctx.guards[0]
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')

  // A workflow that never mentions a protected path stays usable: refusing the
  // whole tool would cost a headline capability in every session, including the
  // ones that never touch a protected path.
  assert.equal(guard({ name: 'workflow', arguments: { script: 'return 1' } }), undefined)
  // The escape is still real (`node:vm` -> real `process`), so a script that
  // names a protected path is refused like a shell command.
  assert.match(guard({ name: 'workflow', arguments: { script: `readFileSync(${JSON.stringify(target)})` } }), /访问被拒绝/)
  // Genuinely unobservable surfaces keep the hard refusal.
  assert.match(guard({ name: 'run_code', arguments: { code: 'x' } }), /访问被拒绝/)
  assert.match(guard({ name: 'ralph', arguments: {} }), /访问被拒绝/)
  assert.equal(isExoticTool('workflow'), false)
  assert.equal(isExoticTool('run_code'), true)
  // In-process delegation stays usable: the global guard covers those children.
  assert.equal(guard({ name: 'subagent', arguments: { prompt: 'x' } }), undefined)
  assert.equal(guard({ name: 'subagent_fork', arguments: { prompt: 'x' } }), undefined)
})

test('a JSON-escaped Windows path is still detected in an opaque program', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')
  // Every program-string channel spells a Windows path inside a JS/JSON string
  // literal, i.e. with DOUBLED backslashes. Before the normalization pass this
  // read as an unrelated string and slipped through.
  const script = `const fs = await import('node:fs'); return fs.readFileSync(${JSON.stringify(target)}, 'utf8')`
  assert.ok(script.includes('\\\\'), 'the fixture must actually contain doubled backslashes')
  assert.match(ctx.guards[0]({ name: 'workflow', arguments: { script } }), /访问被拒绝/)
})

test('V-1: shell output blocks mentioning a protected path are withheld', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const passthrough = { kind: 'accept' }
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')

  const leaked = await handler(
    { name: 'pwsh', arguments: {} },
    { isError: false, content: [{ type: 'text', text: `-----BEGIN KEY-----\n${target}\n` }] },
    async () => passthrough,
  )
  assert.equal(leaked.kind, 'accept')
  assert.ok(!JSON.stringify(leaked.content).includes('BEGIN KEY'), 'the block must not survive')

  const clean = await handler(
    { name: 'pwsh', arguments: {} },
    { isError: false, content: [{ type: 'text', text: 'nothing interesting here' }] },
    async () => passthrough,
  )
  assert.equal(clean, passthrough, 'unrelated output passes through untouched')
})

test('V-3: defaultAccess != allow with no rules refuses the shell instead of opening it', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'none', shell: 'scan', selfProtection: false })
  // No rule can produce a needle, so "nothing matched" must not read as "safe".
  assert.match(ctx.guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), /访问被拒绝/)

  const lax = fakeCtx()
  apply(lax, { enabled: true, rules: [], defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  assert.equal(lax.guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), undefined)
})

test('V-4: shell scanning skips write-level rules but keeps the stricter ones', () => {
  const project = join(tmpdir(), 'pg-proj')
  const ctx = fakeCtx()
  apply(ctx, {
    enabled: true,
    defaultAccess: 'allow',
    shell: 'scan',
    selfProtection: false,
    rules: [
      { path: project, access: 'write', note: '' },
      { path: join(HOME, '.ssh'), access: 'list', note: '' },
    ],
  })
  const guard = ctx.guards[0]
  // `write` already grants everything, so mentioning the path is not a violation.
  assert.equal(guard({ name: 'pwsh', arguments: { command: `cd '${project}'; npm test` } }), undefined)
  // `list` still refuses: the shell cannot be judged per-path, and it would leak content.
  assert.match(guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(HOME, '.ssh', 'id_rsa')}'` } }), /访问被拒绝/)
})

test('V-7: a malformed rule list fails closed instead of silently disabling the policy', async () => {
  const ctx = fakeCtx()
  const broken = Object.freeze({ get: () => 'not-an-array', [VOLATILE_WRITE]: () => {} })
  apply(ctx, { enabled: ref(true), rules: broken, defaultAccess: ref('allow'), selfProtection: ref(false) })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'x.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /内部出错/)
})

test('V-10: an internal failure does not take away tools this plugin does not govern', async () => {
  let reads = 0
  const flaky = Object.freeze({
    get: () => {
      reads += 1
      if (reads > 1) throw new Error('boom')
      return []
    },
    [VOLATILE_WRITE]: () => {},
  })
  const ctx = fakeCtx()
  apply(ctx, { enabled: ref(true), rules: flaky, defaultAccess: ref('allow'), selfProtection: ref(false) })
  // Human-escalation and bookkeeping tools must survive a plugin bug.
  assert.equal((await preExecute(ctx, { name: 'ask_user_question', arguments: {} })).kind, 'allow')
  assert.equal((await preExecute(ctx, { name: 'todo_write', arguments: {} })).kind, 'allow')
  assert.equal(ctx.guards[0]({ name: 'todo_write', arguments: {} }), undefined)
  // Governed calls still fail closed.
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: 'x' } })).kind, 'deny')
})
