/**
 * Plugin configuration schema for dsh-path-guard.
 *
 * The Settings page is generated from this schema by the plugin's own client
 * half, so the field order here is also the order the user sees.
 *
 * IMPORTANT — schemastery volatility rules (vendor/schemastery/src/index.ts):
 * `validateVolatileSchema` (lines 488-509) rejects a volatile field nested
 * inside another volatile field, and it validates an array's inner schema with
 * `blocked = true` (line 501-503). A volatile field therefore cannot live
 * inside an array element. The shipped pattern for an editable list is to mark
 * the WHOLE array volatile and keep its element schema plain — exactly how
 * `llm-deepseek` declares `models: z.array(catalogModel).volatile()`
 * (packages/llm/llm-deepseek/src/config.ts:88).
 *
 * Only volatile fields are projected into an editable form
 * (packages/settings/settings/src/index.ts:308-309).
 *
 * @module dsh-path-guard/config
 */

import z from '@deepseek-ai/schemastery'

/** Access levels a rule may assign, weakest first. Also the capability ladder. */
export const ACCESS_VALUES = ['none', 'list', 'read', 'write']

/**
 * `defaultAccess` additionally accepts `allow`: "no rule matched, do not
 * restrict". `allow` is not a rule value — a rule that matched always means
 * "this user asked for something", never "unrestricted".
 */
export const DEFAULT_ACCESS_VALUES = ['allow', 'none', 'list', 'read', 'write']

/** How the plugin treats surfaces it cannot reliably fence (shell, run_code, MCP). */
export const SHELL_VALUES = ['scan', 'deny', 'off']
export const EXOTIC_VALUES = ['deny', 'allow']

/**
 * Desktop-notification policy for denials. `focused` rides the notify plugin's
 * focus gate (no pop while the user is already looking at that session),
 * `always` bypasses it, `off` disables notifications.
 */
export const NOTIFY_VALUES = ['focused', 'always', 'off']

/** One user rule: a path pattern mapped to an access level. */
const rule = z.object({
  /** Path pattern: `~`, `${workspace}`, an absolute path, `*`, `**`, `?`. */
  path: z.string().default(''),
  /** Access level granted for this path and everything under it. */
  access: z.union(ACCESS_VALUES).default('none'),
  /** Free-form note shown in the editor; carries no semantics. */
  note: z.string().default(''),
})

/**
 * Plugin config. Every user-editable field is `.volatile()`, and the rule list
 * is volatile as a whole while its elements stay plain.
 */
export const Config = z.object({
  /** Master switch. When off the plugin registers nothing that can deny a call. */
  enabled: z.boolean().default(true).volatile(),

  /**
   * Access level applied to a path that matches no rule.
   * `allow` keeps the plugin inert for that path (backwards compatible default).
   */
  defaultAccess: z.union(DEFAULT_ACCESS_VALUES).default('allow').volatile(),

  /** Ordered rule list. More specific paths win, so later rules can exempt earlier ones. */
  rules: z.array(rule).default([]).volatile(),

  /** Redact `glob`/`grep` results that fall under a protected path. */
  searchRedaction: z.boolean().default(true).volatile(),

  /**
   * `scan`: shell commands stay usable; their text is scanned for protected
   * paths and their output is filtered. `deny`: every shell call is refused.
   * `off`: no shell handling at all (documented as a known hole).
   */
  shell: z.union(SHELL_VALUES).default('scan').volatile(),

  /**
   * Surfaces a plugin cannot fence at all (MCP servers, `run_code`, foreign
   * subagent loops). `deny` refuses the call; `allow` accepts the hole.
   */
  exoticTools: z.union(EXOTIC_VALUES).default('deny').volatile(),

  /**
   * Keep the AI from editing the profile composition that carries this
   * plugin's own rules. `plugin_manager` still works — it writes through the
   * Host's config editor, not through the model's file tools.
   */
  selfProtection: z.boolean().default(true).volatile(),

  /**
   * Desktop notification when a call is refused, through the optional
   * `desktopNotify` service registered by `dsh-desktop-notify`. Absent that
   * plugin nothing happens; the setting costs nothing.
   */
  notify: z.union(NOTIFY_VALUES).default('focused').volatile(),
})

export default Config
