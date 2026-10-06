/**
 * Tool tracking registry: continuous detection, denial-time self-learning,
 * family generalization, and persistence.
 *
 * The plugin tracks the tools it does NOT model (third-party plugins, MCP
 * servers), because that is exactly the set it cannot judge by table. What used
 * to be a one-shot `Map<name, 'seen' | reason>` is now a registry with two jobs
 * (the user's item 4):
 *
 * 1. **Continuous detection.** Every unmodelled call is {@link observe}d, so a
 *    tool carries a real sighting count and last-seen time instead of a single
 *    "we saw it once" flag. That is what makes the trust list sortable, the caps
 *    evictable, and "have we already told the user about this one?" answerable.
 * 2. **Self-learning on refusal.** When a rule refuses a path an unmodelled tool
 *    named, {@link learnFromDenial} remembers the FIELD that carried it. From
 *    then on that field is judged by NAME — every non-empty string in it is a
 *    path — instead of by guessing at the value's shape. The same field is
 *    stamped onto every already-recorded tool of the same family, which is how
 *    one refusal teaches `mcp__fs__write_file` what `mcp__fs__read_file` was
 *    refused for.
 *
 * The registry is deliberately pure, with the same discipline as
 * `src/resource.ts`: zero imports, no clock of its own (every entry point takes
 * `at`), no I/O, and no knowledge of Cordis, policy, or resource resolution.
 * Persistence belongs to the caller (`src/index.ts`), which only has to funnel
 * {@link Tracking.toJSON} / {@link Tracking.fromJSON} through a file.
 *
 * @module dsh-path-guard/tracking
 */
/** One field learned for a tracked tool. */
export interface TrackedField {
    /** The field, in the accessor notation a resource was reported under. */
    field: string;
    /**
     * The capability the field's value needs. Persisted data that carries none
     * (or carries something unrecognised) reads back as `write` — the strictest
     * rung, so a corrupt file can only ever over-restrict.
     */
    capability: string;
}
/**
 * One tracked tool.
 *
 * `fields` is the tool's own learned field list; fields inherited through
 * {@link Tracking.learnFromDenial}'s family rule are materialized into it, so
 * there is exactly one place to read a record's knowledge from.
 */
export interface ToolRecord {
    /** The model-facing tool name, as observed. */
    name: string;
    /** First sighting, epoch ms. */
    firstSeenAt: number;
    /** Most recent sighting, epoch ms. */
    lastSeenAt: number;
    /** How many calls have been observed. */
    seen: number;
    /** How many of those calls a rule refused. */
    refused: number;
    /** Learned path fields, in the order they were learned (≤ {@link TRACKED_FIELDS_MAX}). */
    fields: string[];
    /** Which leg taught the most recent field: a path-shaped value, or a path-shaped name. */
    learnedFrom?: 'name' | 'value';
    /** Field → capability. Additive to the original sketch: without it a restart would lose it. */
    capabilities?: Record<string, string>;
    /**
     * Whether the user has already been told about this tool.
     *
     * Derived from the registry's independent notification set, NOT stored on the
     * record: a record can be evicted, and a dedup bit that dies with its record
     * turns "once per tool" into "once per time the tool re-enters the registry".
     */
    notified?: boolean;
}
/** The persisted file shape. */
export interface TrackingSnapshot {
    /** Format version; {@link Tracking.fromJSON} accepts this envelope or a bare array. */
    version: number;
    /** The records, in first-seen order. */
    records: ToolRecord[];
    /** Names the user has already been told about (see {@link Tracking.notifiedBefore}). */
    notified?: string[];
}
/** Cap on tracked tools. Older sightings are evicted first (see {@link Tracking.observe}). */
export declare const TRACKED_TOOLS_MAX = 200;
/** Cap on learned fields per tool. The first fields learned win. */
export declare const TRACKED_FIELDS_MAX = 16;
/** Cap on the notification memory. Older names are forgotten first. */
export declare const NOTIFIED_MAX = 1000;
/** Version stamped into {@link TrackingSnapshot}. */
export declare const TRACKING_VERSION = 1;
/**
 * The family prefix of a tool name — the unit {@link Tracking.learnFromDenial}
 * generalizes over.
 *
 * - `mcp__<server>__tool` → `mcp__<server>__`, so every tool of one MCP server
 *   is one family (the server is what shares a schema). An `mcp__` name WITHOUT
 *   that second segment (`mcp__read_file`, `mcp__`) names no server, so it gets
 *   NO family rather than a fabricated `mcp__read_`, and it does not fall back
 *   to the generic rule either — that fallback is exactly how the fake family
 *   used to appear;
 * - otherwise the text up to and including the LAST `_` (`acme_status` →
 *   `acme_`), which is the naming convention plugin tools already follow;
 * - no `_` at all, or a prefix shorter than two characters (`_private`) → `''`:
 *   an underscore-less name must not be the sibling of every other
 *   underscore-less name, and a one-character prefix is a coincidence rather
 *   than an attribution.
 *
 * Family is still a NAME convention rather than real ownership, so two unrelated
 * tools that happen to share `list_` do share a family. That is the accepted
 * price of the feature the user asked for ("record the same for other similar
 * tools"); the rules above only remove the names that prove nothing at all.
 * @param {unknown} name - the tool name.
 * @returns {string} the family prefix, or `''` when the name has no family.
 */
