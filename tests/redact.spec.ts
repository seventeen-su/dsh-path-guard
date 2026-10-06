/**
 * Tests for `src/redact.js` — structured redaction of `glob` / `grep` values.
 *
 * Run: node --test tests/redact.spec.js
 *
 * Sample values mirror the structures confirmed from the DSH sources
 * (`packages/fs/tool-fs-search/src/glob.ts:321-329,340,348` and
 * `grep.ts:294-313,324,335`); path expectations are built with `node:path` so
 * they hold on both platforms, following `search-core.ts:300-306`
 * (`toWorkdirRelative`: relative, workdir-relative, or unchanged absolute).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join, parse, resolve } from 'node:path'

import {
  isRecognizedGlobValue,
  isRecognizedGrepValue,
  redactGlobValue,
  redactGrepValue,
} from '../src/redact.ts'
import { redactTextBlocks, scanCommand } from '../src/scan.ts'
import type { Needle } from '../src/scan.ts'

/** The declared `glob` value shape (glob.ts:321-329). */
interface GlobValue {
  root: string
  paths: string[]
}

/** One `grep` match (grep.ts:302-310). */
interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/** The declared `grep` value shape (grep.ts:294-313). */
interface GrepValue {
  matches: GrepMatch[]
}

/** A deterministic fake session workdir (never touches the real filesystem). */
const CWD = resolve(process.cwd(), 'fixture-workspace')

/** An absolute path outside `CWD`, of the form the tools leave unresolved. */
const OUTSIDE = join(parse(CWD).root, 'outside', 'b.ts')

/** The declared `glob` value schema (glob.ts:322-329). */
function assertGlobSchema(value: GlobValue) {
  assert.deepEqual(Object.keys(value).sort(), ['paths', 'root'])
  assert.equal(typeof value.root, 'string')
  assert.ok(Array.isArray(value.paths))
  assert.ok(value.paths.every((path) => typeof path === 'string'))
}

/** The declared `grep` value schema (grep.ts:295-313). */
function assertGrepSchema(value: GrepValue) {
  assert.deepEqual(Object.keys(value), ['matches'])
  assert.ok(Array.isArray(value.matches))
  for (const match of value.matches) {
    assert.deepEqual(Object.keys(match).sort(), ['line', 'lineNumber', 'path'])
    assert.equal(typeof match.path, 'string')
    assert.ok(Number.isInteger(match.lineNumber), 'lineNumber must be an integer per the schema')
    assert.equal(typeof match.line, 'string')
  }
}

/** Group flat matches by file exactly as grep.ts:191-203 `formatGrepMatches` does. */
function groupByFile(matches: GrepMatch[]) {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  return Array.from(byFile, ([path, group]) => ({ path, group }))
}

/** A `decide` that keys off the basename, recording every absolute path it saw. */
function decideByBasename(map: Record<string, string>, fallback = 'none') {
  const calls: string[] = []
  const decide = (absolutePath: string) => {
    calls.push(absolutePath)
    return map[basename(absolutePath)] ?? fallback
  }
  return { decide, calls }
}

/** Freeze a value deeply so any in-place mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Fixtures that are NOT the declared value structure. */
const UNRECOGNIZED = [
  ['null', null],
  ['undefined', undefined],
  ['number', 42],
  ['string', 'src/a.ts\nsrc/b.ts'],
  ['array', ['src/a.ts']],
  ['legacy text blocks', [{ type: 'text', text: 'Found 2 matches' }]],
  ['empty object', {}],
]

describe('isRecognizedGlobValue', () => {
  it('accepts the populated and empty declared shapes', () => {
    assert.equal(isRecognizedGlobValue({ root: '.', paths: ['a.ts', join('src', 'b.ts'), OUTSIDE] }), true)
    assert.equal(isRecognizedGlobValue({ root: '.', paths: [] }), true)
    assert.equal(isRecognizedGlobValue({ root: 'src', paths: ['a.ts'] }), true)
  })

  it('rejects anything else without throwing', () => {
    const cases = [
      ...UNRECOGNIZED,
      ['missing root', { paths: [] }],
      ['missing paths', { root: '.' }],
      ['non-string root', { root: 1, paths: [] }],
      ['non-array paths', { root: '.', paths: 'a.ts' }],
      ['non-string path entry', { root: '.', paths: [1] }],
      ['null path entry', { root: '.', paths: [null] }],
      ['unknown key (additionalProperties: false)', { root: '.', paths: [], seen: 3 }],
    ]
    for (const [label, value] of cases) {
      assert.equal(isRecognizedGlobValue(value), false, `expected unrecognized: ${label}`)
    }
  })

  it('accepts a glob value the schema validator accepts, after redaction', () => {
    const { decide } = decideByBasename({ 'keep.ts': 'read' })
    const result = redactGlobValue({ root: '.', paths: [join('src', 'keep.ts'), join('src', 'drop.ts')] }, { cwd: CWD, decide })
    assert.equal(result.changed, true)
    assertGlobSchema(result.value as GlobValue)
  })
})

