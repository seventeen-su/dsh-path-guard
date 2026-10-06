/**
 * Host-wiring integration tests: `src/index.js` against a fake Cordis context.
 *
 * These exercise the plugin the way the Harness does — through
 * `ctx.tools.guard()` and the `tools/pre-execute` / `tools/post-execute`
 * waterfalls — without needing a live DSH process.
 *
 * @module dsh-path-guard/tests/host
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config, inject, name, unwrap } from '../src/index.ts'
import { opForCommand, collectPaths, isExoticTool } from '../src/tool-fields.ts'
import { buildNeedles, scanCommand, commandOf, literalNeedlePrefix, unscannablePatterns } from '../src/scan.ts'
import { TRACKED_TOOLS_MAX } from '../src/tracking.ts'

// `~` rules are expanded with the real home directory by the plugin, so the
// tests must use the same anchor or they would exercise an unmatched rule.
const HOME = homedir()
const WORKSPACE = join(tmpdir(), 'pg-ws')

// Tool tracking persists into `<DSH_PROFILE_DIR>/path-guard-tools.json`. The
// suite must never write into the developer's real profile, and must not
// inherit records from an earlier run — either would make these tests
// order-dependent. The persistence case below points the variable at its own
// temporary directory and puts back what is saved here.
const PROFILE_DIR_BEFORE_TESTS = process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE_DIR
after(() => {
  if (PROFILE_DIR_BEFORE_TESTS === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = PROFILE_DIR_BEFORE_TESTS
})

/**
 * Poll until a condition holds — used for the registry's debounced write.
 * @param predicate - the condition to wait for.
 * @param timeoutMs - how long to wait before failing.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition not met before the timeout')
}

/** The plugin's own ctx contract, derived from `apply` so the fake cannot drift from it. */
type PluginCtx = Parameters<typeof apply>[0]
/** The exec object the plugin's guard receives (src/index.ts mirrors DSH's ToolExecution). */
type GuardExec = Parameters<Parameters<NonNullable<PluginCtx['tools']>['guard']>[0]>[0]
/** A guard as the fake registry records it. */
type GuardFn = (exec: GuardExec) => string | undefined
/** A registered listener (pre-execute takes 2 args, post-execute 3). */
type AnyListener = (...args: unknown[]) => unknown
/** The decision a `tools/pre-execute` listener returns, as these tests read it back. */
interface Decision {
  kind: string
  reason?: string | undefined
}
/** The decision a `tools/post-execute` listener returns, as these tests read it back. */
interface PostDecision {
  kind: string
  content?: unknown
  value?: { paths?: string[]; matches?: unknown[] } | undefined
}
/** One payload recorded by the fake `desktopNotify` service. */
interface PushedItem {
  title: string
  message: string
  urgency?: string | undefined
  sessionId?: unknown
  /** Click target. `sessionId` gates; THIS is what makes a toast clickable. */
  click?: { type: 'session'; sessionId: unknown } | { type: 'page'; page: string } | undefined
}
/** A response the fake route handler wrote to. */
interface FakeResponse {
  status?: number | undefined
  headers?: Record<string, string> | undefined
  body?: string | undefined
  writeHead: (status: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}
/** One route the plugin registered on the fake web server. */
interface FakeRoute {
  kind: string
  path: string
  handler: (req: unknown, res: FakeResponse) => unknown
}
/** What the tests read off the fake beyond the plugin's own ctx contract. */
interface FakeCtxExtra {
  guards: GuardFn[]
  listeners: Map<string, AnyListener[]>
  logs: unknown[][]
  pushed: PushedItem[]
  pushedAlways: PushedItem[]
  /** Routes registered on the fake `webServer` (empty unless it was requested). */
  routes: FakeRoute[]
}
/** Overrides `fakeCtx` accepts (documented `canonical` plus per-case service wiring). */
interface FakeCtxOptions {
  canonical?: ((raw: string) => string) | undefined
  notifyService?: Record<string, unknown> | undefined
  services?: Record<string, unknown> | undefined
  readText?: ((displayPath: string) => string) | undefined
  /** Provide a fake `webServer` so route registrations can be observed. */
  webServer?: boolean | undefined
}

/**
 * A minimal stand-in for the Cordis context surface this plugin touches.
 * @param options - resolve override and per-case service wiring.
 * @returns the fake context plus captured registrations.
 */
function fakeCtx(options: FakeCtxOptions = {}): PluginCtx & FakeCtxExtra {
  const guards: GuardFn[] = []
  const listeners = new Map<string, AnyListener[]>()
  const logs: unknown[][] = []
  const pushed: PushedItem[] = []
  const pushedAlways: PushedItem[] = []
  const routes: FakeRoute[] = []
  const canonical = options.canonical ?? ((raw: string) => raw)
  const service = options.notifyService === undefined
    ? undefined
    : {
      push: (item: unknown) => { pushed.push(item as PushedItem); return true },
      pushAlways: (item: unknown) => { pushedAlways.push(item as PushedItem); return true },
      ...options.notifyService,
    }
  return {
    guards,
    listeners,
    logs,
    pushed,
    pushedAlways,
    routes,
    logger: {
      info: (...args: unknown[]) => logs.push(['info', ...args]),
      warn: (...args: unknown[]) => logs.push(['warn', ...args]),
      error: (...args: unknown[]) => logs.push(['error', ...args]),
      debug: (...args: unknown[]) => logs.push(['debug', ...args]),
    },
    // Runs the callback now and hands back its disposer, like the real effect.
    effect: (callback: () => unknown) => {
      const disposer = callback()
      return () => { if (typeof disposer === 'function') (disposer as () => void)() }
    },
    ...(options.webServer === true
      ? {
        webServer: {
          register: (route: FakeRoute) => {
            routes.push(route)
            return () => { routes.splice(routes.indexOf(route), 1) }
          },
        },
      }
      : {}),
    get(name: string) {
      if (name === 'desktopNotify') return service
      return options.services === undefined ? undefined : options.services[name]
    },
    tools: { guard: (fn: GuardFn) => { guards.push(fn); return () => {} } },
    on(event: string, handler: AnyListener) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    fs: {
      async resolve(raw: string) {
        return { targetKey: `k:${raw}`, displayPath: canonical(raw) }
      },
      processPath(target: { displayPath: string }) {
        return target.displayPath
      },
      ...(options.readText === undefined ? {} : {
        async readText(target: { displayPath: string }) {
          return options.readText!(target.displayPath)
        },
      }),
    },
  } as unknown as PluginCtx & FakeCtxExtra
}

/**
 * Run one call through the plugin's pre-execute waterfall.
 * @param ctx - the fake context.
 * @param exec - the call.
 * @returns the decision the framework would receive.
 */
async function preExecute(
  ctx: { listeners: Map<string, AnyListener[]> },
  exec: { name: string; arguments: unknown },
): Promise<Decision> {
  for (const handler of ctx.listeners.get('tools/pre-execute') ?? []) {
    const decision = await handler({ ...exec, agent: undefined, signal: new AbortController().signal }, async () => ({ kind: 'allow' })) as Decision | undefined
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
  assert.match(decision.reason!, /访问被拒绝/)
  assert.match(decision.reason!, /不要尝试绕过/)
})

test('half access: list lets glob through but not grep', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const glob = await preExecute(ctx, { name: 'glob', arguments: { pattern: '**/*', path: '~/.ssh' } })
  assert.equal(glob.kind, 'allow', 'glob only lists names, which `list` permits')
  const grep = await preExecute(ctx, { name: 'grep', arguments: { pattern: 'KEY', path: '~/.ssh' } })
  assert.equal(grep.kind, 'deny', 'grep returns content, which `list` does not permit')
  assert.match(grep.reason!, /仅允许查看文件名/)
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
  assert.match(write.reason!, /不允许写入或修改/)
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
  assert.match(decision.reason!, /pg-secrets/)
})

