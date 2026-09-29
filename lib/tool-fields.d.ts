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
export declare const OP: {
    LIST: string;
    READ: string;
    WRITE: string;
};
/**
 * Tools that name paths in their arguments.
 *
 * `root: true` marks a search root: the path is a directory the call will walk,
 * so the operation is what the call does with everything it finds. `glob` only
 * lists names (so `list` suffices), while `grep` returns matched content and
 * therefore needs `read` on the root itself.
 */
export declare const PATH_TOOLS: {
    read: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    read_image: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    write: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    edit: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    lsp: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    present: {
        paths: {
            field: string;
            each: string;
            op: string;
        }[];
    };
    str_replace_editor: {
        paths: {
            field: string;
            op: string;
        }[];
    };
    glob: {
        paths: {
            field: string;
            op: string;
            root: boolean;
        }[];
        search: string;
    };
    grep: {
        paths: {
            field: string;
            op: string;
            root: boolean;
        }[];
        search: string;
    };
};
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
export declare const SHELL_TOOLS: Set<string>;
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
export declare const SCRIPT_TOOLS: Map<string, string>;
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
export declare const EXOTIC_TOOLS: Set<string>;
/** Prefixes of dynamically registered exotic tools (MCP servers, desktop drivers). */
export declare const EXOTIC_TOOL_PREFIXES: string[];
/**
 * The operation a `str_replace_editor` call performs, decided by its `command`.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string} one of {@link OP}.
 */
export declare function opForCommand(args: unknown): string;
/**
 * Whether a tool carries an opaque program string this plugin can scan.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true for a script tool.
 */
export declare function isScriptTool(toolName: string): boolean;
/**
 * The program text of a script-shaped tool call.
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string | undefined} the script text, when present.
 */
export declare function scriptOf(toolName: string, args: unknown): string | undefined;
/**
 * Whether a tool name belongs to a surface the plugin refuses by default.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true when the tool cannot be fenced.
 */
export declare function isExoticTool(toolName: string): boolean;
/**
 * Every path value a call supplies for one spec field.
 * @param {unknown} args - the parsed tool arguments.
 * @param {{field: string, each?: string}} spec - the field spec.
 * @returns {string[]} the path strings present (blank values dropped).
 */
export declare function collectPaths(args: unknown, spec: {
    field: string;
    each?: string | undefined;
}): unknown[];
