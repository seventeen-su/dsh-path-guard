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
 *    row and attaches to four existing extension points. Unloading it restores
 *    the previous behaviour exactly.
 * 2. **`tools/pre-execute` is the authority on paths, not `ctx.tools.guard()`.**
 *    `ToolGuard` is synchronous by type (packages/core/tools/src/index.ts:731)
 *    while `FileSystem.resolve` returns a Promise, and only a resolved path is
 *    symlink-safe: `FsTarget.targetKey` is documented opaque and must not be
 *    parsed (packages/fs/fs/src/types.ts:11-15). A workspace symlink pointing
 *    into `~/.ssh` defeats any purely lexical check.
 * 3. **The guard handles only what is unambiguous without I/O** — surfaces the
 *    plugin refuses by name, and `plugin_manager` actions aimed at itself.
 * 4. **Result redaction rewrites the structured `value`, not rendered text**,
 *    and uses `{ prepend: true }` because a prepended listener is outermost and
 *    therefore has the last word (vendor/cordis/src/events.ts:255).
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
  redactionBlockedText,
  selfDenialText,
  shellDenialText,
} from './deny.js'
import { buildNeedles, commandOf, scanCommand } from './scan.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'path-guard'

/** Services this plugin needs: the tool registry and the resolved-path source. */
export const inject = ['tools', 'fs']

export { Config }

/** This bundle's package name, used to recognise self-targeting actions. */
const SELF_PACKAGE = 'dsh-path-guard'

/** This bundle's row id in the profile patch, also its settings namespace. */
const SELF_ROW_ID = 'path-guard'

