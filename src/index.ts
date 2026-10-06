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
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { Config } from './config.ts'
import { capabilities, compile, expandPath, match } from './policy.ts'
import {
  isRecognizedGlobValue,
  isRecognizedGrepValue,
  redactGlobValue,
  redactGrepValue,
} from './redact.ts'
import {
  KNOWN_TOOLS,
  isGoverned,
  policyAccessFor,
  resolveResources,
} from './resource.ts'
import {
  SHELL_TOOLS,
  isExoticTool,
  isScriptTool,
  scriptOf,
} from './tool-fields.ts'
import {
  denialText,
  exoticDenialText,
  installSourceDenialText,
  internalErrorText,
  redactionBlockedText,
  selfDenialText,
  shellDenialText,
  unknownToolDenialText,
} from './deny.ts'
import { buildNeedles, commandOf, redactTextBlocks, scanCommand, unscannablePatterns } from './scan.ts'
import { createNotifier, NOTIFY_API_VERSION } from './notify.ts'
import { createFsGuard } from './fs-guard.ts'
import { TRACKED_TOOLS_MAX, createTracking } from './tracking.ts'

/** 本插件自产的一条规则（与 `policy.ts` 的 `RuleInput` 形状一致）。 */
type LocalRule = { id: string; path: string; access: string; note?: string | undefined }

/** 策略判定结果。结构镜像自本仓 `src/policy.ts` 的 `match()` 返回形状（外加 `defaultAccess` 分支）。 */
type Decision = {
  access: string
  ruleId?: string | undefined
  pattern?: string | undefined
}

/** 一次拒绝的内部记录（`checkPath` 的返回值，供 `evaluatePaths` 原样上抛）。 */
type DenialRecord = {
  reason: string
  target: string
  access: string
  ruleId?: string | undefined
  rulePath?: string | undefined
  /** 被拒资源所在的参数字段（accessor 记法），供拒绝日志与自学习使用。 */
  field?: string | undefined
}

/** 一条拒绝事实，`reportDenial` / `denialText` 的入参。 */
type DenialHit = {
  reason: string
  target?: string | undefined
  access?: string | undefined
  rulePath?: string | undefined
  ruleId?: string | undefined
}

/**
 * 工具调用对象。结构镜像自 DSH `packages/core/tools/src/index.ts` 的 `ToolExecution`，
 * 只列出本插件真正读取的字段（`name` / `arguments` / `signal` /
 * `agent.session.header.cwd` / `agent.session.header.id`）。
 */
type ToolExecution = {
  name: string
  arguments: Record<string, unknown>
  signal?: unknown
  agent?: { session: { header: { cwd: string; id?: string } } } | undefined
}

/**
 * Cordis 上下文子集。结构镜像自 DSH `packages/core` 各包的 `src/index.ts` 与
 * `vendor/cordis/src/events.ts`，只列出本插件用到的成员。
 */
type CordisContext = {
  logger: {
    info: (...args: unknown[]) => unknown
    warn: (...args: unknown[]) => unknown
    error: (...args: unknown[]) => unknown
    debug: (...args: unknown[]) => unknown
  }
  fs?: {
    resolve: (path: string, opts?: { cwd?: string; signal?: unknown }) => Promise<{ targetKey: unknown; displayPath: string }>
    processPath: (target: unknown) => string
    readText?: (target: unknown, signal?: unknown) => Promise<string>
  } | undefined
  tools?: { guard: (handler: (exec: ToolExecution) => unknown) => unknown } | undefined
  on: (...args: unknown[]) => unknown
  get: (name: string) => unknown
  /**
   * Loader-managed effect: whatever the callback returns is disposed with the
   * plugin. Used to tie the web route's registration to this plugin's lifetime.
   */
  effect?: ((callback: () => unknown, label?: string) => unknown) | undefined
  /** The Host web server. Optional: a profile without one must still arm. */
  webServer?: {
    register: (route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: HttpResponse) => unknown
    }) => unknown
  } | undefined
}

/** The slice of `ServerResponse` this plugin writes to. Mirrors `node:http`. */
type HttpResponse = {
  writeHead: (status: number, headers?: Record<string, string>) => unknown
  end: (body?: string) => unknown
}

/** The slice of `IncomingMessage` the admission check reads. */
type HttpRequest = unknown

/** Cordis plugin name used by loader diagnostics. */
export const name = 'path-guard'

/** Services this plugin needs: the tool registry and the resolved-path source. */
export const inject = ['tools', 'fs']

export { Config }

/** The cross-copy volatile marker (vendor/cosmokit/src/volatile.ts:3,52-54). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** This bundle's package name, the other half of its identity in the profile. */
const SELF_PACKAGE = 'dsh-path-guard'

/** This bundle's row id in the profile patch, also its settings namespace. */
const SELF_ROW_ID = 'path-guard'

/**
 * The route the client half reads the tracked-tool list from.
 *
 * The two halves of a bundle are separate realms: the client cannot see Host
 * runtime state, and `remote.*` namespaces are declared through DSH's own API
 * gateway rather than by a third-party bundle. A same-origin route is the
 * mechanism the ecosystem already uses for exactly this (`dsh-desktop-notify`
 * serves its whole `/dnotify` surface this way, gate included).
 */
const TRACKED_TOOLS_PATH = '/path-guard/tools'

/**
 * The tracked-tool registry's file, inside the profile directory.
 *
 * The profile directory is the one place this plugin can name without inventing
 * a location, and the file is DERIVED state rather than policy: losing it costs
 * the learned fields, never a rule.
 */
const TRACKED_TOOLS_FILE = 'path-guard-tools.json'

/**
 * How long the registry waits before writing its file.
 *
 * Every unmodelled call touches the registry, and a tool called in a loop must
 * not become a write per call. One pending write per burst — plus the flush at
 * unload — is enough for state that is a convenience.
 */
const TRACKING_SAVE_DEBOUNCE_MS = 750

/**
 * `plugin_manager` actions that change the profile composition.
 *
 * Those NAMING this plugin are refused outright: disabling, replacing or
 * removing the protection row is exactly what self-protection exists to stop,
 * and the entry id (`include:path-guard`) and the bundle name
 * (`dsh-path-guard`) are stable identities, so a substring test is sound there.
 *
 * `install_bundle` needs a finer rule. A `target` string is NOT a reliable
 * identity for "which row will this change": a package the model authored
 * itself, installed from a local path, a git URL or a tarball, can carry a patch
 * layer doing `- id: path-guard` + `disabled: true`, switching the guard off
 * from a later layer. So an install is allowed only from the registry, where the
 * model cannot mint the package within the same turn.
 * Spec forms mirror packages/boot/plugin-manager/src/install-spec.ts:21-31.
 */
const COMPOSITION_CHANGING_ACTIONS = new Set([
  'set_plugin',
  'set_bundle',
  'install_bundle',
  'remove_bundle',
  'set_version_exemption',
])

/** A pnpm git shorthand (`github:user/repo`). */
const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i
/** A git URL or an scp-like `git@host:path`. */
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i
/** A hosted repository URL. */
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i
/** A tarball, on disk or over HTTP. */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i

/**
 * Whether an install spec resolves through the registry, i.e. to a package the
 * model cannot have authored in the same turn.
 * @param {unknown} raw - the `install_bundle` target.
 * @returns {boolean} true for a plain registry package spec.
 */
