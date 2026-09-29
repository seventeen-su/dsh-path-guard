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
import z from '@deepseek-ai/schemastery';
/** Access levels a rule may assign, weakest first. Also the capability ladder. */
export declare const ACCESS_VALUES: string[];
/**
 * `defaultAccess` additionally accepts `allow`: "no rule matched, do not
 * restrict". `allow` is not a rule value — a rule that matched always means
 * "this user asked for something", never "unrestricted".
 */
export declare const DEFAULT_ACCESS_VALUES: string[];
/** How the plugin treats surfaces it cannot reliably fence (shell, run_code, MCP). */
export declare const SHELL_VALUES: string[];
export declare const EXOTIC_VALUES: string[];
/**
 * How an UNMODELLED tool is judged.
 *
 * `check` (default): the heuristics in `resource.ts` look for path-shaped
 * arguments and those paths are judged against the rules like any other tool's.
 * The call is refused only when a rule actually protects the path found.
 *
 * `deny`: refuse every unmodelled call whose arguments carry a path-shaped
 * value, whether or not a rule covers it. Stricter, and deliberately noisy.
 *
 * Why `check` is the default: blanket refusal was untenable in practice. A memory
 * lookup whose QUERY merely looked like a path (a search tool taking a file path
 * as its query) was refused outright, which is a false positive with no security
 * value — the tool never touches the filesystem.
 */
export declare const UNKNOWN_TOOL_VALUES: string[];
/**
 * Desktop-notification policy for denials. `focused` rides the notify plugin's
 * focus gate (no pop while the user is already looking at that session),
 * `always` bypasses it, `off` disables notifications.
 */
export declare const NOTIFY_VALUES: string[];
/**
 * Plugin config. Every user-editable field is `.volatile()`, and the rule list
 * is volatile as a whole while its elements stay plain.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** Master switch. When off the plugin registers nothing that can deny a call. */
    enabled: z<boolean, boolean, "volatile-defined">;
    /**
     * Access level applied to a path that matches no rule.
     * `allow` keeps the plugin inert for that path (backwards compatible default).
     */
    defaultAccess: z<string, string, "volatile-defined">;
    /** Ordered rule list. More specific paths win, so later rules can exempt earlier ones. */
    rules: z<NoInfer<({
        path?: string | null;
        access?: string | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[]>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** Path pattern: `~`, `${workspace}`, an absolute path, `*`, `**`, `?`. */
        path: z<string, string, "defined">;
        /** Access level granted for this path and everything under it. */
        access: z<string, string, "defined">;
        /** Free-form note shown in the editor; carries no semantics. */
        note: z<string, string, "defined">;
    }>>[]>, "volatile-defined">;
    /** Redact `glob`/`grep` results that fall under a protected path. */
    searchRedaction: z<boolean, boolean, "volatile-defined">;
    /**
     * `scan`: shell commands stay usable; their text is scanned for protected
     * paths and their output is filtered. `deny`: every shell call is refused.
     * `off`: no shell handling at all (documented as a known hole).
     */
    shell: z<string, string, "volatile-defined">;
    /**
     * Surfaces a plugin cannot fence at all (MCP servers, `run_code`, foreign
     * subagent loops). `deny` refuses the call; `allow` accepts the hole.
     */
    exoticTools: z<string, string, "volatile-defined">;
    /**
     * Keep the AI from editing the profile composition that carries this
     * plugin's own rules. `plugin_manager` still works — it writes through the
     * Host's config editor, not through the model's file tools.
     */
    selfProtection: z<boolean, boolean, "volatile-defined">;
    /**
     * How an unmodelled tool is judged. See {@link UNKNOWN_TOOL_VALUES}.
     */
    unknownTools: z<string, string, "volatile-defined">;
    /**
     * Tools this plugin does not judge at all. An entry matches the exact tool
     * name, or every tool whose name starts with the entry when it ends in `*`
     * (`notes_*` trusts a whole plugin's tool set). Trust is the user's explicit
     * decision: a trusted tool skips every check this plugin would otherwise do,
     * which is what an MCP server that legitimately manages protected paths needs.
     */
    trustedTools: z<NoInfer<({
        match?: string | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[]>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** Tool name (`notes_search`) or a prefix pattern (`notes_*`, `mcp__*`). */
        match: z<string, string, "defined">;
        /** Free-form note shown in the editor; carries no semantics. */
        note: z<string, string, "defined">;
    }>>[]>, "volatile-defined">;
    /**
     * Desktop notification when a call is refused, through the optional
     * `desktopNotify` service registered by `dsh-desktop-notify`. Absent that
     * plugin nothing happens; the setting costs nothing.
     */
    notify: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Master switch. When off the plugin registers nothing that can deny a call. */
    enabled: z<boolean, boolean, "volatile-defined">;
    /**
     * Access level applied to a path that matches no rule.
     * `allow` keeps the plugin inert for that path (backwards compatible default).
     */
    defaultAccess: z<string, string, "volatile-defined">;
    /** Ordered rule list. More specific paths win, so later rules can exempt earlier ones. */
    rules: z<NoInfer<({
        path?: string | null;
        access?: string | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[]>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** Path pattern: `~`, `${workspace}`, an absolute path, `*`, `**`, `?`. */
        path: z<string, string, "defined">;
        /** Access level granted for this path and everything under it. */
        access: z<string, string, "defined">;
        /** Free-form note shown in the editor; carries no semantics. */
        note: z<string, string, "defined">;
    }>>[]>, "volatile-defined">;
    /** Redact `glob`/`grep` results that fall under a protected path. */
    searchRedaction: z<boolean, boolean, "volatile-defined">;
    /**
     * `scan`: shell commands stay usable; their text is scanned for protected
     * paths and their output is filtered. `deny`: every shell call is refused.
     * `off`: no shell handling at all (documented as a known hole).
     */
    shell: z<string, string, "volatile-defined">;
    /**
     * Surfaces a plugin cannot fence at all (MCP servers, `run_code`, foreign
     * subagent loops). `deny` refuses the call; `allow` accepts the hole.
     */
    exoticTools: z<string, string, "volatile-defined">;
    /**
     * Keep the AI from editing the profile composition that carries this
     * plugin's own rules. `plugin_manager` still works — it writes through the
     * Host's config editor, not through the model's file tools.
     */
    selfProtection: z<boolean, boolean, "volatile-defined">;
    /**
     * How an unmodelled tool is judged. See {@link UNKNOWN_TOOL_VALUES}.
     */
    unknownTools: z<string, string, "volatile-defined">;
    /**
     * Tools this plugin does not judge at all. An entry matches the exact tool
     * name, or every tool whose name starts with the entry when it ends in `*`
     * (`notes_*` trusts a whole plugin's tool set). Trust is the user's explicit
     * decision: a trusted tool skips every check this plugin would otherwise do,
     * which is what an MCP server that legitimately manages protected paths needs.
     */
    trustedTools: z<NoInfer<({
        match?: string | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[]>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** Tool name (`notes_search`) or a prefix pattern (`notes_*`, `mcp__*`). */
        match: z<string, string, "defined">;
        /** Free-form note shown in the editor; carries no semantics. */
        note: z<string, string, "defined">;
    }>>[]>, "volatile-defined">;
    /**
     * Desktop notification when a call is refused, through the optional
     * `desktopNotify` service registered by `dsh-desktop-notify`. Absent that
     * plugin nothing happens; the setting costs nothing.
     */
    notify: z<string, string, "volatile-defined">;
}>>, "plain">;
export default Config;