test('a search tool without a path checks the session workspace root', async () => {
  const ctx = fakeCtx({ canonical: () => join(tmpdir(), 'pg-secrets') })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const exec = { name: 'glob', arguments: { pattern: '**/*' }, agent: { session: { header: { cwd: join(tmpdir(), 'pg-secrets') } } }, signal: new AbortController().signal }
  const decision = await ctx.listeners.get('tools/pre-execute')![0]!(exec, async () => ({ kind: 'allow' })) as Decision
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
  assert.equal(typeof strict.guards[0]!({ name: 'run_code', arguments: {} }), 'string')
  assert.equal(typeof strict.guards[0]!({ name: 'mcp__filesystem__read_file', arguments: {} }), 'string')
  assert.equal(strict.guards[0]!({ name: 'read', arguments: {} }), undefined)

  const lax = fakeCtx()
  apply(lax, { enabled: true, rules: [], defaultAccess: 'allow', exoticTools: 'allow', selfProtection: false })
  assert.equal(lax.guards[0]!({ name: 'run_code', arguments: {} }), undefined)
})

test('self-protection blocks only what can actually disable the guard', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const guard = ctx.guards[0]!
  const pm = (args: Record<string, unknown>) => guard({ name: 'plugin_manager', arguments: args })

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
  assert.match(pm({ action: 'set_plugin', target: 'path-guard', enabled: false })!, /自我保护/)
  assert.match(pm({ action: 'set_plugin', target: 'include:path-guard', enabled: false })!, /自我保护/)
  assert.match(pm({ action: 'remove_bundle', target: 'dsh-path-guard' })!, /自我保护/)
  assert.match(pm({ action: 'install_bundle', target: 'dsh-path-guard@1.0.0' })!, /自我保护/)

  // Regression (verifier V-5): the model can author a package in the same turn
  // and install it from git or a tarball; its patch layer could then disable the
  // row by id, with a target that names nothing of ours. Sources that cannot be
  // inspected BEFORE they land are refused outright.
  for (const spec of [
    'https://example.invalid/x.git',
    'https://example.invalid/x.tgz',
    'github:user/repo',
    'git@github.com:user/repo.git',
    'pkg.tgz',
    './relative',
    '../up',
  ]) {
    assert.match(pm({ action: 'install_bundle', target: spec })!, /拒绝了这次安装来源/, `expected ${spec} to be refused`)
  }

  // A LOCAL path is inspected by the async pass instead, so the synchronous
  // guard must leave it alone rather than guess.
  assert.equal(pm({ action: 'install_bundle', target: 'D:/tmp/copy' }), undefined)
  assert.equal(pm({ action: 'install_bundle', target: 'D:\\tmp\\copy' }), undefined)
  assert.equal(pm({ action: 'install_bundle', target: 'file:C:/tmp/pkg' }), undefined)

  // Turning self-protection off restores unrestricted management.
  const open = fakeCtx()
  apply(open, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  assert.equal(open.guards[0]!({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'D:/tmp/copy' } }), undefined)
  assert.equal(open.guards[0]!({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'dsh-path-guard' } }), undefined)
})

test('a local bundle is inspected before install, so the dev loop keeps working', async () => {
  const dir = join(tmpdir(), 'pg-local-bundle')
  const clean: Record<string, string> = {
    [join(dir, 'package.json')]: JSON.stringify({
      name: 'my-local-plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    [join(dir, 'cordis.patch.yml')]: '- insert:\n    - id: my-row\n      name: my-local-plugin\n',
  }
  const ctx = fakeCtx({ readText: path => clean[path]! })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const decision = await preExecute(ctx, { name: 'plugin_manager', arguments: { action: 'install_bundle', target: dir } })
  assert.equal(decision.kind, 'allow', 'a local plugin that never touches this row installs normally')
})

test('a local bundle that could switch the guard off is refused', async () => {
  const dir = join(tmpdir(), 'pg-hostile-bundle')
  const manifest = JSON.stringify({ name: 'evil', dsh: { bundle: { patch: './cordis.patch.yml' } } })

  // Its patch disables this plugin's row by id.
  const hostile = fakeCtx({
    readText: path => (path.endsWith('package.json') ? manifest : '- id: path-guard\n  disabled: true\n'),
  })
  apply(hostile, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const denied = await preExecute(hostile, { name: 'plugin_manager', arguments: { action: 'install_bundle', target: dir } })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason!, /row id 或包名/)

  // Its install hook would run code while installing.
  const hooked = fakeCtx({
    readText: () => JSON.stringify({ name: 'evil', scripts: { postinstall: 'node pwn.js' } }),
  })
  apply(hooked, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const hookDenied = await preExecute(hooked, { name: 'plugin_manager', arguments: { action: 'install_bundle', target: dir } })
  assert.equal(hookDenied.kind, 'deny')
  assert.match(hookDenied.reason!, /postinstall/)

  // Nothing readable -> fail closed rather than wave it through.
  const blind = fakeCtx()
  apply(blind, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
  const blindDenied = await preExecute(blind, { name: 'plugin_manager', arguments: { action: 'install_bundle', target: dir } })
  assert.equal(blindDenied.kind, 'deny')
  assert.match(blindDenied.reason!, /fail-closed/)
})

test('guard scans shell command text for protected paths', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  const guard = ctx.guards[0]!
  const protectedFile = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.match(guard({ name: 'pwsh', arguments: { command: `Get-Content '${protectedFile}'` } })!, /pg-secrets/)
  assert.match(guard({ name: 'bash', arguments: { command: `cat ${protectedFile.replaceAll('\\', '/')}` } })!, /pg-secrets/)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), undefined)
})

test('shell: deny refuses every shell call; shell: off refuses nothing', () => {
  const deny = fakeCtx()
  apply(deny, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'deny', selfProtection: false })
  assert.match(deny.guards[0]!({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })!, /访问被拒绝/)

  const off = fakeCtx()
  apply(off, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'off', selfProtection: false })
  assert.equal(off.guards[0]!({ name: 'pwsh', arguments: { command: `Get-Content '${join(tmpdir(), 'pg-secrets', 'k.txt')}'` } }), undefined)
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
    // The shell scan deliberately does NOT cover this path any more. The profile
    // patch is a `read`-tier self-protection rule — readable on purpose — and the
    // scanner cannot tell a read from a write inside an opaque command, so making
    // it a needle denied exactly what the tier allows. That was a real false
    // positive: `read` returned the profile's package.json in full while `pwsh`
    // printing the same path lost its whole output.
    //
    // The trade-off, stated plainly: a shell command that WRITES to the profile
    // patch is no longer caught by the scanner. Writes through the file tools are
    // still denied (above), and writes through `ctx.fs` hit the authoritative
    // fs-intent layer, which sees the resolved target. An opaque shell write was
    // never fenceable here in the first place — see the README's shell row.
    assert.equal(
      ctx.guards[0]!({ name: 'pwsh', arguments: { command: `Get-Content '${patch}'` } }),
      undefined,
      'a read-tier path, including a self-protection one, is not a shell-scan needle',
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
  assert.equal(ctx.guards[0]!({ name: 'run_code', arguments: {} }), undefined)
})

test('invalid rules are reported and skipped instead of breaking activation', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [{ path: '', access: 'nope' }], defaultAccess: 'allow', selfProtection: false })
  assert.ok(ctx.logs.some(([level]) => level === 'warn'))
})

test('post-execute passes unrelated tools and untouched results straight through', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')![0]!
  const passthrough = { kind: 'accept' }
  assert.equal(await handler({ name: 'read', arguments: {} }, { isError: false, value: {} }, async () => passthrough), passthrough)

  // glob with nothing protected in it: no change, so the downstream decision wins.
  const clean = { root: '.', paths: ['src/a.js'] }
  assert.equal(await handler({ name: 'glob', arguments: {} }, { isError: false, value: clean }, async () => passthrough), passthrough)
})

