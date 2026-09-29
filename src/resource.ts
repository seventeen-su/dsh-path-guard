/**
 * Resource identity + capability resolution — the move from "tool-name
 * whitelist" to "operation -> resource".
 *
 * The static model (`PATH_TOOLS` in `src/tool-fields.js`) answered the wrong
 * question: "is this a tool I recognize?". DSH registers tools dynamically
 * (third-party plugins, MCP servers, runtime registration), so every tool the
 * table did not name was silently ALLOWED — a fail-open default in a security
 * control (docs/ARCHITECTURE.md §2.2).
 *
 * This module answers "what resource does this call touch, and what does it do
 * to it?" instead:
 *
 *   tool call -> resolveResources() -> [{ value, capability, field }] -> policy
 *
 * Three surfaces come out of one call:
 *
 * 1. **Modelled tools** ({@link KNOWN_TOOLS}) — the path-carrying tools DSH
 *    ships. Field names are preserved verbatim from the shipped tool
 *    definitions (the file:line evidence lives in `src/tool-fields.js`); only
 *    the operation vocabulary changed, to {@link CAPABILITY}.
 * 2. **Opaque tools** ({@link OPAQUE_TOOLS}) — shell / script surfaces whose
 *    argument is a program string. They are deliberately NOT resolved here:
 *    they keep flowing through the existing text-scan channel (`src/scan.js`).
 * 3. **Unmodelled tools** — everything else, including MCP servers and
 *    dynamically registered tools. Their string arguments are inspected with a
 *    two-legged heuristic: a field NAME that denotes a filesystem resource
 *    ({@link looksLikePathName}), OR a VALUE whose shape is a path
 *    ({@link looksLikePathValue}). A hit is reported so the CALLER can fail
 *    closed; whether to allow or deny stays the caller's decision.
 *
 * What this module deliberately does not claim:
 *  - the heuristics are heuristics. The exact accepted / rejected shapes are in
 *    the two `looksLike*` functions, and their undecidable edges are reported
 *    rather than silently widened;
 *  - an unmodelled tool is only marked `opaque` for unambiguously
 *    command-shaped field names (`command`, `script`, …); a `code` field must
 *    additionally look like a program, because `code` is also a country code;
 *  - known tools are resolved from their modelled fields ONLY. An extra,
 *    unmodelled path argument on a known tool is not discovered — that is the
 *    price of keeping the known mapping byte-identical to the existing
 *    behaviour;
 *  - nothing here reads a file, touches the filesystem, or knows about Cordis.
 *    Pure ESM, zero imports.
 *
 * @module dsh-path-guard/resource
 */

/**
 * The unified capability vocabulary. Every resource a call touches is expressed
 * as "what the call does to it", not "which tool made the call".
 *
 * `LIST` / `READ` / `WRITE` are the policy ladder's own rungs
 * (`src/policy.js` `capabilities()`, `src/index.js` `permits()`);
 * `ENUMERATE` / `EXPORT` / `EXECUTE` are the finer-grained operations the
 * resource model needs and are projected back onto the ladder by
 * {@link policyAccessFor}.
 */
export const CAPABILITY = Object.freeze({
  LIST: 'list',
  READ: 'read',
  WRITE: 'write',
  ENUMERATE: 'enumerate',
  EXPORT: 'export',
  EXECUTE: 'execute',
})

/** Every capability value in {@link CAPABILITY}: the vocabulary's literal union. */
type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY]

/**
 * Strictness ladder, used to collapse the capabilities of several resources
 * into the one capability a call needs.
 *
 * `ENUMERATE` sits with `LIST` (both only learn names), `EXPORT` with `READ`
 * (both disclose content), and `EXECUTE` above `WRITE`: an opaque program is
 * unbounded, while a write is at least a bounded resource operation.
 */
const CAPABILITY_RANK = Object.freeze({
  [CAPABILITY.LIST]: 1,
  [CAPABILITY.ENUMERATE]: 1,
  [CAPABILITY.READ]: 2,
  [CAPABILITY.EXPORT]: 2,
  [CAPABILITY.WRITE]: 3,
  [CAPABILITY.EXECUTE]: 4,
})

/** Deepest argument nesting inspected before the call counts as undecidable. */
const MAX_ARG_DEPTH = 16

/**
 * One path-bearing argument field of a modelled tool.
 *
 * `capability` is absent exactly when `byCommand` is true — then the call's
 * `command` argument decides the capability (see {@link KNOWN_TOOLS}).
 */
