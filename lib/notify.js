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
// ---------------------------------------------------------------------------
// Limits mirrored from the peer (`dsh-desktop-notify/lib/api.js:20-22`)
// ---------------------------------------------------------------------------
/** Peer title limit (`MAX_TITLE`). */
const MAX_TITLE = 160;
/** Peer message limit (`MAX_MESSAGE`). */
const MAX_MESSAGE = 400;
/** Default silence window for one interception reason (ms). */
const DEFAULT_THROTTLE_MS = 10000;
/** Default cap of the throttle table; a resident process must not grow with sessions. */
const DEFAULT_MAX_TRACKED = 64;
/**
 * Per-field caps. Chosen so that the worst-case composed denial message (max kind
 * label + max tool + max rule + max access + separators) still leaves a useful
 * target budget inside MAX_MESSAGE — the tail of the line (rule, tier) survives.
 */
const FIELD_LIMITS = {
    kind: 24,
    toolName: 80,
    target: 240,
    rule: 160,
    access: 24,
    where: 120,
};
/** Lowest number of target characters kept when the rest of the line is long. */
const MIN_TARGET_BUDGET = 40;
/** Visible title of a denial notification (spec: `🚫 Path Guard 拦截`). */
const DENIAL_TITLE = '🚫 Path Guard 拦截';
/** Visible title of an internal-malfunction notification (spec). */
const MALFUNCTION_TITLE = '⚠️ Path Guard 内部错误';
/**
 * Chinese label per interception kind (Maps, not object literals: a kind such as
 * `constructor` must not read `Object.prototype` and become a function).
 * @type {ReadonlyMap<string, string>}
 */
const KIND_LABELS = new Map([
    ['path', '路径'],
    ['shell', '命令'],
    ['exotic', '工具面'],
    ['self', '自改配置'],
    ['redaction', '结果脱敏'],
]);
/**
 * Urgency override per kind; anything not listed is `normal`.
 * `self` is the guard denying a change to its own composition — the one case worth
 * the most prominent OS-level urgency.
 * @type {ReadonlyMap<string, 'low'|'normal'|'critical'>}
 */
const KIND_URGENCY = new Map([['self', 'critical']]);
/** NUL cannot appear in a tool name / path, so it is a safe key separator. */
const KEY_SEPARATOR = '\u0000';
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
/**
 * Truncate to at most `max` UTF-16 code units without producing a lone surrogate
 * (an orphaned high surrogate is encoded as U+FFFD in the bytes handed to the OS).
 * Mirrors the peer's `truncateText` (`dsh-desktop-notify/lib/text.js`); no ellipsis
 * is added, so the returned length is always ≤ `max`.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncateText(value, max) {
    const text = String(value === undefined || value === null ? '' : value);
    if (!Number.isFinite(max) || max <= 0)
        return '';
    if (text.length <= max)
        return text;
    const last = text.charCodeAt(max - 1);
    const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
    return text.slice(0, cut);
}
/**
 * Normalize one payload field the way the peer will anyway (collapse whitespace,
 * trim, single line) and cap it at `max` code units, marking a real cut with `…`.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clipField(value, max) {
    if (value === undefined || value === null)
        return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text.length <= max)
        return text;
    return `${truncateText(text, max - 1)}…`;
}
/**
 * Short, log-safe description of a thrown value.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
    if (error instanceof Error)
        return truncateText(error.stack ?? error.message, 300);
    return truncateText(String(error), 300);
}
/**
 * A thenable result would be an asynchronous peer implementation; the public
 * function must stay synchronous.
 * @param {unknown} value
 * @returns {boolean}
 */