test('post-execute redacts glob paths under a protected directory', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')![0]!
  const protectedRoot = join(tmpdir(), 'pg-secrets')
  // Search results carry workdir-relative paths when the hit is inside the
  // workdir, so absolute inputs here stand in for the mixed real case.
  const value = { root: protectedRoot, paths: [join(protectedRoot, 'a.txt'), join(protectedRoot, 'b.txt')] }
  const decision = await handler({ name: 'glob', arguments: {} }, { isError: false, value }, async () => ({ kind: 'accept' })) as PostDecision
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.value!.paths, [])
})

test('post-execute withholds an unrecognized structure when rules exist (fail-closed)', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')![0]!
  const decision = await handler({ name: 'grep', arguments: {} }, { isError: false, value: { unexpected: true } }, async () => ({ kind: 'accept' })) as PostDecision
  assert.equal(decision.kind, 'block')
})

test('post-execute never touches a failed result', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')![0]!
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

test('name: rules are reported as uncovered instead of producing a bogus needle', () => {
  // Regression found by the path-model teammate: `literalNeedlePrefix` treats the
  // whole `name:readme.md` string as a literal, so a deny-direction name rule was
  // neither enforced on the shell channel nor reported — and expanding it as a
  // path made Windows ADS folding emit the over-broad needle `D:/proj/name`.
  assert.deepEqual(unscannablePatterns([{ path: 'name:id_rsa' }]), ['name:id_rsa'])
  assert.deepEqual(unscannablePatterns([{ path: 'name:*.md' }]), ['name:*.md'])
  const needles = buildNeedles(
    [{ path: 'name:id_rsa', access: 'none' }, { path: 'name:*.md', access: 'none' }],
    { home: HOME, workspace: join(tmpdir(), 'pg-proj'), windows: true },
  )
  assert.deepEqual(needles, [], 'a basename is too common to serve as a substring needle')
})

test('a trailing-glob rule still produces a usable shell needle', () => {
  // Regression: expanding the pattern as written put a literal `**` in the
  // needle, which no command ever contains — so `~/.ssh/**` was silently
  // unenforced on every shell spelling while still counting as "scannable".
  for (const pattern of ['~/.ssh', '~/.ssh/**', '~/.ssh/*']) {
    const needles = buildNeedles([{ path: pattern, access: 'none' }], { home: HOME, windows: true })
    assert.ok(needles.length > 0, `${pattern} must produce needles`)
    assert.ok(scanCommand(`cat ${join(HOME, '.ssh', 'id_rsa')}`, needles, true), `${pattern} must catch the absolute form`)
    assert.ok(scanCommand('cat ~/.ssh/id_rsa', needles, true), `${pattern} must catch the ~ form`)
  }
})

test('an unreducible pattern is reported instead of silently unenforced', () => {
  assert.equal(literalNeedlePrefix('~/.ssh/**'), '~/.ssh')
  assert.equal(literalNeedlePrefix('D:/secrets/*'), 'D:/secrets')
  // A wildcard inside a segment, or one with a literal tail, has no substring
  // that means the same thing.
  assert.equal(literalNeedlePrefix('D:/sec*'), undefined)
  assert.equal(literalNeedlePrefix('D:/a/*/secret'), undefined)
  assert.deepEqual(
    unscannablePatterns([{ path: '~/.ssh/**' }, { path: 'D:/a/*/secret' }]),
    ['D:/a/*/secret'],
  )

  const ctx = fakeCtx()
  apply(ctx, {
    enabled: true,
    rules: [{ path: 'D:/a/*/secret', access: 'none' }],
    defaultAccess: 'allow',
    shell: 'scan',
    selfProtection: false,
  })
  assert.ok(
    ctx.logs.some(([level, message]) => level === 'warn' && String(message).includes('cannot be covered')),
    'an unenforceable-on-shell rule must be reported, not left silent',
  )
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
function ref(initial: unknown) {
  let current = initial
  return Object.freeze({ get: () => current, [VOLATILE_WRITE]: (value: unknown) => { current = value } })
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
  assert.match(ctx.guards[0]!({ name: 'pwsh', arguments: { command: `Get-Content '${join(tmpdir(), 'pg-secrets', 'k.txt')}'` } })!, /pg-secrets/)
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
  assert.match(denied.reason!, /defaultAccess/)

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

  const guardResult = ctx.guards[0]!({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })
  assert.equal(typeof guardResult, 'string', 'the guard must return a reason, never throw')
  assert.match(guardResult!, /内部出错/)
  assert.ok(ctx.logs.some(([level]) => level === 'error'), 'the failure must be logged at error level')

  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'x.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason!, /内部出错/)
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
  assert.ok(ctx.pushed[0]!.title.includes('Path Guard'))
  assert.ok(ctx.pushed[0]!.message.length > 0)
})

// ---------------------------------------------------------------------------
// The tracked-tools route the client's trust editor reads
// ---------------------------------------------------------------------------

/**
 * Invoke one registered route with a fake response sink.
 * @param ctx - the fake context that captured the registrations.
 * @param path - the route path.
 * @param req - the request handed to the admission check.
 */
async function callRoute(ctx: PluginCtx & FakeCtxExtra, path: string, req: unknown = {}) {
  const route = ctx.routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} must be registered`)
  const res: FakeResponse = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
  await route.handler(req, res)
  return res
}

test('DSH bookkeeping tools are never path-judged, but third-party tools still are', async () => {
  // Reproduced live before this was written: a task list whose TEXT was a
  // protected path got refused, with the rule's own message, for a tool that
  // only writes a task list. `todo_write` never opens a file, so the refusal
  // protected nothing and broke the tool.
  const protectedPath = join(tmpdir(), 'pg-secrets', 'k.txt')
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })

  const todo = await preExecute(ctx, {
    name: 'todo_write',
    arguments: { todos: [{ content: protectedPath, status: 'pending' }] },
  })
  assert.equal(todo.kind, 'allow', 'a bookkeeping tool must not be judged by its prose')

  // Same for the rest of the verified table, through the two shapes that used to
  // trip the heuristic: a bare protected path and a covered path named in prose.
  for (const name of ['job_list', 'schedule_list', 'web_search', 'send_message', 'create_goal']) {
    const decision = await preExecute(ctx, { name, arguments: { query: protectedPath, prompt: protectedPath } })
    assert.equal(decision.kind, 'allow', `${name} touches no file and must not be refused`)
  }

  // NEGATIVE CONTROL. The fix is a verified per-tool table, NOT a blanket
  // exemption for anything that looks like an orchestration tool: an unmodelled
  // third-party tool naming the same path is still refused.
  const thirdParty = await preExecute(ctx, {
    name: 'notes_search',
    arguments: { query: protectedPath },
  })
  assert.equal(thirdParty.kind, 'deny', 'the table must not widen into a blanket exemption')

  // …and a covered path in the TOOL'S OWN path argument is still refused, which is
  // the behaviour the table must not weaken.
  const covered = await preExecute(ctx, { name: 'read', arguments: { file_path: protectedPath } })
  assert.equal(covered.kind, 'deny')
})

test('the tracked-tools route serves the tools this plugin has seen', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  assert.equal(ctx.routes.length, 1, 'exactly one route is mounted')
  assert.equal(ctx.routes[0]!.path, '/path-guard/tools')
  assert.equal(ctx.routes[0]!.kind, 'exact')

  // Nothing seen yet: the editor gets an empty suggestion list, not an error.
  const empty = await callRoute(ctx, '/path-guard/tools')
  assert.equal(empty.status, 200)
  const blank = JSON.parse(String(empty.body)) as { tools: string[]; lastUnmodelledAt: number | null; records: unknown[] }
  assert.deepEqual(
    { tools: blank.tools, lastUnmodelledAt: blank.lastUnmodelledAt },
    { tools: [], lastUnmodelledAt: null },
    'the legacy shape the client reads is unchanged',
  )
  assert.deepEqual(blank.records, [], 'the additive record view starts empty too')

  // Two unmodelled tools, seen through the normal path so the registration is
  // exercising the same code the running plugin does.
  const uncovered = { query: join(tmpdir(), 'pg-uncovered', 'k.txt') }
  const before = Date.now()
  await preExecute(ctx, { name: 'notes_search', arguments: uncovered })
  await preExecute(ctx, { name: 'acme_list', arguments: uncovered })

  const filled = await callRoute(ctx, '/path-guard/tools')
  assert.equal(filled.status, 200)
  assert.equal(filled.headers?.['cache-control'], 'no-store', 'runtime state must not be cached')
  const payload = JSON.parse(String(filled.body)) as { tools: string[]; lastUnmodelledAt: number | null }
  assert.deepEqual(payload.tools, ['acme_list', 'notes_search'], 'sorted, deduped, and only what was actually seen')
  // The client uses this timestamp to correct a click the peer lands on the wrong
  // bundle page (see `lastUnmodelledAt` in src/index.ts). It must be a real
  // sighting time, not something the route invents.
  assert.equal(typeof payload.lastUnmodelledAt, 'number', 'a sighting must be timestamped')
  assert.ok(
    payload.lastUnmodelledAt !== null && payload.lastUnmodelledAt >= before && payload.lastUnmodelledAt <= Date.now(),
    'the timestamp must come from the sighting itself',
  )

  // A tool whose arguments look like NOTHING must still be remembered. The editor
  // suggests from this list, and a list that only held tools which already
  // tripped a heuristic would be empty exactly when the user goes looking for
  // what to trust.
  const quiet = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(quiet, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  const benign = await preExecute(quiet, { name: 'acme_status', arguments: { format: 'json' } })
  assert.equal(benign.kind, 'allow')
  const listed = JSON.parse(String((await callRoute(quiet, '/path-guard/tools')).body)) as { tools: string[] }
  assert.deepEqual(listed.tools, ['acme_status'], 'a benign unmodelled tool is still offered for trust')
})

test('the tracked-tools route reveals nothing without admission', async () => {
  // The list is runtime state. An unauthenticated or cross-origin caller must not
  // learn the tool names, or even that the plugin is installed.
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => ({ rejection: 401 }) } } })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  await preExecute(ctx, {
    name: 'notes_search',
    arguments: { query: join(tmpdir(), 'pg-uncovered', 'k.txt') },
  })

  const res = await callRoute(ctx, '/path-guard/tools')
  assert.equal(res.status, 401)
  assert.ok(!String(res.body).includes('notes_search'), 'a rejected request learns no tool names')
})

test('no web server means no route, and the plugin still arms', async () => {
  // The endpoint is a convenience for the trust editor. A profile without a web
  // server (or without the connection fence) must lose only the suggestions —
  // declaring `webServer` in `inject` would park activation instead.
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  assert.deepEqual(ctx.routes, [], 'nothing is registered without a web server')
  // …and the guard still works, which is the part that matters.
  assert.match(
    ctx.guards[0]!({ name: 'pwsh', arguments: { command: `Get-Content '${join(tmpdir(), 'pg-secrets', 'k.txt')}'` } })!,
    /访问被拒绝/,
  )

  // A web server WITHOUT the admission fence must also skip: serving runtime
  // state with no way to authenticate the caller is worse than no suggestions.
  const unfenced = fakeCtx({ webServer: true })
  apply(unfenced, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  assert.deepEqual(unfenced.routes, [], 'no admission check, no route')
})

test('the first sighting of an unmodelled tool notifies once, naming the prefix to trust', async () => {
  const ctx = fakeCtx({ notifyService: {} })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })

  // A path-shaped argument no rule covers: the call is allowed, but the tool is
  // new to this plugin, so the user is told how to trust the whole plugin rather
  // than being left to guess a tool name they never saw.
  const probe = { name: 'notes_search', arguments: { query: join(tmpdir(), 'pg-uncovered', 'k.txt') } }
  assert.equal((await preExecute(ctx, probe)).kind, 'allow')
  assert.equal(ctx.pushed.length, 1, 'a first sighting notifies')
  assert.ok(ctx.pushed[0]!.message.includes('notes_*'), 'the suggestion must be the prefix form, not just the tool name')

  // Clicking leads to where the FIX lives: the sidebar's Plugins panel, not the
  // session. The peer requires an explicit `click` (no `click` ⇒ not clickable).
  assert.deepEqual(ctx.pushed[0]!.click, { type: 'page', page: 'plugins' })

  // Deliberately NOT session-gated. `push` silences a notification while the user
  // is looking at that very session, and this notice exists for exactly that
  // moment — the tool call that raised it happened in the session on screen. With
  // a `sessionId` this notification would essentially never be seen.
  assert.ok(!('sessionId' in ctx.pushed[0]!), 'the trust suggestion must not be session-gated')

  // Once per TOOL, not once per call: the registry's `notified` flag is the
  // dedup, so this can never turn into a stream of notifications.
  await preExecute(ctx, probe)
  await preExecute(ctx, { name: 'notes_search', arguments: { query: join(tmpdir(), 'pg-uncovered', 'other.txt') } })
  assert.equal(ctx.pushed.length, 1, 'the suggestion must not repeat for the same tool')

  // A second, different tool notifies in turn.
  await preExecute(ctx, { name: 'notes_list', arguments: { query: join(tmpdir(), 'pg-uncovered', 'k.txt') } })
  assert.equal(ctx.pushed.length, 2)

  // `notify: off` silences it, like every other notification.
  const off = fakeCtx({ notifyService: {} })
  apply(off, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false, notify: 'off' })
  await preExecute(off, { name: 'notes_status', arguments: { query: join(tmpdir(), 'pg-uncovered', 'k.txt') } })
  assert.equal(off.pushed.length, 0)
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
  exotic.guards[0]!({ name: 'run_code', arguments: { code: 'x' } })
  assert.equal(exotic.pushedAlways.length, 1)
  assert.match(exotic.pushedAlways[0]!.message, /run_code/)

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
  ctx.guards[0]!({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })
  // `malfunction` is throttled per extension point and rides the focus gate
  // (`push`), unlike `always: true` denials.
  assert.equal(ctx.pushed.length, 1)
  assert.match(ctx.pushed[0]!.title, /内部错误/)
  assert.equal(ctx.pushedAlways.length, 0)
})

// ---------------------------------------------------------------------------
// Regressions for the adversarial verification findings (reports/verification.md)
// ---------------------------------------------------------------------------

test('V-2: workflow is scanned as an opaque program, not refused outright', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', exoticTools: 'deny', selfProtection: false })
  const guard = ctx.guards[0]!
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')

  // A workflow that never mentions a protected path stays usable: refusing the
  // whole tool would cost a headline capability in every session, including the
  // ones that never touch a protected path.
  assert.equal(guard({ name: 'workflow', arguments: { script: 'return 1' } }), undefined)
  // The escape is still real (`node:vm` -> real `process`), so a script that
  // names a protected path is refused like a shell command.
  assert.match(guard({ name: 'workflow', arguments: { script: `readFileSync(${JSON.stringify(target)})` } })!, /访问被拒绝/)
  // Genuinely unobservable surfaces keep the hard refusal.
  assert.match(guard({ name: 'run_code', arguments: { code: 'x' } })!, /访问被拒绝/)
  assert.match(guard({ name: 'ralph', arguments: {} })!, /访问被拒绝/)
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
  assert.match(ctx.guards[0]!({ name: 'workflow', arguments: { script } })!, /访问被拒绝/)
})

test('V-1: only the output LINES that mention a protected path are withheld', async () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  const handler = ctx.listeners.get('tools/post-execute')![0]!
  const passthrough = { kind: 'accept' }
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')

  // Redaction is per LINE. Replacing the whole block meant one mention — often a
  // single path the command printed itself — took every unrelated line with it
  // and left the tool result useless for anything else.
  const leaked = await handler(
    { name: 'pwsh', arguments: {} },
    { isError: false, content: [{ type: 'text', text: `HARMLESS-LINE-1\n${target}\nHARMLESS-LINE-2` }] },
    async () => passthrough,
  ) as PostDecision
  assert.equal(leaked.kind, 'accept')
  const rendered = JSON.stringify(leaked.content)
  assert.ok(!rendered.includes(target), 'the protected path must not survive')
  assert.ok(rendered.includes('HARMLESS-LINE-1'), 'an unrelated line BEFORE the hit must survive')
  assert.ok(rendered.includes('HARMLESS-LINE-2'), 'an unrelated line AFTER the hit must survive')
  assert.ok(rendered.includes('已扣留'), 'the withheld line is replaced by a visible marker')

  // The marker must not quote the path it withheld: the needle IS the path.
  assert.ok(!rendered.includes('pg-secrets'), 'the marker must not leak the path it withheld')

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
  assert.match(ctx.guards[0]!({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } })!, /访问被拒绝/)

  const lax = fakeCtx()
  apply(lax, { enabled: true, rules: [], defaultAccess: 'allow', shell: 'scan', selfProtection: false })
  assert.equal(lax.guards[0]!({ name: 'pwsh', arguments: { command: 'Get-ChildItem .' } }), undefined)
})

test('V-4: only the tiers that FORBID reading become shell-scan needles', () => {
  const base = join(tmpdir(), 'pg-tiers')
  const ctx = fakeCtx()
  apply(ctx, {
    enabled: true,
    defaultAccess: 'allow',
    shell: 'scan',
    selfProtection: false,
    rules: [
      { path: join(base, 'none'), access: 'none', note: '' },
      { path: join(base, 'list'), access: 'list', note: '' },
      { path: join(base, 'read'), access: 'read', note: '' },
      { path: join(base, 'write'), access: 'write', note: '' },
    ],
  })
  const guard = ctx.guards[0]!
  const refuses = (name: string) =>
    guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(base, name)}'` } }) !== undefined

  assert.equal(refuses('none'), true, '`none` hides even the names, so a mention is a violation')
  assert.equal(refuses('list'), true, '`list` shows names but not contents, so reading is still a violation')

  // The regression this pins. `read` GRANTS reading, and the scanner cannot tell a
  // read from a write inside an opaque command string, so treating a mention as a
  // violation denied exactly what the rule allows: `read` on the profile's
  // package.json returned the whole file while `pwsh` printing that same path lost
  // its entire output. This also covers the self-protection rules, which are
  // `read` tier on purpose.
  assert.equal(refuses('read'), false, '`read` grants reading -> a mention is legitimate')

  // `write` already granted everything under the old filter; it stays out.
  assert.equal(refuses('write'), false, '`write` grants everything -> a mention is legitimate')

  // `allow` is an exemption, and the OLD test was a subtraction
  // (`access !== 'write'`), so had an `allow` value reached the rule list it would
  // have become a needle — exempting a path would have made the plugin reach
  // FURTHER. It cannot arrive through the schema (`rule.access` unions
  // none/list/read/write; only `defaultAccess` accepts `allow`), which is exactly
  // why the filter is now an explicit allow-list of forbidding tiers rather than a
  // subtraction that assumes what the rest of the values mean.
  assert.equal(
    guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(base, 'allow')}'` } }),
    undefined,
  )
})

