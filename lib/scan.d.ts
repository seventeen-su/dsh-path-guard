/**
 * Best-effort shell command scanner.
 *
 * A shell command string is Turing-complete, so no analysis of it is sound.
 * This module does the only thing that is cheap and has no false negatives for
 * the naive case: it looks for the protected paths themselves, in the spellings
 * a person (or a model) actually types — absolute, backslashed, `~`-relative,
 * `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`.
 *
 * It is documented to the user as best-effort, and `shell: 'deny'` in the
 * plugin config is the setting for anyone who needs more than that.
 *
 * @module dsh-path-guard/scan
 */
/** One scanner needle, as produced by {@link buildNeedles}. */
export interface Needle {
    needle: string;
    pattern: string;
    access: string;
}
/**
 * The literal text a rule pattern can be reduced to for substring scanning.
 *
 * The scanner matches substrings, so a pattern's WILDCARDS have to be dropped —
 * a needle containing `**` can never appear in a real command. Only one shape is
 * reducible without guessing: a trailing wildcard on a segment boundary
 * (`~/.ssh/**`, `~/.ssh/*`, `D:/secrets/**`), whose literal prefix names exactly
 * the protected directory.
 *
 * Everything else is refused rather than approximated:
 *   - a wildcard cutting through a segment (`D:/sec` + `*`) has no literal
 *     prefix that is not simply a longer string than the rule means;
 *   - a wildcard with a literal tail (`D:/a/<any>/secret`) cannot be expressed
 *     as a substring at all, and using the head (`D:/a`) would deny every command
 *     that merely mentions that directory.
 * Those rules are reported by {@link unscannablePatterns} so the user learns the
 * scanner does not cover them, instead of believing they are enforced.
 *
 * @param {string} pattern - one rule path as written.
 * @returns {string | undefined} the literal prefix, or undefined when the pattern is not reducible.
 */
export declare function literalNeedlePrefix(pattern: string): string | undefined;
/**
 * Rule patterns the substring scanner cannot cover.
 * @param {Array<{path?: string}>} rules - the configured rules.
 * @returns {string[]} the patterns that produced no needle for structural reasons.
 */
export declare function unscannablePatterns(rules?: ReadonlyArray<{
    path?: unknown;
} | null | undefined>): string[];
/**
 * Build the search needles for a rule list.
 * @param {Array<{path?: string, access?: string}>} rules - the configured rules.
 * @param {{home?: string, workspace?: string, windows?: boolean}} ctx - expansion context.
 * @returns {Array<{needle: string, pattern: string, access: string}>} needles, longest first.
 */
export declare function buildNeedles(rules: ReadonlyArray<{
    path?: unknown;
    access?: unknown;
} | null | undefined>, ctx: {
    home?: string | undefined;
    workspace?: string | undefined;
    windows?: boolean | undefined;
}): Needle[];
/**
 * Find the first protected path referenced by a command string.
 * @param {unknown} command - the raw command text.
 * @param {Array<{needle: string, pattern: string, access: string}>} needles - from {@link buildNeedles}.
 * @param {boolean} windows - compare case-insensitively.
 * @returns {{needle: string, pattern: string, access: string} | undefined} the match, if any.
 */
export declare function scanCommand(command: unknown, needles: Needle[], windows: boolean): Needle | undefined;
/**
 * The command text of a shell-shaped tool call.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string | undefined} `command` (bash/pwsh) or `text` (terminal_send).
 */
export declare function commandOf(args: unknown): string | undefined;
/**
 * Withhold the output LINES that mention a protected path.
 *
 * Only `text` blocks are inspected; anything else is passed through untouched.
 *
 * Redaction is per LINE. Replacing the whole block meant one mention — often a
 * single path the command printed itself — took every unrelated line down with
 * it, and the tool result stopped being usable for anything else.
 *
 * The marker deliberately does NOT quote the path: the needle IS the protected
 * path, so naming it in the replacement would leak precisely what is withheld.
 *
 * Known limit: a path the terminal WRAPS across two lines, or one the emitting
 * program splits with a newline of its own, is not matched line-wise. The old
 * whole-block test would have caught that; per-line redaction trades it away for
 * output that stays usable.
 *
 * @param {unknown} content - the tool result's content blocks.
 * @param {Array<{needle: string, pattern: string, access: string}>} needles - from {@link buildNeedles}.
 * @param {boolean} windows - compare case-insensitively.
 * @returns {{changed: boolean, content: unknown}} the rewritten blocks, or the input when nothing matched.
 */
export declare function redactTextBlocks(content: unknown, needles: Needle[], windows: boolean): {
    changed: boolean;
    content: unknown;
};