interface FieldSpec {
  /** The argument name, e.g. `file_path`. */
  field: string
  /** The capability this field's resource needs; absent only for a `byCommand` field. */
  capability?: Capability
  /** Fan-out: the field holds an array of objects and this key holds the path. */
  each?: string
  /** A search root: an absent argument means the caller must fall back to the session workspace. */
  root?: boolean
  /** Take the capability from the call's `command` argument instead. */
  byCommand?: boolean
}

/** One modelled tool: its path-bearing fields, plus the legacy `search` marker. */
interface KnownTool {
  paths: ReadonlyArray<FieldSpec>
  search?: string
}

/**
 * The modelled tool table, keyed by tool name.
 *
 * The explicit key list keeps literal access (`KNOWN_TOOLS.glob.paths`)
 * `undefined`-free under `noUncheckedIndexedAccess`, while the string index
 * signature is what lets the wiring look up a model-facing name dynamically.
 */
type KnownToolTable = Readonly<Record<string, KnownTool>> & Readonly<Record<
  'read' | 'read_image' | 'write' | 'edit' | 'lsp' | 'present' | 'str_replace_editor' | 'glob' | 'grep',
  KnownTool
>>

/** One resource a call touches: the path value, the capability it needs, and where it was named. */
interface Resource {
  value: string
  capability: Capability
  field: string
}

/**
 * What {@link resolveResources} reports.
 *
 * `reason` present means the call MUST be refused; `note` is informational only.
 * `actionable` exists only on the unmodelled-tool path — modelled tools carry
 * their resources directly.
 */
interface Resolution {
  known: boolean
  capability: Capability
  resources: Resource[]
  actionable?: Resource[]
  opaque: boolean
  reason?: string
  note?: string
}

/** What {@link scanUnknownArgs} hands back to {@link resolveResources}. */
interface ScanResult {
  resources: Resource[]
  actionable: Resource[]
  noted: Resource[]
  opaque: boolean
  truncated: boolean
}

/**
 * Freeze one modelled tool entry.
 * @param {ReadonlyArray<FieldSpec>} fields - the tool's path-bearing argument fields.
 * @param {{search?: string}} [extra] - extra metadata (the legacy `search` marker).
 * @returns {KnownTool} the frozen entry.
 */
const tool = (fields: ReadonlyArray<FieldSpec>, extra: { search?: string } = {}): KnownTool => Object.freeze({
  paths: Object.freeze(fields.map(field => Object.freeze(field))),
  ...extra,
})

/**
 * Tools this plugin has explicitly modelled, expressed as capability: what the
 * call does to the resource, plus where the resource is named.
 *
 * Field names, the `each` fan-out, the `root` marker and the `search` metadata
 * are byte-identical to the table they replace (`src/tool-fields.js`), so the
 * switch to the resource model does not change any known tool's verdict:
 *
 *   read / read_image      -> `file_path`                       -> READ
 *   write / edit           -> `file_path`                       -> WRITE
 *   lsp                    -> `file_path`                       -> READ
 *   present                -> `files[].path`                    -> EXPORT
 *   glob                   -> `path` (root)                     -> ENUMERATE
 *   grep                   -> `path` (root)                     -> READ
 *   str_replace_editor     -> `path`, by `command`              -> READ | WRITE
 *
 * `root: true` marks a search root: the path is a directory the call walks, and
 * when the argument is absent the CALLER must fall back to the session workspace
 * (`src/index.js` `evaluatePaths()` does this today). This module cannot: it
 * never sees the session.
 */
export const KNOWN_TOOLS: KnownToolTable = Object.freeze({
  read: tool([{ field: 'file_path', capability: CAPABILITY.READ }]),
  read_image: tool([{ field: 'file_path', capability: CAPABILITY.READ }]),
  write: tool([{ field: 'file_path', capability: CAPABILITY.WRITE }]),
  edit: tool([{ field: 'file_path', capability: CAPABILITY.WRITE }]),
  lsp: tool([{ field: 'file_path', capability: CAPABILITY.READ }]),
  present: tool([{ field: 'files', each: 'path', capability: CAPABILITY.EXPORT }]),
  str_replace_editor: tool([{ field: 'path', byCommand: true }]),
  glob: tool([{ field: 'path', capability: CAPABILITY.ENUMERATE, root: true }], { search: 'glob' }),
  grep: tool([{ field: 'path', capability: CAPABILITY.READ, root: true }], { search: 'grep' }),
})