test('V-7: a malformed rule list fails closed instead of silently disabling the policy', async () => {
  const ctx = fakeCtx()
  const broken = Object.freeze({ get: () => 'not-an-array', [VOLATILE_WRITE]: () => {} })
  apply(ctx, { enabled: ref(true), rules: broken, defaultAccess: ref('allow'), selfProtection: ref(false) })
  const decision = await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'x.txt') } })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason!, /内部出错/)
})

test('trust reaches every judgement, not just the unmodelled branch', async () => {
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')
  const ctx = fakeCtx()
  apply(ctx, {
    enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false,
    exoticTools: 'deny',
    trustedTools: [{ match: 'pwsh', note: '' }, { match: 'read', note: '' }],
  })

  // 1. The synchronous guard, which owns BOTH the shell scan and
  //    `exoticTools: deny`. Consulting the trust table only in the unmodelled
  //    branch (as an earlier version did) left `trustedTools: ['pwsh']` accepted
  //    and completely inert: the config promised a skip that never happened, and
  //    the user's shell output was still withheld while the page said otherwise.
  assert.equal(
    ctx.guards[0]!({ name: 'pwsh', arguments: { command: `Get-Content '${target}'` } }),
    undefined,
    'a trusted shell tool is not scanned',
  )

  // 2. Path judgement.
  assert.equal(
    (await preExecute(ctx, { name: 'read', arguments: { file_path: target } })).kind,
    'allow',
    'a trusted tool is not path-judged',
  )
  // Negative control: the same call through an UNTRUSTED modelled tool is denied,
  // so the assertion above is measuring trust and not a broken fixture.
  assert.equal(
    (await preExecute(ctx, { name: 'write', arguments: { file_path: target, content: '' } })).kind,
    'deny',
  )

  // 3. The L4 output filter. This is the half that silently did nothing.
  const handler = ctx.listeners.get('tools/post-execute')![0]!
  const passthrough = { kind: 'accept' }
  assert.equal(
    await handler(
      { name: 'pwsh', arguments: {} },
      { isError: false, content: [{ type: 'text', text: `line with ${target} in it` }] },
      async () => passthrough,
    ),
    passthrough,
    'a trusted tool skips the output filter too',
  )
})