describe('redactGlobValue', () => {
  it('drops `none` entries and keeps `list`/`read`/`write`/`allow` file names', () => {
    const paths = [
      join('src', 'none.ts'),
      join('src', 'list.ts'),
      join('src', 'read.ts'),
      join('src', 'write.ts'),
      join('src', 'allow.ts'),
      join('src', 'unknown-decision.ts'),
    ]
    const { decide } = decideByBasename({
      'none.ts': 'none',
      'list.ts': 'list',
      'read.ts': 'read',
      'write.ts': 'write',
      'allow.ts': 'allow',
      'unknown-decision.ts': 'deny',
    })
    const value = { root: '.', paths }
    const result = redactGlobValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, true)
    assert.deepEqual(result.value.paths, [
      join('src', 'list.ts'),
      join('src', 'read.ts'),
      join('src', 'write.ts'),
      join('src', 'allow.ts'),
    ])
    assert.deepEqual(result.value.root, '.')
    assertGlobSchema(result.value as GlobValue)
  })

  it('returns changed=false and the SAME reference when nothing is dropped', () => {
    const { decide } = decideByBasename({ 'a.ts': 'read', 'b.ts': 'allow' })
    const value = { root: '.', paths: [join('src', 'a.ts'), join('src', 'b.ts')] }
    const result = redactGlobValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, false)
    assert.equal(result.value, value)
  })

  it('treats an empty result as recognized and unchanged', () => {
    const { decide, calls } = decideByBasename({})
    const value = { root: '.', paths: [] }
    const result = redactGlobValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, false)
    assert.equal(result.value, value)
    assert.equal(isRecognizedGlobValue(value), true)
    assert.deepEqual(calls, [])
  })

  it('resolves relative display paths against ctx.cwd for decide', () => {
    const { decide, calls } = decideByBasename({ 'a.ts': 'read' })
    redactGlobValue({ root: '.', paths: [join('src', 'a.ts'), 'rel/c.ts'] }, { cwd: CWD, decide })

    assert.deepEqual(calls, [join(CWD, 'src', 'a.ts'), join(CWD, 'rel', 'c.ts')])
  })

  it('passes an absolute path outside the workdir through as an absolute path', () => {
    const { decide, calls } = decideByBasename({ 'b.ts': 'read' })
    const value = { root: '.', paths: [OUTSIDE] }
    const result = redactGlobValue(value, { cwd: CWD, decide })

    assert.deepEqual(calls, [OUTSIDE])
    assert.equal(resolve(OUTSIDE), OUTSIDE)
    assert.equal(result.changed, false)
  })

  it('falls back to process.cwd() when ctx.cwd is absent', () => {
    const { decide, calls } = decideByBasename({ 'a.ts': 'read' })
    redactGlobValue({ root: '.', paths: ['src/a.ts'] }, { decide })

    assert.deepEqual(calls, [resolve(process.cwd(), 'src', 'a.ts')])
  })

  it('does not mutate a deeply frozen input', () => {
    const { decide } = decideByBasename({ 'drop.ts': 'none', 'keep.ts': 'read' })
    const paths = deepFreeze([join('src', 'drop.ts'), join('src', 'keep.ts')])
    const value = deepFreeze({ root: '.', paths })

    const result = redactGlobValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, true)
    assert.notEqual(result.value, value)
    assert.equal(value.paths.length, 2, 'the input array must keep both entries')
    assert.deepEqual(value.paths, [join('src', 'drop.ts'), join('src', 'keep.ts')])
    assert.deepEqual(result.value.paths, [join('src', 'keep.ts')])
  })

  it('drops an entry when decide throws or returns a non-string (fail-closed)', () => {
    const throwing = () => { throw new Error('policy engine exploded') }
    const result = redactGlobValue({ root: '.', paths: ['a.ts'] }, { cwd: CWD, decide: throwing })
    assert.equal(result.changed, true)
    assert.deepEqual(result.value.paths, [])

    // 此处故意违反契约：断言的是 decide 返回非字符串时条目被丢弃（fail-closed）。
    const silent = redactGlobValue({ root: '.', paths: ['a.ts'] }, { cwd: CWD, decide: () => undefined } as unknown as Parameters<typeof redactGlobValue>[1])
    assert.equal(silent.changed, true)
    assert.deepEqual(silent.value.paths, [])
  })

  it('never throws and never calls decide for an unrecognized structure', () => {
    let calls = 0
    const ctx = { cwd: CWD, decide: () => { calls += 1; return 'allow' } }
    for (const [label, value] of [...UNRECOGNIZED, ['unknown key', { root: '.', paths: ['a.ts'], extra: 1 }]]) {
      let result: { changed: boolean; value: unknown } | undefined
      assert.doesNotThrow(() => { result = redactGlobValue(value, ctx) }, `threw for ${label}`)
      assert.equal(result!.changed, false, `changed for ${label}`)
      assert.equal(result!.value, value, `reference changed for ${label}`)
    }
    assert.equal(calls, 0)
  })

  it('never throws for an unrecognized structure even with no usable ctx', () => {
    let result: { changed: boolean; value: unknown } | undefined
    // 此处故意违反契约：断言的是「无法识别的结构 + 无可用 ctx」时仍不抛。
    assert.doesNotThrow(() => { result = redactGlobValue(null, undefined as unknown as Parameters<typeof redactGlobValue>[1]) })
    assert.equal(result!.changed, false)
    assert.equal(result!.value, null)
  })

  it('throws a TypeError when ctx.decide is missing for a recognized value', () => {
    // 此处故意违反契约：断言的是缺 decide 时抛 TypeError（调用方契约违规，不是结构不认识）。
    assert.throws(() => redactGlobValue({ root: '.', paths: ['a.ts'] }, { cwd: CWD } as unknown as Parameters<typeof redactGlobValue>[1]), TypeError)
    assert.throws(() => redactGlobValue({ root: '.', paths: ['a.ts'] }, {} as unknown as Parameters<typeof redactGlobValue>[1]), TypeError)
  })
})

