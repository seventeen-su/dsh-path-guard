/**
 * Denial text.
 *
 * Whatever this module returns reaches the model verbatim: `tools/pre-execute`
 * denials are rendered as `Error: <reason>`
 * (packages/core/tools/src/index.ts:1526), and `ctx.tools.guard()` reasons take
 * the same path. The wording is therefore part of the product, not debug output.
 *
 * Per the user's decision the refusal is EXPLICIT: it says the user blocked
 * this path, names the rule, forbids bypass attempts, and points at the legal
 * route (ask the user to change the rule).
 *
 * @module dsh-path-guard/deny
 */
/**
 * The refusal for a path-level policy violation.
 * @param {{toolName: string, shownPath: string, access: string, required: string,
 *          ruleId?: string, rulePath?: string}} input - the decision facts.
 * @returns {string} the model-facing reason.
 */
export declare function denialText({ toolName, shownPath, access, required, ruleId, rulePath }: {
    toolName: string;
    shownPath: string;
    access: string;
    required: string;
    ruleId?: string;
    rulePath?: string;
}): string;
/**
 * The refusal for an opaque-program call (shell command or workflow script)
 * whose text references a protected path.
 * @param {{toolName: string, needle: string, rulePath?: string, access: string,
 *          kind?: 'shell'|'script'}} input - the match facts.
 * @returns {string} the model-facing reason.
 */
export declare function shellDenialText({ toolName, needle, rulePath, access, kind }: {
    toolName: string;
    needle: string;
    rulePath?: string;
    access: string;
    kind?: 'shell' | 'script';
}): string;
/**
 * The refusal for an `install_bundle` this plugin refuses on source grounds.
 * @param {{target: string, why?: string}} input - the attempted spec and the specific finding.
 * @returns {string} the model-facing reason.
 */
export declare function installSourceDenialText({ target, why }: {
    target: string;
    why?: string;
}): string;
/**
 * The refusal for an unmodelled tool whose arguments carry a path-shaped value
 * (or were nested too deeply to inspect).
 * @param {{toolName: string, reason: string}} input - the tool and the finding.
 * @returns {string} the model-facing reason.
 */
export declare function unknownToolDenialText({ toolName, reason }: {
    toolName: string;
    reason: string;
}): string;
/**
 * The refusal for a surface the plugin cannot fence at all.
 * @param {{toolName: string}} input - the tool identity.
 * @returns {string} the model-facing reason.
 */
export declare function exoticDenialText({ toolName }: {
    toolName: string;
}): string;
/**
 * The refusal for a `plugin_manager` action that would change the profile
 * composition while self-protection is on.
 * @param {{action: string, target: string}} input - the attempted action.
 * @returns {string} the model-facing reason.
 */
export declare function selfDenialText({ action, target }: {
    action: string;
    target: string;
}): string;
/**
 * The refusal used when the plugin's own code failed.
 *
 * An exception thrown from `ctx.tools.guard()` or `tools/pre-execute` becomes a
 * tool failure, so an internal bug would otherwise take the whole tool surface
 * down with a stack trace the model cannot act on — or, if swallowed, silently
 * remove the protection the user asked for. Neither is acceptable for a
 * security control, so the plugin fails CLOSED and says exactly what happened.
 * @param {string} where - the extension point that failed.
 * @returns {string} the model-facing reason.
 */
export declare function internalErrorText(where: string): string;
/**
 * The refusal used when a search result had to be withheld because redaction
 * could not be applied safely (fail-closed).
 * @param {string} toolName - `glob` or `grep`.
 * @returns {string} the model-facing reason.
 */
export declare function redactionBlockedText(toolName: string): string;
