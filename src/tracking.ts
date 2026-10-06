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
  field: string
  /**
   * The capability the field's value needs. Persisted data that carries none
   * (or carries something unrecognised) reads back as `write` — the strictest
   * rung, so a corrupt file can only ever over-restrict.
   */
  capability: string
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
  name: string
  /** First sighting, epoch ms. */
  firstSeenAt: number
  /** Most recent sighting, epoch ms. */
  lastSeenAt: number
  /** How many calls have been observed. */
  seen: number
  /** How many of those calls a rule refused. */
  refused: number
  /** Learned path fields, in the order they were learned (≤ {@link TRACKED_FIELDS_MAX}). */
  fields: string[]
  /** Which leg taught the most recent field: a path-shaped value, or a path-shaped name. */
  learnedFrom?: 'name' | 'value'
  /** Field → capability. Additive to the original sketch: without it a restart would lose it. */
  capabilities?: Record<string, string>
  /**
   * Whether the user has already been told about this tool.
   *
   * Derived from the registry's independent notification set, NOT stored on the
   * record: a record can be evicted, and a dedup bit that dies with its record
   * turns "once per tool" into "once per time the tool re-enters the registry".
   */
  notified?: boolean
}

/** The persisted file shape. */
export interface TrackingSnapshot {
  /** Format version; {@link Tracking.fromJSON} accepts this envelope or a bare array. */
  version: number
  /** The records, in first-seen order. */
  records: ToolRecord[]
  /** Names the user has already been told about (see {@link Tracking.notifiedBefore}). */
  notified?: string[]
}

/** Cap on tracked tools. Older sightings are evicted first (see {@link Tracking.observe}). */
export const TRACKED_TOOLS_MAX = 200

/** Cap on learned fields per tool. The first fields learned win. */
export const TRACKED_FIELDS_MAX = 16

/** Cap on the notification memory. Older names are forgotten first. */
export const NOTIFIED_MAX = 1000

/**
 * Most records {@link Tracking.fromJSON} will even look at.
 *
 * The registry's own cap is {@link TRACKED_TOOLS_MAX}, so a file an order of
 * magnitude past it was not written by this plugin (or was tampered with). It is
 * treated as damaged: only its tail — the newest entries, in a file we wrote —
 * is considered, instead of walking megabytes of attacker-supplied records.
 */
const LOAD_RECORDS_MAX = TRACKED_TOOLS_MAX * 10

/** Version stamped into {@link TrackingSnapshot}. */
export const TRACKING_VERSION = 1

/** The capability used when persisted data carries none: the strictest rung. */
const FALLBACK_CAPABILITY = 'write'

/** Longest capability string accepted from persisted data. */
const CAPABILITY_MAX_LENGTH = 32

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
export function familyOf(name: unknown): string {
  const text = typeof name === 'string' ? name : ''
  if (text === '') return ''
  if (text.startsWith('mcp__')) {
    const rest = text.slice(5)
    const separator = rest.indexOf('__')
    // A server is present only when something precedes the second `__`.
    if (separator > 0) return `mcp__${rest.slice(0, separator)}__`
    // Malformed MCP name: no server, therefore no family.
    return ''
  }
  const cut = text.lastIndexOf('_')
  // `cut < 1` covers both "no underscore" and "the name starts with one".
  return cut < 1 ? '' : text.slice(0, cut + 1)
}

/** A record plus the live lookup its materialized form cannot carry. */
interface InternalRecord {
  name: string
  firstSeenAt: number
  lastSeenAt: number
  seen: number
  refused: number
  fields: string[]
  capabilities: Map<string, string>
  learnedFrom?: 'name' | 'value'
}

