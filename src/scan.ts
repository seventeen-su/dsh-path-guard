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

import { expandPath } from './policy.ts'

/** Needles shorter than this are too generic to be evidence of anything. */
const MIN_NEEDLE = 4

/**
 * Prefix marking a BY-FILENAME rule (`name:readme.md`) in `policy.js`. Such a
 * rule constrains a basename, which a whole-path substring scanner cannot
 * express, so `scan.js` reports it as uncovered rather than approximating it.
 */
const NAME_RULE_PREFIX = 'name:'

/** Environment-variable spellings of a home directory, per shell dialect. */
const HOME_FORMS = ['~', '$HOME', '${HOME}', '$env:USERPROFILE', '%USERPROFILE%']

/** One scanner needle, as produced by {@link buildNeedles}. */
export interface Needle {
  needle: string
  pattern: string
  access: string
}

/** Glob metacharacters that end a literal prefix. */
const GLOB_META = /[*?[]/

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
export function literalNeedlePrefix(pattern: string): string | undefined {
  const at = pattern.search(GLOB_META)
  if (at === -1) return pattern
  if (!pattern.endsWith('*')) return undefined
  const head = pattern.slice(0, at)
  if (head === '' || !/[\\/]$/.test(head)) return undefined
  return head.replace(/[\\/]+$/, '')
}

/**
 * Rule patterns the substring scanner cannot cover.
 * @param {Array<{path?: string}>} rules - the configured rules.
 * @returns {string[]} the patterns that produced no needle for structural reasons.
 */
export function unscannablePatterns(rules?: ReadonlyArray<{ path?: unknown } | null | undefined>): string[] {
  const out = []
  for (const rule of rules ?? []) {
    if (rule === null || typeof rule !== 'object') continue
    const pattern = typeof rule.path === 'string' ? rule.path.trim() : ''
    if (pattern === '') continue
    // A `name:` rule constrains a BASENAME, and the substring scanner works on
    // whole paths. `literalNeedlePrefix('name:id_rsa')` happily returns the whole
    // string, so without this branch a deny-direction name rule would be neither
    // enforced nor reported — the same silent fail-open §1.1 of
    // docs/ARCHITECTURE.md was written to kill. Report it instead.
    if (pattern.startsWith(NAME_RULE_PREFIX)) {
      out.push(pattern)
      continue
    }
    if (literalNeedlePrefix(pattern) === undefined) out.push(pattern)
  }
  return out
}

/**
 * Build the search needles for a rule list.
 * @param {Array<{path?: string, access?: string}>} rules - the configured rules.
 * @param {{home?: string, workspace?: string, windows?: boolean}} ctx - expansion context.
 * @returns {Array<{needle: string, pattern: string, access: string}>} needles, longest first.
 */
export function buildNeedles(
  rules: ReadonlyArray<{ path?: unknown; access?: unknown } | null | undefined>,
  ctx: { home?: string | undefined; workspace?: string | undefined; windows?: boolean | undefined },
): Needle[] {
  const { home, workspace, windows = false } = ctx
  const needles: Needle[] = []
  const seen = new Set()
  const push = (needle: string, pattern: string, access: string) => {
    if (needle.length < MIN_NEEDLE) return
    const key = windows ? needle.toLowerCase() : needle
    if (seen.has(key)) return
    seen.add(key)
    needles.push({ needle, pattern, access })
  }
  for (const rule of rules ?? []) {
    if (rule === null || typeof rule !== 'object') continue
    const pattern = typeof rule.path === 'string' ? rule.path : ''
    if (pattern.trim() === '') continue
    const access = typeof rule.access === 'string' ? rule.access : 'none'
    // Reduce the pattern to its literal prefix FIRST: expanding `~/.ssh/**`
    // yields a needle with a literal `**` in it, which no command ever contains,
    // so the rule would be silently unenforced in every spelling.
    // A `name:` rule is not a path: expanding it would treat `name:readme.md` as
    // a path (and on Windows the ADS folding then turns it into `D:/proj/name`),
    // producing a short, over-broad needle that denies commands merely mentioning
    // that text. Report it as unscannable instead — the bare basename is far too
    // common in ordinary commands to be a usable needle.
    if (pattern.startsWith(NAME_RULE_PREFIX)) continue
    const literal = literalNeedlePrefix(pattern)
    if (literal === undefined || literal === '') continue
    const absolute = expandPath(literal, { home, workspace })
    if (absolute === '') continue
    push(absolute, pattern, access)
    push(absolute.replaceAll('/', '\\'), pattern, access)
    // `expandPath` normalizes to forward slashes, but `os.homedir()` on Windows
    // returns backslashes. Compare on one separator, or the `~` spellings below
    // are never generated on Windows and the scanner silently misses `~/.ssh`.
    const normalizedHome = typeof home === 'string' && home !== '' ? home.replaceAll('\\', '/') : undefined
    if (normalizedHome !== undefined && absolute.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
      const rest = absolute.slice(normalizedHome.length).replace(/^\/+/u, '')
      for (const form of HOME_FORMS) {
        const joined = rest === '' ? form : `${form}/${rest}`
        push(joined, pattern, access)
        push(joined.replaceAll('/', '\\'), pattern, access)
      }
    }
  }
  // Longest first: the most specific needle is the most useful thing to report.
  return needles.sort((a, b) => b.needle.length - a.needle.length)
}

/**
 * Find the first protected path referenced by a command string.
 * @param {unknown} command - the raw command text.
 * @param {Array<{needle: string, pattern: string, access: string}>} needles - from {@link buildNeedles}.
 * @param {boolean} windows - compare case-insensitively.
 * @returns {{needle: string, pattern: string, access: string} | undefined} the match, if any.
 */
export function scanCommand(command: unknown, needles: Needle[], windows: boolean) {
  if (typeof command !== 'string' || command === '' || needles.length === 0) return undefined
  const direct = scanText(command, needles, windows)
  if (direct !== undefined) return direct
  // A path inside a JSON/JS string literal carries DOUBLED backslashes
  // (`"C:\\Users\\..."`), which is how any program-string channel spells a
  // Windows path — a workflow script above all. Collapsing the doubling and
  // scanning again is the difference between catching that and missing it
  // entirely; without this pass `readFileSync("C:\\\\Users\\\\...")` reads as an
  // unrelated string.
  if (command.includes('\\\\')) return scanText(command.replaceAll('\\\\', '\\'), needles, windows)
  return undefined
}

/**
 * Plain substring search of one haystack.
 * @param {string} text - already-normalized haystack.
 * @param {Array<{needle: string, pattern: string, access: string}>} needles - the needles.
 * @param {boolean} windows - compare case-insensitively.
 * @returns {{needle: string, pattern: string, access: string} | undefined} the match, if any.
 */
function scanText(text: string, needles: Needle[], windows: boolean) {
  const haystack = windows ? text.toLowerCase() : text
  for (const entry of needles) {
    const needle = windows ? entry.needle.toLowerCase() : entry.needle
    if (haystack.includes(needle)) return entry
  }
  return undefined
}

/**
 * The command text of a shell-shaped tool call.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string | undefined} `command` (bash/pwsh) or `text` (terminal_send).
 */
export function commandOf(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  for (const field of ['command', 'text']) {
    const value = (args as Record<string, unknown>)[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** What one withheld output LINE is replaced with. */
const WITHHELD_LINE = '[dsh-path-guard] 本行提到了受保护路径，已扣留。'

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
export function redactTextBlocks(content: unknown, needles: Needle[], windows: boolean) {
  if (!Array.isArray(content) || needles.length === 0) return { changed: false, content }
  let changed = false
  const next = content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = block.text as string
    // Whole-block gate (audit A2). It is a pure SKIP, never a decision:
    //   - a line is a substring of its block, so a needle inside a line is
    //     inside the block;
    //   - the `\\` -> `\` collapse is LINE-LOCAL: a backslash pair cannot
    //     straddle the `\n` between two lines, so collapse(block) is exactly
    //     collapse(l1) + '\n' + … + collapse(ln), keeping every collapsed line a
    //     substring of the collapsed block.
    // A clean block therefore proves every line clean, and the per-line work —
    // split + a toLowerCase + one includes per needle PER LINE — is skipped.
    // A block that does hit falls through to the unchanged per-line loop, so the
    // gate can never withhold something the old code would have kept.
    if (scanCommand(text, needles, windows) === undefined) return block
    let blockChanged = false
    const kept = text.split('\n').map((line: string) => {
      if (scanCommand(line, needles, windows) === undefined) return line
      blockChanged = true
      return WITHHELD_LINE
    })
    if (!blockChanged) return block
    changed = true
    return { ...block, text: kept.join('\n') }
  })
  return changed ? { changed: true, content: next } : { changed: false, content }
}