test('a trusted tool is judged before the policy, so a broken config cannot deny it', async () => {
  // The fail-closed path asks `governs()`, which judges by NAME SHAPE —
  // `PATH_NAME_TOKENS` contains `files`, so `notes_files` looks filesystem-ish and
  // a plugin bug used to deny it even when the whole prefix was trusted. Making
  // `governs()` trust-aware is the guarantee; this test pins its reachable half.
  const target = join(tmpdir(), 'pg-secrets', 'k.txt')
  const broken = Object.freeze({ get: () => 'not-an-array', [VOLATILE_WRITE]: () => {} })

  const trusted = fakeCtx()
  apply(trusted, {
    enabled: true, rules: broken, defaultAccess: 'allow', selfProtection: false,
    trustedTools: [{ match: 'notes_*', note: '' }],
  })
  assert.equal(
    (await preExecute(trusted, { name: 'notes_files', arguments: { path: target } })).kind,
    'allow',
    'trust short-circuits before the policy is read, so the broken config cannot fail it closed',
  )

  // The same call, untrusted, DOES fail closed — which is the correct behaviour
  // for a tool this plugin governs.
  const untrusted = fakeCtx()
  apply(untrusted, { enabled: true, rules: broken, defaultAccess: 'allow', selfProtection: false })
  assert.equal(
    (await preExecute(untrusted, { name: 'notes_files', arguments: { path: target } })).kind,
    'deny',
  )
})