function isRegistrySpec(raw: unknown): boolean {
  const spec = String(raw ?? '').trim()
  if (spec === '') return false
  const path = spec.replace(/^(?:file|link):/, '')
  if (path !== spec || isAbsolute(path)) return false
  if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) return false
  if (GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec)) return false
  if (/^https?:\/\//i.test(spec)) return false
  if (TARBALL_SPEC.test(spec)) return false
  return true
}

/**
 * The absolute directory a local install spec points at, when it is one.
 * @param {unknown} raw - the `install_bundle` target.
 * @returns {string | undefined} the absolute directory, or undefined.
 */
function localSpecPath(raw: unknown): string | undefined {
  const spec = String(raw ?? '').trim()
  if (spec === '') return undefined
  const stripped = spec.replace(/^(?:file|link):/, '')
  if (stripped !== spec) return isAbsolute(stripped) ? stripped : undefined
  return isAbsolute(spec) ? spec : undefined
}

/** Install-lifecycle hooks that run code while the package is being installed. */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']

/** Cap on how much of a candidate patch this plugin will read while inspecting it. */
const MAX_PATCH_BYTES = 512 * 1024

/**
 * Profile files the AI may read but must not rewrite.
 *
 * The tracked-tool registry belongs in this set even though it is not
 * composition: `src/tracking.ts` reads it back as FACT on the next activation,
 * so a model that can write it can seed learned fields (turning a refusal into
 * an allow) or silence its own "new tool" notice. The plugin's own
 * `saveTracking()` writes the file directly and never passes through this guard.
 */
const PROFILE_FILES = ['cordis.patch.yml', 'cordis.yml', 'package.json', TRACKED_TOOLS_FILE]

/**
 * Read a non-empty string, else undefined.
 * @param {unknown} value - candidate.
 * @returns {string | undefined} the string when usable.
 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Capability ordering; a lower rank is stricter. */
const RANK: Record<string, number> = { none: 0, list: 1, read: 2, write: 3 }

/** Wording for the operation a denied call was attempting. */
const REQUIRED_TEXT: Record<string, string> = {
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
  unknownTools: 'check',
  trustedTools: [],
  selfProtection: true,
  notify: 'focused',
}

/** Stable empty rule list, so the compiled-policy cache key keeps its identity. */
const NO_RULES = Object.freeze([])

/**
 * Read a schemastery volatile reference, which is a frozen `{ get() }` object.
 * Plain values pass through, so tests and direct construction behave the same.
 * @param {unknown} value - a resolved config field or a plain value.
 * @returns {unknown} the current snapshot.
 */
export function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get: () => unknown }).get()
  }
  return value
}

/**
 * Keep the stricter of two decisions, treating `undefined` as "no opinion".
 * @param {{access: string} | undefined} a - first decision.
 * @param {{access: string} | undefined} b - second decision.
 * @returns {{access: string} | undefined} the stricter decision.
 */
function strictest(a: Decision | undefined, b: Decision | undefined): Decision | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return RANK[a.access]! <= RANK[b.access]! ? a : b
}

/**
 * Whether a decision permits an operation.
 * @param {{access: string} | undefined} decision - the policy decision, if any.
 * @param {string} required - the operation the call performs (`list`/`read`/`write`).
 * @returns {boolean} true when the call may proceed.
 */
function permits(decision: Decision | undefined, required: string): boolean {
  if (decision === undefined || decision.access === 'allow') return true
  return (capabilities(decision.access) as Record<string, boolean>)[required] === true
}

/**
 * Register the policy enforcement points.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} config - the row config, volatile fields still wrapped.
 */
