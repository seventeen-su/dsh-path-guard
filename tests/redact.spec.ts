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