/**
 * Shell- and script-shaped tools. Their argument is an opaque program string,
 * so there is no resource identity to extract: they keep going through the
 * existing text scan, which is best effort by construction (see the long note
 * on `SCRIPT_TOOLS` in `src/tool-fields.js`).
 *
 * Treat as read-only; it is an export so wiring can route these calls to the
 * scan channel instead of guessing.
 */
export const OPAQUE_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send', 'workflow'])

/**
 * Tools that reach the filesystem through a process or loop this plugin can
 * observe neither by argument nor by output. They are governed (the caller
 * refuses them by name under `exoticTools: deny`) but are not path resources.
 * Mirrors `EXOTIC_TOOLS` in `src/tool-fields.js`.
 */
const EXOTIC_TOOLS = new Set([
  'run_code',
  'ralph',
  'subagent_codex',
  'subagent_claude_code',
  'subagent_acp',
])

/** Prefixes of dynamically registered tools that cannot be fenced by argument. */
const EXOTIC_TOOL_PREFIXES = ['mcp__', 'cua_driver']

/** The composition-editing tool whose actions are judged by the self-protection layer. */
const SELF_GOVERNED_TOOLS = new Set(['plugin_manager'])

// ---------------------------------------------------------------------------
// field-name heuristics
// ---------------------------------------------------------------------------

/**
 * Tokens in an argument name that denote a filesystem resource. Matched against
 * whole tokens, never substrings, so `profile` does not read as `file`.
 */
const PATH_NAME_TOKENS = new Set([
  'path', 'paths', 'pathname',
  'file', 'files', 'filename', 'filenames', 'filepath', 'filepaths',
  'dir', 'dirs', 'directory', 'directories', 'folder', 'folders',
  'cwd', 'target', 'targets', 'source', 'sources', 'dest', 'destination', 'root',
])

/**
 * Compound-token suffixes that also denote a path (`targetpath`, `workdir`,
 * `homedir`). Restricted to `path`/`dir`/`folder`/`directory` on purpose:
 * suffix-matching `file` would make `profile` a path.
 */
const PATH_NAME_SUFFIXES = Object.freeze(['path', 'dir', 'folder', 'directory'])

/** Extra resource nouns recognised in TOOL names only (see {@link isGoverned}). */
const TOOL_NAME_RESOURCE_TOKENS = new Set([
  'fs', 'filesystem', 'disk', 'volume', 'mount',
])

/**
 * Field names whose value is a program, not a resource. `code` is handled
 * separately: it is just as often a country / coupon / product code.
 */
const STRONG_PROGRAM_TOKENS = new Set(['command', 'cmd', 'commandline', 'script', 'shell', 'program', 'exec'])

/** Field names that are a program only when the value also looks like one. */
const WEAK_PROGRAM_TOKENS = new Set(['code'])