test('trust silences the shell/script/exotic legs of governs — but never plugin_manager', () => {
  // The residual this pins. `governs` used to read
  //     !isTrustedTool(n) && isGoverned(n)
  //       || SHELL_TOOLS.has(n) || isScriptTool(n) || isExoticTool(n) || n === 'plugin_manager'
  // and `&&` binds tighter than `||`, so it parsed as
  //     (!trusted && isGoverned) || SHELL || SCRIPT || EXOTIC || plugin_manager
  // Trust therefore suppressed ONLY the name-shape leg: a trusted `pwsh`,
  // `workflow` or `mcp__*` still hit its own leg and was failed closed when this
  // plugin had an internal error — the exact opposite of what `governs`'s own
  // comment promises ("a bug of ours must not take it away").
  const boom = Object.freeze({
    get: () => {
      throw new Error('boom')
    },
    [VOLATILE_WRITE]: () => {},
  })

  // A trusted tool of each affected leg survives an internal error.
  for (const name of ['pwsh', 'workflow', 'mcp__fs__read_file']) {
    const ctx = fakeCtx()
    apply(ctx, {
      enabled: boom, rules: [], defaultAccess: 'allow', selfProtection: true,
      trustedTools: [{ match: name, note: '' }],
    })
    assert.equal(
      ctx.guards[0]!({ name, arguments: { command: 'x' } }),
      undefined,
      `a trusted ${name} must not be failed closed by our own bug`,
    )
  }

  // …and the SAME call without trust still fails closed, so the assertion above
  // measures trust rather than a guard that stopped working.
  for (const name of ['pwsh', 'workflow', 'mcp__fs__read_file']) {
    const ctx = fakeCtx()
    apply(ctx, { enabled: boom, rules: [], defaultAccess: 'allow', selfProtection: true })
    assert.match(
      String(ctx.guards[0]!({ name, arguments: { command: 'x' } })),
      /出错/,
      `an untrusted ${name} must still fail closed`,
    )
  }

  // THE EXCEPTION. Self-protection outranks trust (V-11), and that has to hold in
  // BOTH directions: here it means a trusted `plugin_manager` stays this plugin's
  // business, so an internal error fails closed on it instead of letting the
  // composition change slip through on a bug.
  const selfCtx = fakeCtx()
  apply(selfCtx, {
    enabled: boom, rules: [], defaultAccess: 'allow', selfProtection: true,
    trustedTools: [{ match: 'plugin_manager', note: '' }],
  })
  assert.match(
    String(selfCtx.guards[0]!({ name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'x' } })),
    /出错/,
    'trusting plugin_manager must not make self-protection fail OPEN on an internal error',
  )
})

test('V-11: a trusted tool cannot switch off self-protection', () => {
  // Trust is a statement about a tool's FILE ACCESS. Letting it defeat the guard's
  // own integrity would mean one config line hands the AI the ability to disable
  // the plugin, so self-protection deliberately outranks trust.
  const ctx = fakeCtx({ services: { profileContext: { patchPath: join(tmpdir(), 'pg-profile3', 'cordis.patch.yml') } } })
  apply(ctx, {
    enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true,
    trustedTools: [{ match: 'plugin_manager', note: '' }, { match: 'pwsh', note: '' }],
  })
  assert.match(
    ctx.guards[0]!({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'dsh-path-guard' } })!,
    /自我保护/,
    'trusting plugin_manager must not unlock the composition',
  )
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
  assert.equal(ctx.guards[0]!({ name: 'todo_write', arguments: {} }), undefined)
  // Governed calls still fail closed.
  assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: 'x' } })).kind, 'deny')
})

// Regression: the unmodelled-tool branch used to hand back a bare STRING while
// the caller read `hit.reason`, so the refusal rendered as the literal text
// `reason: "undefined"` — the model saw a denial with no explanation. Locking the
// user-visible wording down (not just the deny/allow verdict) is the point here.
test('V-8: an unmodelled tool is judged by the paths it names, not by shape alone', async () => {
  // Default `unknownTools: 'check'`. A path-shaped argument that NO rule covers
  // must stay allowed. Blanket refusal on shape was a real false positive in the
  // live profile: `notes_search` takes a natural-language query that is often a
  // file path, and refusing a memory lookup protects nothing.
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  const uncovered = await preExecute(ctx, {
    name: 'third_party_tool',
    arguments: { file_path: join(tmpdir(), 'pg-uncovered', 'k.txt') },
  })
  assert.equal(uncovered.kind, 'allow', 'a path no rule covers must not be refused')

  // A path a rule DOES cover is still refused — with the rule's own reason.
  const guarded = fakeCtx()
  apply(guarded, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const covered = await preExecute(guarded, {
    name: 'third_party_tool',
    arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') },
  })
  assert.equal(covered.kind, 'deny', 'a covered path must be refused even for an unmodelled tool')

  // `unknownTools: 'deny'` restores the strict posture, and its reason must be a
  // real string naming the tool — never the literal `undefined`.
  const strict = fakeCtx()
  apply(strict, {
    enabled: true, rules: [], defaultAccess: 'allow', unknownTools: 'deny', selfProtection: false,
  })
  const denied = await preExecute(strict, {
    name: 'third_party_tool',
    arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') },
  })
  assert.equal(denied.kind, 'deny')
  const reason = denied.reason
  assert.equal(typeof reason, 'string', 'the denial must carry a string reason')
  assert.ok(reason !== undefined && reason.length > 0, 'the reason must not be empty')
  assert.ok(reason.includes('third_party_tool'), 'the reason must name the refused tool')
  assert.notEqual(reason, 'undefined', 'the reason must never render as the literal "undefined"')
  assert.ok(!/\bundefined\b/.test(reason), 'the reason text must not contain the word "undefined" anywhere')

  // A string argument that is not path-shaped must stay allowed: the rule keys off
  // the VALUE shape, not the parameter name.
  const benign = await preExecute(strict, { name: 'third_party_tool', arguments: { query: 'asc' } })
  assert.equal(benign.kind, 'allow')
})

test('the reported false positive stays fixed: notes_search with a path-shaped query', async () => {
  // The exact live case. `notes_search` reads the memory store — it never touches
  // the filesystem — but its `query` is natural language and often IS a file
  // path. Under blanket fail-closed the whole memory lookup was refused:
  //
  //   访问被拒绝：工具 `notes_search` 不在 dsh-path-guard 的已知工具表里，
  //   而它的参数里出现了路径形态的取值。
  //
  // No rule covers the query, so there is nothing to protect and nothing to
  // refuse. This test pins that, because the failure mode was user-visible and
  // the denial was indistinguishable from a real policy decision.
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  const decision = await preExecute(ctx, {
    name: 'notes_search',
    arguments: { query: 'D:/Program/dsh-path-guard/src/index.ts', limit: 2 },
  })
  assert.equal(decision.kind, 'allow', 'a memory lookup naming an uncovered path must not be refused')

  // Same tool, a query that DOES name a protected path: now it is refused, and by
  // the rule rather than by the tool's name.
  const guarded = await preExecute(ctx, {
    name: 'notes_search',
    arguments: { query: join(tmpdir(), 'pg-secrets', 'k.txt') },
  })
  assert.equal(guarded.kind, 'deny', 'a query naming a protected path must be refused')
})

test('trustedTools skips the plugin entirely, by exact name or by prefix', async () => {
  const probe = { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') }

  const exact = fakeCtx()
  apply(exact, {
    enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false,
    trustedTools: [{ match: 'notes_search', note: '' }],
  })
  assert.equal((await preExecute(exact, { name: 'notes_search', arguments: probe })).kind, 'allow')
  // The exact entry trusts only that tool.
  assert.equal((await preExecute(exact, { name: 'notes_save', arguments: probe })).kind, 'deny')

  // The prefix form trusts a whole plugin's tool set — including tools that
  // plugin has not shipped yet. That is the point: a per-tool list rots, and a
  // plugin's tool list changes between versions.
  const prefix = fakeCtx()
  apply(prefix, {
    enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false,
    trustedTools: [{ match: 'notes_*', note: '' }],
  })
  for (const name of ['notes_search', 'notes_save', 'notes_a_tool_from_a_future_version']) {
    const decision = await preExecute(prefix, { name, arguments: probe })
    assert.equal(decision.kind, 'allow', `${name} must be trusted by the notes_* prefix`)
  }
  // A different prefix stays governed: trust is scoped, not global.
  assert.equal((await preExecute(prefix, { name: 'other_tool', arguments: probe })).kind, 'deny')

  // An empty or malformed entry must never widen trust.
  const malformed = fakeCtx()
  apply(malformed, {
    enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false,
    trustedTools: [{ match: '', note: '' }, null, { note: 'no match field' }],
  })
  assert.equal((await preExecute(malformed, { name: 'other_tool', arguments: probe })).kind, 'deny')
})

// ---------------------------------------------------------------------------
// tool tracking: continuous detection, self-learning, family, persistence
// ---------------------------------------------------------------------------

/** One record as the tracked-tools route reports it. */
interface TrackedRecord {
  name: string
  firstSeenAt: number
  lastSeenAt: number
  seen: number
  refused: number
  fields: string[]
  capabilities?: Record<string, string>
  notified?: boolean
}

/** Read the additive `records` view off the tracked-tools route. */
async function trackedRecords(ctx: PluginCtx & FakeCtxExtra): Promise<TrackedRecord[]> {
  const body = JSON.parse(String((await callRoute(ctx, '/path-guard/tools')).body)) as { records?: TrackedRecord[] }
  return body.records ?? []
}

test('the registry counts every sighting and reports it on the tracked-tools route', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })

  const uncovered = join(tmpdir(), 'pg-uncovered', 'k.txt')
  await preExecute(ctx, { name: 'notes_search', arguments: { query: uncovered } })
  await preExecute(ctx, { name: 'notes_search', arguments: { query: join(tmpdir(), 'pg-uncovered', 'other.txt') } })

  const records = await trackedRecords(ctx)
  assert.equal(records.length, 1)
  const record = records[0]!
  assert.equal(record.name, 'notes_search')
  assert.equal(record.seen, 2, 'continuous detection counts every call, not just the first')
  assert.ok(record.lastSeenAt >= record.firstSeenAt)
  assert.equal(record.refused, 0)
  assert.deepEqual(record.fields, [], 'nothing has been refused yet')
  assert.equal(record.notified, true, 'the first sighting told the user')

  // The legacy view the client reads is unchanged by any of this.
  const payload = JSON.parse(String((await callRoute(ctx, '/path-guard/tools')).body)) as { tools: string[] }
  assert.deepEqual(payload.tools, ['notes_search'])
})

