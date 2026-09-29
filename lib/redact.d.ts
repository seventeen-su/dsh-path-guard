/**
 * Structured redaction of the `glob` / `grep` tool RESULT VALUES.
 *
 * The two search tools do not go through `ctx.fs`; they spawn the packaged
 * ripgrep binary directly, so a filesystem-level fence cannot see them. The
 * `tools/post-execute` seam is the interception point, and the canonical
 * structured `value` is the lever — replacing it makes the runtime re-render
 * text AND re-project `meta` from the redacted value (see "WHY VALUE" below).
 *
 * This module is pure, synchronous, dependency-free (only `node:path`), ESM,
 * never mutates its input, and never throws on a structure it does not know.
 * The caller keeps its own fail-closed gate via `isRecognized*Value`.
 *
 * ===========================================================================
 * CONFIRMED VALUE STRUCTURES (read from D:\Program\deepseek-harness @ this session)
 * ===========================================================================
 *
 * `glob` — value is `{ root: string, paths: string[] }` (FLAT; no grouping).
 *
 *   packages/fs/tool-fs-search/src/glob.ts:321-329
 *     output: {
 *       schema: {
 *         type: 'object',
 *         additionalProperties: false,
 *         properties: {
 *           root: { type: 'string', required: true },
 *           paths: { type: 'array', required: true, items: { type: 'string' } },
 *         },
 *       },
 *
 *   packages/fs/tool-fs-search/src/glob.ts:340,348  (execute return)
 *     if (run.noMatches) return { root, paths: [] }
 *     ...
 *     return { root, paths: all }
 *   → the ONLY two shapes: `paths` empty (exit 1 / no matches) and `paths`
 *     populated. `root` is always present. There is no grouped variant and no
 *     cap-dependent variant in the value: the inline cap (`globMaxResults`) is
 *     applied later, inside `render`/`presentationMeta`, never to the value
 *     (glob.ts:330-334). A capped result therefore reaches us with the COMPLETE
 *     path list.
 *
 * `grep` — value is `{ matches: Array<{ path, lineNumber, line }> }` (FLAT
 * per-match list; NOT grouped by file).
 *
 *   packages/fs/tool-fs-search/src/grep.ts:294-313
 *     output: {
 *       schema: {
 *         type: 'object',
 *         additionalProperties: false,
 *         properties: {
 *           matches: {
 *             type: 'array',
 *             required: true,
 *             items: {
 *               type: 'object',
 *               additionalProperties: false,
 *               properties: {
 *                 path: { type: 'string', required: true },
 *                 lineNumber: { type: 'integer', required: true },
 *                 line: { type: 'string', required: true },
 *               },
 *             },
 *           },
 *         },
 *       },
 *
 *   packages/fs/tool-fs-search/src/grep.ts:324,335  (execute return)
 *     if (run.noMatches) return { matches: [] }
 *     ...
 *     return { matches: all }
 *   → the ONLY two shapes: `matches` empty and `matches` populated. One flat
 *     entry per matched LINE, carrying the matched line TEXT.
 *
 *   The by-file grouping the model-facing text shows is derived at render time
 *   (grep.ts:191-203 `formatGrepMatches`), and the grouped shape exists ONLY in
 *   the card metadata, not in the value:
 *   packages/fs/tool-fs-search/src/presentation.ts:60-68
 *     { shape: 'matches', files: [{ path, matches: [{ lineNumber, line }] }], ... }
 *   So there is no file-group wrapper in the value that could be left as an
 *   empty shell: dropping every match of a file drops the file entirely. Tests
 *   assert exactly that, and additionally re-group the redacted flat list the
 *   way `formatGrepMatches` does to prove no empty section can appear.
 *
 * PATHS ARE DISPLAY PATHS, NOT NECESSARILY RELATIVE AND NOT NECESSARILY ABSOLUTE
 *   packages/fs/tool-fs-search/src/search-core.ts:300-306 `toWorkdirRelative`
 *     absolute inside workdir → workdir-RELATIVE (platform separator)
 *     relative input          → unchanged
 *     absolute outside workdir→ unchanged (stays ABSOLUTE)
 *   Both call sites relativize against the run workdir, NOT against `root`
 *   (glob.ts:339-347), so `root` must never be used as the join base.
 *   Real mixed sample: tests/tools.spec.ts:740
 *     { root: '.', paths: [join('src','a.ts'), '/elsewhere/b.ts', 'rel/c.ts'] }
 *   → every entry is resolved with `path.resolve(cwd, entry)`, which handles a
 *   relative path, a platform-separator path, and an already-absolute path
 *   uniformly.
 *
 * WHY VALUE, AND WHY IT IS SUFFICIENT (and covers the card metadata too)
 *   packages/core/tools/src/index.ts:1803-1813 — an `accept` decision carrying
 *   `value` calls `createSuccessResult(exec, tool, decision.value)`;
 *   index.ts:1832-1862 — that helper re-validates the new value against
 *   `tool.output.schema`, re-runs `tool.output.render(...)` to rebuild `content`,
 *   and re-runs `tool.output.presentationMeta(...)` to rebuild `meta` (top-level
 *   calls; `meta` is skipped for subagent calls, index.ts:1845). So a redacted
 *   value yields redacted text and a redacted search card, with no stale
 *   original left behind. Two consequences this module respects:
 *     1. the returned value MUST still satisfy the declared schema (exact keys,
 *        exact types) or the replacement throws `ToolOutputError`;
 *     2. `root` is schema-required, so it is always carried through unchanged.
 *   Because `additionalProperties: false` is declared for both values, a
 *   genuine value can never carry an unknown key; recognition mirrors the
 *   schema exactly (unknown key ⇒ unrecognized ⇒ caller fail-closed) so a
 *   future field can never be forwarded unredacted.
 *
 * ===========================================================================
 * REDACTION SEMANTICS (from the task spec)
 * ===========================================================================
 * `decide(absolutePath) -> 'none' | 'list' | 'read' | 'write' | 'allow'`
 *   glob  (file NAMES only): drop `none`; KEEP `list`/`read`/`write`/`allow`.
 *   grep  (matched line CONTENT): drop `none` AND `list`; keep
 *         `read`/`write`/`allow`.
 *
 * Deliberate fail-closed choices (documented, not incidental):
 *   - a decision outside that vocabulary, a non-string decision, or a
 *     `decide()` throw drops the entry (over-redaction, never under-);
 *   - an unrecognized structure returns `{ changed: false, value }` with the
 *     ORIGINAL reference and makes `isRecognized*Value` return false, so the
 *     caller decides whether to block the whole result;
 *   - no-op results return the SAME reference, as the spec requires — safe
 *     here precisely because a recognized value has only schema-known fields;
 *   - a missing/non-callable `ctx.decide` is a caller contract violation, not
 *     an unrecognized structure: it throws a TypeError rather than silently
 *     returning an unredacted result that the caller would accept.
 *
 * @module dsh-path-guard/redact
 */