export declare function familyOf(name: unknown): string;
/** The registry surface `src/index.ts` wires. */
export interface Tracking {
    /**
     * Record one sighting (continuous detection). Creates the record on first
     * sighting; afterwards bumps `seen` and `lastSeenAt` only.
     * @param {unknown} name - the tool name.
     * @param {number} [at] - sighting time, epoch ms; defaults to `Date.now()`.
     * @returns {ToolRecord | undefined} a snapshot of the record, or undefined for an unusable name.
     */
    observe(name: unknown, at?: number): ToolRecord | undefined;
    /**
     * Learn one path field from a refusal.
     *
     * Records the tool first when it has never been seen, counts the refusal, and
     * stamps the same field onto every ALREADY-recorded tool of the same family.
     * A tool first seen later does not inherit retroactively — it learns on its
     * own first refusal (the heuristics still judge its arguments meanwhile).
     * @param {unknown} name - the refused tool.
     * @param {unknown} field - the field that carried the refused path.
     * @param {unknown} capability - the capability the field needs.
     * @param {number} [at] - refusal time, epoch ms.
     * @param {'name' | 'value'} [learnedFrom] - which leg produced the field.
     * @returns {string[]} the OTHER tools the field was stamped onto, sorted.
     */
    learnFromDenial(name: unknown, field: unknown, capability: unknown, at?: number, learnedFrom?: 'name' | 'value'): string[];
    /**
     * The fields this tool knows, directly or by family inheritance.
     * @param {unknown} name - the tool name.
     * @returns {TrackedField[]} the fields, in learning order.
     */
    knownFields(name: unknown): TrackedField[];
    /** @param {unknown} name - the tool name. @returns {string} the family prefix. */
    familyOf(name: unknown): string;
    /** @param {unknown} name - the tool name. @returns {ToolRecord | undefined} a snapshot, if tracked. */
    get(name: unknown): ToolRecord | undefined;
    /**
     * Whether the user has already been told about this tool.
     *
     * Answered from the independent notification set, so it stays true across
     * record eviction — that is the difference between "once per tool" and "once
     * per time the tool re-enters the registry".
     * @param {unknown} name - the tool name.
     * @returns {boolean} true when the notice has already been sent for this name.
     */
    notifiedBefore(name: unknown): boolean;
    /**
     * Record that the user has been told about this tool, so the notice fires once.
     * @param {unknown} name - the tool name.
     */
    markNotified(name: unknown): void;
    /** @returns {ToolRecord[]} every record, in first-seen order. */
    list(): ToolRecord[];
    /** @returns {TrackingSnapshot} a JSON-safe snapshot of the whole registry. */
    toJSON(): TrackingSnapshot;
    /**
     * Replace the registry with persisted data. Never throws: any shape is
     * accepted, and every entry that does not fit the schema is dropped.
     * @param {unknown} data - the parsed file, or anything else.
     */
    fromJSON(data: unknown): void;
}
/**
 * Create an empty registry.
 *
 * A factory rather than module state on purpose: every plugin activation gets
 * its own registry (and its own persistence), and tests can hold several at
 * once without leaking into each other.
 * @returns {Tracking} the registry.
 */
export declare function createTracking(): Tracking;