test('a refusal teaches the field, and the next call is judged by NAME', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  // `defaultAccess: none` is what makes the difference visible: the learned
  // field makes the value CHECKABLE, and every checkable path is refused here.
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })

  // 1. A path-shaped value under a rule-covered path: refused, and the field
  //    that carried it is learned.
  const covered = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.equal((await preExecute(ctx, { name: 'notes_read', arguments: { file_path: covered } })).kind, 'deny')
  const record = (await trackedRecords(ctx)).find(entry => entry.name === 'notes_read')
  assert.deepEqual(record?.fields, ['file_path'], 'the refused field is remembered')
  assert.equal(record?.refused, 1)

  // 2. The SAME tool with a value that looks like nothing at all is now refused:
  //    a learned field is judged by name instead of by value shape.
  const second = await preExecute(ctx, { name: 'notes_read', arguments: { file_path: 'notes' } })
  assert.equal(second.kind, 'deny', 'the learned field is judged by name')

  // CONTROL: another tool that was never refused is still only NOTED, so the
  // denial above really is the learned knowledge and not `defaultAccess`.
  const control = fakeCtx()
  apply(control, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })
  assert.equal((await preExecute(control, { name: 'acme_read', arguments: { file_path: 'notes' } })).kind, 'allow')
})

test('one refusal generalizes to the already-tracked tools of the same family', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })

  // The sibling is tracked FIRST: family knowledge is stamped onto the tools
  // that are already in the registry when the refusal happens.
  assert.equal((await preExecute(ctx, { name: 'mcp__fs__stat', arguments: { format: 'json' } })).kind, 'allow')

  const covered = join(tmpdir(), 'pg-secrets', 'k.txt')
  assert.equal((await preExecute(ctx, { name: 'mcp__fs__read_file', arguments: { path: covered } })).kind, 'deny')

  const sibling = (await trackedRecords(ctx)).find(entry => entry.name === 'mcp__fs__stat')
  assert.deepEqual(sibling?.fields, ['path'], 'the sibling inherited the learned field')
  assert.equal(sibling?.refused, 0, 'inheriting is not being refused')

  const inherited = await preExecute(ctx, { name: 'mcp__fs__stat', arguments: { path: 'notes' } })
  assert.equal(inherited.kind, 'deny', 'the sibling is now judged by the inherited field name')

  // A different MCP server is a different family and stays unaffected.
  const other = await preExecute(ctx, { name: 'mcp__git__status', arguments: { path: 'notes' } })
  assert.equal(other.kind, 'allow')
})

test('the registry persists into the profile directory and survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-track-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    const covered = join(tmpdir(), 'pg-secrets', 'k.txt')
    const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
    apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })
    assert.equal((await preExecute(ctx, { name: 'notes_read', arguments: { file_path: covered } })).kind, 'deny')

    const file = join(dir, 'path-guard-tools.json')
    await waitFor(() => existsSync(file))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; records: TrackedRecord[] }
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.records.find(entry => entry.name === 'notes_read')?.fields, ['file_path'])

    // A fresh activation is what a restart looks like: it must read the file
    // back and keep judging by the learned field, with no new refusal in this
    // process to teach it again.
    const restarted = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
    apply(restarted, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })
    const learned = await preExecute(restarted, { name: 'notes_read', arguments: { file_path: 'notes' } })
    assert.equal(learned.kind, 'deny', 'the learned field came back from disk')
    assert.equal(
      (await trackedRecords(restarted))[0]?.seen,
      2,
      'one sighting was loaded from the file, and the call above added the second',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('unreadable tracking state costs the convenience, never the guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-track-bad-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    // Garbage in the file must not stop activation, and must not throw.
    writeFileSync(join(dir, 'path-guard-tools.json'), '{ this is not json')
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false }))
    assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })).kind, 'deny')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

/** Run `body` with `DSH_PROFILE_DIR` pointed at a fresh temporary directory. */
async function withProfileDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pg-track-fix-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    return await body(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

// ---------------------------------------------------------------------------
// R1: the tracking file is AI-writable state the plugin trusts — it must not be
// ---------------------------------------------------------------------------

test('R1a: self-protection refuses writes to the tracking file, and allows reads', async () => {
  await withProfileDir(async dir => {
    const ctx = fakeCtx()
    apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: true })
    const file = join(dir, 'path-guard-tools.json')
    // Readable on purpose: the `read` tier is what the other profile files get,
    // and the AI may legitimately want to see what it has been accused of.
    assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: file } })).kind, 'allow')
    assert.equal(
      (await preExecute(ctx, { name: 'write', arguments: { file_path: file, content: '{}' } })).kind,
      'deny',
      'the agent must not be able to author its own tracking file',
    )
    assert.equal(
      (await preExecute(ctx, { name: 'edit', arguments: { file_path: file, old_string: 'a', new_string: 'b' } })).kind,
      'deny',
    )
    // The rest of the profile set keeps working (no regression in the rule list).
    assert.equal(
      (await preExecute(ctx, { name: 'write', arguments: { file_path: join(dir, 'cordis.patch.yml'), content: '' } })).kind,
      'deny',
    )
  })
})