/** A program string contains whitespace or a shell/code metacharacter. */
const PROGRAM_SHAPE = /[\s;|&$`(){}<>]/

/** Write-ish capability hints (the spec's list; anything unmatched defaults to WRITE). */
const WRITE_HINTS = new Set(['write', 'create', 'delete', 'remove', 'save'])

/** Read-ish capability hints. */
const READ_HINTS = new Set(['read', 'load', 'get'])

/** Listing capability hints. */
const LIST_HINTS = new Set(['list', 'dir', 'scan'])

/**
 * Split an argument / tool name into lowercase word tokens, so `filePath`,
 * `file_path` and `FILE-PATH` all yield `['file', 'path']`.
 * @param {unknown} name - the raw key or tool name.
 * @returns {string[]} the tokens.
 */
function tokensOf(name: unknown) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token !== '')
}

/**
 * Whether a field / tool name denotes a filesystem resource. This is leg one of
 * the heuristic; it matches whole tokens plus a narrow set of path-ish suffixes.
 * @param {unknown} name - the argument key or tool name.
 * @returns {boolean} true when the name reads as a path field.
 */
function looksLikePathName(name: unknown): boolean {
  return tokensOf(name).some(token => PATH_NAME_TOKENS.has(token)
    || PATH_NAME_SUFFIXES.some(suffix => token.length > suffix.length && token.endsWith(suffix)))
}

/**
 * Capability inferred from the field name. Order is write > read > list; an
 * unclassifiable name falls back to WRITE, the strictest rung.
 * @param {unknown} name - the argument key.
 * @returns {Capability} one of {@link CAPABILITY}.
 */
function inferCapability(name: unknown): Capability {
  const tokens = tokensOf(name)
  if (tokens.some(token => WRITE_HINTS.has(token))) return CAPABILITY.WRITE
  if (tokens.some(token => READ_HINTS.has(token))) return CAPABILITY.READ
  if (tokens.some(token => LIST_HINTS.has(token))) return CAPABILITY.LIST
  return CAPABILITY.WRITE
}

// ---------------------------------------------------------------------------
// value-shape heuristics
// ---------------------------------------------------------------------------

/** `C:\`, `C:/`, `C:` and drive-relative `C:foo`. */
const WINDOWS_DRIVE = /^[A-Za-z]:/

/** `\\server\share`, and the `\\?\` / `\\.\` device forms. */
const WINDOWS_UNC = /^\\\\[^\\/]+[\\/]/

/** `~`, `~/x`, `~user/x`, `$HOME`, `${HOME}/x`, `$env:USERPROFILE`, `%USERPROFILE%`. */
const HOME_HEAD = /^(?:~[A-Za-z0-9._-]*(?=[\\/]|$)|\$\{?HOME\}?(?=[\\/]|$)|\$env:(?:HOME|USERPROFILE)(?=[\\/]|$)|%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|HOME)%(?=[\\/]|$))/i

/** A `file://` locator: an unambiguous reference to a local file. */
const FILE_URL = /^file:\/\//i

/** An explicit relative path (`./x`, `..\x`) — a path even when it has spaces. */
const EXPLICIT_RELATIVE = /^\.{1,2}[\\/]/

/** A URL scheme (`https://`, `s3://`, …): not a filesystem path. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/** A date or fraction (`2026/09/30`, `1/2`) — digits and separators only. */
const NUMERIC_PATH = /^[0-9]+(?:[\\/][0-9]+)*[\\/]?$/

/**
 * First characters after a leading `/` that make a value look like a regex or
 * operator soup (`/^a$/`, `/[a-z]+/`) rather than a POSIX path. Non-ASCII and
 * punctuation that can appear in real file names are NOT excluded.
 */
const POSIX_METACHARS = new Set(['/', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '\\'])

/**
 * Whether a value is a POSIX absolute path (`/x`, and root as `/`).
 * @param {string} text - the trimmed value.
 * @returns {boolean} true when it is an absolute POSIX path.
 */
function isPosixAbsolute(text: string): boolean {
  if (!text.startsWith('/')) return false
  if (text === '/' || text === '//') return true
  const rest = text.startsWith('//') ? text.slice(2) : text.slice(1)
  // `rest` is non-empty here, so `rest[0]` is defined; the assertion only
  // satisfies `noUncheckedIndexedAccess` and is erased at emit.
  return rest !== '' && !POSIX_METACHARS.has(rest[0]!)
}

/**
 * Whether a value is an OBVIOUS relative path: a single token with a separator
 * that is not a URL, not all digits, and either contains a `.`/`..` segment,
 * ends in a file-extension-looking segment, or has two or more separators.
 *
 * This is the deliberately narrow leg. `text/html`, `application/json` and
 * `read/write` are single-separator, extension-less tokens and are NOT reported,
 * which is what keeps an unmodelled tool's ordinary enum-ish strings from being
 * mistaken for paths. A single-separator directory path without an extension
 * (`docs/guide`) is therefore missed by the value leg — the name leg is what
 * catches it.
 * @param {string} text - the trimmed, whitespace-free candidate.
 * @returns {boolean} true when it is an obvious relative path.
 */
function looksLikeRelativePath(text: string): boolean {
  if (/\s/.test(text)) return false
  // A leading separator means this is an absolute-ish form, already judged by
  // the dedicated legs above. Re-admitting it here would let a rejected regex
  // such as `/^a$/` back in through the separator count.
  if (text.startsWith('/') || text.startsWith('\\')) return false
  if (URL_SCHEME.test(text)) return false
  if (NUMERIC_PATH.test(text)) return false
  if (!/[\\/]/.test(text)) return false
  if (/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(text)) return true
  if (/[\\/][^\s\\/]*\.[A-Za-z0-9]{1,12}$/.test(text)) return true
  return (text.match(/[\\/]/g)?.length ?? 0) >= 2
}

/**
 * Whether a raw argument value has the shape of a filesystem path. Leg two of
 * the heuristic: absolute forms, home / env-var heads, `file://`, an explicit
 * `./` / `../`, or an obvious relative path.
 * @param {string} raw - the argument value.
 * @returns {boolean} true when the value looks like a path.
 */
function looksLikePathValue(raw: string): boolean {
  const text = raw.trim()
  if (text === '') return false
  if (WINDOWS_DRIVE.test(text) || WINDOWS_UNC.test(text) || isPosixAbsolute(text)) return true
  if (HOME_HEAD.test(text) || FILE_URL.test(text)) return true
  if (EXPLICIT_RELATIVE.test(text)) return true
  return looksLikeRelativePath(text)
}

/**
 * Whether a field name names a program (`command`, `script`, …). `code` only
 * counts when the value also looks like a program, because `code` is also a
 * country / coupon / product code.
 * @param {unknown} name - the argument key.
 * @param {string} value - the trimmed argument value.
 * @returns {boolean} true when the field holds an opaque program.
 */
function looksLikeProgramField(name: unknown, value: string): boolean {
  const tokens = tokensOf(name)
  if (tokens.some(token => STRONG_PROGRAM_TOKENS.has(token))) return true
  return tokens.some(token => WEAK_PROGRAM_TOKENS.has(token)) && PROGRAM_SHAPE.test(value)
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * The strictest capability of a set, or undefined when the set is empty.
 * @param {ReadonlyArray<Capability>} capabilities - candidate capabilities.
 * @returns {Capability | undefined} the strictest one.
 */
function strictestCapability(capabilities: ReadonlyArray<Capability>): Capability | undefined {
  let strictest: Capability | undefined
  for (const capability of capabilities) {
    const rank = CAPABILITY_RANK[capability] ?? 0
    if (strictest === undefined || rank > (CAPABILITY_RANK[strictest] ?? 0)) strictest = capability
  }
  return strictest
}

/**
 * The accessor notation used in a resource's `field`, e.g. `file_path` or
 * `files[].path`. Only used for messages, never for lookup.
 * @param {FieldSpec} spec - the field spec.
 * @returns {string} the accessor notation.
 */
function fieldNotation(spec: FieldSpec): string {
  return spec.each === undefined ? spec.field : `${spec.field}[].${spec.each}`
}

/**
 * Every non-blank string value a modelled field contributes, mirroring
 * `collectPaths()` in `src/tool-fields.js` exactly (including not trimming).
 * @param {unknown} args - the parsed tool arguments.
 * @param {FieldSpec} spec - the field spec.
 * @returns {string[]} the values present.
 */
function modelledValues(args: unknown, spec: FieldSpec): string[] {
  if (args === null || typeof args !== 'object') return []
  // `as` is erased at emit, not a runtime coercion: the arguments are the parsed
  // JSON object the caller already hands over.
  const raw = (args as Record<string, unknown>)[spec.field]
  const values = spec.each === undefined
    ? [raw]
    : Array.isArray(raw)
      ? raw.map(entry => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)[spec.each!] : undefined))
      : []
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

/**
 * The capability a `str_replace_editor` call needs, from its `command`. Mirrors
 * `opForCommand()` in `src/tool-fields.js`: `view` reads, everything else —
 * including a missing command — writes.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {Capability} {@link CAPABILITY.READ} or {@link CAPABILITY.WRITE}.
 */
function commandCapability(args: unknown): Capability {
  // `as` is erased at emit; the guard in the same expression already proved the
  // value is an object.
  const command = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).command : undefined
  return command === 'view' ? CAPABILITY.READ : CAPABILITY.WRITE
}

