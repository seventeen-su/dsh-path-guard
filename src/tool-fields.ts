/**
 * Model-facing tools, and where their path arguments live.
 *
 * Field names are taken from the shipped tool definitions, not guessed:
 *   read / read_image / write / edit -> `file_path`
 *     (packages/fs/tool-fs/src/read.ts:81, write.ts:76, edit.ts:88, read-image.ts:214)
 *   glob -> `pattern` + optional `path`   (packages/fs/tool-fs-search/src/glob.ts:311)
 *   grep -> `pattern` + optional `path`   (packages/fs/tool-fs-search/src/grep.ts:288)
 *   present -> `files[].path`             (packages/deliverables/tool-present/src/index.ts:44-51)
 *   str_replace_editor -> `command` + absolute `path`
 *     (packages/fs/tool-str-replace-editor/src/index.ts:429-432)
 *
 * Anything not listed here has no path argument we know how to read; the
 * plugin then stays out of the way rather than guessing.
 *
 * @module dsh-path-guard/tool-fields
 */

/** An operation a call performs on a path. Mirrors the policy access ladder. */
export const OP = { LIST: 'list', READ: 'read', WRITE: 'write' }

/**
 * Tools that name paths in their arguments.
 *
 * `root: true` marks a search root: the path is a directory the call will walk,
 * so the operation is what the call does with everything it finds. `glob` only
 * lists names (so `list` suffices), while `grep` returns matched content and
 * therefore needs `read` on the root itself.
 */
export const PATH_TOOLS = {
  read: { paths: [{ field: 'file_path', op: OP.READ }] },
  read_image: { paths: [{ field: 'file_path', op: OP.READ }] },
  write: { paths: [{ field: 'file_path', op: OP.WRITE }] },
  edit: { paths: [{ field: 'file_path', op: OP.WRITE }] },
  lsp: { paths: [{ field: 'file_path', op: OP.READ }] },
  present: { paths: [{ field: 'files', each: 'path', op: OP.LIST }] },
  str_replace_editor: { paths: [{ field: 'path', op: 'by-command' }] },
  glob: { paths: [{ field: 'path', op: OP.LIST, root: true }], search: 'glob' },
  grep: { paths: [{ field: 'path', op: OP.READ, root: true }], search: 'grep' },
}

/**
 * Shell-shaped tools. Their command text is opaque: a shell string is
 * Turing-complete, so the plugin scans it for protected paths instead of
 * parsing it, and (best effort) withholds output blocks that mention one.
 *
 * This is NOT a boundary. Any spelling that does not contain the protected
 * path as a literal substring — `"$(echo ~)/.ssh/id_rsa"`,
 * `Join-Path $HOME '.ssh/id_rsa'`, a glob like `~/.ss?/id_rsa`, or a one-liner
 * that builds the path inside another interpreter — passes the scan, and then
 * the output filter has nothing to match on either. `shell: deny` is the only
 * setting that actually closes this channel.
 */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send'])

/**
 * Tools whose argument is an opaque PROGRAM string. Their text is scanned for
 * protected paths exactly like a shell command — best effort — instead of being
 * refused outright.
 *
 * `workflow` deserves the nuance. Its script runs in a `node:vm` context that
 * DSH's own test escapes on purpose (`globalThis.constructor.constructor('return
 * process')()`, packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts:58),
 * and under `danger-full-access` the runtime it spawns is not confined
 * (packages/ptc-runtime/ptc-runtime-node/src/index.ts:224). Refusing it outright
 * closes that hole but costs a headline capability in EVERY session, including
 * the ones that never touch a protected path — which is a bad trade. Scanning
 * the script keeps the capability and still rejects the naive case; the escape
 * remains a documented hole, and `exoticTools: deny` is there for anyone who
 * wants it closed.
 */
export const SCRIPT_TOOLS = new Map([['workflow', 'script']])

/**
 * Tools that reach the filesystem through a process or loop this plugin can
 * observe neither by argument nor by output.
 *
 * - `run_code` is a real Node/Python process whose code argument this plugin has
 *   no verified field name for (packages/ptc-runtime/ptc-runtime-node/src/index.ts:68).
 * - `ralph` drives repeated subagent rounds.
 * - MCP tools carry server-supplied schemas.
 * - The codex/claude-code/acp subagents run their own agent loop in a child process.
 */
export const EXOTIC_TOOLS = new Set([
  'run_code',
  'ralph',
  'subagent_codex',
  'subagent_claude_code',
  'subagent_acp',
])

/** Prefixes of dynamically registered exotic tools (MCP servers, desktop drivers). */
export const EXOTIC_TOOL_PREFIXES = ['mcp__', 'cua_driver']

/** `str_replace_editor` command values that only observe the file. */
const SRE_READ_COMMANDS = new Set(['view'])

/**
 * The operation a `str_replace_editor` call performs, decided by its `command`.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string} one of {@link OP}.
 */
export function opForCommand(args: unknown): string {
  const command = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).command : undefined
  return typeof command === 'string' && SRE_READ_COMMANDS.has(command) ? OP.READ : OP.WRITE
}

/**
 * Whether a tool carries an opaque program string this plugin can scan.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true for a script tool.
 */
export function isScriptTool(toolName: string): boolean {
  return SCRIPT_TOOLS.has(toolName)
}

/**
 * The program text of a script-shaped tool call.
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string | undefined} the script text, when present.
 */
export function scriptOf(toolName: string, args: unknown): string | undefined {
  const field = SCRIPT_TOOLS.get(toolName)
  if (field === undefined || args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Whether a tool name belongs to a surface the plugin refuses by default.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true when the tool cannot be fenced.
 */
export function isExoticTool(toolName: string): boolean {
  if (EXOTIC_TOOLS.has(toolName)) return true
  return EXOTIC_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix))
}

/**
 * Every path value a call supplies for one spec field.
 * @param {unknown} args - the parsed tool arguments.
 * @param {{field: string, each?: string}} spec - the field spec.
 * @returns {string[]} the path strings present (blank values dropped).
 */
export function collectPaths(args: unknown, spec: { field: string; each?: string | undefined }) {
  if (args === null || typeof args !== 'object') return []
  const raw = (args as Record<string, unknown>)[spec.field]
  const values = spec.each === undefined
    ? [raw]
    : Array.isArray(raw)
      ? raw.map(entry => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)[spec.each!] : undefined))
      : []
  return values.filter(value => typeof value === 'string' && value.trim() !== '')
}