test('R1b: a pre-seeded weak capability cannot downgrade a refusal into an allow', async () => {
  await withProfileDir(async dir => {
    // The audit's X8c, verbatim: `{'path':'list'}` under a `list`-tier rule made
    // a read the rules refuse come back as ALLOW.
    const secret = join(dir, 'pg-secrets')
    writeFileSync(join(dir, 'path-guard-tools.json'), JSON.stringify({
      version: 1,
      records: [{
        name: 'mcp__acme__read',
        seen: 5,
        refused: 1,
        fields: ['path'],
        capabilities: { path: 'list' },
        notified: true,
      }],
    }))
    const ctx = fakeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{ id: 'sec', path: secret, access: 'list', note: '' }],
      defaultAccess: 'allow',
      selfProtection: false,
    })
    const decision = await preExecute(ctx, { name: 'mcp__acme__read', arguments: { path: join(secret, 'k.txt') } })
    assert.equal(decision.kind, 'deny', 'a learned field needs WRITE, so a list-tier rule cannot permit it')
  })
})

test('R1c: a notification bit with no sighting behind it cannot silence the notice', async () => {
  await withProfileDir(async dir => {
    const file = join(dir, 'path-guard-tools.json')
    const probe = { name: 'notes_search', arguments: { query: join(tmpdir(), 'pg-uncovered', 'k.txt') } }

    // Hand-written, no observation evidence: the gate drops the bit.
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ name: 'notes_search', notified: true }] }))
    const forged = fakeCtx({ notifyService: {} })
    apply(forged, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
    await preExecute(forged, probe)
    assert.equal(forged.pushed.length, 1, 'the first-sighting notice must still fire')

    // The organic case still holds: a record with a real sighting keeps its bit.
    writeFileSync(file, JSON.stringify({
      version: 1,
      records: [{ name: 'notes_search', seen: 1, lastSeenAt: Date.now(), notified: true }],
    }))
    const organic = fakeCtx({ notifyService: {} })
    apply(organic, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
    await preExecute(organic, probe)
    assert.equal(organic.pushed.length, 0, 'a tool the user was already told about stays quiet')
  })
})

// ---------------------------------------------------------------------------
// R3: the dedup survives eviction, so a loop of tool names cannot re-notify
// ---------------------------------------------------------------------------

test('R3: the notice stays once per tool even after 200+ other tools evict it', async () => {
  const ctx = fakeCtx({ notifyService: {} })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'allow', selfProtection: false })
  const probe = { query: join(tmpdir(), 'pg-uncovered', 'k.txt') }
  const total = TRACKED_TOOLS_MAX + 30
  for (let index = 0; index < total; index += 1) {
    await preExecute(ctx, { name: `acme_tool_${index}`, arguments: probe })
  }
  assert.equal(ctx.pushed.length, total, 'every new tool is announced once')
  // The first tool's RECORD is long gone; its dedup bit is not.
  await preExecute(ctx, { name: 'acme_tool_0', arguments: probe })
  assert.equal(ctx.pushed.length, total, 'an evicted tool must not be announced again')
})

// ---------------------------------------------------------------------------
// R4: family is a name convention — but resource-free tools never enter at all
// ---------------------------------------------------------------------------

test('R4: tools verified to touch no file never enter the registry', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'allow', selfProtection: false })
  // `list_agents` shares the `list_` prefix with other DSH tools, and `todo_write`
  // takes prose that can contain a path — both are resource-free by table, so
  // neither may be tracked, and neither may be family-joined with anything.
  for (const toolName of ['list_agents', 'todo_write', 'web_search', 'team_task_list']) {
    const decision = await preExecute(ctx, { name: toolName, arguments: { query: join(tmpdir(), 'pg-secrets', 'k.txt') } })
    assert.equal(decision.kind, 'allow', toolName)
  }
  assert.deepEqual(await trackedRecords(ctx), [], 'the registry stays empty for resource-free tools')
})

test('R4: malformed MCP names neither generalize nor inherit', async () => {
  const ctx = fakeCtx({ webServer: true, services: { connection: { admit: () => undefined } } })
  apply(ctx, { enabled: true, rules: [], defaultAccess: 'none', selfProtection: false })
  // Both are malformed (`mcp__` with no server), so they are NOT siblings of each
  // other even though a naive prefix rule would join them.
  await preExecute(ctx, { name: 'mcp__read_file', arguments: { path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
  assert.equal(
    (await preExecute(ctx, { name: 'mcp__stat_file', arguments: { path: 'plain-name' } })).kind,
    'allow',
    'a malformed MCP name must not inherit a sibling\'s learning',
  )
})

// ---------------------------------------------------------------------------
// R5: the write is atomic
// ---------------------------------------------------------------------------

test('R5: the registry write leaves a complete file and no temporary behind', async () => {
  await withProfileDir(async dir => {
    const ctx = fakeCtx()
    apply(ctx, { enabled: true, rules: RULES, defaultAccess: 'none', selfProtection: false })
    await preExecute(ctx, { name: 'notes_read', arguments: { file_path: join(tmpdir(), 'pg-secrets', 'k.txt') } })
    const file = join(dir, 'path-guard-tools.json')
    await waitFor(() => existsSync(file))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown[] }
    assert.equal(Array.isArray(parsed.records), true, 'the file is always complete JSON')
    assert.deepEqual(
      readdirSync(dir).filter(entry => entry.includes('.tmp')),
      [],
      'the rename consumes the temporary file',
    )
  })
})

// ---------------------------------------------------------------------------
// E1: the needle cache — hits are reused, and every real change invalidates
// ---------------------------------------------------------------------------

test('E1: needles are reused while the rule snapshot is unchanged', () => {
  const secretA = join(tmpdir(), 'pg-cache-a')
  const secretB = join(tmpdir(), 'pg-cache-b')
  const config = {
    enabled: true,
    rules: [{ id: 'a', path: secretA, access: 'none', note: '' }],
    defaultAccess: 'allow',
    selfProtection: false,
    shell: 'scan',
  }
  const ctx = fakeCtx()
  apply(ctx, config)
  const guard = ctx.guards[0]!
  assert.match(guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(secretA, 'k.txt')}'` } })!, /访问被拒绝/)

  // CACHE HIT, observed through the contract: the memo is keyed on the rule
  // snapshot's IDENTITY (exactly like `policy()`), and an in-place mutation is
  // not a supported update — the volatile protocol replaces the snapshot. If the
  // needles were rebuilt per call, the mutated rule would already be in force.
  config.rules[0]!.path = secretB
  assert.equal(
    guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(secretB, 'k.txt')}'` } }),
    undefined,
    'the cached needles are reused while the snapshot identity is unchanged',
  )

  // INVALIDATION: replacing the snapshot is what a settings save does.
  config.rules = [{ id: 'b', path: secretB, access: 'none', note: '' }]
  assert.match(guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(secretB, 'k.txt')}'` } })!, /访问被拒绝/)
  assert.equal(
    guard({ name: 'pwsh', arguments: { command: `Get-Content '${join(secretA, 'k.txt')}'` } }),
    undefined,
    'and the old needle is gone',
  )
})

test('E1: the session workspace is part of the cache key', () => {
  const one = join(tmpdir(), 'pg-ws-one')
  const two = join(tmpdir(), 'pg-ws-two')
  const ctx = fakeCtx()
  apply(ctx, {
    enabled: true,
    rules: [{ id: 'w', path: '${workspace}/secret', access: 'none', note: '' }],
    defaultAccess: 'allow',
    selfProtection: false,
    shell: 'scan',
  })
  const guard = ctx.guards[0]!
  const probe = (workspace: string) => ({
    name: 'pwsh',
    arguments: { command: `Get-Content '${join(workspace, 'secret', 'k.txt')}'` },
    agent: { session: { header: { cwd: workspace } } },
  })
  assert.match(guard(probe(one))!, /访问被拒绝/)
  // A stale cache that ignored the workspace would let the second session read
  // its own protected path.
  assert.match(guard(probe(two))!, /访问被拒绝/, 'each session is judged with its own needles')
  assert.match(guard(probe(one))!, /访问被拒绝/)
})