/** The registry surface `src/index.ts` wires. */
export interface Tracking {
  /**
   * Record one sighting (continuous detection). Creates the record on first
   * sighting; afterwards bumps `seen` and `lastSeenAt` only.
   * @param {unknown} name - the tool name.
   * @param {number} [at] - sighting time, epoch ms; defaults to `Date.now()`.
   * @returns {ToolRecord | undefined} a snapshot of the record, or undefined for an unusable name.
   */
  observe(name: unknown, at?: number): ToolRecord | undefined
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
  learnFromDenial(
    name: unknown,
    field: unknown,
    capability: unknown,
    at?: number,
    learnedFrom?: 'name' | 'value',
  ): string[]
  /**
   * The fields this tool knows, directly or by family inheritance.
   * @param {unknown} name - the tool name.
   * @returns {TrackedField[]} the fields, in learning order.
   */
  knownFields(name: unknown): TrackedField[]
  /** @param {unknown} name - the tool name. @returns {string} the family prefix. */
  familyOf(name: unknown): string
  /** @param {unknown} name - the tool name. @returns {ToolRecord | undefined} a snapshot, if tracked. */
  get(name: unknown): ToolRecord | undefined
  /**
   * Whether the user has already been told about this tool.
   *
   * Answered from the independent notification set, so it stays true across
   * record eviction — that is the difference between "once per tool" and "once
   * per time the tool re-enters the registry".
   * @param {unknown} name - the tool name.
   * @returns {boolean} true when the notice has already been sent for this name.
   */
  notifiedBefore(name: unknown): boolean
  /**
   * Record that the user has been told about this tool, so the notice fires once.
   * @param {unknown} name - the tool name.
   */
  markNotified(name: unknown): void
  /** @returns {ToolRecord[]} every record, in first-seen order. */
  list(): ToolRecord[]
  /** @returns {TrackingSnapshot} a JSON-safe snapshot of the whole registry. */
  toJSON(): TrackingSnapshot
  /**
   * Replace the registry with persisted data. Never throws: any shape is
   * accepted, and every entry that does not fit the schema is dropped.
   * @param {unknown} data - the parsed file, or anything else.
   */
  fromJSON(data: unknown): void
}

/** Read a usable tool name, un-trimmed so a padded name can never alias a real one. */
function cleanName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read a usable field name, un-trimmed for the same reason. */
function cleanField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read an epoch-ms timestamp, falling back when the value is not one. */
function cleanTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Read a non-negative counter. */
function cleanCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Read a capability string from persisted data; unrecognised shapes are dropped. */
function cleanCapability(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' || text.length > CAPABILITY_MAX_LENGTH ? undefined : text
}

/** Read the leg a field was learned from. */
function cleanLearnedFrom(value: unknown): 'name' | 'value' | undefined {
  return value === 'name' || value === 'value' ? value : undefined
}

/**
 * Order records newest-first: by last sighting, then first sighting, then name.
 * The first {@link TRACKED_TOOLS_MAX} of this order are the ones kept.
 * @param {InternalRecord} a - left record.
 * @param {InternalRecord} b - right record.
 * @returns {number} comparison result.
 */
