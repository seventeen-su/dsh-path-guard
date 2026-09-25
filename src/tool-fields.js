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
 * parsing it, and filters the output. This is explicitly best-effort.
 */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send'])

/**
 * Tools that reach the filesystem through a process or loop this plugin cannot
 * observe at all. `run_code` is a real Node/Python process
 * (packages/ptc-runtime/ptc-runtime-node/src/index.ts:68), MCP tools have
 * server-supplied schemas, and the codex/claude-code subagents run their own
 * agent loop in a child process.
 */
export const EXOTIC_TOOLS = new Set([
  'run_code',
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
export function opForCommand(args) {
  const command = args !== null && typeof args === 'object' ? args.command : undefined
  return typeof command === 'string' && SRE_READ_COMMANDS.has(command) ? OP.READ : OP.WRITE
}

/**
 * Whether a tool name belongs to a surface the plugin refuses by default.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true when the tool cannot be fenced.
 */
export function isExoticTool(toolName) {
  if (EXOTIC_TOOLS.has(toolName)) return true
  return EXOTIC_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix))
}

/**
 * Every path value a call supplies for one spec field.
 * @param {unknown} args - the parsed tool arguments.
 * @param {{field: string, each?: string}} spec - the field spec.
 * @returns {string[]} the path strings present (blank values dropped).
 */
export function collectPaths(args, spec) {
  if (args === null || typeof args !== 'object') return []
  const raw = args[spec.field]
  const values = spec.each === undefined
    ? [raw]
    : Array.isArray(raw)
      ? raw.map(entry => (entry !== null && typeof entry === 'object' ? entry[spec.each] : undefined))
      : []
  return values.filter(value => typeof value === 'string' && value.trim() !== '')
}