describe('isRecognizedGrepValue', () => {
  it('accepts the populated and empty declared shapes', () => {
    assert.equal(isRecognizedGrepValue({ matches: [{ path: 'a.ts', lineNumber: 1, line: 'x' }] }), true)
    assert.equal(isRecognizedGrepValue({ matches: [] }), true)
  })

  it('rejects anything else without throwing', () => {
    const cases = [
      ...UNRECOGNIZED,
      ['missing matches', {}],
      ['non-array matches', { matches: 'a.ts' }],
      ['match missing line', { matches: [{ path: 'a.ts', lineNumber: 1 }] }],
      ['match missing lineNumber', { matches: [{ path: 'a.ts', line: 'x' }] }],
      ['non-integer lineNumber', { matches: [{ path: 'a.ts', lineNumber: 1.5, line: 'x' }] }],
      ['non-number lineNumber', { matches: [{ path: 'a.ts', lineNumber: '1', line: 'x' }] }],
      ['null match', { matches: [null] }],
      ['unknown match key', { matches: [{ path: 'a.ts', lineNumber: 1, line: 'x', context: 'y' }] }],
      ['unknown top-level key', { matches: [], files: [] }],
      ['grouped meta shape, not the value', { shape: 'matches', files: [], truncated: false, total: 0 }],
    ]
    for (const [label, value] of cases) {
      assert.equal(isRecognizedGrepValue(value), false, `expected unrecognized: ${label}`)
    }
  })
})