/**
 * Whether `value` is the declared `glob` output value:
 * `{ root: string, paths: string[] }` with no unknown key — the empty `paths`
 * variant (a search with no matches) included.
 *
 * Never throws. A false result is the caller's fail-closed signal.
 *
 * @param {unknown} value - the raw tool result value.
 * @returns {boolean} true only for the exact declared structure.
 */
export declare function isRecognizedGlobValue(value: unknown): boolean;
/**
 * Whether `value` is the declared `grep` output value:
 * `{ matches: Array<{ path: string, lineNumber: integer, line: string }> }` with
 * no unknown key — the empty `matches` variant (no matches) included.
 *
 * Never throws. A false result is the caller's fail-closed signal.
 *
 * @param {unknown} value - the raw tool result value.
 * @returns {boolean} true only for the exact declared structure.
 */
export declare function isRecognizedGrepValue(value: unknown): boolean;
/**
 * Redact one `glob` result value: drop every path whose decision is `none`.
 *
 * `list` is KEPT here — `glob` exposes file names only, which is the
 * "visible file name" half-access semantic.
 *
 * @param {unknown} value - the raw `glob` value (`{ root, paths }`).
 * @param {{cwd?: string, decide: (absolutePath: string) => string}} ctx - `cwd`
 *   resolves relative display paths; `decide` returns the access decision.
 * @returns {{changed: boolean, value: T}} `changed: false` with the SAME `value`
 *   reference when nothing was dropped (including an unrecognized structure and
 *   an empty result); otherwise `changed: true` with a NEW object. The value is
 *   typed by the caller's own parameter type: a caller holding `unknown` gets
 *   `unknown` back, which keeps every call site honest without a cast.
 * @throws {TypeError} when `ctx.decide` is not callable.
 */
export declare function redactGlobValue<T>(value: T, ctx: {
    cwd?: string;
    decide: (absolutePath: string) => string;
}): {
    changed: boolean;
    value: T;
};
/**
 * Redact one `grep` result value: drop every match whose decision is `none` or
 * `list`.
 *
 * `list` is dropped here — `grep` returns matched line CONTENT, which the
 * `list` tier must not see. Dropping a file's last match removes the file
 * entirely (the value is flat; grouping happens only at render time), so no
 * empty file shell can survive.
 *
 * @param {unknown} value - the raw `grep` value (`{ matches }`).
 * @param {{cwd?: string, decide: (absolutePath: string) => string}} ctx - `cwd`
 *   resolves relative display paths; `decide` returns the access decision.
 * @returns {{changed: boolean, value: unknown}} `changed: false` with the SAME
 *   `value` reference when nothing was dropped (including an unrecognized
 *   structure and an empty result); otherwise `changed: true` with a NEW object.
 * @throws {TypeError} when `ctx.decide` is not callable.
 */
export declare function redactGrepValue(value: unknown, ctx: {
    cwd?: string;
    decide: (absolutePath: string) => string;
}): {
    changed: boolean;
    value: unknown;
};
