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
export declare const CAPABILITY: Readonly<{
    LIST: "list";
    READ: "read";
    WRITE: "write";
    ENUMERATE: "enumerate";
    EXPORT: "export";
    EXECUTE: "execute";
}>;
/** Every capability value in {@link CAPABILITY}: the vocabulary's literal union. */
type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];
/**
 * One path-bearing argument field of a modelled tool.
 *
 * `capability` is absent exactly when `byCommand` is true — then the call's
 * `command` argument decides the capability (see {@link KNOWN_TOOLS}).
 */
interface FieldSpec {
    /** The argument name, e.g. `file_path`. */
    field: string;
    /** The capability this field's resource needs; absent only for a `byCommand` field. */
    capability?: Capability;
    /** Fan-out: the field holds an array of objects and this key holds the path. */
    each?: string;
    /** A search root: an absent argument means the caller must fall back to the session workspace. */
    root?: boolean;
    /** Take the capability from the call's `command` argument instead. */
    byCommand?: boolean;
}
/** One modelled tool: its path-bearing fields, plus the legacy `search` marker. */
interface KnownTool {
    paths: ReadonlyArray<FieldSpec>;
    search?: string;
}
/**
 * The modelled tool table, keyed by tool name.
 *
 * The explicit key list keeps literal access (`KNOWN_TOOLS.glob.paths`)
 * `undefined`-free under `noUncheckedIndexedAccess`, while the string index
 * signature is what lets the wiring look up a model-facing name dynamically.
 */
type KnownToolTable = Readonly<Record<string, KnownTool>> & Readonly<Record<'read' | 'read_image' | 'write' | 'edit' | 'lsp' | 'present' | 'str_replace_editor' | 'glob' | 'grep', KnownTool>>;
/** One resource a call touches: the path value, the capability it needs, and where it was named. */
interface Resource {
    value: string;
    capability: Capability;
    field: string;
}
/**
 * What {@link resolveResources} reports.
 *
 * `reason` present means the call MUST be refused; `note` is informational only.
 * `actionable` exists only on the unmodelled-tool path — modelled tools carry
 * their resources directly.
 */
interface Resolution {
    known: boolean;
    capability: Capability;
    resources: Resource[];
    actionable?: Resource[];
    opaque: boolean;
    reason?: string;
    note?: string;
}
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
export declare const KNOWN_TOOLS: KnownToolTable;
/**
 * Shell- and script-shaped tools. Their argument is an opaque program string,
 * so there is no resource identity to extract: they keep going through the
 * existing text scan, which is best effort by construction (see the long note
 * on `SCRIPT_TOOLS` in `src/tool-fields.js`).
 *
 * Treat as read-only; it is an export so wiring can route these calls to the
 * scan channel instead of guessing.
 */
export declare const OPAQUE_TOOLS: Set<string>;
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
export declare function resolveResources(toolName: unknown, args: unknown): Resolution;
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
export declare function isGoverned(toolName: unknown): boolean;
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
export declare function policyAccessFor(capability: string | undefined): 'list' | 'read' | 'write';
export {};