export function apply(ctx: CordisContext, config: Record<string, unknown>) {
  const raw: Record<string, unknown> = config !== null && typeof config === 'object' ? config : {}
  const home = os.homedir()
  const windows = process.platform === 'win32'

  /**
   * Read one config field through the volatile protocol, falling back to the
   * schema default. Called per decision, never captured at activation.
   * @param {keyof typeof DEFAULTS} key - the field name.
   * @returns {unknown} the current value.
   */
  const read = (key: keyof typeof DEFAULTS): unknown => {
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
  const rulesOf = (): Array<object>  => {
    const value = read('rules')
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      throw new TypeError(`path-guard: config.rules must be an array, received ${typeof value}`)
    }
    return value
  }

  /**
   * Whether the user trusts a tool, i.e. this plugin must not judge it at all.
   *
   * An entry matches the exact tool name, or — when it ends in `*` — every tool
   * whose name starts with the entry before the star. The prefix form is what
   * lets one entry trust a whole plugin's tool set: `notes_*` covers
   * `notes_search`, `notes_save` and anything that plugin adds later, which is
   * the point — a plugin's tool list changes between versions and re-trusting
   * every new tool by hand is how a trust list rots.
   * @param {string} toolName - the model-facing tool name.
   * @returns {boolean} true when the tool is trusted.
   */
  const isTrustedTool = (toolName: string): boolean => {
    const configured = read('trustedTools')
    if (!Array.isArray(configured)) return false
    for (const rawEntry of configured) {
      const entry = unwrap(rawEntry)
      if (entry === null || typeof entry !== 'object') continue
      const match = (entry as { match?: unknown }).match
      if (typeof match !== 'string' || match === '') continue
      if (match.endsWith('*')) {
        if (toolName.startsWith(match.slice(0, -1))) return true
      } else if (toolName === match) {
        return true
      }
    }
    return false
  }

  /**
   * The tracked-tool registry: continuous detection plus denial-time
   * self-learning.
   *
   * It replaces the old `Map<name, 'seen' | reason>`. That map could only say
   * "we saw this once"; the registry counts sightings, remembers which argument
   * field carried a refused path, generalizes that to the tool's whole family,
   * and survives a restart (`src/tracking.ts` documents the model). It is also
   * what the log quotes back to the user, instead of leaving them to guess a
   * tool name they never saw — which is how a trust list never gets filled in.
   */
  const tracking = createTracking()

  /**
   * Where the registry persists, or undefined when no profile directory is
   * resolvable — in which case tracking is memory-only, exactly as it was.
   *
   * Service-first on purpose. `DSH_PROFILE_DIR` is contributed to each shell
   * EXECUTION (shell-env/src/index.ts:158-167), not to the Host's own
   * environment, so the live `profileContext` is the authoritative source and
   * the variable is the last resort — the same order `resolveSelfPaths()` uses.
   * @returns {string | undefined} the file to read/write.
   */
  const trackingFilePath = (): string | undefined => {
    const lookup = (service: string, field: string): string | undefined => {
      try {
        const instance = ctx.get(service) as Record<string, unknown> | undefined
        const value = instance === null || typeof instance !== 'object' ? undefined : instance[field]
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }
    const patch = lookup('profileContext', 'patchPath') ?? lookup('configEditor', 'documentPath')
    if (patch !== undefined) return join(dirname(patch), TRACKED_TOOLS_FILE)
    const dir = process.env.DSH_PROFILE_DIR
    return typeof dir === 'string' && dir !== '' ? join(dir, TRACKED_TOOLS_FILE) : undefined
  }

  /**
   * Read the persisted registry once, during activation.
   *
   * Never throws and never blocks arming: a missing file is the normal first
   * run, and unreadable state is a convenience lost, not a guard lost.
   */
  const loadTracking = (): void => {
    const file = trackingFilePath()
    if (file === undefined) return
    try {
      tracking.fromJSON(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      ctx.logger.debug('path-guard: no usable tool-tracking file at %s (%s)', file, String(error))
    }
  }

  /**
   * Write the registry now. Any failure is a debug line, never a thrown error.
   *
   * Written to a sibling temporary file and renamed into place: two DSH
   * processes sharing one profile (CLI + Web) each rewrite the whole file, and a
   * rename means a reader sees either the old file or the new one, never an
   * interleaved half of both. The pid keeps two writers' temporaries apart.
   */
  const saveTracking = (): void => {
    const file = trackingFilePath()
    if (file === undefined) return
    const temporary = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(tracking.toJSON()))
      renameSync(temporary, file)
    } catch (error) {
      ctx.logger.debug('path-guard: cannot persist tool tracking to %s (%s)', file, String(error))
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Best-effort cleanup; a leftover temporary file is harmless.
      }
    }
  }

  let trackingSaveTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Coalesce writes: a burst of unmodelled calls becomes one write.
   * `unref()` keeps a pending write from holding the process open.
   */
  const scheduleTrackingSave = (): void => {
    // Timer first: while a write is already pending, the path lookup (two
    // service probes plus a join) would be pure overhead. Both are reads.
    if (trackingSaveTimer !== undefined || trackingFilePath() === undefined) return
    trackingSaveTimer = setTimeout(() => {
      trackingSaveTimer = undefined
      saveTracking()
    }, TRACKING_SAVE_DEBOUNCE_MS)
    trackingSaveTimer.unref?.()
  }

  // Flush whatever the debounce still holds when the plugin is unloaded, so the
  // last sighting is not lost. Guarded: a profile without `ctx.effect` must
  // still arm, and the callback only registers a disposer.
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        if (trackingSaveTimer === undefined) return
        clearTimeout(trackingSaveTimer)
        trackingSaveTimer = undefined
        saveTracking()
      }, 'path-guard: tool-tracking persistence')
    } catch (error) {
      ctx.logger.debug('path-guard: cannot tie tool tracking to the plugin lifetime: %s', String(error))
    }
  }

  loadTracking()

  /**
   * When this plugin last told the user about an unmodelled tool, in epoch ms.
   *
   * The client half reads this to finish a job the notification peer cannot. The
   * peer's `page:plugins` target opens the plugins panel, but `openPluginsPanel()`
   * then hardcodes ITS OWN bundle name (`openBundle('dsh-desktop-notify')`), so a
   * click lands on the wrong package page. The wire format's page whitelist is the
   * bare pair `['settings-plugins','plugins']` — there is no bundle-qualified
   * target — so the page has to be corrected on our side.
   *
   * This timestamp is what makes that correction safe rather than a hijack: the
   * client only redirects within a short window after a notice this plugin
   * actually sent, never for ordinary navigation to the plugins panel.
   */
  let lastUnmodelledAt: number | null = null

  /**
   * Observe one unmodelled tool: the continuous half of the tracking model.
   * @param {string} toolName - the model-facing tool name.
   */
  const observeTool = (toolName: string): void => {
    tracking.observe(toolName, Date.now())
    scheduleTrackingSave()
  }

  /**
   * Record an unmodelled tool once and say how to trust it.
   * @param {string} toolName - the model-facing tool name.
   * @param {string} reason - why the plugin considered the call at all.
   */
  const noteUnmodelledTool = (toolName: string, reason: string): void => {
    // Once per TOOL, and the registry carries the flag — so a restart, which
    // reloads the records, does not re-notify for tools the user has already
    // been told about. The dedup lives in the registry's own bounded name set
    // rather than on the record: a record can be evicted, and a dedup that reset
    // with it would let a loop over 200+ tool names notify forever.
    if (tracking.notifiedBefore(toolName)) return
    tracking.markNotified(toolName)
    scheduleTrackingSave()
    lastUnmodelledAt = Date.now()
    const prefix = /^[A-Za-z0-9]+_/.exec(toolName)?.[0]
    const suggestion = prefix === undefined ? toolName : `${prefix}*`
    ctx.logger.info(
      'path-guard: unmodelled tool %s (%s). Add "%s" to trustedTools to trust the whole plugin, or "%s" for this tool alone.',
      toolName, reason, suggestion, toolName,
    )
    if (read('notify') === 'off') return
    // The popup half of the trust story. DSH gives a plugin no modal, so the
    // desktop notification is the only surface that can reach the user while they
    // are not looking at the settings page. Once per tool — the registry's
    // `notified` flag is the dedup, so this cannot become a stream.
    try {
      const service = ctx.get('desktopNotify') as { push?: (item: Record<string, unknown>) => unknown } | undefined
      void service?.push?.({
        title: '路径守卫：发现未建模的工具',
        message: `工具 ${toolName} 不在已知工具表里，插件只能按规则判定它报出的路径。`
          + `要完全信任它，请在「设置 → 插件 → 路径守卫 → 工具信任」里加上 ${suggestion}`
          + (prefix === undefined ? '。' : ' —— 这会一次信任该插件的全部工具（含它以后新增的）。'),
        urgency: 'low',
        // Same declared protocol version as the denial notifications: the peer
        // ignores unknown fields, so declaring it never costs a delivery.
        v: NOTIFY_API_VERSION,
        // Clicking leads to where the FIX lives, not to the session: the user's
        // next action is to add a trust entry, and that is on this plugin's page.
        //
        // `page:plugins` is the sidebar's Plugins panel — the page the user asked
        // for (`layout.selectPanel('plugins')`, dsh-desktop-notify src/client.ts
        // openPluginsPanel). Note the peer's own quirk: it prefers
        // `pluginNavigation.openBundle('dsh-desktop-notify')` over the plain
        // `selectPanel`, and that bundle name is HARDCODED (client.ts:163), so the
        // panel opens on the notify plugin's own page rather than the list. That
        // is the peer's bug, not a target we can correct from here — the wire
        // format's page whitelist is the bare pair
        // `['settings-plugins', 'plugins']`, with no bundle parameter.
        //
        // `page:settings-plugins` would reach the plugins LIST in Settings, which
        // is a different page and not what was asked for.
        click: { type: 'page', page: 'plugins' },
        // Deliberately NO `sessionId`. `push` silences a notification while the
        // user is looking at that very session, and this notice exists for exactly
        // that moment — the tool call that raised it happened in the session on
        // screen, so a session-gated notice would never be seen at all.
      })
    } catch (error) {
      ctx.logger.debug('path-guard: trust-suggestion notification failed: %s', String(error))
    }
  }

  /**
   * Report the installed bundles and their versions once, at activation.
   *
   * This is the "which plugins and which versions are running" half of the trust
   * story: a trust entry is a decision about a piece of third-party code, and the
   * decision is only meaningful next to the version it was made about. Read from
   * the profile manifest (`dsh.profile.bundles`) plus each bundle's own
   * package.json, so nothing here depends on a private Host API.
   */
  const logInstalledBundles = (): void => {
    try {
      const resolution = resolveSelfPaths()
      if (!Array.isArray(resolution) || resolution.length === 0) return
      const profileDir = dirname(resolution[0] as string)
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } }
      }
      const bundles = manifest.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) return
      const described = bundles.map(name => {
        try {
          const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', String(name), 'package.json'), 'utf8')) as { version?: unknown }
          return `${String(name)}@${typeof pkg.version === 'string' ? pkg.version : '?'}`
        } catch {
          return `${String(name)}@(unresolved)`
        }
      })
      ctx.logger.info('path-guard: %d installed bundle(s): %s', described.length, described.join(', '))
    } catch (error) {
      ctx.logger.debug('path-guard: cannot read the profile manifest: %s', String(error))
    }
  }

  /**
   * Rules that generate shell-scan needles.
   *
   * ONLY the tiers that FORBID READING may become needles: `none` (invisible) and
   * `list` (names visible, contents not). Everything else is excluded, each for
   * its own reason:
   *
   *   - `write` grants full access, so mentioning the path in a command is not a
   *     violation — refusing `cd D:/proj && npm test` would contradict the user's
   *     own rule and make the plugin unusable for the workspace it exists to allow.
   *   - `read` GRANTS reading, and the scanner cannot tell a read from a write
   *     inside an opaque command string. Treating a mention as a violation denied
   *     exactly what the rule allows: `read` on the profile's package.json
   *     returned the whole file, while `pwsh` printing that same path lost its
   *     entire output. The write side is covered by the file tools and by the
   *     authoritative fs-intent layer, which see the real target.
   *   - `allow` is an EXEMPTION — `permits()` returns true for it unconditionally.
   *     The old `access !== 'write'` test kept it, so EXEMPTING a path made the
   *     plugin reach FURTHER. A rule that points the wrong way is worse than a
   *     missing one, because it silently punishes the user for configuring it.
   *
   * The same filter applies to the self-protection rules: they are `read` tier on
   * purpose (readable, not writable), so their paths must not be needles either.
   */
  const SCAN_TIERS = ['none', 'list']
  const scanRules = () => [
    ...rulesOf(),
    ...selfRulesFor(),
  ].filter(rule => rule !== null && typeof rule === 'object' && SCAN_TIERS.includes(String((rule as { access?: unknown }).access)))

  // Memoized exactly like `policy()` below, and keyed on the same identities:
  // the configured rule snapshot, the self-rule snapshot, and the session
  // workspace. `rulesOf()` returns the SAME array until a config save replaces
  // it, and `selfRulesFor()` rebuilds only when the resolved profile path
  // changes — so identity IS the correct invalidation signal, and a save always
  // produces a new array. Workspace is in the key because a `${workspace}` rule
  // compiles to a different needle per session.
  let cachedNeedleRules: unknown = null
  let cachedNeedleSelf: unknown = null
  let cachedNeedleWorkspace: string | undefined
  let cachedNeedles: ReturnType<typeof buildNeedles> | null = null

  /**
   * Build scan needles for the current rules and the calling session.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {ReturnType<typeof buildNeedles>} the needles, longest first.
   */
  const shellNeedles = (exec: ToolExecution) => {
    const workspace = exec.agent?.session.header.cwd
    const configured = rulesOf()
    const extra = selfRulesFor()
    if (cachedNeedles === null || cachedNeedleRules !== configured
      || cachedNeedleSelf !== extra || cachedNeedleWorkspace !== workspace) {
      cachedNeedles = buildNeedles(scanRules(), { home, windows, ...(workspace === undefined ? {} : { workspace }) })
      cachedNeedleRules = configured
      cachedNeedleSelf = extra
      cachedNeedleWorkspace = workspace
    }
    return cachedNeedles
  }

  /** Whether this plugin is the component responsible for judging a tool call. */
  /**
   * Whether a call is this plugin's business — and therefore whether an internal
   * error must fail closed. Delegates to the resource layer, which knows the
   * modelled tools, the opaque ones, the exotic ones, and the name shapes that
   * mean "this could touch a filesystem".
   */
  /**
   * Whether an internal error must fail CLOSED for this tool.
   *
   * Two rules, and they used to be written as one expression that got both wrong:
   *
   * 1. **Trust wins for everything except self-protection.** A trusted tool is
   *    never this plugin's business, so a bug of ours must not take it away —
   *    including the shell, script and exotic legs. `isGoverned()` alone cannot
   *    express that (it judges by name shape, and `notes_files` looks
   *    filesystem-ish even when the whole plugin is trusted), so trust is
   *    consulted HERE, at the one place the fail-closed decision is made.
   *
   * 2. **Self-protection outranks trust** (see V-11). A trust entry is a statement
   *    about a tool's FILE ACCESS; letting it defeat the guard's own integrity
   *    would hand the AI the ability to disable the plugin. So `plugin_manager`
   *    stays governed while self-protection is on, trusted or not — otherwise our
   *    own bug would fail OPEN on the one tool that can rewrite the composition.
   *
   * The previous form was
   *     !isTrustedTool(n) && isGoverned(n) || SHELL_TOOLS.has(n) || isScriptTool(n)
   *       || isExoticTool(n) || n === 'plugin_manager'
   * and `&&` binds tighter than `||`, so it parsed as
   *     (!trusted && isGoverned) || SHELL || SCRIPT || EXOTIC || plugin_manager.
   * Trust then suppressed only the FIRST leg: a trusted `pwsh`, `workflow` or
   * `mcp__*` still matched its own leg and was failed closed by our bug. The
   * chain is deliberately GONE rather than reordered — `isGoverned()` already
   * covers all four of those legs, so keeping them was both redundant and a trap.
   */
  const governs = (toolName: string): boolean => {
    if (read('selfProtection') === true && toolName === 'plugin_manager') return true
    if (isTrustedTool(toolName)) return false
    return isGoverned(toolName)
  }

  /**
   * Absolute paths of the profile composition that carries this plugin's rules.
   *
   * `process.env.DSH_PROFILE_DIR` is NOT a reliable source here, and relying on
   * it left self-protection SILENTLY inert in a real deployment: that variable
   * is contributed by `@deepseek-ai/dsh-shell-env` to each shell EXECUTION
   * (packages/shell/shell-env/src/index.ts:158-167), not to the Host process's
   * own environment. With no self-rules the guard had no needles at all, so the
   * model could read and rewrite the very patch that carries the policy.
   *
   * The authoritative source is the live `profileContext` the profile booted
   * from, with the config editor's document as the second choice and the
   * environment variable as a last resort.
   * @returns {readonly string[]} absolute paths, or `NO_RULES` when unresolvable.
   */
  const resolveSelfPaths = (): readonly string[] | readonly never[] => {
    const lookup = (name: string, field: string) => {
      try {
        return nonEmpty((ctx.get?.(name) as Record<string, unknown> | undefined)?.[field])
      } catch {
        return undefined
      }
    }
    const patch = lookup('profileContext', 'patchPath') ?? lookup('configEditor', 'documentPath')
    if (patch !== undefined) {
      const dir = dirname(patch)
      // The patch itself first: it is the exact file carrying the rules. The rest
      // of PROFILE_FILES follows, so both branches protect the same set — and the
      // tracked-tool registry cannot fall out of it.
      return Object.freeze([patch, ...PROFILE_FILES.map(file => join(dir, file)).filter(path => path !== patch)])
    }
    const dir = nonEmpty(process.env.DSH_PROFILE_DIR)
    return dir === undefined
      ? NO_RULES
      : Object.freeze(PROFILE_FILES.map(file => join(dir, file)))
  }

  let selfRulePaths: string | null | undefined = null
  let selfRules: readonly LocalRule[] = NO_RULES
  let warnedNoProfile = false

  /** Implicit rules that keep the AI from editing the composition carrying this policy. */
  const selfRulesFor = () => {
    if (read('selfProtection') !== true) return NO_RULES
    const paths = resolveSelfPaths()
    if (paths === NO_RULES || paths.length === 0) {
      // Never fail silently again: an unarmed self-protection must be visible.
      if (!warnedNoProfile) {
        warnedNoProfile = true
        ctx.logger.error(
          'path-guard: selfProtection is ON but the profile path could not be resolved'
          + ' (no profileContext/configEditor service and no DSH_PROFILE_DIR);'
          + ' the profile composition is NOT protected',
        )
      }
      return NO_RULES
    }
    if (selfRulePaths !== paths[0]) {
      selfRulePaths = paths[0]
      selfRules = Object.freeze(paths.map(path => Object.freeze({
        id: 'self-protection',
        path,
        access: 'read',
        note: 'dsh-path-guard self-protection',
      })))
    }
    return selfRules
  }

  let cachedRules: unknown = null
  let cachedExtra: unknown = null
  let cachedPolicy: ReturnType<typeof compile> | null = null
  let warnedInvalid = ''
  let warnedUnscannable = ''

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
      // A rule the substring scanner cannot reduce to a literal (a wildcard with
      // a literal tail, or one cutting through a segment) is simply NOT enforced
      // on the shell / script channels. Saying so is the difference between a
      // documented limit and a silent hole — the failure mode this plugin was
      // already bitten by once.
      const unscannable = read('shell') === 'off' ? [] : unscannablePatterns([...configured, ...extra])
      const key = unscannable.join('\u0000')
      if (unscannable.length > 0 && key !== warnedUnscannable) {
        warnedUnscannable = key
        ctx.logger.warn(
          'path-guard: %d rule(s) cannot be covered by the shell/script text scan (%s);'
          + ' they stay enforced for tool paths, but use an exact path or a trailing-glob form'
          + ' (like ~/.ssh/**) if you need them covered there too, or set shell: deny',
          unscannable.length,
          unscannable.join(', '),
        )
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
  const decideAbsolute = (absolutePath: string, workspace: string | undefined): Decision | undefined => {
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
  const decidePath = async (exec: ToolExecution, rawPath: string) => {
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
  const checkPath = async (exec: ToolExecution, rawPath: string, required: string, field?: string): Promise<DenialRecord | undefined> => {
    const { decision, shown } = await decidePath(exec, rawPath)
    if (permits(decision, required)) return undefined
    return {
      reason: denialText({
        toolName: exec.name,
        shownPath: shown,
        access: decision!.access,
        required: REQUIRED_TEXT[required] ?? required,
        ...(decision!.ruleId === undefined ? {} : { ruleId: decision!.ruleId }),
        ...(decision!.pattern === undefined ? {} : { rulePath: decision!.pattern }),
      }),
      target: shown,
      access: decision!.access,
      ...(field === undefined ? {} : { field }),
      ...(decision!.ruleId === undefined ? {} : { ruleId: decision!.ruleId }),
      ...(decision!.pattern === undefined ? {} : { rulePath: decision!.pattern }),
    }
  }

  /**
   * Evaluate every path argument of a call.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {Promise<string | undefined>} a denial reason, or undefined to allow.
   */
  /**
   * Judge one call's resources.
   *
   * This used to consult a static `PATH_TOOLS` table, so any tool not in it fell
   * through to `undefined` — i.e. ALLOW. Since DSH registers tools dynamically
   * (third-party, MCP), that made the security model "I recognise this tool → I
   * can judge it; I don't → allow", which is exactly backwards. It now resolves
   * the call into resources first and decides on those.
   *
   * Two deliberate limits, both from `docs/ARCHITECTURE.md` §2.2.1:
   *   - an unmodelled tool is refused only when a path-shaped VALUE appears
   *     (`result.reason`); a path-shaped FIELD NAME alone (`{dir:'asc'}`) must
   *     not deny, or MIME types and enum values get blocked everywhere;
   *   - an opaque tool (shell/script) yields no resources here — the scan pass in
   *     the synchronous guard owns that channel.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {Promise<DenialRecord | undefined>} a denial record, or undefined to allow.
   */
  const evaluatePaths = async (exec: ToolExecution): Promise<DenialRecord | undefined> => {
    // Trust is consulted before anything else, so this pass cannot refuse a tool
    // the user has trusted. Self-protection is the one axis trust must not defeat
    // (see the synchronous guard): `plugin_manager` keeps its own handling below.
    if (exec.name !== 'plugin_manager' && isTrustedTool(exec.name)) return undefined
    const args = exec.arguments
    const workspace = exec.agent?.session.header.cwd
    // Learned fields ride along for every call: a modelled tool ignores them (it
    // already knows its own fields), and passing them here keeps the unmodelled
    // branch below from needing a second resolution pass.
    const resolved = resolveResources(exec.name, args, tracking.knownFields(exec.name))

    if (resolved.known) {
      if (resolved.opaque) return undefined
      for (const resource of resolved.resources) {
        const hit = await checkPath(exec, resource.value, policyAccessFor(resource.capability))
        if (hit !== undefined) return hit
      }
      // A search tool without `path` walks the session workspace; check that root.
      if (resolved.resources.length === 0 && typeof workspace === 'string') {
        for (const field of KNOWN_TOOLS[exec.name]?.paths ?? []) {
          if (field.root !== true) continue
          const hit = await checkPath(exec, workspace, policyAccessFor(field.capability))
          if (hit !== undefined) return hit
        }
      }
      return undefined
    }

    // Unmodelled tool.
    //
    // `plugin_manager` is excluded first: its `target` IS a path by design (an
    // install source), so a blanket rule would refuse every install and shadow
    // `evaluateLocalInstall()`, the layer that actually inspects a local bundle
    // and makes installing one safe. Self-protection owns that tool.
    if (exec.name === 'plugin_manager') return undefined

    // A trusted tool is not judged at all — the user's explicit decision for a
    // whole plugin's tool set (see `trustedTools` in config.ts).
    if (isTrustedTool(exec.name)) return undefined

    // Remember EVERY unmodelled tool, not only the ones whose arguments look like
    // paths. The client's trust editor suggests from this list, and a list that
    // only ever contains tools that already tripped a heuristic would be empty
    // exactly when the user goes looking for what to trust.
    observeTool(exec.name)

    // Judge what the heuristics actually FOUND against the rules. Blanket
    // refusal on "an argument looked like a path" was untenable: a memory tool
    // takes a natural-language query that may well be a file path, and refusing
    // a memory lookup protects nothing. Checking the found paths is precise — it
    // refuses exactly when a rule covers one — and `unknownTools: 'deny'` keeps
    // the strict posture for anyone who wants it.
    for (const resource of resolved.actionable ?? []) {
      const hit = await checkPath(exec, resource.value, policyAccessFor(resource.capability), resource.field)
      if (hit !== undefined) {
        // The refusal is the teaching moment: this field carried a path a rule
        // protects, so from now on it is judged by NAME — for this tool, and for
        // the already-tracked rest of its family (`src/tracking.ts`).
        const taught = tracking.learnFromDenial(
          exec.name, resource.field, resource.capability, Date.now(), 'value',
        )
        if (taught.length > 0) {
          ctx.logger.debug(
            'path-guard: learned field %s from %s; the same field now applies to %s',
            resource.field, exec.name, taught.join(', '),
          )
        }
        scheduleTrackingSave()
        return hit
      }
    }

    if (resolved.reason !== undefined) {
      if (resolved.note !== undefined) ctx.logger.debug('path-guard: %s', resolved.note)
      // Only the strict mode refuses on shape alone. Either way the tool is
      // remembered, so the page can offer it for trust.
      noteUnmodelledTool(exec.name, resolved.reason)
      if (read('unknownTools') === 'deny') {
        // A RECORD, not the message string: the caller reads `hit.reason` and
        // `reportDenial()` reads `hit.target`, so a bare string rendered the
        // refusal as the literal text `undefined`.
        return {
          reason: unknownToolDenialText({ toolName: exec.name, reason: resolved.reason }),
          target: exec.name,
          access: 'none',
        }
      }
    }
    if ((resolved as { note?: string | undefined }).note !== undefined) ctx.logger.debug('path-guard: %s', (resolved as { note?: string | undefined }).note)
    return undefined
  }

  /**
   * Evaluate the opaque-program surfaces: a shell command string, or a workflow
   * script. Both are scanned rather than executed-and-inspected, so both are
   * best effort by construction.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {{reason: string, target: string, access: string, rulePath?: string} | undefined} the verdict.
   */
  const evaluateOpaque = (exec: ToolExecution) => {
    const script = isScriptTool(exec.name)
    const text = script ? scriptOf(exec.name, exec.arguments) : commandOf(exec.arguments)
    if (text === undefined) return undefined
    const kind = script ? 'script' : 'shell'
    const mode = read('shell')
    if (!script && mode === 'off') return undefined
    if (!script && mode === 'deny') {
      return {
        reason: shellDenialText({ toolName: exec.name, needle: 'shell 已被整体禁用（shell: deny）', access: 'none' }),
        target: '(shell)',
        access: 'none',
      }
    }
    const needles = shellNeedles(exec)
    if (needles.length === 0) {
      // No needle at all must not read as "nothing is dangerous". With
      // `defaultAccess` set to anything but allow the user asked for deny by
      // default, and these are the channels where "nothing matched" is
      // indistinguishable from "not looked for".
      const fallback = read('defaultAccess')
      if (fallback === 'allow') return undefined
      return {
        reason: shellDenialText({
          toolName: exec.name,
          needle: 'defaultAccess 不是 allow，但没有任何可用的路径规则供扫描',
          access: String(fallback),
          kind,
        }),
        target: '(opaque program)',
        access: String(fallback),
      }
    }
    const hit = scanCommand(text, needles, windows)
    if (hit === undefined) return undefined
    return {
      reason: shellDenialText({
        toolName: exec.name,
        needle: hit.needle,
        rulePath: hit.pattern,
        access: hit.access,
        kind,
      }),
      target: hit.needle,
      access: hit.access,
      rulePath: hit.pattern,
    }
  }

  /**
   * Refuse every composition-changing `plugin_manager` action while
   * self-protection is on. Listing actions stay allowed, so the model keeps its
   * ability to see what is installed.
   * @param {unknown} args - the `plugin_manager` arguments.
   * @returns {string | undefined} a denial reason, or undefined to allow.
   */
  const selfTargetVerdict = (args: unknown): string | undefined  => {
    if (args === null || typeof args !== 'object') return undefined
    const action = (args as Record<string, unknown>).action
    if (typeof action !== 'string' || !COMPOSITION_CHANGING_ACTIONS.has(action)) return undefined
    const target = typeof (args as Record<string, unknown>).target === 'string' ? (args as Record<string, unknown>).target as string : ''
    // Identity by name: the entry id and the bundle name are stable, so nothing
    // can dodge this by renaming a file.
    if (target.includes(SELF_PACKAGE) || target.includes(SELF_ROW_ID)) {
      return selfDenialText({ action, target })
    }
    // Installing from anywhere but the registry would let the model author the
    // very patch layer that switches this row off — the one bypass a target
    // string cannot rule out. A LOCAL directory is the exception: it can be
    // inspected before it lands, which the async `tools/pre-execute` pass does,
    // so this synchronous guard leaves it alone rather than guessing.
    if (action === 'install_bundle') {
      if (isRegistrySpec(target)) return undefined
      if (localSpecPath(target) !== undefined) return undefined
      return installSourceDenialText({ target })
    }
    return undefined
  }

  // Desktop notifications go through the OPTIONAL `desktopNotify` service that
  // `dsh-desktop-notify` registers. Resolved per call, so enabling that plugin
  // later takes effect without a restart, and absent it nothing happens at all.
  const notifier = createNotifier({
    resolveService: () => {
      try {
        return ctx.get('desktopNotify')
      } catch {
        return undefined
      }
    },
    logger: ctx.logger,
  })

  /**
   * The session a call belongs to, as the notification peer wants it.
   *
   * The plain id is preferred over the session object: the id is what the click
   * target is built from (`session:<id>`), and handing over a string removes any
   * dependence on the peer normalizing an object shape it may change.
   * @param {ToolExecution} exec - the running call.
   * @returns {unknown} the session id, the session object, or undefined.
   */
  const sessionOf = (exec: ToolExecution): unknown => {
    const session = exec.agent?.session
    if (session === undefined || session === null) return undefined
    const id = session.header?.id
    return typeof id === 'string' && id !== '' ? id : session
  }

  /**
   * Record a refusal: one log line, plus a desktop notification when enabled.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the refused call.
   * @param {{reason: string, target?: string, access?: string, rulePath?: string, ruleId?: string}} hit - the verdict.
   * @param {string} kind - `path` | `shell` | `exotic` | `self` | `redaction`.
   */
  const reportDenial = (exec: ToolExecution, hit: DenialHit, kind: string) => {
    ctx.logger.warn('path-guard: denied %s — %s', exec.name, String(hit.reason).split('\n')[0])
    const mode = read('notify')
    if (mode === 'off') return
    const session = sessionOf(exec)
    notifier.denial({
      kind,
      toolName: exec.name,
      ...(hit.target === undefined ? {} : { target: hit.target }),
      ...(hit.access === undefined ? {} : { access: hit.access }),
      ...(hit.rulePath === undefined ? {} : { rulePath: hit.rulePath }),
      ...(hit.ruleId === undefined ? {} : { ruleId: hit.ruleId }),
      ...(session === undefined ? {} : { sessionId: session }),
      always: mode === 'always',
    })
  }

  /**
   * Inspect a LOCAL bundle before it is installed.
   *
   * Refusing every local path was the blunt answer to the bypass that a target
   * string cannot rule out: a package the model authored in the same turn can
   * ship a patch layer doing `- id: path-guard` + `disabled: true`, and a newly
   * installed bundle's layer applies AFTER this one. But refusing them all also
   * blocks the ordinary dev loop of installing a plugin you are writing — the
   * far more common case. So the directory is read first:
   *   - an install-lifecycle script runs code at install time -> refuse;
   *   - a declared patch that mentions this row id or bundle name -> refuse;
   *   - anything unreadable -> refuse (fail-closed);
   *   - otherwise -> allow.
   * Residual: a patch that computes the row id through `!!js` instead of
   * spelling it cannot be seen by a text scan. That is deliberate effort against
   * this specific plugin, and `plugin_manager` still cannot name us directly.
   *
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the running call.
   * @returns {Promise<{reason: string, target: string} | undefined>} a denial, or undefined to allow.
   */
  const evaluateLocalInstall = async (exec: ToolExecution) => {
    if (read('selfProtection') !== true || exec.name !== 'plugin_manager') return undefined
    const args = exec.arguments
    if (args === null || typeof args !== 'object' || args.action !== 'install_bundle') return undefined
    const target = typeof args.target === 'string' ? args.target : ''
    const dir = localSpecPath(target)
    if (dir === undefined) return undefined // registry / git / tarball: handled by the guard
    const reason = (why?: string) => ({ reason: installSourceDenialText({ target, why } as unknown as { target: string; why?: string }), target })
    const fs = ctx.fs
    if (fs === undefined || typeof fs.readText !== 'function') {
      return reason('无法读取该本地包的内容（fail-closed）')
    }
    try {
      const read = async (relative: string) => {
        const resolved = await fs.resolve(join(dir, relative), { signal: exec.signal })
        return await fs.readText!(resolved, exec.signal)
      }
      const manifest = JSON.parse(await read('package.json'))
      const scripts = manifest?.scripts
      if (scripts !== null && typeof scripts === 'object') {
        for (const hook of INSTALL_HOOKS) {
          if (typeof scripts[hook] === 'string' && scripts[hook] !== '') {
            return reason(`该包声明了 ${hook} 安装脚本，安装时会执行代码`)
          }
        }
      }
      const declared = manifest?.dsh?.bundle?.patch
      const patches = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
      for (const relative of patches) {
        if (typeof relative !== 'string' || relative === '') continue
        const text = await read(relative)
        if (text.length > MAX_PATCH_BYTES) return reason(`补丁 ${relative} 过大，无法核对`)
        if (text.includes(SELF_ROW_ID) || text.includes(SELF_PACKAGE)) {
          return reason(`补丁 ${relative} 引用了本插件的 row id 或包名`)
        }
      }
      return undefined
    } catch (error) {
      ctx.logger.warn('path-guard: cannot inspect local bundle %s: %s', target, String(error))
      return reason('无法读取该本地包的内容（fail-closed）')
    }
  }

  // ---- L1: the authority on paths -----------------------------------------
  //
  // Every registration below is wrapped: an exception raised here becomes a tool
  // failure, so an internal bug would take the tool surface down with a stack
  // trace the model cannot act on. Failing closed with an actionable message is
  // the only acceptable outcome for a security control (see `internalErrorText`).
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => unknown) => {
    try {
      if (read('enabled') !== true) return next()
      const install = await evaluateLocalInstall(exec)
      if (install !== undefined) {
        reportDenial(exec, install, 'self')
        return { kind: 'deny', reason: install.reason }
      }
      const hit = await evaluatePaths(exec)
      if (hit !== undefined) {
        reportDenial(exec, hit, 'path')
        return { kind: 'deny', reason: hit.reason }
      }
      return next()
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools/pre-execute: %s', (error as { stack?: string } | undefined)?.stack ?? String(error))
      // Fail closed ONLY for calls this plugin is responsible for judging. A bug
      // here must not take away the model's unrelated tools — above all the
      // human-escalation ones (`ask_user_question`), which are how a stuck model
      // reaches the user.
      if (!governs(exec.name)) return next()
      notifier.malfunction('tools/pre-execute')
      return { kind: 'deny', reason: internalErrorText('tools/pre-execute') }
    }
  })

  // ---- L2/L5/L6: the synchronous guard ------------------------------------
  ctx.tools!.guard((exec: ToolExecution) => {
    try {
      if (read('enabled') !== true) return undefined
      // Trust is consulted FIRST, so `trustedTools` really does skip every
      // judgement this plugin makes — including `exoticTools: deny` and the shell
      // scan. Checking it only in the unmodelled branch (as an earlier version
      // did) left the promise in config.ts unfulfilled: `trustedTools: ['pwsh']`
      // looked accepted and changed nothing, because the shell branch below never
      // asked.
      //
      // ONE exception, and it is deliberate: self-protection outranks trust. A
      // trust entry is a statement about a tool's FILE ACCESS; letting it defeat
      // the guard's own integrity would let a single config line hand the AI the
      // ability to disable the plugin.
      const selfOwned = read('selfProtection') === true && exec.name === 'plugin_manager'
      if (!selfOwned && isTrustedTool(exec.name)) return undefined
      let verdict: (DenialHit & { kind: string }) | undefined
      if (selfOwned) {
        const reason = selfTargetVerdict(exec.arguments)
        verdict = reason === undefined
          ? undefined
          : { reason, kind: 'self', target: String(exec.arguments?.target ?? '') }
      } else if (read('exoticTools') === 'deny' && isExoticTool(exec.name)) {
        verdict = { reason: exoticDenialText({ toolName: exec.name }), kind: 'exotic', target: exec.name }
      } else if (SHELL_TOOLS.has(exec.name) || isScriptTool(exec.name)) {
        const opaque = evaluateOpaque(exec)
        verdict = opaque === undefined ? undefined : { ...opaque, kind: 'shell' }
      }
      if (verdict !== undefined) reportDenial(exec, verdict, verdict.kind)
      return verdict?.reason
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools.guard: %s', (error as { stack?: string } | undefined)?.stack ?? String(error))
      if (!governs(exec.name)) return undefined
      notifier.malfunction('ctx.tools.guard()')
      return internalErrorText('ctx.tools.guard()')
    }
  })

  // ---- L3: the AUTHORITATIVE write veto -----------------------------------
  //
  // `tools/pre-execute` cannot be the final authority on writes: the FsTarget it
  // resolves is NOT the one the tool later uses, so a symlink swapped in between
  // defeats it. These two waterfall events carry the target the mutation will
  // actually use (packages/fs/fs/src/index.ts:59,67) and a listener may throw to
  // veto. Three constraints come straight from the source:
  //   - `fs-observation-policy` deliberately does NOT call `next()` so it owns
  //     the single decision slot (packages/fs/fs-observation-policy/src/index.ts:119,122),
  //     and a waterfall listener that skips `next()` truncates the whole chain
  //     (vendor/cordis/src/events.ts:234-243). This MUST therefore be registered
  //     outermost via `prepend`, or it would never run — a silent fail-open.
  //   - These events are dispatched by the write/edit tools (and by
  //     `str_replace_editor`), so an actor here is always a tool call; the GUI
  //     writes through `ctx.fs` directly and never reaches them.
  //   - `decideAbsolute` returns `undefined` for "no rule matched AND
  //     defaultAccess is allow". That is an ALLOW, not an unknown: passing it
  //     through unwrapped would fail closed on every unprotected path.
  /**
   * `@deepseek-ai/dsh-fs` is not resolvable from a profile-installed bundle, so
   * this mirrors `FsError`'s contract (`message` + `code`); the tool layer keys
   * its rendering off `code`.
   */
  class PathGuardFsError extends Error {
    declare code: string
    constructor(message: string, code: string, options?: { cause?: unknown }) {
      super(message, options)
      this.name = 'FsError'
      this.code = code
    }
  }

  const fsGuard = createFsGuard({
    FsError: PathGuardFsError,
    actorIsAgent: actor => actor !== null && typeof actor === 'object',
    decide: (_targetKey, displayPath) => {
      const decision = decideAbsolute(displayPath, undefined)
      if (decision === undefined) return { access: 'allow' }
      return {
        access: decision.access,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(decision.pattern === undefined ? {} : { pattern: decision.pattern }),
      }
    },
    logger: ctx.logger,
  })
  ctx.on('fs/write-intent', fsGuard.writeIntent, { prepend: true })
  ctx.on('fs/edit-intent', fsGuard.editIntent, { prepend: true })

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
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Record<string, unknown>, next: () => unknown) => {
    try {
      if (read('enabled') !== true) return next()
      // A trusted tool skips the output filter too. Without this check the
      // promise in config.ts ("trust skips every judgement") was silently false
      // for exactly the tools people most want to trust: `trustedTools: ['pwsh']`
      // was accepted, changed nothing, and the user's shell output was still
      // withheld while the config said otherwise.
      if (isTrustedTool(exec.name)) return next()
      if (result.isError === true) return next()

      // Shell output. The same substring test as the command scan, so it
      // inherits the same limit: a command that builds the protected path
      // without ever writing it as a literal produces output this cannot
      // recognise either. Withholding the whole block is deliberate — a partial
      // redaction of arbitrary command output would be guesswork.
      if (SHELL_TOOLS.has(exec.name) || isScriptTool(exec.name)) {
        if (read('shell') !== 'scan' && !isScriptTool(exec.name)) return next()
        const needles = shellNeedles(exec)
        if (needles.length === 0) return next()
        const filtered = redactTextBlocks(result.content, needles, windows)
        if (!filtered.changed) return next()
        ctx.logger.info('path-guard: withheld a %s output block mentioning a protected path', exec.name)
        reportDenial(exec, {
          reason: `\`${exec.name}\` 的输出提到了受保护路径，已整体扣留（fail-closed）。`,
          target: '(output)',
        }, 'redaction')
        return { kind: 'accept', content: filtered.content }
      }

      if (read('searchRedaction') !== true) return next()
      const kind = exec.name
      if (kind !== 'glob' && kind !== 'grep') return next()

      const workspace = exec.agent?.session.header.cwd
      const cwd = workspace ?? process.cwd()
      const decide = (absolutePath: string) => decideAbsolute(absolutePath, workspace)?.access ?? 'allow'

      const recognized = kind === 'glob' ? isRecognizedGlobValue(result.value) : isRecognizedGrepValue(result.value)
      if (!recognized) {
        // Structure drift: we cannot prove the result is clean. Refuse it only
        // when a user rule actually protects something — the implicit
        // self-protection rules are `read`-level (the AI may read the profile
        // composition by design), so they never justify blocking a search.
        const protects = rulesOf().some(rule => rule !== null && typeof rule === 'object' && (rule as { access?: unknown }).access !== 'write')
        if (!protects) return next()
        ctx.logger.warn('path-guard: withheld an unrecognized %s result (fail-closed)', kind)
        reportDenial(exec, {
          reason: `\`${kind}\` 的返回结构无法识别，已整体扣留（fail-closed）。`,
          target: '(unrecognized result)',
        }, 'redaction')
        return { kind: 'block', feedback: [{ type: 'text', text: redactionBlockedText(kind) }] }
      }

      const redacted = kind === 'glob'
        ? redactGlobValue(result.value, { cwd, decide })
        : redactGrepValue(result.value, { cwd, decide })
      if (!redacted.changed) return next()

      ctx.logger.info('path-guard: redacted %s results under a protected path', kind)
      return { kind: 'accept', value: redacted.value }
    } catch (error) {
      ctx.logger.error('path-guard: internal error in tools/post-execute: %s', (error as { stack?: string } | undefined)?.stack ?? String(error))
      notifier.malfunction('tools/post-execute')
      return { kind: 'block', feedback: [{ type: 'text', text: internalErrorText('tools/post-execute') }] }
    }
  }, { prepend: true })

  // ---- L7: the tracked-tool list the client's trust editor suggests from -----
  //
  // The Host half knows which unmodelled tools it has SEEN (the registry in
  // `src/tracking.ts`);
  // the client half cannot see that state, and a third-party bundle has no
  // `remote.*` namespace (those are declared through DSH's API gateway, not by a
  // plugin). So the list travels over a same-origin route, which is the
  // mechanism `dsh-desktop-notify` already uses for its own `/dnotify` surface.
  //
  // Everything here is a CONVENIENCE for the trust editor's `<datalist>`, so:
  //   - `webServer` / `connection` are resolved optionally, never injected: this
  //     plugin must arm in a profile with no web server at all, and declaring
  //     them in `inject` would park activation waiting for a service that is
  //     never coming;
  //   - registration failures are logged, never thrown — a missing suggestion
  //     list must not cost the user the plugin.
  try {
    const webServer = ctx.webServer
    const connection = ctx.get('connection') as { admit?: (request: HttpRequest) => unknown } | undefined
    if (webServer === undefined || typeof webServer.register !== 'function'
      || typeof connection?.admit !== 'function' || typeof ctx.effect !== 'function') {
      ctx.logger.debug(
        'path-guard: tracked-tools endpoint not mounted (webServer=%s, admit=%s, effect=%s);'
        + ' the trust editor will simply have no suggestions',
        webServer === undefined ? 'no' : 'yes',
        typeof connection?.admit === 'function' ? 'yes' : 'no',
        typeof ctx.effect === 'function' ? 'yes' : 'no',
      )
    } else {
      const admit = connection.admit.bind(connection)
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: TRACKED_TOOLS_PATH,
        handler: (req: HttpRequest, res: HttpResponse) => {
          // Same fence the rest of the Host uses: an unauthenticated or
          // cross-origin request learns nothing, not even whether the plugin is
          // installed. There is no unauthenticated path — without `admit` this
          // route would be an unauthenticated read of runtime state.
          const admission = admit(req)
          if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
            const rejection = (admission as { rejection?: unknown }).rejection
            const status = typeof rejection === 'number' ? rejection : 403
            res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(status === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          const records = tracking.list()
          const tools = records.map(record => record.name).sort().slice(0, TRACKED_TOOLS_MAX)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            // Runtime state that changes as tools are discovered: never cache it.
            'cache-control': 'no-store',
          })
          // `tools` keeps the exact shape the client's trust editor reads;
          // `records` is the additive view on the same state (sighting counts,
          // refusals, learned fields) that makes the tracking legible.
          res.end(JSON.stringify({ tools, lastUnmodelledAt, records }))
        },
      }), 'path-guard: tracked-tools route')
      ctx.logger.info('path-guard: tracked-tools endpoint at %s', TRACKED_TOOLS_PATH)
    }
  } catch (error) {
    ctx.logger.warn('path-guard: cannot mount the tracked-tools endpoint: %s', String(error))
  }

  // Last statement of activation: the bundle/version inventory is diagnostic, so
  // it must never be able to stop the registrations above from arming. It also
  // runs after every helper it uses is initialized.
  logInstalledBundles()
}
