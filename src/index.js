/**
 * dsh-path-guard — host half.
 *
 * Enforces a per-path access policy on model-driven tool calls, independently
 * of the DSH file sandbox, so it still applies under `danger-full-access`
 * (where `packages/fs/fs-sandbox/src/index.ts:5-8,125` deliberately fences
 * nothing, and reads are never fenced in any mode).
 *
 * Design constraints this file honours:
 *
 * 1. **No service takeover, no row override.** The plugin only inserts its own
 *    row and attaches to existing extension points. Unloading it restores the
 *    previous behaviour exactly.
 * 2. **`tools/pre-execute` is the authority on paths, not `ctx.tools.guard()`.**
 *    `ToolGuard` is synchronous by type (packages/core/tools/src/index.ts:731)
 *    while `FileSystem.resolve` returns a Promise, and only a resolved path is
 *    symlink-safe: `FsTarget.targetKey` is documented opaque and must not be
 *    parsed (packages/fs/fs/src/types.ts:11-15). A workspace symlink pointing
 *    into `~/.ssh` defeats any purely lexical check.
 * 3. **The guard handles only what is unambiguous without I/O** — surfaces the
 *    plugin refuses by name, and `plugin_manager` actions aimed at itself.
 * 4. **Result redaction rewrites the structured `value`, not rendered text.**
 *    See the ordering note at the post-execute registration.
 * 5. **Configuration is read through the volatile protocol on every decision.**
 *    A schemastery `.volatile()` field resolves to a frozen `{ get() }`
 *    reference, not a plain value (vendor/cosmokit/src/volatile.ts:39-45), and
 *    that reference is updated in place when the user saves the settings page.
 *    Capturing `config.rules` once at activation would therefore pin the policy
 *    to whatever existed at boot, and treating it as an array throws.
 *
 * @module dsh-path-guard
 */

import os from 'node:os'
import { join } from 'node:path'

import { Config } from './config.js'
import { capabilities, compile, expandPath, match } from './policy.js'
import {
  isRecognizedGlobValue,
  isRecognizedGrepValue,
  redactGlobValue,
  redactGrepValue,
} from './redact.js'
import { PATH_TOOLS, SHELL_TOOLS, collectPaths, isExoticTool, opForCommand } from './tool-fields.js'
import {
  denialText,
  exoticDenialText,
  internalErrorText,
  redactionBlockedText,
  selfDenialText,
  shellDenialText,
} from './deny.js'
import { buildNeedles, commandOf, redactTextBlocks, scanCommand } from './scan.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'path-guard'

/** Services this plugin needs: the tool registry and the resolved-path source. */
export const inject = ['tools', 'fs']

export { Config }

/** The cross-copy volatile marker (vendor/cosmokit/src/volatile.ts:3,52-54). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** This bundle's row id in the profile patch, also its settings namespace. */
const SELF_ROW_ID = 'path-guard'

/**
 * `plugin_manager` actions that change the profile composition.
 *
 * Self-protection refuses ALL of them, not just the ones naming this plugin.
 * The earlier "deny only self-targeting targets" rule matched the `target`
 * string against this bundle's names, which is bypassable: the model can copy
 * this package elsewhere and `install_bundle` that path — the target contains
 * neither name, yet the copy declares the same row id and overrides the row.
 * A `target` string is not a safe identity for "which row does this affect", so
 * the only sound rule is to keep the tool read-only while protection is on.
 * Turning `selfProtection` off restores full management.
 */
const COMPOSITION_CHANGING_ACTIONS = new Set([
  'set_plugin',
  'set_bundle',
  'install_bundle',
  'remove_bundle',
  'set_version_exemption',
])

/** Profile composition files the AI may read but must not rewrite. */
const PROFILE_FILES = ['cordis.patch.yml', 'cordis.yml', 'package.json']

/** Capability ordering; a lower rank is stricter. */
const RANK = { none: 0, list: 1, read: 2, write: 3 }

/** Wording for the operation a denied call was attempting. */
const REQUIRED_TEXT = {
  list: '列目录 / 查看文件名与目录结构',
  read: '读取文件内容',
  write: '写入或修改文件',
}

/** Schema defaults, repeated here so direct construction (tests) behaves like the Loader. */
const DEFAULTS = {
  enabled: true,
  defaultAccess: 'allow',
  rules: [],
  searchRedaction: true,
  shell: 'scan',
  exoticTools: 'deny',
  selfProtection: true,
}