/** `plugin_manager` actions that can disable, replace or remove this plugin. */
const SELF_TARGETING_ACTIONS = new Set([
  'set_plugin',
  'set_bundle',
  'remove_bundle',
  'install_bundle',
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
 * @param {Partial<typeof DEFAULTS>} config - the row config with schema defaults applied.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const home = os.homedir()
  const windows = process.platform === 'win32'
  const profileDir = process.env.DSH_PROFILE_DIR

  /** @type {Array<object>} */
  let rules = []
  /** @type {ReturnType<typeof buildNeedles>} */
  let needles = []

  /**
   * Compile the configured rules, appending the implicit self-protection rules.
   * Self-protection is expressed as ordinary `read`-level rules so it flows
   * through the same matcher, the same denial text and the same audit trail.
   */
  const rebuild = () => {
    const configured = Array.isArray(cfg.rules) ? cfg.rules : []
    const extra = []
    if (cfg.selfProtection && typeof profileDir === 'string' && profileDir !== '') {
      for (const file of PROFILE_FILES) {
        extra.push({ path: join(profileDir, file), access: 'read', note: 'dsh-path-guard self-protection' })
      }
    }
    const result = compile({ rules: [...configured, ...extra], home, windows })
    rules = result.rules
    needles = buildNeedles([...configured, ...extra], { home, windows })
    if (result.invalid.length > 0) {
      for (const bad of result.invalid) {
        ctx.logger.warn('path-guard: ignoring rule #%d (%s): %s', bad.index, bad.path ?? '', bad.reason)
      }
    }
    ctx.logger.info(
      'path-guard: active with %d rule(s)%s',
      rules.length,
      cfg.enabled ? '' : ' (disabled by config)',
    )
  }
  rebuild()

  /**
   * Match one already-absolute path against the compiled policy.
   * @param {string} absolutePath - a resolved or lexically absolute path.
   * @param {string | undefined} workspace - the session workspace, for `${workspace}` rules.
   * @returns {{access: string, ruleId?: string, pattern?: string} | undefined} the decision.
   */
  const decideAbsolute = (absolutePath, workspace) => {
    if (typeof absolutePath !== 'string' || absolutePath === '') return undefined
    return match(rules, absolutePath, workspace === undefined ? {} : { workspace })
  }

  /**
   * Decide a raw, model-supplied path. The lexical answer is computed first so
   * a path that cannot be resolved still gets a verdict, then refined by the
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
        ctx.logger.debug?.('path-guard: resolve failed for %s: %s', rawPath, String(error))
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
    if (cfg.shell === 'off') return undefined
    if (!SHELL_TOOLS.has(exec.name)) return undefined
    if (cfg.shell === 'deny') {
      return shellDenialText({ toolName: exec.name, needle: '(shell 已被整体禁用)', rulePath: undefined, access: 'none' })
    }
    const workspace = exec.agent?.session.header.cwd
    const localNeedles = buildNeedles(cfg.rules, { home, ...(workspace === undefined ? {} : { workspace }), windows })
    const hit = scanCommand(commandOf(exec.arguments), localNeedles, windows)
    if (hit === undefined) return undefined
    return shellDenialText({
      toolName: exec.name,
      needle: hit.needle,
      rulePath: hit.pattern,
      access: hit.access,
    })
  }

  /**
   * The synchronous guard: everything decidable without I/O.
   * @param {Readonly<import('@deepseek-ai/dsh-tools').ToolExecution>} exec - the running call.
   * @returns {string | undefined} a denial reason, or undefined to leave the call alone.
   */
  const guardVerdict = (exec) => {
    if (!cfg.enabled) return undefined
    if (cfg.exoticTools === 'deny' && isExoticTool(exec.name)) {
      return exoticDenialText({ toolName: exec.name })
    }
    if (cfg.selfProtection && exec.name === 'plugin_manager') return selfTargetVerdict(exec.arguments)
    return evaluateShell(exec)
  }

  /**
   * Refuse `plugin_manager` actions that would disable or replace this plugin.
   * Listing actions stay allowed on purpose: the model keeps its ability to see
   * what is installed.
   * @param {unknown} args - the `plugin_manager` arguments.
   * @returns {string | undefined} a denial reason, or undefined to allow.
   */
  const selfTargetVerdict = (args) => {
    if (args === null || typeof args !== 'object') return undefined
    const action = args.action
    if (typeof action !== 'string' || !SELF_TARGETING_ACTIONS.has(action)) return undefined
    const target = typeof args.target === 'string' ? args.target : ''
    if (!target.includes(SELF_PACKAGE) && !target.includes(SELF_ROW_ID)) return undefined
    return selfDenialText({ action, target })
  }

  // ---- L1: the authority on paths -----------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!cfg.enabled) return next()
    const reason = await evaluatePaths(exec)
    if (reason !== undefined) {
      ctx.logger.warn('path-guard: denied %s — %s', exec.name, reason.split('\n')[0])
      return { kind: 'deny', reason }
    }
    return next()
  })

  // ---- L2/L5/L6: the synchronous guard ------------------------------------
  ctx.tools.guard((exec) => {
    const reason = guardVerdict(exec)
    if (reason !== undefined) {
      ctx.logger.warn('path-guard: denied %s — %s', exec.name, reason.split('\n')[0])
    }
    return reason
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
    if (!cfg.enabled || !cfg.searchRedaction) return next()
    const kind = exec.name
    if (kind !== 'glob' && kind !== 'grep') return next()
    if (result.isError === true) return next()

    const workspace = exec.agent?.session.header.cwd
    const cwd = workspace ?? process.cwd()
    const decide = absolutePath => decideAbsolute(absolutePath, workspace)?.access ?? 'allow'

    const recognized = kind === 'glob' ? isRecognizedGlobValue(result.value) : isRecognizedGrepValue(result.value)
    if (!recognized) {
      // Structure drift: we cannot prove the result is clean. Refuse it only
      // when there is something to protect at all, so an empty policy stays inert.
      if (rules.length === 0) return next()
      ctx.logger.warn('path-guard: withheld an unrecognized %s result (fail-closed)', kind)
      return { kind: 'block', feedback: [{ type: 'text', text: redactionBlockedText(kind) }] }
    }

    const redacted = kind === 'glob'
      ? redactGlobValue(result.value, { cwd, decide })
      : redactGrepValue(result.value, { cwd, decide })
    if (!redacted.changed) return next()

    ctx.logger.info('path-guard: redacted %s results under a protected path', kind)
    return { kind: 'accept', value: redacted.value }
  }, { prepend: true })
}
