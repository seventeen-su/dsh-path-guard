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

import { expandPath } from './policy.js'

/** Needles shorter than this are too generic to be evidence of anything. */
const MIN_NEEDLE = 4

/** Environment-variable spellings of a home directory, per shell dialect. */
const HOME_FORMS = ['~', '$HOME', '${HOME}', '$env:USERPROFILE', '%USERPROFILE%']

/**
 * Build the search needles for a rule list.
 * @param {Array<{path?: string, access?: string}>} rules - the configured rules.
 * @param {{home?: string, workspace?: string, windows?: boolean}} ctx - expansion context.
 * @returns {Array<{needle: string, pattern: string, access: string}>} needles, longest first.
 */
export function buildNeedles(rules, ctx) {
  const { home, workspace, windows = false } = ctx
  /** @type {Array<{needle: string, pattern: string, access: string}>} */
  const needles = []
  const seen = new Set()
  const push = (needle, pattern, access) => {
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
    const absolute = expandPath(pattern, { home, workspace })
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
export function scanCommand(command, needles, windows) {
  if (typeof command !== 'string' || command === '' || needles.length === 0) return undefined
  const haystack = windows ? command.toLowerCase() : command
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
export function commandOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const field of ['command', 'text']) {
    const value = args[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}
