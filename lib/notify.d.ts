/**
 * Interception-event desktop notifications for dsh-path-guard.
 *
 * The peer plugin `dsh-desktop-notify` is OPTIONAL: it publishes itself as the
 * Cordis service `desktopNotify`, and when it is not installed nothing should
 * happen at all. This module therefore never touches Cordis — the caller injects
 * `resolveService()`, which is re-evaluated on EVERY event, so enabling the plugin
 * mid-session starts working immediately and a missing service degrades to a
 * silent `false` (no throw, no log flood).
 *
 * VERIFIED PEER CONTRACT (`dsh-desktop-notify@1.5.4`, lib/api.js):
 *   push(item)        -> boolean   focus-gated: the session you are looking at is silenced
 *   pushAlways(item)  -> boolean   bypasses the focus gate
 *   item = { title, message?, urgency?, sessionId?, url? }
 *   - `title` is required; an empty title returns false and pushes nothing
 *   - the peer truncates the title at 160 and the message at 400, and collapses
 *     runs of whitespace into one space
 *   - `urgency` is one of 'low' | 'normal' | 'critical' (invalid becomes 'normal')
 *   - `sessionId` accepts a session object, an id, or an array of either
 *   - the return value means "actually queued": a focus-silenced, deduplicated or
 *     backend-less push returns false
 *
 * ===========================================================================
 * DELIBERATE DECISIONS (each is allowed by the module spec, and each is here so
 * the next reader does not have to reverse-engineer it)
 * ===========================================================================
 *
 * 1. TRUNCATION HAPPENS HERE. The peer truncates as well, but the "≤ 400 chars"
 *    guarantee must not be a property of a third-party version we do not pin.
 *    Fields are clipped first, then the composed message is clipped again, and
 *    clipping never splits a UTF-16 surrogate pair (a lone surrogate becomes
 *    U+FFFD in the payload the operating system receives).
 *
 * 2. ONE DENIAL TITLE FOR EVERY KIND. The spec names `🚫 Path Guard 拦截` and
 *    permits per-kind tuning; a constant title is strictly compatible with both
 *    (any caller/verifier can assert it literally) and keeps the visible wording
 *    stable. Only `urgency` varies: `self` (the guard refusing a change to its own
 *    composition) is `critical`, everything else is `normal`.
 *
 * 3. THE THROTTLE KEY IS kind + tool + target + rulePath + ruleId + access, and
 *    deliberately NOT sessionId. The key must distinguish target paths (otherwise
 *    the user only ever sees the first denied path), while a process-wide key keeps
 *    the table from multiplying by session count in a long-lived host. Consequence:
 *    two sessions hitting the same reason within the window get one notification.
 *
 * 4. `always: true` BYPASSES THE FOCUS GATE, NOT THE THROTTLE. It selects
 *    `pushAlways` (decision the spec pins), while the throttle stays a pure
 *    duplicate suppressor for an identical reason — otherwise a persistent
 *    misconfiguration would fire a toast per tool call. `sessionId` is still sent
 *    on both paths because the peer uses it to build the click-through link.
 *
 * 5. THE THROTTLE ENTRY IS WRITTEN ONLY WHEN A PUSH METHOD WAS ACTUALLY INVOKED.
 *    If the service is absent we neither log nor remember, so (a) `tracked()` stays
 *    0 for a user without the plugin and (b) the first event after the plugin is
 *    enabled is not swallowed by a window that was opened while it was absent. The
 *    entry is written even when the peer returns false or throws: the throttle
 *    governs PUSH ATTEMPTS, not the peer's success, which is what keeps "one push
 *    per reason per window" true for a focus-silenced or broken peer too.
 *
 * 6. `malfunction()` IS THROTTLED PER EXTENSION POINT. A fail-closed bug fires on
 *    every governed call; unthrottled it would produce a toast storm that buries
 *    the first, useful notification. One per site per window is the useful signal.
 *
 * 7. EVERY FAILURE IS `warn`, NEVER `error`. `error` is reserved for genuine
 *    internal faults of dsh-path-guard itself (see `src/index.js`), so a missing or
 *    misbehaving optional notification plugin must not look like a guard failure.
 *
 * Pure ESM, zero dependencies, no Cordis import, no I/O: everything is testable
 * with an injected clock and a fake service.
 */
/**
 * The peer protocol version this plugin speaks, declared on every payload as `v`.
 *
 * The peer's contract is explicit about forward compatibility: unknown payload
 * fields are ignored rather than rejected, and a payload declaring a HIGHER major
 * version is still pushed (the result comes back with `unsupportedVersion: true`).
 * Declaring the version is therefore free insurance — it never costs a delivery,
 * and it lets a future peer see which contract we were written against.
 */
declare const NOTIFY_API_VERSION = "1.0.0";
/** Exported so the other push site declares the same version this module does. */
export { NOTIFY_API_VERSION };
/**
 * Create the interception-event notifier. Never throws, never depends on Cordis.
 *
 * @param {{
 *   resolveService: () => any,
 *   logger?: { warn?: Function, error?: Function, debug?: Function },
 *   now?: () => number,
 *   throttleMs?: number,
 *   maxTracked?: number,
 * }} deps `resolveService()` is called on every event and may return `undefined`
 *   when `dsh-desktop-notify` is not installed. `logger.warn` is used for every
 *   recoverable failure (a throwing `logger.warn` is itself swallowed). `now`
 *   defaults to `Date.now`; `throttleMs` to 10000 (0 disables throttling);
 *   `maxTracked` to 64 (oldest entry evicted first).
 * @returns {{
 *   denial: (input: {
 *     toolName?: string, target?: string, access?: string, rulePath?: string,
 *     ruleId?: string, sessionId?: unknown,
 *     kind?: 'path'|'shell'|'exotic'|'self'|'redaction', always?: boolean,
 *   }) => boolean,
 *   malfunction: (where: string) => boolean,
 *   reset: () => void,
 *   tracked: () => number,
 * }} The notifier. `denial`/`malfunction` return `true` only when the peer
 *   reported the notification as actually queued; every failure (no service,
 *   missing method, thrown error, throttled, `undefined` result) returns `false`.
 */
export declare function createNotifier(deps?: {
    resolveService?: unknown;
    logger?: {
        warn?: (...args: unknown[]) => unknown;
        info?: (...args: unknown[]) => unknown;
    } | null;
    now?: (() => number) | undefined;
    throttleMs?: number | undefined;
    maxTracked?: number | undefined;
}): {
    denial: (input: {
        toolName?: string | undefined;
        target?: string | undefined;
        access?: string | undefined;
        rulePath?: string | undefined;
        ruleId?: string | undefined;
        sessionId?: unknown;
        kind?: "path" | "shell" | "exotic" | "self" | "redaction" | string;
        always?: boolean | undefined;
    }) => boolean;
    malfunction: (where: string) => boolean;
    reset: () => void;
    tracked: () => number;
};