/**
 * Resolve a modelled tool's resources.
 * @param {KnownTool} spec - the {@link KNOWN_TOOLS} entry.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {Resolution} the resolution.
 */
function resolveKnown(spec: KnownTool, args: unknown): Resolution {
  const resources: Resource[] = []
  const capabilities: Capability[] = []
  for (const field of spec.paths) {
    // `capability` is absent only on a `byCommand` field, which the left branch
    // already answered. The assertion is erased at emit; a hypothetical
    // `undefined` would still collapse onto WRITE below (fail-closed).
    const capability = field.byCommand === true ? commandCapability(args) : field.capability!
    capabilities.push(capability)
    for (const value of modelledValues(args, field)) {
      resources.push({ value, capability, field: fieldNotation(field) })
    }
  }
  return {
    known: true,
    capability: strictestCapability(capabilities) ?? CAPABILITY.WRITE,
    resources,
    opaque: false,
  }
}

/**
 * Walk an unmodelled tool's arguments and collect the resources the heuristics
 * can see, plus whether any argument is an opaque program.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {ScanResult} what was found.
 */
function scanUnknownArgs(args: unknown): ScanResult {
  const resources: Resource[] = []
  /** Values whose SHAPE is a path: real evidence, safe to refuse on. */
  const actionable: Resource[] = []
  /** Values collected on the field-NAME leg alone: reported, never a ground to refuse. */
  const noted: Resource[] = []
  const seen = new WeakSet<object>()
  let opaque = false
  let truncated = false

  /**
   * Judge one string argument.
   *
   * A program-shaped field is NOT mutually exclusive with a resource: a value
   * like `D:/tools/x.exe` under `command` is both something opaque to execute
   * and a path a rule may protect, so both facts are reported and the caller can
   * act on either.
   * @param {string} raw - the value.
   * @param {string} field - the accessor notation.
   * @param {string} key - the immediate argument name.
   */
  const visit = (raw: string, field: string, key: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const named = looksLikePathName(key)
    const valueShaped = looksLikePathValue(trimmed)
    if (!named && looksLikeProgramField(key, trimmed)) opaque = true
    if (!named && !valueShaped) return
    // The stored value is trimmed: leading/trailing blanks are not part of a
    // resource identity, and keeping them would let ` C:/secrets ` be judged as
    // a cwd-relative path while the tool itself reads the trimmed one.
    const resource: Resource = { value: trimmed, capability: inferCapability(key), field }
    resources.push(resource)
    // WHICH leg matched is what the caller needs, so it is kept OUT of the
    // resource shape (that stays `{value, capability, field}`) and reported as
    // two lists instead. Separating them inside the resource objects would let a
    // consumer treat a name-leg match as evidence, and `{dir:'asc'}` would then
    // deny every MIME type and enum value on unmodelled tools.
    ;(valueShaped ? actionable : noted).push(resource)
  }

  /**
   * Recurse into objects and arrays.
   * @param {unknown} node - the current value.
   * @param {string} prefix - the accessor notation of the container.
   * @param {string} key - the argument name that led here.
   * @param {number} depth - the current nesting depth.
   */
  const walk = (node: unknown, prefix: string, key: string, depth: number) => {
    if (depth > MAX_ARG_DEPTH) {
      truncated = true
      return
    }
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      const item = prefix === '' ? '[]' : `${prefix}[]`
      // The `as` casts below only pin down what `Array.isArray` / `Object.entries`
      // already narrowed; they are erased at emit.
      for (const entry of node as ReadonlyArray<unknown>) {
        if (typeof entry === 'string') visit(entry, item, key)
        else walk(entry, item, key, depth + 1)
      }
      return
    }
    for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
      const field = prefix === '' ? name : `${prefix}.${name}`
      if (typeof value === 'string') visit(value, field, name)
      else walk(value, field, name, depth + 1)
    }
  }

  walk(args, '', '', 0)
  return { resources, actionable, noted, opaque, truncated }
}