function isThenable(value) {
    return (value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function');
}
// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
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
export function createNotifier(deps) {
    const { resolveService, logger, now = Date.now, throttleMs = DEFAULT_THROTTLE_MS, maxTracked = DEFAULT_MAX_TRACKED, } = deps ?? {};
    const clock = typeof now === 'function' ? now : Date.now;
    const resolve = typeof resolveService === 'function' ? resolveService : undefined;
    const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : undefined;
    const windowMs = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : DEFAULT_THROTTLE_MS;
    const limit = Number.isFinite(maxTracked) && maxTracked >= 1 ? Math.floor(maxTracked) : DEFAULT_MAX_TRACKED;
    /**
     * Reason key → timestamp of the last push ATTEMPT. Map insertion order is
     * refreshed on every attempt, so the head is the least recently used reason.
     */
    const lastAttemptAt = new Map();
    /** Log through the injected logger without ever letting it break the hook. */
    function logWarn(detail) {
        if (warn === undefined)
            return;
        try {
            warn(`path-guard: desktop notification: ${detail}`);
        }
        catch {
            /* a broken logger must not turn a notification into a tool failure */
        }
    }
    /** Current time from the injected clock; a non-finite reading falls back to the wall clock. */
    function currentTime() {
        const at = clock();
        return Number.isFinite(at) ? at : Date.now();
    }
    /** True when the same reason was already pushed inside the current window. */
    function isThrottled(key, at) {
        const previous = lastAttemptAt.get(key);
        if (previous === undefined)
            return false;
        // A clock that moved backwards is treated as "still inside the window".
        return at - previous < windowMs;
    }
    /** Record a push attempt and evict the oldest entries beyond `maxTracked`. */
    function remember(key, at) {
        if (lastAttemptAt.has(key))
            lastAttemptAt.delete(key);
        lastAttemptAt.set(key, at);
        while (lastAttemptAt.size > limit) {
            const oldest = lastAttemptAt.keys().next().value;
            if (oldest === undefined)
                break;
            lastAttemptAt.delete(oldest);
        }
    }
    /**
     * Hand one payload to the peer service.
     *
     * @param {{title: string, message: string, urgency: string, sessionId?: unknown}} payload
     * @param {boolean} always bypass the peer's focus gate
     * @param {string} site short label used in warnings, e.g. `denial:path`
     * @returns {{attempted: boolean, queued: boolean}} `attempted` is true once a
     *   push method was invoked (even if it returned false or threw) — that is what
     *   the throttle records.
     */
    function deliver(payload, always, site) {
        let service;
        try {
            service = resolve === undefined ? undefined : resolve();
        }
        catch (error) {
            logWarn(`resolveService() threw in ${site}: ${describeError(error)}`);
            return { attempted: false, queued: false };
        }
        // Optional plugin not loaded: the whole point is that nothing happens here.
        if (service === undefined || service === null)
            return { attempted: false, queued: false };
        const methodName = always === true ? 'pushAlways' : 'push';
        try {
            const method = service[methodName];
            if (typeof method !== 'function') {
                // A service that exists but does not expose the method is a version
                // mismatch, not an absent plugin: warn every time (this path is bounded by
                // the number of interceptions, not by a loop) and remember nothing, so the
                // window is not consumed by a notification that was never attempted.
                logWarn(`service is present but ${methodName}() is missing (${site})`);
                return { attempted: false, queued: false };
            }
            const result = method.call(service, payload);
            if (isThenable(result)) {
                // The peer contract is synchronous. Keep the call a no-op, but attach a
                // catch so a mis-implemented async peer cannot crash the host with an
                // unhandled rejection.
                if (typeof result.catch === 'function')
                    result.catch(() => { });
                logWarn(`${methodName}() returned a Promise (${site}); the peer contract is synchronous`);
                return { attempted: true, queued: false };
            }
            return { attempted: true, queued: result === true };
        }
        catch (error) {
            logWarn(`${methodName}() threw in ${site}: ${describeError(error)}`);
            return { attempted: true, queued: false };
        }
    }
    /**
     * Normalize the whole denial input into the fields the key and the message need.
     * @param {Record<string, unknown>} input
     */
    function readDenialFields(input) {
        const kind = clipField(input.kind, FIELD_LIMITS.kind) || 'unknown';
        const tool = clipField(input.toolName, FIELD_LIMITS.toolName);
        const rulePath = clipField(input.rulePath, FIELD_LIMITS.rule);
        const ruleId = clipField(input.ruleId, FIELD_LIMITS.rule);
        const access = clipField(input.access, FIELD_LIMITS.access);
        const sessionId = input.sessionId;
        const hasSession = sessionId !== undefined &&
            sessionId !== null &&
            !(typeof sessionId === 'string' && sessionId.trim() === '');
        return {
            kind,
            kindLabel: KIND_LABELS.get(kind) ?? kind,
            tool,
            target: clipField(input.target, FIELD_LIMITS.target),
            rulePath,
            ruleId,
            rule: clipField(rulePath && ruleId ? `${rulePath}（${ruleId}）` : rulePath || ruleId, FIELD_LIMITS.rule),
            access,
            // Every displayed field is part of the reason: a different target path IS a
            // different reason (otherwise the user only ever sees the first one).
            key: [kind, tool, clipField(input.target, FIELD_LIMITS.target), rulePath, ruleId, access].join(KEY_SEPARATOR),
            sessionId,
            hasSession,
        };
    }
    /**
     * Build the denial payload for one reason.
     * @param {ReturnType<typeof readDenialFields>} fields
     */
    function denialPayload(fields) {
        const head = `已拦截（${fields.kindLabel}）：工具 ${fields.tool || '(未提供)'}`;
        const tail = `${fields.rule ? `，规则 ${fields.rule}` : ''}${fields.access ? `，档位 ${fields.access}` : ''}`;
        // Reserve room for the tail (rule + tier) so truncation can never hide which
        // tier fired; the target is clipped to whatever is left, never below the floor.
        const budget = MAX_MESSAGE - head.length - tail.length - '，目标 '.length;
        const target = fields.target
            ? clipField(fields.target, Math.max(MIN_TARGET_BUDGET, Math.min(FIELD_LIMITS.target, budget)))
            : '';
        const body = `${head}${target ? `，目标 ${target}` : ''}${tail}`;
        const payload = {
            title: truncateText(DENIAL_TITLE, MAX_TITLE),
            message: truncateText(body, MAX_MESSAGE),
            urgency: KIND_URGENCY.get(fields.kind) ?? 'normal',
        };
        // Absent session ⇒ the field must not be present at all: the peer treats an
        // empty list as "attribution unknown" and pushes, and a stray `undefined`
        // key would needless surface.
        if (fields.hasSession) {
            payload.sessionId = fields.sessionId;
            // `sessionId` drives the FOCUS GATE only; the click target is a separate,
            // explicit field, and omitting it makes the toast silently unclickable
            // (dsh-desktop-notify 1.6.0+). A denial the user cannot act on is half a
            // notification: the whole point of the popup is to take them to the call
            // that was refused.
            payload.click = { type: 'session', sessionId: fields.sessionId };
        }
        return payload;
    }
    /**
     * Notify the user that a tool call was denied by dsh-path-guard.
     *
     * Throttled per reason (kind + tool + target + rule + tier) for `throttleMs`.
     * Silently returns `false` when the optional notification plugin is not
     * installed; every other failure is reported through `logger.warn`.
     *
     * @param {{
     *   toolName?: string,
     *   target?: string,
     *   access?: string,
     *   rulePath?: string,
     *   ruleId?: string,
     *   sessionId?: unknown,
     *   kind?: 'path'|'shell'|'exotic'|'self'|'redaction'|string,
     *   always?: boolean,
     * }} input `always: true` uses `pushAlways` (bypasses the peer focus gate).
     * @returns {boolean} true only when the peer queued the notification.
     */
    function denial(input) {
        try {
            // Not an object: a caller bug, not an event worth surfacing to a human.
            if (input === null || typeof input !== 'object')
                return false;
            const at = currentTime();
            const fields = readDenialFields(input);
            if (isThrottled(fields.key, at))
                return false;
            const outcome = deliver(denialPayload(fields), input.always === true, `denial:${fields.kind}`);
            if (outcome.attempted)
                remember(fields.key, at);
            return outcome.queued;
        }
        catch (error) {
            logWarn(`denial() failed unexpectedly: ${describeError(error)}`);
            return false;
        }
    }
    /**
     * Notify the user that an extension point hit an internal error and the plugin
     * failed closed. Throttled per extension point: an active bug fires on every
     * governed call and must not turn into a toast storm (decision 6 in the header).
     *
     * @param {string} where extension-point name, e.g. `'tools/pre-execute'`.
     * @returns {boolean} true only when the peer queued the notification.
     */
    function malfunction(where) {
        try {
            const label = clipField(where, FIELD_LIMITS.where) || '(未提供扩展点)';
            const at = currentTime();
            const key = `malfunction${KEY_SEPARATOR}${label}`;
            if (isThrottled(key, at))
                return false;
            const payload = {
                title: truncateText(MALFUNCTION_TITLE, MAX_TITLE),
                message: truncateText(`扩展点 ${label} 发生内部错误：插件已 fail-closed，相关调用被拒。请查看 DSH 日志。`, MAX_MESSAGE),
                urgency: 'critical',
            };
            const outcome = deliver(payload, false, `malfunction:${label}`);
            if (outcome.attempted)
                remember(key, at);
            return outcome.queued;
        }
        catch (error) {
            logWarn(`malfunction() failed unexpectedly: ${describeError(error)}`);
            return false;
        }
    }
    /** Drop every throttle entry (tests, and configuration changes). */
    function reset() {
        lastAttemptAt.clear();
    }
    /** Current throttle-table size; never above `maxTracked`. */
    function tracked() {
        return lastAttemptAt.size;
    }
    return { denial, malfunction, reset, tracked };
}
