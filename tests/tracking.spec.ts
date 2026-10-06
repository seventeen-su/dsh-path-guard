/**
 * `src/tracking.ts` — the tool-tracking registry.
 *
 * Covers the two halves the user asked for: continuous detection (observe) and
 * denial-time self-learning with family generalization, plus the caps and the
 * persistence round-trip that make the registry survive a restart.
 *
 * @module dsh-path-guard/tests/tracking
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTIFIED_MAX,
  TRACKED_FIELDS_MAX,
  TRACKED_TOOLS_MAX,
  TRACKING_VERSION,
  createTracking,
  familyOf,
} from '../src/tracking.ts'

// ---------------------------------------------------------------------------
// familyOf
// ---------------------------------------------------------------------------

test('familyOf: an MCP server names the family', () => {
  assert.equal(familyOf('mcp__fs__read_file'), 'mcp__fs__')
  assert.equal(familyOf('mcp__fs__write_file'), 'mcp__fs__')
  assert.equal(familyOf('mcp__git__status'), 'mcp__git__')
  // The server is what shares a schema, so two servers never share a family.
  assert.notEqual(familyOf('mcp__fs__read_file'), familyOf('mcp__git__read_file'), )
})

test('familyOf: otherwise the last underscore wins', () => {
  assert.equal(familyOf('acme_status'), 'acme_')
  assert.equal(familyOf('notes_search_v2'), 'notes_search_')
  assert.equal(familyOf('a_b_c'), 'a_b_')
})

test('familyOf: no underscore means no family', () => {
  // The point of the empty string: an underscore-less name must not be the
  // sibling of every other underscore-less name.
  assert.equal(familyOf('unknown'), '')
  assert.equal(familyOf(''), '')
  assert.equal(familyOf(undefined), '')
  assert.equal(familyOf(42), '')
})

test('familyOf: malformed MCP names produce NO family', () => {
  // `mcp__foo` has no server separator, so it is not `mcp__<server>__tool`. It
  // must not fall back to the generic underscore rule either: that fallback is
  // exactly how the fabricated families `mcp__` / `mcp__read_` used to appear.
  assert.equal(familyOf('mcp__foo'), '')
  assert.equal(familyOf('mcp__read_file'), '')
  assert.equal(familyOf('mcp__'), '')
  // …while a real second segment still names its server.
  assert.equal(familyOf('mcp__fs__'), 'mcp__fs__')
})

test('familyOf: a one-character prefix proves nothing', () => {
  // `_private` would otherwise put every leading-underscore tool in one family.
  assert.equal(familyOf('_private'), '')
  assert.equal(familyOf('_'), '')
  // Two characters is the floor for a real prefix.
  assert.equal(familyOf('a_b'), 'a_')
  assert.equal(familyOf('ab_c'), 'ab_')
})

// ---------------------------------------------------------------------------
// observe — continuous detection
// ---------------------------------------------------------------------------

test('observe creates on first sighting and counts afterwards', () => {
  const tracking = createTracking()
  const first = tracking.observe('acme_status', 1000)
  assert.deepEqual(first, {
    name: 'acme_status',
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    seen: 1,
    refused: 0,
    fields: [],
    capabilities: {},
    notified: false,
  })
  const second = tracking.observe('acme_status', 2000)
  assert.equal(second?.seen, 2)
  assert.equal(second?.lastSeenAt, 2000)
  assert.equal(second?.firstSeenAt, 1000, 'the first sighting is not overwritten')
  assert.equal(tracking.list().length, 1, 'one record, not one per call')
})

test('observe ignores names that are not usable tool names', () => {
  const tracking = createTracking()
  for (const name of [undefined, null, 42, {}, [], '']) {
    assert.equal(tracking.observe(name, 1), undefined, String(name))
  }
  assert.deepEqual(tracking.list(), [])
})

test('observe does not trim names, so a padded name cannot alias a real tool', () => {
  const tracking = createTracking()
  tracking.observe('  notes_search  ', 5)
  tracking.observe('notes_search', 6)
  assert.deepEqual(tracking.list().map(record => record.name), ['  notes_search  ', 'notes_search'])
})

test('an unusable timestamp falls back to the clock instead of poisoning the record', () => {
  const tracking = createTracking()
  const before = Date.now()
  const record = tracking.observe('acme_status', Number.NaN)
  assert.ok((record?.lastSeenAt ?? 0) >= before, 'the wall clock is used when `at` is not a number')
})

// ---------------------------------------------------------------------------
// learnFromDenial — self-learning + family generalization
// ---------------------------------------------------------------------------

test('learnFromDenial records a tool that was never observed', () => {
  const tracking = createTracking()
  const affected = tracking.learnFromDenial('acme_read', 'file_path', 'read', 100)
  assert.deepEqual(affected, [], 'nothing else was recorded, so nothing else changed')
  const record = tracking.get('acme_read')
  assert.equal(record?.seen, 1, 'the tool is recorded first')
  assert.equal(record?.refused, 1, 'and the refusal is counted')
  assert.deepEqual(record?.fields, ['file_path'])
  assert.equal(record?.capabilities?.['file_path'], 'read')
})

test('learnFromDenial stamps the field onto already-recorded family members', () => {
  const tracking = createTracking()
  tracking.observe('mcp__fs__read_file', 1)
  tracking.observe('mcp__fs__stat', 2)
  tracking.observe('mcp__git__status', 3)
  const affected = tracking.learnFromDenial('mcp__fs__write_file', 'path', 'write', 4)
  assert.deepEqual(affected, ['mcp__fs__read_file', 'mcp__fs__stat'], 'sorted, and only the same server')
  assert.deepEqual(tracking.knownFields('mcp__fs__read_file'), [{ field: 'path', capability: 'write' }])
  assert.deepEqual(tracking.knownFields('mcp__fs__stat'), [{ field: 'path', capability: 'write' }])
  assert.deepEqual(tracking.knownFields('mcp__git__status'), [], 'a different server learns nothing')
})

test('learnFromDenial does not generalize past a name with no family', () => {
  const tracking = createTracking()
  tracking.observe('alpha', 1)
  tracking.observe('beta', 2)
  const affected = tracking.learnFromDenial('gamma', 'path', 'write', 3)
  assert.deepEqual(affected, [], 'no underscore means no siblings')
  assert.deepEqual(tracking.knownFields('alpha'), [])
  assert.deepEqual(tracking.knownFields('beta'), [])
})

test('learnFromDenial ignores an unusable name or field, and does not count it as a refusal', () => {
  const tracking = createTracking()
  assert.deepEqual(tracking.learnFromDenial('', 'path', 'write', 1), [])
  assert.deepEqual(tracking.learnFromDenial('acme_read', '', 'write', 1), [])
  assert.deepEqual(tracking.learnFromDenial('acme_read', undefined, 'write', 1), [])
  assert.deepEqual(tracking.list(), [], 'nothing was recorded')
})

test('learning the same field twice does not duplicate it, and still counts the refusal', () => {
  const tracking = createTracking()
  tracking.learnFromDenial('acme_read', 'path', 'read', 1)
  tracking.learnFromDenial('acme_read', 'path', 'write', 2)
  const record = tracking.get('acme_read')
  assert.deepEqual(record?.fields, ['path'])
  assert.equal(record?.refused, 2)
  assert.equal(record?.capabilities?.['path'], 'write', 'the latest capability wins')
  assert.equal(record?.lastSeenAt, 2)
})

test('learnedFrom records which leg taught the field, when the caller says so', () => {
  const tracking = createTracking()
  tracking.learnFromDenial('acme_read', 'path', 'read', 1, 'value')
  assert.equal(tracking.get('acme_read')?.learnedFrom, 'value')
  tracking.learnFromDenial('acme_read', 'dir', 'list', 2, 'name')
  assert.equal(tracking.get('acme_read')?.learnedFrom, 'name')
})

test('knownFields reports the strictest capability for data that lost its own', () => {
  const tracking = createTracking()
  tracking.fromJSON([{ name: 'acme_read', fields: ['path'], seen: 1 }])
  assert.deepEqual(tracking.knownFields('acme_read'), [{ field: 'path', capability: 'write' }])
})

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test(`a tool keeps at most ${TRACKED_FIELDS_MAX} learned fields, first learned first`, () => {
  const tracking = createTracking()
  for (let index = 0; index < TRACKED_FIELDS_MAX + 5; index += 1) {
    tracking.learnFromDenial('acme_read', `field_${index}`, 'write', index)
  }
  const record = tracking.get('acme_read')
  assert.equal(record?.fields.length, TRACKED_FIELDS_MAX)
  assert.equal(record?.fields[0], 'field_0', 'the first fields learned are the ones kept')
  assert.equal(record?.fields.includes(`field_${TRACKED_FIELDS_MAX}`), false)
})

test(`the registry keeps at most ${TRACKED_TOOLS_MAX} tools, evicting the least recently seen`, () => {
  const tracking = createTracking()
  for (let index = 0; index < TRACKED_TOOLS_MAX; index += 1) tracking.observe(`tool_${index}`, 1000 + index)
  assert.equal(tracking.list().length, TRACKED_TOOLS_MAX)
  // A fresh sighting of the oldest tool must make it survive the next eviction.
  tracking.observe('tool_0', 99999)
  tracking.observe('newcomer', 100000)
  assert.equal(tracking.list().length, TRACKED_TOOLS_MAX)
  assert.equal(tracking.get('tool_0') !== undefined, true, 'a re-sighting refreshes recency')
  assert.equal(tracking.get('tool_1'), undefined, 'the next-oldest went instead')
  assert.equal(tracking.get('newcomer') !== undefined, true)
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test('toJSON/fromJSON round-trips every field the registry carries', () => {
  const tracking = createTracking()
  tracking.observe('mcp__fs__read_file', 10)
  tracking.observe('mcp__fs__read_file', 20)
  tracking.learnFromDenial('mcp__fs__read_file', 'path', 'read', 30, 'value')
  tracking.markNotified('mcp__fs__read_file')

  const snapshot = tracking.toJSON()
  assert.equal(snapshot.version, TRACKING_VERSION)
  assert.equal(JSON.parse(JSON.stringify(snapshot)) !== null, true, 'the snapshot is JSON-safe')

  const restored = createTracking()
  restored.fromJSON(snapshot)
  assert.deepEqual(restored.list(), tracking.list())
  assert.deepEqual(restored.knownFields('mcp__fs__read_file'), [{ field: 'path', capability: 'read' }])
  assert.equal(restored.get('mcp__fs__read_file')?.notified, true, 'a restart must not re-notify')
})

test('fromJSON accepts a bare array as well as the versioned envelope', () => {
  const tracking = createTracking()
  tracking.fromJSON([{ name: 'acme_status', seen: 3, lastSeenAt: 7 }])
  assert.equal(tracking.get('acme_status')?.seen, 3)
  assert.equal(tracking.get('acme_status')?.firstSeenAt, 7, 'a missing first sighting mirrors the last one')
})

test('fromJSON replaces the registry rather than merging into it', () => {
  const tracking = createTracking()
  tracking.observe('old_tool', 1)
  tracking.fromJSON({ version: 1, records: [{ name: 'new_tool', seen: 1 }] })
  assert.deepEqual(tracking.list().map(record => record.name), ['new_tool'])
})

test('fromJSON never throws and drops every entry that is not a record', () => {
  const tracking = createTracking()
  const junk: unknown[] = [null, undefined, 42, 'text', [], {}, { name: '' }, { name: 7 }]
  for (const data of [undefined, null, 42, 'text', {}, { records: 'no' }, { records: [null] }, junk, { version: 1, records: junk }]) {
    assert.doesNotThrow(() => tracking.fromJSON(data), JSON.stringify(data) ?? 'undefined')
  }
  assert.deepEqual(tracking.list(), [], 'no entry in that list is a record')
})

test('fromJSON repairs bad fields instead of trusting them', () => {
  const tracking = createTracking()
  tracking.fromJSON({
    version: 1,
    records: [{
      name: 'acme_read',
      firstSeenAt: -5,
      lastSeenAt: 'yesterday',
      seen: 2,
      refused: 2.7,
      fields: ['path', 'path', '', 42, 'dir'],
      capabilities: { path: 'read', dir: 'nonsense', ghost: 'read' },
      learnedFrom: 'somewhere',
      notified: 'yes',
    }],
  })
  const record = tracking.get('acme_read')
  assert.equal(record?.firstSeenAt, 0)
  assert.equal(record?.lastSeenAt, 0)
  assert.equal(record?.seen, 2)
  assert.equal(record?.refused, 2)
  assert.deepEqual(record?.fields, ['path', 'dir'], 'deduped, non-strings dropped')
  assert.deepEqual(record?.capabilities, { path: 'read', dir: 'nonsense' }, 'a capability for a missing field is junk')
  assert.equal(record?.learnedFrom, undefined, 'an unknown leg is dropped')
  assert.equal(record?.notified, false, 'only a true boolean counts')
})

// ---------------------------------------------------------------------------
// R1(c): persisted state needs real observation evidence
// ---------------------------------------------------------------------------

test('a record with no sighting keeps its NAME but loses everything a file could forge', () => {
  const tracking = createTracking()
  tracking.fromJSON({
    version: 1,
    records: [{
      name: 'acme_read',
      seen: 0,
      refused: 0,
      fields: ['path'],
      capabilities: { path: 'list' },
      learnedFrom: 'value',
      notified: true,
    }],
  })
  const record = tracking.get('acme_read')
  assert.equal(record !== undefined, true, 'the name survives, so the trust list still offers the tool')
  assert.deepEqual(record?.fields, [], 'no sighting ⇒ no learned knowledge')
  assert.deepEqual(record?.capabilities, {})
  assert.equal(record?.learnedFrom, undefined)
  assert.equal(record?.notified, false, 'no sighting ⇒ the notice is NOT silenced')
  assert.equal(tracking.notifiedBefore('acme_read'), false)
  assert.deepEqual(tracking.knownFields('acme_read'), [])
})

test('a record whose counts are missing or unusable is treated as unsighted', () => {
  const tracking = createTracking()
  tracking.fromJSON([
    { name: 'no_counts', fields: ['path'], notified: true },
    { name: 'negative', seen: -3, fields: ['path'], notified: true },
    { name: 'fractional', seen: 0.9, fields: ['path'], notified: true },
    { name: 'stringly', seen: '9', fields: ['path'], notified: true },
  ])
  for (const name of ['no_counts', 'negative', 'fractional', 'stringly']) {
    assert.deepEqual(tracking.get(name)?.fields, [], name)
    assert.equal(tracking.notifiedBefore(name), false, name)
  }
})

test('one real sighting is enough evidence to keep learned state', () => {
  const tracking = createTracking()
  tracking.fromJSON({
    version: 1,
    records: [{ name: 'acme_read', seen: 1, refused: 1, fields: ['path'], capabilities: { path: 'read' }, notified: true }],
  })
  assert.deepEqual(tracking.get('acme_read')?.fields, ['path'])
  assert.equal(tracking.notifiedBefore('acme_read'), true)
})

test('an envelope notification list is only believed with a sighting behind it', () => {
  const tracking = createTracking()
  tracking.fromJSON({
    version: 1,
    records: [{ name: 'seen_tool', seen: 1 }, { name: 'silent_tool' }],
    notified: ['seen_tool', 'silent_tool', 'no_record', '', 42],
  })
  assert.equal(tracking.notifiedBefore('seen_tool'), true)
  assert.equal(tracking.notifiedBefore('silent_tool'), false, 'the record shows no sighting')
  assert.equal(tracking.notifiedBefore('no_record'), false, 'no record at all')
  assert.equal(tracking.toJSON().notified?.length, 1)
})

// ---------------------------------------------------------------------------
// R2: bounded load + non-quadratic eviction
// ---------------------------------------------------------------------------

test('200k records load in milliseconds and keep only the newest 200', () => {
  const tracking = createTracking()
  const total = 200_000
  const records = Array.from({ length: total }, (_, index) => ({ name: `tool_${index}`, lastSeenAt: index }))
  const started = performance.now()
  tracking.fromJSON({ version: 1, records })
  const elapsed = performance.now() - started
  const kept = tracking.list()
  assert.equal(kept.length, TRACKED_TOOLS_MAX)
  assert.ok(elapsed < 1000, `200k records must load in milliseconds, took ${elapsed.toFixed(1)}ms`)
  // The cap keeps the NEWEST names: the tail of the file is what survives.
  assert.equal(tracking.get(`tool_${total - 1}`)?.name, `tool_${total - 1}`)
  assert.equal(tracking.get('tool_0'), undefined)
  console.log(`    [perf] fromJSON with 200k records: ${elapsed.toFixed(1)}ms`)
})

test('an oversized file keeps the newest slice instead of walking all of it', () => {
  const tracking = createTracking()
  const total = TRACKED_TOOLS_MAX * 10 + 500
  const records = Array.from({ length: total }, (_, index) => ({ name: `tool_${index}`, lastSeenAt: index }))
  tracking.fromJSON(records)
  assert.equal(tracking.list().length, TRACKED_TOOLS_MAX)
  assert.equal(tracking.get(`tool_${total - 1}`) !== undefined, true)
  // Everything before the retained slice is gone, so a 7MB file cannot stall
  // activation even when its entries are individually valid.
  assert.equal(tracking.get(`tool_${total - TRACKED_TOOLS_MAX * 10 - 1}`), undefined)
})

test('observe stays linear: filling well past the cap does not blow up', () => {
  const tracking = createTracking()
  const started = performance.now()
  for (let index = 0; index < 20_000; index += 1) tracking.observe(`tool_${index}`, index)
  const elapsed = performance.now() - started
  assert.equal(tracking.list().length, TRACKED_TOOLS_MAX)
  assert.ok(elapsed < 2000, `20k sightings must stay linear, took ${elapsed.toFixed(1)}ms`)
  console.log(`    [perf] 20k observe() calls: ${elapsed.toFixed(1)}ms`)
})

// ---------------------------------------------------------------------------
// R3: the notification dedup is independent of record eviction
// ---------------------------------------------------------------------------

test('the notification bit survives the eviction of its own record', () => {
  const tracking = createTracking()
  tracking.observe('tool_000', 1)
  tracking.markNotified('tool_000')
  for (let index = 1; index <= TRACKED_TOOLS_MAX; index += 1) tracking.observe(`tool_${String(index).padStart(3, '0')}`, index + 1)
  assert.equal(tracking.get('tool_000'), undefined, 'the record itself was evicted')
  assert.equal(tracking.notifiedBefore('tool_000'), true, 'the dedup did not reset with it')
  tracking.observe('tool_000', 9999)
  assert.equal(tracking.notifiedBefore('tool_000'), true)
})

test('the notification set is bounded and forgets the oldest names first', () => {
  const tracking = createTracking()
  for (let index = 0; index < NOTIFIED_MAX + 50; index += 1) {
    tracking.observe(`tool_${index}`, index)
    tracking.markNotified(`tool_${index}`)
  }
  assert.equal(tracking.toJSON().notified?.length, NOTIFIED_MAX)
  assert.equal(tracking.notifiedBefore('tool_0'), false, 'the oldest notification was forgotten')
  assert.equal(tracking.notifiedBefore(`tool_${NOTIFIED_MAX + 49}`), true)
})

test('markNotified does not need a record, and round-trips through the file', () => {
  const tracking = createTracking()
  tracking.markNotified('ghost_tool')
  assert.equal(tracking.notifiedBefore('ghost_tool'), true)
  const restored = createTracking()
  restored.fromJSON(tracking.toJSON())
  assert.equal(restored.notifiedBefore('ghost_tool'), false, 'no sighting ⇒ the name is not believed')
})

test('a notified tool with a real record keeps its dedup across a reload', () => {
  const tracking = createTracking()
  tracking.observe('acme_status', 10)
  tracking.markNotified('acme_status')
  const restored = createTracking()
  restored.fromJSON(JSON.parse(JSON.stringify(tracking.toJSON())))
  assert.equal(restored.notifiedBefore('acme_status'), true, 'the organic record carries the evidence')
})

test('fromJSON keeps the first of two records with the same name', () => {
  const tracking = createTracking()
  tracking.fromJSON([
    { name: 'acme_read', seen: 1 },
    { name: 'acme_read', seen: 9 },
  ])
  assert.equal(tracking.list().length, 1)
  assert.equal(tracking.get('acme_read')?.seen, 1)
})

test('fromJSON bounds the loaded set like the live registry', () => {
  const tracking = createTracking()
  const records = Array.from({ length: TRACKED_TOOLS_MAX + 10 }, (_, index) => ({
    name: `tool_${index}`,
    lastSeenAt: index,
  }))
  tracking.fromJSON(records)
  assert.equal(tracking.list().length, TRACKED_TOOLS_MAX)
  assert.equal(tracking.get('tool_0'), undefined, 'the oldest loaded sighting is the first to go')
})