/**
 * Resolve a modelled tool's resources, or heuristically resolve an unmodelled
 * one. Never throws for non-object arguments.
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed, deep-frozen tool arguments.
 * @returns {Resolution} the resolution. `reason` present means the call MUST be refused; `note` is informational only.
 *
 * `toolName` is typed `unknown` on purpose: the guard below is the contract, and
 * callers really do hand over non-strings (the specs pin that down). Widening it
 * from `string` is type-only — the runtime is unchanged.
 */
export function resolveResources(toolName: unknown, args: unknown): Resolution {
  const name = typeof toolName === 'string' ? toolName : ''

  if (OPAQUE_TOOLS.has(name)) {
    return { known: true, capability: CAPABILITY.EXECUTE, resources: [], opaque: true }
  }

  const spec = KNOWN_TOOLS[name]
  if (spec !== undefined) return resolveKnown(spec, args)

  const { resources, actionable, noted, opaque, truncated } = scanUnknownArgs(args)
  const capabilities: Capability[] = resources.map(resource => resource.capability)
  if (opaque) capabilities.push(CAPABILITY.EXECUTE)

  const result: Resolution = {
    known: false,
    capability: strictestCapability(capabilities) ?? CAPABILITY.WRITE,
    resources,
    actionable,
    opaque,
  }
  const fieldsOf = (list: ReadonlyArray<Resource>): string => [...new Set(list.map(resource => resource.field))].join(', ')

  // The caller needs the grounds for a fail-closed decision, not just the list.
  if (actionable.length > 0) {
    result.reason = `工具 \`${name}\` 未被建模，但参数 ${fieldsOf(actionable)} 的取值形态是路径；`
      + `按最严能力「${result.capability}」处理（fail-closed）。`
    if (truncated) {
      result.reason += ` 另有参数嵌套超过 ${MAX_ARG_DEPTH} 层，未能确认其中是否含路径。`
    }
  } else if (truncated) {
    result.reason = `工具 \`${name}\` 未被建模，且参数嵌套超过 ${MAX_ARG_DEPTH} 层，无法确认其中是否含路径（fail-closed）。`
  }
  if (noted.length > 0) {
    result.note = `工具 \`${name}\` 未被建模，参数 ${fieldsOf(noted)} 的名字像路径字段但取值不像路径；`
      + '不据此拒绝（否则 MIME 类型、枚举值会被大面积误拦）。'
  }

  return result
}