/** Stable empty rule list, so the compiled-policy cache key keeps its identity. */
const NO_RULES = Object.freeze([])

/**
 * Read a schemastery volatile reference, which is a frozen `{ get() }` object.
 * Plain values pass through, so tests and direct construction behave the same.
 * @param {unknown} value - a resolved config field or a plain value.
 * @returns {unknown} the current snapshot.
 */
export function unwrap(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * Keep the stricter of two decisions, treating `undefined` as "no opinion".
 * @param {{access: string} | undefined} a - first decision.
 * @param {{access: string} | undefined} b - second decision.
 * @returns {{access: string} | undefined} the stricter decision.
 */
function strictest(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  return RANK[a.access] <= RANK[b.access] ? a : b
}

/**
 * Whether a decision permits an operation.
 * @param {{access: string} | undefined} decision - the policy decision, if any.
 * @param {string} required - the operation the call performs (`list`/`read`/`write`).
 * @returns {boolean} true when the call may proceed.
 */
function permits(decision, required) {
  if (decision === undefined || decision.access === 'allow') return true
  return capabilities(decision.access)[required] === true
}

/**
 * Register the policy enforcement points.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} config - the row config, volatile fields still wrapped.
 */
export function apply(ctx, config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const home = os.homedir()
  const windows = process.platform === 'win32'
  const profileDir = process.env.DSH_PROFILE_DIR

  /**
   * Read one config field through the volatile protocol, falling back to the
   * schema default. Called per decision, never captured at activation.
   * @param {keyof typeof DEFAULTS} key - the field name.
   * @returns {unknown} the current value.
   */
  const read = (key) => {
    const value = unwrap(raw[key])
    return value === undefined || value === null ? DEFAULTS[key] : value
  }

  /**
   * The configured rule list.
   *
   * A `rules` value that is present but not an array is configuration-shape
   * drift, NOT "no rules". Folding it to `[]` would silently turn the policy off
   * (fail-OPEN) while the plugin still reports itself armed, so it is raised
   * instead and the interceptors' catch turns it into a loud refusal.
   * @returns {Array<object>} the configured rules.
   * @throws {TypeError} when the value is present and not an array.
   */
  const rulesOf = () => {
    const value = read('rules')
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      throw new TypeError(`path-guard: config.rules must be an array, received ${typeof value}`)
    }
    return value
  }

  /** Implicit rules that keep the AI from editing the composition carrying this policy. */
  const selfRulesFor = () => (read('selfProtection') === true ? selfRules : NO_RULES)

  /**
   * Rules that generate shell-scan needles.
   *
   * `write`-level rules are skipped: the policy already grants full access
   * there, so mentioning such a path in a command is not a violation — refusing
   * `cd D:/proj && npm test` would contradict the user's own `write` rule and
   * make the plugin unusable for the workspace it is meant to allow.
   */
  const scanRules = () => [
    ...rulesOf().filter(rule => rule === null || typeof rule !== 'object' || rule.access !== 'write'),
    ...selfRulesFor(),
  ]

  /**
   * Build scan needles for the current rules and the calling session.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {ReturnType<typeof buildNeedles>} the needles, longest first.
   */
  const shellNeedles = (exec) => {
    const workspace = exec.agent?.session.header.cwd
    return buildNeedles(scanRules(), { home, windows, ...(workspace === undefined ? {} : { workspace }) })
  }

  /** Whether this plugin is the component responsible for judging a tool call. */
  const governs = (toolName) => PATH_TOOLS[toolName] !== undefined
    || SHELL_TOOLS.has(toolName)
    || isExoticTool(toolName)
    || toolName === 'plugin_manager'

  /** Implicit rules that keep the AI from editing the composition carrying this policy. */
  const selfRules = typeof profileDir === 'string' && profileDir !== ''
    ? Object.freeze(PROFILE_FILES.map(file => Object.freeze({
      id: 'self-protection',
      path: join(profileDir, file),
      access: 'read',
      note: 'dsh-path-guard self-protection',
    })))
    : NO_RULES

  let cachedRules = null
  let cachedExtra = null
  let cachedPolicy = null
  let warnedInvalid = ''

  /**
   * The compiled policy, recomputed only when the volatile rule snapshot changes
   * identity — `get()` returns the same frozen snapshot until a save replaces it.
   * @returns {{rules: Array<object>, isEmpty: boolean, invalid: Array<object>}} the compiled policy.
   */
  const policy = () => {
    const configured = rulesOf()
    const extra = selfRulesFor()
    if (cachedPolicy === null || cachedRules !== configured || cachedExtra !== extra) {
      cachedPolicy = compile({ rules: [...configured, ...extra], home, windows })
      cachedRules = configured
      cachedExtra = extra
      const invalid = cachedPolicy.invalid.map(bad => `${bad.index}:${bad.path ?? ''}`).join(',')
      if (cachedPolicy.invalid.length > 0 && invalid !== warnedInvalid) {
        warnedInvalid = invalid
        for (const bad of cachedPolicy.invalid) {
          ctx.logger.warn('path-guard: ignoring rule #%d (%s): %s', bad.index, bad.path ?? '', bad.reason)
        }
      }
    }
    return cachedPolicy
  }

  try {
    ctx.logger.info(
      'path-guard: armed (%d rule(s), defaultAccess=%s, shell=%s, exoticTools=%s)',
      policy().rules.length,
      String(read('defaultAccess')),
      String(read('shell')),
      String(read('exoticTools')),
    )
  } catch (error) {
    // A malformed configuration must be loud but must not stop activation:
    // deactivating the plugin silently would remove the protection entirely.
    ctx.logger.error('path-guard: configuration is unusable: %s', String(error))
  }

  /**
   * Match one already-absolute path against the live policy, applying
   * `defaultAccess` when nothing matches.
   * @param {string} absolutePath - a resolved or lexically absolute path.
   * @param {string | undefined} workspace - the session workspace, for `${workspace}` rules.
   * @returns {{access: string, ruleId?: string, pattern?: string} | undefined} the decision.
   */
  const decideAbsolute = (absolutePath, workspace) => {
    if (typeof absolutePath !== 'string' || absolutePath === '') return undefined
    const opts = workspace === undefined ? {} : { workspace }
    const hit = match(policy().rules, absolutePath, opts)
    if (hit !== undefined) return hit
    const fallback = read('defaultAccess')
    return fallback === 'allow' ? undefined : { access: String(fallback), ruleId: 'defaultAccess' }
  }

  /**
   * Decide a raw, model-supplied path. The lexical answer is computed first so a
   * path that cannot be resolved still gets a verdict, then refined by the
   * canonical path from `ctx.fs.resolve` — which is what defeats symlinks.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @param {string} rawPath - the argument as the model wrote it.
   * @returns {Promise<{decision: object | undefined, shown: string}>} the stricter decision and its path.
   */
  const decidePath = async (exec, rawPath) => {
    const workspace = exec.agent?.session.header.cwd
    let expanded = rawPath
    try {
      expanded = expandPath(rawPath, { home, ...(workspace === undefined ? {} : { workspace }) })
    } catch (error) {
      ctx.logger.debug?.('path-guard: cannot expand %s: %s', rawPath, String(error))
    }
    let decision = decideAbsolute(expanded, workspace)
    let shown = expanded

    const fs = ctx.fs
    if (fs !== undefined && typeof fs.resolve === 'function') {
      try {
        const target = await fs.resolve(rawPath, {
          ...(workspace === undefined ? {} : { cwd: workspace }),
          signal: exec.signal,
        })
        const canonical = fs.processPath(target)
        const resolved = decideAbsolute(canonical, workspace)
        const stricter = strictest(decision, resolved)
        // Report the canonical path whenever it produced the winning verdict:
        // that is the path the user's rules actually matched.
        if (resolved !== undefined && stricter === resolved) shown = canonical
        decision = stricter
      } catch (error) {
        // An unresolvable path keeps the lexical verdict; providing one for
        // paths that do not resolve is the whole reason the lexical pass exists.
        // For the search tools this is more serious: they never call `ctx.fs`
        // themselves (they hand the raw path to ripgrep), so when resolution
        // fails the lexical pass is the ONLY thing standing between the model
        // and the path — worth more than a debug line.
        const search = exec.name === 'glob' || exec.name === 'grep'
        const log = search ? ctx.logger.warn.bind(ctx.logger) : ctx.logger.debug?.bind(ctx.logger)
        log?.('path-guard: resolve failed for %s (%s): %s', rawPath, exec.name, String(error))
      }
    }
    return { decision, shown }
  }

  /**
   * Enforce the policy for one path argument of one call.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @param {string} rawPath - the path value.
   * @param {string} required - `list`, `read` or `write`.
   * @returns {Promise<string | undefined>} a denial reason, or undefined to allow.
   */
  const checkPath = async (exec, rawPath, required) => {
    const { decision, shown } = await decidePath(exec, rawPath)
    if (permits(decision, required)) return undefined
    return denialText({
      toolName: exec.name,
      shownPath: shown,
      access: decision.access,
      required: REQUIRED_TEXT[required] ?? required,
      ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
      ...(decision.pattern === undefined ? {} : { rulePath: decision.pattern }),
    })
  }

  /**
   * Evaluate every path argument of a call.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {Promise<string | undefined>} a denial reason, or undefined to allow.
   */
  const evaluatePaths = async (exec) => {
    const spec = PATH_TOOLS[exec.name]
    if (spec === undefined) return undefined
    const args = exec.arguments
    const workspace = exec.agent?.session.header.cwd
    for (const entry of spec.paths) {
      const required = entry.op === 'by-command' ? opForCommand(args) : entry.op
      const values = collectPaths(args, entry)
      if (entry.root === true && values.length === 0 && typeof workspace === 'string') {
        // A search tool without `path` walks the session workspace; check that root.
        values.push(workspace)
      }
      for (const value of values) {
        const reason = await checkPath(exec, value, required)
        if (reason !== undefined) return reason
      }
    }
    return undefined
  }

  /**
   * Evaluate the shell-shaped surfaces.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {string | undefined} a denial reason, or undefined to allow.
   */
  const evaluateShell = (exec) => {
    const mode = read('shell')
    if (mode === 'off') return undefined
    if (!SHELL_TOOLS.has(exec.name)) return undefined
    if (mode === 'deny') {
      return shellDenialText({ toolName: exec.name, needle: 'shell 已被整体禁用（shell: deny）', access: 'none' })
    }
    const needles = shellNeedles(exec)
    if (needles.length === 0) {
      // No needle at all must not read as "nothing is dangerous". With
      // `defaultAccess` set to anything but allow the user asked for deny by
      // default, and the shell is the one channel where "nothing matched" is
      // indistinguishable from "not looked for".
      const fallback = read('defaultAccess')
      if (fallback === 'allow') return undefined
      return shellDenialText({
        toolName: exec.name,
        needle: 'defaultAccess 不是 allow，但没有任何可用的路径规则供扫描',
        access: String(fallback),
      })
    }
    const hit = scanCommand(commandOf(exec.arguments), needles, windows)
    if (hit === undefined) return undefined
    return shellDenialText({
      toolName: exec.name,
      needle: hit.needle,
      rulePath: hit.pattern,
      access: hit.access,
    })
  }

  /**
   * Refuse every composition-changing `plugin_manager` action while
   * self-protection is on. Listing actions stay allowed, so the model keeps its
   * ability to see what is installed.
   * @param {unknown} args - the `plugin_manager` arguments.
   * @returns {string | undefined} a denial reason, or undefined to allow.
   */
  const selfTargetVerdict = (args) => {
    if (args === null || typeof args !== 'object') return undefined
    const action = args.action
    if (typeof action !== 'string' || !COMPOSITION_CHANGING_ACTIONS.has(action)) return undefined
    return selfDenialText({ action, target: typeof args.target === 'string' ? args.target : '(未指定)' })
  }

  // ---- L1: the authority on paths -----------------------------------------
  //
  // Every registration below is wrapped: an exception raised here becomes a tool
  // failure, so an internal bug would take the tool surface down with a stack
  // trace the model cannot act on. Failing closed with an actionable message is
  // the only acceptable outcome for a security control (see `internalErrorText`).
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (read('enabled') !== true) return next()
      const reason = await evaluatePaths(exec)
      if (reason !== undefined) {
        ctx.logger.warn('path-guard: denied %s — %s', exec.name, reason.split('\n')[0])
        return { kind: 'deny', reason }
      }
      return next()
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools/pre-execute: %s', error?.stack ?? String(error))
      // Fail closed ONLY for calls this plugin is responsible for judging. A bug
      // here must not take away the model's unrelated tools — above all the
      // human-escalation ones (`ask_user_question`), which are how a stuck model
      // reaches the user.
      if (!governs(exec.name)) return next()
      return { kind: 'deny', reason: internalErrorText('tools/pre-execute') }
    }
  })

  // ---- L2/L5/L6: the synchronous guard ------------------------------------
  ctx.tools.guard((exec) => {
    try {
      if (read('enabled') !== true) return undefined
      let reason
      if (read('exoticTools') === 'deny' && isExoticTool(exec.name)) {
        reason = exoticDenialText({ toolName: exec.name })
      } else if (read('selfProtection') === true && exec.name === 'plugin_manager') {
        reason = selfTargetVerdict(exec.arguments)
      } else {
        reason = evaluateShell(exec)
      }
      if (reason !== undefined) {
        ctx.logger.warn('path-guard: denied %s — %s', exec.name, reason.split('\n')[0])
      }
      return reason
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools.guard: %s', error?.stack ?? String(error))
      if (!governs(exec.name)) return undefined
      return internalErrorText('ctx.tools.guard()')
    }
  })

  // ---- L4: structured result redaction ------------------------------------
  //
  // Ordering here is load-bearing, and the obvious implementation is wrong.
  //
  // This listener is prepended, i.e. outermost, so `next()` would run the tool
  // package's OWN post-execute listener first. `tool-fs-search` does two things
  // there that we must prevent:
  //   (a) over the inline cap (glob > 100 paths, grep > 250 matches) it writes
  //       the COMPLETE unredacted result to a spill file
  //       (packages/fs/tool-fs-search/src/glob.ts:360, grep.ts:351) and returns
  //       `content` instead of a direct value;
  //   (b) it bails out early when the downstream decision already carries a
  //       `value` (packages/fs/tool-fs-search/src/direct-call.ts:24).
  //
  // So calling `next()` first would both leak the whole result to disk and turn
  // every over-cap search into a hard block. Instead, when redaction is actually
  // required we decide from the raw `result` and return `{ kind: 'accept',
  // value }` WITHOUT calling `next()`: the tool's listener never runs, no spill
  // is written, and the framework re-validates the value against the tool's
  // output schema and re-runs `render`/`presentationMeta`
  // (packages/core/tools/src/index.ts:1803-1813,1839,1848).
  //
  // Everything that needs no redaction is passed straight through with `next()`.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (read('enabled') !== true) return next()
      if (result.isError === true) return next()

      // Shell output. The same substring test as the command scan, so it
      // inherits the same limit: a command that builds the protected path
      // without ever writing it as a literal produces output this cannot
      // recognise either. Withholding the whole block is deliberate — a partial
      // redaction of arbitrary command output would be guesswork.
      if (SHELL_TOOLS.has(exec.name)) {
        if (read('shell') !== 'scan') return next()
        const needles = shellNeedles(exec)
        if (needles.length === 0) return next()
        const filtered = redactTextBlocks(result.content, needles, windows)
        if (!filtered.changed) return next()
        ctx.logger.info('path-guard: withheld a %s output block mentioning a protected path', exec.name)
        return { kind: 'accept', content: filtered.content }
      }

      if (read('searchRedaction') !== true) return next()
      const kind = exec.name
      if (kind !== 'glob' && kind !== 'grep') return next()

      const workspace = exec.agent?.session.header.cwd
      const cwd = workspace ?? process.cwd()
      const decide = absolutePath => decideAbsolute(absolutePath, workspace)?.access ?? 'allow'

      const recognized = kind === 'glob' ? isRecognizedGlobValue(result.value) : isRecognizedGrepValue(result.value)
      if (!recognized) {
        // Structure drift: we cannot prove the result is clean. Refuse it only
        // when a user rule actually protects something — the implicit
        // self-protection rules are `read`-level (the AI may read the profile
        // composition by design), so they never justify blocking a search.
        const protects = rulesOf().some(rule => rule !== null && typeof rule === 'object' && rule.access !== 'write')
        if (!protects) return next()
        ctx.logger.warn('path-guard: withheld an unrecognized %s result (fail-closed)', kind)
        return { kind: 'block', feedback: [{ type: 'text', text: redactionBlockedText(kind) }] }
      }

      const redacted = kind === 'glob'
        ? redactGlobValue(result.value, { cwd, decide })
        : redactGrepValue(result.value, { cwd, decide })
      if (!redacted.changed) return next()

      ctx.logger.info('path-guard: redacted %s results under a protected path', kind)
      return { kind: 'accept', value: redacted.value }
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools/post-execute: %s', error?.stack ?? String(error))
      return { kind: 'block', feedback: [{ type: 'text', text: internalErrorText('tools/post-execute') }] }
    }
  }, { prepend: true })
}