function compareRecency(a: InternalRecord, b: InternalRecord): number {
  return b.lastSeenAt - a.lastSeenAt
    || b.firstSeenAt - a.firstSeenAt
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * Materialize an internal record into its JSON-safe, caller-facing shape.
 * @param {InternalRecord} record - the internal record.
 * @param {boolean} isNotified - whether the notification set holds this name.
 * @returns {ToolRecord} the caller-facing record.
 */
function materialize(record: InternalRecord, isNotified: boolean): ToolRecord {
  const out: ToolRecord = {
    name: record.name,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    seen: record.seen,
    refused: record.refused,
    fields: [...record.fields],
    capabilities: Object.fromEntries(record.capabilities),
    notified: isNotified,
  }
  if (record.learnedFrom !== undefined) out.learnedFrom = record.learnedFrom
  return out
}

/**
 * Create an empty registry.
 *
 * A factory rather than module state on purpose: every plugin activation gets
 * its own registry (and its own persistence), and tests can hold several at
 * once without leaking into each other.
 * @returns {Tracking} the registry.
 */
export function createTracking(): Tracking {
  /** Records in first-seen order. */
  const records = new Map<string, InternalRecord>()

  /**
   * Names the user was told about, oldest first — the notification dedup.
   *
   * Deliberately NOT a field on the record: records are evicted at
   * {@link TRACKED_TOOLS_MAX}, and a dedup bit that dies with its record turns
   * "once per tool" into "once per time the tool re-enters the registry" (a loop
   * over 200+ names would notify forever). This set is bounded by
   * {@link NOTIFIED_MAX} instead and survives record eviction.
   */
  const notified = new Set<string>()

  /** Remember a notification, keeping the set bounded (oldest name first out). */
  const rememberNotified = (name: string): void => {
    // Re-inserting moves a name to the back: this is a FIFO of RECENT
    // notifications, not of first ones.
    notified.delete(name)
    notified.add(name)
    while (notified.size > NOTIFIED_MAX) {
      const oldest = notified.values().next().value
      if (oldest === undefined) return
      notified.delete(oldest)
    }
  }

  /** The caller-facing view of one internal record. */
  const view = (record: InternalRecord): ToolRecord => materialize(record, notified.has(record.name))

  /**
   * Drop the least-recently-seen records until the cap holds.
   *
   * One `O(n log n)` ordering, or a single `O(n)` scan when one insert pushed the
   * table one past the cap. The previous implementation re-scanned the whole
   * table for EVERY eviction, which made loading an oversized file quadratic: a
   * 200k-entry file took ~115s and blocked activation.
   */
  const evict = (): void => {
    const excess = records.size - TRACKED_TOOLS_MAX
    if (excess <= 0) return
    if (excess === 1) {
      let oldest: InternalRecord | undefined
      for (const record of records.values()) {
        if (oldest === undefined || compareRecency(record, oldest) > 0) oldest = record
      }
      if (oldest !== undefined) records.delete(oldest.name)
      return
    }
    // Bulk path (a file load): sort once, keep the newest TRACKED_TOOLS_MAX.
    const ordered = [...records.values()].sort(compareRecency)
    for (const record of ordered.slice(TRACKED_TOOLS_MAX)) records.delete(record.name)
  }

  /** Insert a fresh record. */
  const create = (name: string, at: number): InternalRecord => {
    const record: InternalRecord = {
      name,
      firstSeenAt: at,
      lastSeenAt: at,
      seen: 1,
      refused: 0,
      fields: [],
      capabilities: new Map<string, string>(),
    }
    records.set(name, record)
    evict()
    return record
  }

  /**
   * Add one field to a record.
   * @returns {boolean} true when the record did not already have it.
   */
  const teach = (record: InternalRecord, field: string, capability: string | undefined): boolean => {
    const fresh = !record.fields.includes(field)
    if (fresh) {
      // The cap is a cap: the first fields learned win, so a tool that sprays
      // random argument names cannot push out the field that was really denied.
      if (record.fields.length >= TRACKED_FIELDS_MAX) return false
      record.fields.push(field)
    }
    if (capability !== undefined) record.capabilities.set(field, capability)
    return fresh
  }

  return {
    observe(name, at) {
      const key = cleanName(name)
      if (key === undefined) return undefined
      const when = cleanTime(at, Date.now())
      const record = records.get(key)
      if (record === undefined) return view(create(key, when))
      record.seen += 1
      record.lastSeenAt = when
      return view(record)
    },

    learnFromDenial(name, field, capability, at, learnedFrom) {
      const key = cleanName(name)
      const target = cleanField(field)
      if (key === undefined || target === undefined) return []
      const when = cleanTime(at, Date.now())
      const record = records.get(key) ?? create(key, when)
      record.refused += 1
      if (when > record.lastSeenAt) record.lastSeenAt = when
      const cap = cleanCapability(capability)
      teach(record, target, cap)
      const leg = cleanLearnedFrom(learnedFrom)
      if (leg !== undefined) record.learnedFrom = leg

      const affected: string[] = []
      const family = familyOf(key)
      // No family means no siblings: an underscore-less name must not infect
      // every other unrelated tool that also has no underscore.
      if (family !== '') {
        for (const other of records.values()) {
          if (other.name === key || familyOf(other.name) !== family) continue
          if (teach(other, target, cap)) affected.push(other.name)
        }
      }
      return affected.sort()
    },

    knownFields(name) {
      const key = cleanName(name)
      const record = key === undefined ? undefined : records.get(key)
      if (record === undefined) return []
      return record.fields.map(field => ({
        field,
        capability: record.capabilities.get(field) ?? FALLBACK_CAPABILITY,
      }))
    },

    familyOf,

    get(name) {
      const key = cleanName(name)
      const record = key === undefined ? undefined : records.get(key)
      return record === undefined ? undefined : view(record)
    },

    notifiedBefore(name) {
      const key = cleanName(name)
      return key === undefined ? false : notified.has(key)
    },

    markNotified(name) {
      const key = cleanName(name)
      // No record required: the dedup outlives the record on purpose.
      if (key !== undefined) rememberNotified(key)
    },

    list() {
      return [...records.values()].map(view)
    },

    toJSON() {
      // Built from `records` directly rather than via `this.list()`: a caller
      // that destructures the method must not lose the registry.
      return {
        version: TRACKING_VERSION,
        records: [...records.values()].map(view),
        notified: [...notified],
      }
    },

    fromJSON(data) {
      try {
        const raw = Array.isArray(data)
          ? data
          : data !== null && typeof data === 'object' && Array.isArray((data as { records?: unknown }).records)
            ? (data as { records: unknown[] }).records
            : []
        // An oversized file was not written by this plugin: our own cap is
        // TRACKED_TOOLS_MAX. Keep the tail — the newest entries, in a file we
        // wrote — instead of walking megabytes of attacker-supplied records.
        const source = raw.length > LOAD_RECORDS_MAX ? raw.slice(raw.length - LOAD_RECORDS_MAX) : raw
        records.clear()
        notified.clear()
        for (const entry of source) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
          const item = entry as Record<string, unknown>
          const name = cleanName(item.name)
          if (name === undefined || records.has(name)) continue

          const seen = cleanCount(item.seen)
          // EVIDENCE GATE. Learned fields, their capabilities and the
          // notification bit are all state a REAL sighting produced. A record
          // that shows no sighting therefore keeps only its name (so the trust
          // list still offers it) and loses everything a hand-written file could
          // otherwise use: knowledge, or a silenced notice.
          const evidenced = seen >= 1

          const fields: string[] = []
          if (evidenced && Array.isArray(item.fields)) {
            for (const value of item.fields) {
              const field = cleanField(value)
              if (field === undefined || fields.includes(field)) continue
              if (fields.length >= TRACKED_FIELDS_MAX) break
              fields.push(field)
            }
          }
          const capabilities = new Map<string, string>()
          const rawCaps = evidenced ? item.capabilities : undefined
          if (rawCaps !== null && rawCaps !== undefined && typeof rawCaps === 'object' && !Array.isArray(rawCaps)) {
            for (const [field, value] of Object.entries(rawCaps)) {
              const cap = cleanCapability(value)
              // A capability for a field the record does not have is junk.
              if (cap !== undefined && fields.includes(field)) capabilities.set(field, cap)
            }
          }
          const lastSeenAt = cleanTime(item.lastSeenAt, 0)
          const record: InternalRecord = {
            name,
            firstSeenAt: cleanTime(item.firstSeenAt, lastSeenAt),
            lastSeenAt,
            seen,
            refused: cleanCount(item.refused),
            fields,
            capabilities,
          }
          // `learnedFrom` describes a field learning that only an evidenced
          // record can have had, so it is gated with the fields themselves.
          const leg = evidenced ? cleanLearnedFrom(item.learnedFrom) : undefined
          if (leg !== undefined) record.learnedFrom = leg
          records.set(name, record)
          if (evidenced && item.notified === true) rememberNotified(name)
        }
        // The envelope's own notification list obeys the same evidence rule: a
        // name is believed only when this same file shows it was really seen.
        // Otherwise `{"notified":["x"]}` would silence the notice in one line.
        const envelope = data !== null && typeof data === 'object' && !Array.isArray(data)
          ? (data as { notified?: unknown }).notified
          : undefined
        if (Array.isArray(envelope)) {
          for (const value of envelope) {
            const name = cleanName(value)
            if (name !== undefined && (records.get(name)?.seen ?? 0) >= 1) rememberNotified(name)
          }
        }
        evict()
      } catch {
        // A registry that throws on a bad file would take the guard down with
        // it. Losing the tracking state is the acceptable failure here.
        records.clear()
        notified.clear()
      }
    },
  }
}