/**
 * Whether this plugin is responsible for judging a tool call.
 *
 * This is a NAME-ONLY classifier — it never sees the arguments — so it answers
 * "could this surface touch a resource?", not "does this call touch one?". It
 * replaces the `governs()` predicate in `src/index.js`, which needs exactly
 * that: a synchronous, argument-free answer on the internal-error path, where
 * an ungoverned call must keep working (above all `ask_user_question`) while a
 * governed one fails closed.
 *
 * True for: modelled path tools, opaque shell / script tools, the exotic and
 * composition-editing surfaces the plugin refuses by name, and unmodelled tools
 * whose NAME reads as filesystem work (`read_file`, `mcp__fs__write_path`, …).
 * False for an unmodelled tool with no resource wording in its name.
 *
 * Note that MCP and desktop-driver prefixes count as governed through the
 * exotic surface, so an MCP tool is never silently ungoverned.
 * @param {unknown} toolName - the model-facing tool name; non-strings are simply not governed.
 * @returns {boolean} true when a call to this tool is this plugin's business.
 *
 * `toolName` is typed `unknown` on purpose: the `typeof` guard below is the
 * contract (the specs pin non-string inputs to `false`), and widening it from
 * `string` is type-only — the runtime is unchanged.
 */
export function isGoverned(toolName: unknown): boolean {
  const name = typeof toolName === 'string' ? toolName : ''
  if (name === '') return false
  if (KNOWN_TOOLS[name] !== undefined) return true
  if (OPAQUE_TOOLS.has(name)) return true
  if (EXOTIC_TOOLS.has(name)) return true
  if (EXOTIC_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) return true
  if (SELF_GOVERNED_TOOLS.has(name)) return true
  return tokensOf(name).some(token => TOOL_NAME_RESOURCE_TOKENS.has(token)) || looksLikePathName(name)
}

/**
 * Project a capability onto the policy ladder (`none` / `list` / `read` /
 * `write`) that `src/policy.js` `capabilities()` and `src/index.js` `permits()`
 * understand.
 *
 * `EXPORT` maps to `list` to keep `present` behaving exactly as it does today
 * (the legacy table gave it `op: OP.LIST`), even though exporting a file
 * discloses content and `read` would be the stricter reading. That is a policy
 * decision, not a resolution one — flipping it here would silently change
 * verdicts for every existing rule.
 * `capability` also accepts `undefined`: the `default` branch IS the contract for
 * anything unrecognised (the specs pin `policyAccessFor(undefined)` to `'write'`),
 * so the widening is type-only and the runtime is unchanged.
 * @param {string | undefined} capability - one of {@link CAPABILITY}, or anything unrecognised.
 * @returns {'list' | 'read' | 'write'} the policy ladder rung.
 */
export function policyAccessFor(capability: string | undefined): 'list' | 'read' | 'write' {
  switch (capability) {
    case CAPABILITY.LIST:
    case CAPABILITY.ENUMERATE:
    case CAPABILITY.EXPORT:
      return 'list'
    case CAPABILITY.READ:
      return 'read'
    case CAPABILITY.WRITE:
    case CAPABILITY.EXECUTE:
      return 'write'
    default:
      return 'write'
  }
}