describe('redactGrepValue', () => {
  it('drops `none` and `list` matches and keeps `read`/`write`/`allow`', () => {
    const { decide } = decideByBasename({
      'none.ts': 'none',
      'list.ts': 'list',
      'read.ts': 'read',
      'write.ts': 'write',
      'allow.ts': 'allow',
      'odd.ts': 'deny',
    })
    const value = {
      matches: [
        { path: join('src', 'none.ts'), lineNumber: 1, line: 'none' },
        { path: join('src', 'list.ts'), lineNumber: 2, line: 'list' },
        { path: join('src', 'read.ts'), lineNumber: 3, line: 'read' },
        { path: join('src', 'write.ts'), lineNumber: 4, line: 'write' },
        { path: join('src', 'allow.ts'), lineNumber: 5, line: 'allow' },
        { path: join('src', 'odd.ts'), lineNumber: 6, line: 'odd' },
      ],
    }
    const result = redactGrepValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, true)
    assert.deepEqual((result.value as GrepValue).matches, [
      { path: join('src', 'read.ts'), lineNumber: 3, line: 'read' },
      { path: join('src', 'write.ts'), lineNumber: 4, line: 'write' },
      { path: join('src', 'allow.ts'), lineNumber: 5, line: 'allow' },
    ])
    assertGrepSchema(result.value as GrepValue)
  })

  it('keeps matched line text and line numbers verbatim', () => {
    const { decide } = decideByBasename({ 'a.ts': 'read' })
    const line = 'const token = "s3cr3t" // ünïcode'
    const result = redactGrepValue(
      { matches: [{ path: 'a.ts', lineNumber: 42, line }, { path: 'b.ts', lineNumber: 7, line: 'gone' }] },
      { cwd: CWD, decide: (abs) => (basename(abs) === 'a.ts' ? 'read' : 'none') },
    )

    assert.deepEqual((result.value as GrepValue).matches, [{ path: 'a.ts', lineNumber: 42, line }])
  })

  it('returns changed=false and the SAME reference when nothing is dropped', () => {
    const { decide } = decideByBasename({ 'a.ts': 'read', 'b.ts': 'write' })
    const value = {
      matches: [
        { path: join('src', 'a.ts'), lineNumber: 1, line: 'a' },
        { path: join('src', 'b.ts'), lineNumber: 2, line: 'b' },
      ],
    }
    const result = redactGrepValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, false)
    assert.equal(result.value, value)
  })

  it('treats a no-match result as recognized and unchanged', () => {
    const { decide, calls } = decideByBasename({})
    const value = { matches: [] }
    const result = redactGrepValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, false)
    assert.equal(result.value, value)
    assert.equal(isRecognizedGrepValue(value), true)
    assert.deepEqual(calls, [])
  })

  it('drops a file entirely once all of its matches are dropped — no empty shell', () => {
    const { decide } = decideByBasename({ 'keep.ts': 'read', 'none.ts': 'none', 'list.ts': 'list' })
    const value = {
      matches: [
        { path: join('src', 'none.ts'), lineNumber: 1, line: 'a' },
        { path: join('src', 'none.ts'), lineNumber: 2, line: 'b' },
        { path: join('src', 'keep.ts'), lineNumber: 3, line: 'c' },
        { path: join('src', 'list.ts'), lineNumber: 4, line: 'd' },
        { path: join('src', 'list.ts'), lineNumber: 5, line: 'e' },
      ],
    }
    const result = redactGrepValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, true)
    assert.deepEqual((result.value as GrepValue).matches, [{ path: join('src', 'keep.ts'), lineNumber: 3, line: 'c' }])
    const serialized = JSON.stringify(result.value)
    assert.equal(serialized.includes('none.ts'), false)
    assert.equal(serialized.includes('list.ts'), false)

    // Re-group exactly as the model-facing render does: no group may be empty.
    const groups = groupByFile((result.value as GrepValue).matches)
    assert.deepEqual(groups.map((group) => group.path), [join('src', 'keep.ts')])
    assert.ok(groups.every((group) => group.group.length > 0), 'no empty file group may remain')
    assertGrepSchema(result.value as GrepValue)
  })

  it('can drop every match of an all-protected result', () => {
    const { decide } = decideByBasename({ 'a.ts': 'none', 'b.ts': 'list' })
    const result = redactGrepValue(
      {
        matches: [
          { path: 'a.ts', lineNumber: 1, line: 'a' },
          { path: 'b.ts', lineNumber: 2, line: 'b' },
        ],
      },
      { cwd: CWD, decide },
    )

    assert.equal(result.changed, true)
    assert.deepEqual((result.value as GrepValue).matches, [])
    assertGrepSchema(result.value as GrepValue)
    assert.deepEqual(groupByFile((result.value as GrepValue).matches), [])
  })

  it('resolves relative paths against ctx.cwd and leaves absolute ones absolute', () => {
    const { decide, calls } = decideByBasename({ 'a.ts': 'read', 'b.ts': 'read' })
    redactGrepValue(
      {
        matches: [
          { path: 'src/a.ts', lineNumber: 1, line: 'a' },
          { path: OUTSIDE, lineNumber: 2, line: 'b' },
        ],
      },
      { cwd: CWD, decide },
    )

    assert.deepEqual(calls, [join(CWD, 'src', 'a.ts'), OUTSIDE])
  })

  it('does not mutate a deeply frozen input', () => {
    const { decide } = decideByBasename({ 'drop.ts': 'list', 'keep.ts': 'read' })
    const matches = deepFreeze([
      { path: join('src', 'drop.ts'), lineNumber: 1, line: 'secret' },
      { path: join('src', 'keep.ts'), lineNumber: 2, line: 'public' },
    ])
    const value = deepFreeze({ matches })

    const result = redactGrepValue(value, { cwd: CWD, decide })

    assert.equal(result.changed, true)
    assert.notEqual(result.value, value)
    assert.equal(value.matches.length, 2, 'the input array must keep both matches')
    assert.deepEqual((result.value as GrepValue).matches, [{ path: join('src', 'keep.ts'), lineNumber: 2, line: 'public' }])
  })

  it('drops a match when decide throws (fail-closed)', () => {
    const result = redactGrepValue(
      { matches: [{ path: 'a.ts', lineNumber: 1, line: 'x' }] },
      { cwd: CWD, decide: () => { throw new Error('boom') } },
    )

    assert.equal(result.changed, true)
    assert.deepEqual((result.value as GrepValue).matches, [])
  })

  it('never throws and never calls decide for an unrecognized structure', () => {
    let calls = 0
    const ctx = { cwd: CWD, decide: () => { calls += 1; return 'allow' } }
    for (const [label, value] of [...UNRECOGNIZED, ['grouped meta shape', { shape: 'matches', files: [], truncated: false, total: 0 }]]) {
      let result: { changed: boolean; value: unknown } | undefined
      assert.doesNotThrow(() => { result = redactGrepValue(value, ctx) }, `threw for ${label}`)
      assert.equal(result!.changed, false, `changed for ${label}`)
      assert.equal(result!.value, value, `reference changed for ${label}`)
    }
    assert.equal(calls, 0)
  })

  it('never throws for an unrecognized structure even with no usable ctx', () => {
    let result: { changed: boolean; value: unknown } | undefined
    // 此处故意违反契约：断言的是「无法识别的结构 + 无可用 ctx」时仍不抛。
    assert.doesNotThrow(() => { result = redactGrepValue(undefined, undefined as unknown as Parameters<typeof redactGrepValue>[1]) })
    assert.equal(result!.changed, false)
    assert.equal(result!.value, undefined)
  })

  it('throws a TypeError when ctx.decide is missing for a recognized value', () => {
    // 此处故意违反契约：断言的是缺 decide 时抛 TypeError（调用方契约违规，不是结构不认识）。
    assert.throws(() => redactGrepValue({ matches: [] }, {} as unknown as Parameters<typeof redactGrepValue>[1]), TypeError)
    assert.throws(() => redactGrepValue({ matches: [] }, { cwd: CWD, decide: 'none' } as unknown as Parameters<typeof redactGrepValue>[1]), TypeError)
  })
})

describe('search-result redaction end to end (value shapes as the runtime hands them over)', () => {
  it('a mixed glob and grep run leaks no protected file into the replacement values', () => {
    const decide = (absolutePath: string) => {
      assert.ok(resolve(absolutePath) === absolutePath || absolutePath.startsWith(parse(CWD).root))
      const name = basename(absolutePath)
      if (name === 'secrets.env' || name === 'id_rsa' || name === 'classify.ts' || name === 'ledger.csv') return 'none'
      if (name === 'package.json') return 'list'
      return 'read'
    }
    const globValue = {
      root: '.',
      paths: ['README.md', join('src', 'index.ts'), join('config', 'secrets.env'), join('keys', 'id_rsa'), 'package.json'],
    }
    const grepValue = {
      matches: [
        { path: 'README.md', lineNumber: 1, line: '# dsh-path-guard' },
        { path: join('config', 'secrets.env'), lineNumber: 3, line: 'API_KEY=...' },
        { path: join('keys', 'id_rsa'), lineNumber: 1, line: 'BEGIN PRIVATE KEY' },
        { path: 'package.json', lineNumber: 5, line: '"type": "module"' },
        { path: join('src', 'classify.ts'), lineNumber: 9, line: 'const x = 1' },
      ],
    }

    const globResult = redactGlobValue(globValue, { cwd: CWD, decide })
    const grepResult = redactGrepValue(grepValue, { cwd: CWD, decide })

    assert.equal(globResult.changed, true)
    assert.deepEqual(globResult.value.paths, ['README.md', join('src', 'index.ts'), 'package.json'])
    assertGlobSchema(globResult.value as GlobValue)

    assert.equal(grepResult.changed, true)
    // classify.ts is `none` here, so even its `read`-looking source line is gone.
    assert.deepEqual((grepResult.value as GrepValue).matches, [
      { path: 'README.md', lineNumber: 1, line: '# dsh-path-guard' },
    ])
    assertGrepSchema(grepResult.value as GrepValue)

    for (const leaked of ['secrets.env', 'id_rsa', 'ledger.csv', 'classify.ts', 'const x = 1', 'API_KEY', 'PRIVATE KEY']) {
      assert.equal(JSON.stringify(globResult.value).includes(leaked), false, `glob leaked ${leaked}`)
      assert.equal(JSON.stringify(grepResult.value).includes(leaked), false, `grep leaked ${leaked}`)
    }
    // `list` file names stay visible to glob but their CONTENT must not survive grep.
    assert.equal(globResult.value.paths.includes('package.json'), true)
    assert.equal(JSON.stringify(grepResult.value).includes('package.json'), false)
  })
})

// ---------------------------------------------------------------------------
// `redactTextBlocks` — whole-block no-hit gate (reports/audit-efficiency.md A2)
//
// The gate returns the block untouched as soon as ONE whole-block scan finds
// nothing, instead of splitting it and scanning every line. Equivalence rests on
// two facts, and these tests check both rather than assuming them:
//
//   1. every line is a substring of its block, so a needle inside a line is
//      inside the block;
//   2. the `\\` -> `\` collapse is LINE-LOCAL — a pair of backslashes can never
//      straddle the `\n` between two lines, so
//      `collapse(block) === collapse(l1) + '\n' + … + collapse(ln)`
//      and each collapsed line is a substring of the collapsed block.
//
// Fact 2 is the one that is easy to get wrong, so it is exercised by an
// exhaustive sweep over a `{a, b, \, \n}` alphabet (every string up to length 7),
// not only by hand-picked cases. The oracle is a VERBATIM copy of the original
// per-line implementation, never the optimized function against itself.
// ---------------------------------------------------------------------------

/**
 * The withheld-line marker, read from the implementation once via a probe.
 * Taking it from a probe instead of repeating the literal keeps the oracle an
 * ALGORITHM copy: a marker change cannot silently desync the two.
 */
const WITHHELD_LINE: string = (() => {
  const probe: Needle = { needle: 'NEEDLE-TEXT', pattern: 'probe', access: 'none' }
  const result = redactTextBlocks([{ type: 'text', text: 'x NEEDLE-TEXT y' }], [probe], false)
  const first = (result.content as Array<{ text?: unknown }>)[0]
  assert.equal(typeof first?.text, 'string', 'probe: a matching line must be withheld')
  return (first as { text: string }).text
})()

/**
 * The ORIGINAL per-line `redactTextBlocks`, copied verbatim (src/scan.ts:229-246
 * before the A2 gate) and used as the equivalence oracle.
 */
function redactTextBlocksReference(content: unknown, needles: Needle[], windows: boolean): { changed: boolean, content: unknown } {
  if (!Array.isArray(content) || needles.length === 0) return { changed: false, content }
  let changed = false
  const next = content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    let blockChanged = false
    const kept = (block.text as string).split('\n').map((line: string) => {
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

/** The audit's needle shape: 28 protected paths x {forward, back} slash spellings = 56 needles. */
function auditNeedles(): Needle[] {
  return Array.from({ length: 28 }, (_, i) => `D:/proj/secret-area-${i}/vault`)
    .flatMap((base) => [
      { needle: base, pattern: `${base}/**`, access: 'none' },
      { needle: base.replaceAll('/', '\\'), pattern: `${base}/**`, access: 'none' },
    ])
}

/** One line of ordinary tool output that mentions no needle. */
function cleanLine(i: number): string {
  return `  at step ${i}: compiled src/module-${i % 17}/index.ts -> dist/chunk-${i}.js in ${100 + (i % 900)}ms`
}

/** `count` clean lines starting at `from`, joined by `\n`. */
function cleanText(from = 0, count = 40): string {
  return Array.from({ length: count }, (_, i) => cleanLine(from + i)).join('\n')
}

/** A raw forward-slash hit, a single-backslash hit, and a hit that needs the collapse pass. */
const HIT_RAW = 'cat "D:/proj/secret-area-3/vault/keys.txt"'
const HIT_BACK = 'type D:\\proj\\secret-area-11\\vault\\notes.txt'
const HIT_ESCAPED = 'readFileSync("D:\\\\proj\\\\secret-area-7\\\\vault\\\\id_rsa")'

/** Class 1 — every block clean (the common case the gate must skip). */
function cleanContent(): unknown {
  return Array.from({ length: 6 }, (_, b) => ({ type: 'text', text: cleanText(b * 40) }))
}

/** Class 2 — some blocks hit, some clean, hits at first/middle/last line. */
function mixedContent(): unknown {
  return [
    { type: 'text', text: cleanText(0) },
    { type: 'text', text: `${cleanText(40, 20)}\n${HIT_RAW}\n${cleanText(60, 19)}` },
    { type: 'text', text: cleanText(80) },
    { type: 'text', text: `${HIT_RAW}\n${cleanText(120, 38)}\n${HIT_BACK}` },
    { type: 'text', text: 'no newline and no needle at all' },
    { type: 'text', text: HIT_RAW },
  ]
}

/** Class 3 — escaped (doubled) backslashes, the collapse pass, CRLF, and odd/even runs. */
function escapedContent(): unknown {
  return [
    // Only the COLLAPSED spelling matches, so the gate must not skip this block.
    { type: 'text', text: `${HIT_ESCAPED}\n${cleanText(0, 39)}` },
    // Doubled backslashes but no needle: the collapse pass runs and finds nothing.
    { type: 'text', text: Array.from({ length: 20 }, (_, i) => `  json{"p":"D:\\\\logs\\\\app-${i}.log"}`).join('\n') },
    // A backslash pair split by the line boundary: it must NOT be collapsed across it.
    { type: 'text', text: 'tail\\\n\\head\nplain\\\n\\plain' },
    // Odd runs at both ends of a line, next to the boundary.
    { type: 'text', text: `odd\\\n\\\\\n${HIT_BACK}\r\n${cleanText(80, 20)}` },
  ]
}

/**
 * Assert the optimized function is indistinguishable from the oracle: same
 * `changed`, same input-reference reuse, same structure, same JSON bytes, and
 * same bytes for every rewritten block text.
 */
function assertSameAsReference(label: string, content: unknown, needles: Needle[], windows: boolean): { changed: boolean, content: unknown } {
  const expected = redactTextBlocksReference(content, needles, windows)
  const actual = redactTextBlocks(content, needles, windows)

  assert.equal(actual.changed, expected.changed, `${label}: changed flag`)
  assert.equal(actual.content === content, expected.content === content, `${label}: input-reference reuse`)
  assert.deepEqual(actual.content, expected.content, `${label}: structure`)
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label}: JSON bytes`)

  const texts = (result: { content: unknown }): string[] =>
    (Array.isArray(result.content) ? result.content : []).map((block) =>
      block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '')
  const actualTexts = texts(actual)
  const expectedTexts = texts(expected)
  assert.equal(actualTexts.length, expectedTexts.length, `${label}: block count`)
  for (let i = 0; i < actualTexts.length; i += 1) {
    assert.ok(
      Buffer.from(actualTexts[i] as string, 'utf8').equals(Buffer.from(expectedTexts[i] as string, 'utf8')),
      `${label}: block ${i} is not byte-identical`,
    )
  }
  return actual
}

/** Every string over `alphabet` up to and including `maxLen` ('' first). */
function allStringsOver(alphabet: string[], maxLen: number): string[] {
  const out: string[] = ['']
  let frontier: string[] = ['']
  for (let len = 1; len <= maxLen; len += 1) {
    const next: string[] = []
    for (const prefix of frontier) for (const char of alphabet) next.push(prefix + char)
    out.push(...next)
    frontier = next
  }
  return out
}

/** Needles chosen to be sensitive to the `\\` -> `\` collapse. */
const FUZZ_NEEDLES: Needle[] = [
  { needle: 'ab', pattern: 'fuzz', access: 'none' },
  { needle: 'a\\b', pattern: 'fuzz', access: 'none' },
  { needle: 'a\\\\b', pattern: 'fuzz', access: 'none' },
  { needle: '\\\\', pattern: 'fuzz', access: 'none' },
  { needle: 'a\\', pattern: 'fuzz', access: 'none' },
  { needle: '\\b', pattern: 'fuzz', access: 'none' },
]

describe('redactTextBlocks: whole-block gate (A2)', () => {
  const needles = auditNeedles()

  it('uses the audit needle shape (56 needles)', () => {
    assert.equal(needles.length, 56)
    assert.equal(new Set(needles.map((n) => n.needle)).size, 56)
  })

  it('is byte-identical to the per-line oracle on clean, mixed and escaped inputs', () => {
    const clean = assertSameAsReference('clean', cleanContent(), needles, false)
    const mixed = assertSameAsReference('mixed', mixedContent(), needles, false)
    const escaped = assertSameAsReference('escaped', escapedContent(), needles, false)

    assert.equal(clean.changed, false, 'clean input must report no change')
    assert.equal(mixed.changed, true, 'mixed input must report a change')
    assert.equal(escaped.changed, true, 'escaped input must report a change')
  })

  it('is byte-identical to the per-line oracle with case-insensitive matching', () => {
    const upper = [{ type: 'text', text: `CAT "D:/PROJ/SECRET-AREA-3/VAULT/KEYS.TXT"\n${cleanText(0, 20)}` }]
    const result = assertSameAsReference('windows', upper, needles, true)
    assert.equal(result.changed, true)
    assert.equal(assertSameAsReference('windows-clean', cleanContent(), needles, true).changed, false)
  })

  it('agrees with the oracle on the sharp line-boundary backslash cases', () => {
    const cases = [
      'a\\\nb',            // 1 + 1 backslashes split by the boundary: no pair either side
      'a\\\\\nb',          // a collapsed pair before the boundary
      'a\n\\\\b',          // a collapsed pair after the boundary
      'a\\\n\\\\b',        // odd before, even after
      'a\\\\\n\\\\b',      // even before, even after
      'a\\\\\\\nb',        // three backslashes: greedy left-to-right pairing
      'a\\\\\\\n\\\\\\b',  // three and three
      'a\\\\b\na\\\\b',    // the same collapsed hit on two lines
      'a\\b\r\na\\\\b',    // CRLF between two spellings
      '\\\\',              // a bare pair
      '\\',                // a bare single backslash
      '\n\n\\\n\n',        // empty lines around a backslash
    ]
    for (const text of cases) {
      assertSameAsReference(`boundary ${JSON.stringify(text)}`, [{ type: 'text', text }], FUZZ_NEEDLES, false)
    }
  })

  it('agrees with the oracle on an exhaustive {a, b, \\, \\n} sweep up to length 7', () => {
    const cases = allStringsOver(['a', 'b', '\\', '\n'], 7)
    assert.ok(cases.length >= 21_000, `sweep should cover a real input space, got ${cases.length}`)
    const mismatches: string[] = []
    for (const text of cases) {
      const content = [{ type: 'text', text }]
      const expected = redactTextBlocksReference(content, FUZZ_NEEDLES, false)
      const actual = redactTextBlocks(content, FUZZ_NEEDLES, false)
      if (actual.changed !== expected.changed || JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(JSON.stringify(text))
        if (mismatches.length >= 5) break
      }
    }
    assert.deepEqual(mismatches, [], `exhaustive sweep disagreed on ${cases.length} inputs (first 5 shown)`)
  })

  it('agrees with the oracle on an exhaustive sweep with case folding enabled', () => {
    const cases = allStringsOver(['A', 'b', '\\', '\n'], 5)
    const mismatches: string[] = []
    for (const text of cases) {
      const content = [{ type: 'text', text }]
      const expected = redactTextBlocksReference(content, FUZZ_NEEDLES, true)
      const actual = redactTextBlocks(content, FUZZ_NEEDLES, true)
      if (actual.changed !== expected.changed || JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(JSON.stringify(text))
        if (mismatches.length >= 5) break
      }
    }
    assert.deepEqual(mismatches, [], `case-folding sweep disagreed (first 5 of ${cases.length})`)
  })

  it('agrees with the oracle on empty, non-text, needle-less and non-array inputs', () => {
    const shapes: Array<[string, unknown]> = [
      ['empty array', []],
      ['not an array', 'nope'],
      ['null', null],
      ['empty text block', [{ type: 'text', text: '' }]],
      ['trailing newline', [{ type: 'text', text: 'a\n' }]],
      ['leading newline', [{ type: 'text', text: '\na' }]],
      ['only newlines', [{ type: 'text', text: '\n\n\n' }]],
      ['non-text block', [{ type: 'image', text: HIT_RAW }]],
      ['text is not a string', [{ type: 'text', text: 42 }]],
      ['null block', [null]],
      ['string block', ['raw']],
      ['mixed shapes', [null, 'raw', { type: 'image' }, { type: 'text', text: HIT_RAW }]],
    ]
    for (const [label, content] of shapes) {
      assertSameAsReference(label, content, needles, false)
      // A needle-less rule set short-circuits in both implementations.
      assertSameAsReference(`${label} (no needles)`, content, [], false)
    }
  })

  it('skips the per-line pass entirely for a clean block (needle reads)', () => {
    let reads = 0
    const counting: Needle[] = Array.from({ length: 56 }, (_, i) => ({
      get needle() { reads += 1; return `D:/proj/never-${i}/vault` },
      pattern: `D:/proj/never-${i}/vault/**`,
      access: 'none',
    }))

    // 100 clean lines: the old per-line code reads all 56 needles per LINE (5600);
    // the gate makes it exactly one whole-block scan (56).
    const clean = [{ type: 'text', text: cleanText(0, 100) }]
    const before = reads
    const cleanResult = redactTextBlocks(clean, counting, false)
    assert.equal(cleanResult.changed, false)
    assert.equal(reads - before, 56, 'a clean block must cost exactly one whole-block scan')

    // A hit on the LAST line still falls back to the per-line pass, so the reads
    // must be far above one whole-block scan.
    const countingHit = 'cat "D:/proj/never-0/vault/keys.txt"'
    const dirty = [{ type: 'text', text: `${cleanText(0, 99)}\n${countingHit}` }]
    const dirtyBefore = reads
    const dirtyResult = redactTextBlocks(dirty, counting, false)
    assert.equal(dirtyResult.changed, true)
    assert.ok(reads - dirtyBefore > 56 * 50, `a hit must still scan per line, got ${reads - dirtyBefore} reads`)
  })

  it('still withholds per line when the block has a hit', () => {
    const text = `${cleanText(0, 3)}\n${HIT_RAW}\n${cleanText(10, 2)}`
    const input = [{ type: 'text', text }]
    const result = redactTextBlocks(input, needles, false)

    assert.equal(result.changed, true)
    const blocks = result.content as Array<{ text: string }>
    assert.notEqual(blocks, input, 'a changed result must be a new array')
    const lines = blocks[0]!.text.split('\n')
    assert.equal(lines.length, 6)
    assert.deepEqual(lines[3], WITHHELD_LINE, 'the offending line is replaced by the marker')
    assert.deepEqual(lines.slice(0, 3), cleanText(0, 3).split('\n'), 'clean lines are untouched')
    assert.deepEqual(lines.slice(4), cleanText(10, 2).split('\n'), 'clean lines after the hit are untouched')
  })

  it('keeps untouched blocks identical and only rebuilds matching blocks', () => {
    const input = [
      { type: 'text', text: cleanText(0) },
      { type: 'text', text: HIT_RAW },
      { type: 'image', source: 'x' },
      { type: 'text', text: cleanText(80) },
    ]
    const result = redactTextBlocks(input, needles, false)
    const blocks = result.content as unknown[]

    assert.equal(result.changed, true)
    assert.equal(blocks[0], input[0], 'a clean block keeps its object identity')
    assert.notEqual(blocks[1], input[1], 'the matching block is rebuilt')
    assert.equal(blocks[2], input[2], 'a non-text block keeps its object identity')
    assert.equal(blocks[3], input[3], 'a clean block keeps its object identity')
  })

  it('is skip-only: a gate hit whose per-line pass finds nothing changes nothing', () => {
    // A needle spanning a newline can never be inside a LINE (the documented
    // limit, src/scan.ts:219-222). The whole-block gate DOES see it, so this is
    // exactly the case where the gate fires and the per-line pass still decides.
    const spanning: Needle = { needle: 'alpha\nbeta', pattern: 'spanning', access: 'none' }
    const content = [{ type: 'text', text: 'alpha\nbeta\ngamma' }]
    const expected = redactTextBlocksReference(content, [spanning], false)
    const actual = redactTextBlocks(content, [spanning], false)

    assert.equal(expected.changed, false)
    assert.equal(actual.changed, false, 'the gate must not withhold on its own')
    assert.equal(actual.content, content, 'nothing changed, so the input is returned as-is')
    assert.equal(JSON.stringify(actual), JSON.stringify(expected))
  })
})
