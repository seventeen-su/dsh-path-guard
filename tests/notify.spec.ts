/**
 * Tests for `src/notify.js` — interception-event desktop notifications.
 *
 * Run: node --test tests/notify.spec.js
 *
 * `src/notify.js` does not import Cordis: everything arrives through dependency
 * injection, so the whole module is exercised here with a recording fake of the
 * `desktopNotify` service (`push` / `pushAlways`), a recording logger and a manual
 * clock. Section numbers below mirror the required-test list in the task spec.
 *
 * Service contract under test (verified against `dsh-desktop-notify@1.5.4`,
 * `lib/api.js:29-93`): `push(item) -> boolean`, `pushAlways(item) -> boolean`,
 * `item = { title, message?, urgency?, sessionId? }`, an empty title returns false,
 * and the return value means "actually queued" (focus-silenced / deduplicated /
 * backend-less pushes all return false).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createNotifier } from '../src/notify.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * One payload handed to the `desktopNotify` service. Structural mirror of the
 * payload `src/notify.ts` builds (`deliver()` / `payload` declare `title`,
 * `message` and `urgency` as required and `sessionId` as optional).
 */
interface NotifyItem {
  title: string
  message: string
  urgency: string
  sessionId?: unknown
}

/** The slice of `desktopNotify` this test fakes. */
interface NotifyService {
  push: (item: NotifyItem) => boolean
  pushAlways: (item: NotifyItem) => boolean
}

/**
 * A recording fake of the `desktopNotify` service: both methods return `true`
 * (as the real one does when the notification is genuinely enqueued).
 * @param overrides - replaces `push` / `pushAlways`
 */
function fakeService(overrides: Partial<NotifyService> = {}) {
  const calls: { push: NotifyItem[]; pushAlways: NotifyItem[] } = { push: [], pushAlways: [] }
  const service = {
    push(item: NotifyItem) {
      calls.push.push(item)
      return true
    },
    pushAlways(item: NotifyItem) {
      calls.pushAlways.push(item)
      return true
    },
    ...overrides,
  }
  return { calls, service, pushed: () => calls.push.length + calls.pushAlways.length }
}

/** Dependency-injection options the harness lets a test override. */
interface SetupOptions {
  throttleMs?: number | undefined
  maxTracked?: number | undefined
  startAt?: number | undefined
  resolve?: (() => NotifyService | null | undefined) | undefined
  logger?: { warn?: (...args: unknown[]) => unknown; error?: (...args: unknown[]) => unknown } | null | undefined
}

/**
 * A notifier wired to a recording logger, a mutable service slot and a manual
 * clock. `slot.service` starts `undefined`, i.e. "the plugin is not installed".
 * @param options - dependency-injection overrides.
 */
function setup(options: SetupOptions = {}) {
  const warns: string[] = []
  const errors: string[] = []
  let clock = options.startAt ?? 1000000
  const slot: { service: NotifyService | null | undefined } = { service: undefined }
  const notifier = createNotifier({
    resolveService: options.resolve ?? (() => slot.service),
    logger: options.logger ?? {
      warn: (message) => {
        warns.push(String(message))
      },
      error: (message: unknown) => {
        errors.push(String(message))
      },
    },
    now: () => clock,
    throttleMs: options.throttleMs,
    maxTracked: options.maxTracked,
  })
  return {
    notifier,
    warns,
    errors,
    slot,
    /** Advance the injected clock by `ms`. */
    advance: (ms: number) => {
      clock += ms
    },
  }
}

/** A complete, typical path-denial event. */
const PATH_DENIAL = {
  kind: 'path',
  toolName: 'read',
  target: 'D:\\secret\\a.txt',
  access: 'deny',
  rulePath: 'D:\\secret',
  ruleId: 'no-secret-read',
  sessionId: 'session-1',
}

/** Payload keys a denial may carry; anything else would be surface we do not own. */
const ALLOWED_PAYLOAD_KEYS = ['message', 'sessionId', 'title', 'urgency']

// ---------------------------------------------------------------------------
// 1. The optional service is absent
// ---------------------------------------------------------------------------

describe('1. optional service missing', () => {
  it('returns false, throws nothing and logs nothing', () => {
    const h = setup()
    for (let i = 0; i < 5; i += 1) {
      assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: `D:\\secret\\${i}.txt` }), false)
    }
    assert.equal(h.notifier.malfunction('tools/pre-execute'), false)
    assert.deepEqual(h.warns, [], 'an uninstalled optional plugin must not log')
    assert.deepEqual(h.errors, [])
    assert.equal(h.notifier.tracked(), 0, 'nothing was attempted, so nothing is tracked')
  })

  it('treats a null service and a non-callable resolveService as absent', () => {
    const nullResolve = setup({ resolve: () => null })
    assert.equal(nullResolve.notifier.denial(PATH_DENIAL), false)
    assert.deepEqual(nullResolve.warns, [])

    const noResolve = setup({ resolve: undefined })
    const bare = createNotifier({ logger: { warn: () => assert.fail('must not warn') } })
    assert.equal(bare.denial(PATH_DENIAL), false)
    assert.equal(bare.malfunction('tools/post-execute'), false)
    assert.equal(noResolve.notifier.denial(PATH_DENIAL), false)
  })

  it('re-resolves per event, so enabling the plugin mid-session takes effect at once', () => {
    const h = setup()
    assert.equal(h.notifier.denial(PATH_DENIAL), false, 'nothing to notify yet')
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true, 'the same reason must not be pre-throttled')
    assert.equal(fake.calls.push.length, 1)
  })
})

// ---------------------------------------------------------------------------
// 2. Normal path
// ---------------------------------------------------------------------------

describe('2. normal path', () => {
  it('pushes a non-empty Chinese payload and forwards sessionId', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service

    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(fake.calls.push.length, 1)
    assert.equal(fake.calls.pushAlways.length, 0)

    const payload = fake.calls.push[0]!
    assert.equal(payload.title, '🚫 Path Guard 拦截')
    assert.equal(typeof payload.message, 'string')
    assert.ok(payload.message.length > 0, 'message must not be empty')
    assert.ok(payload.message.length <= 400)
    assert.ok(payload.title.length <= 160)
    assert.ok(!payload.message.includes('\n'), 'the message is a single line')
    assert.match(payload.message, /read/, 'carries the tool name')
    assert.match(payload.message, /D:\\secret\\a\.txt/, 'carries the denied target')
    assert.match(payload.message, /no-secret-read/, 'carries the matched rule')
    assert.match(payload.message, /deny/, 'carries the tier')
    assert.equal(payload.urgency, 'normal')
    assert.equal(payload.sessionId, 'session-1')
    assert.deepEqual(Object.keys(payload).sort(), ALLOWED_PAYLOAD_KEYS)
    assert.deepEqual(h.warns, [])
    assert.equal(h.notifier.tracked(), 1)
  })

  it('omits the rule and the tier when they are not known', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ kind: 'shell', toolName: 'pwsh', target: 'rm -rf /' }), true)
    const { message } = fake.calls.push[0]!
    assert.match(message, /pwsh/)
    assert.match(message, /rm -rf/)
    assert.ok(!message.includes('规则'))
    assert.ok(!message.includes('档位'))
  })

  it('uses the critical urgency for a self-modification denial', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ kind: 'self', toolName: 'mcp__dsh__plugin', target: 'dsh-path-guard' }), true)
    assert.equal(fake.calls.push[0]!.urgency, 'critical')
    assert.equal(fake.calls.push[0]!.title, '🚫 Path Guard 拦截', 'the title stays the documented one')
  })

  it('survives unknown kinds without touching Object.prototype', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    for (const kind of ['constructor', '__proto__', 'toString', '']) {
      assert.equal(h.notifier.denial({ ...PATH_DENIAL, kind, target: `D:\\x\\${kind}.txt` }), true)
    }
    for (const payload of fake.calls.push) {
      assert.equal(typeof payload.title, 'string')
      assert.equal(typeof payload.message, 'string')
      assert.ok(payload.message.length > 0)
      assert.ok(!payload.message.includes('function'), 'a prototype member must not leak into the text')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. `always`
// ---------------------------------------------------------------------------

describe('3. always', () => {
  it('uses pushAlways and never push', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), true)
    assert.equal(fake.calls.pushAlways.length, 1)
    assert.equal(fake.calls.push.length, 0)
    assert.deepEqual(Object.keys(fake.calls.pushAlways[0]!).sort(), ALLOWED_PAYLOAD_KEYS)
  })

  it('treats a falsy always as the focus-gated path', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: false }), true)
    assert.equal(fake.calls.push.length, 1)
    assert.equal(fake.calls.pushAlways.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 4. sessionId handling
// ---------------------------------------------------------------------------

describe('4. sessionId', () => {
  it('omits the field entirely when the session is unknown', () => {
    for (const sessionId of [undefined, null, '', '   ']) {
      const h = setup()
      const fake = fakeService()
      h.slot.service = fake.service
      assert.equal(h.notifier.denial({ ...PATH_DENIAL, sessionId }), true)
      const payload = fake.calls.push[0]!
      assert.ok(!('sessionId' in payload), `sessionId ${JSON.stringify(sessionId)} must not create a field`)
      assert.deepEqual(Object.keys(payload).sort(), ['message', 'title', 'urgency'])
    }
  })

  it('passes a session object through untouched (the peer accepts objects)', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    const session = { id: 'session-obj' }
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, sessionId: session }), true)
    assert.equal(fake.calls.push[0]!.sessionId, session)
  })

  it('carries sessionId on the pushAlways path too (the peer builds the click link from it)', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), true)
    assert.equal(fake.calls.pushAlways[0]!.sessionId, 'session-1')
  })
})

// ---------------------------------------------------------------------------
// 5. Throttling
// ---------------------------------------------------------------------------

describe('5. throttle', () => {
  it('pushes one reason once inside the window', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(h.notifier.denial(PATH_DENIAL), false, 'the second identical event is silenced')
    assert.equal(fake.calls.push.length, 1)
    assert.equal(h.notifier.tracked(), 1)
  })

  it('treats a different target as a different reason', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: 'D:\\secret\\b.txt' }), true)
    assert.equal(fake.calls.push.length, 2, 'the user must see the second denied path')
    assert.match(fake.calls.push[1]!.message, /b\.txt/)
  })

  it('treats a different tier, tool or kind as a different reason', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, access: 'ask' }), true)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, toolName: 'write' }), true)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, kind: 'shell' }), true)
    assert.equal(fake.pushed(), 4)
  })

  it('ignores the peer result for throttling: an attempt is enough', () => {
    const h = setup()
    const attempts = []
    h.slot.service = fakeService({
      push: (item) => {
        attempts.push(item)
        return false
      },
    }).service
    assert.equal(h.notifier.denial(PATH_DENIAL), false, 'the peer enqueued nothing')
    assert.equal(h.notifier.denial(PATH_DENIAL), false, 'still one attempt per window')
    assert.equal(attempts.length, 1)
    assert.equal(h.notifier.tracked(), 1, 'a silenced peer push still consumes the window')
  })

  it('throttles the pushAlways path as well (always bypasses the focus gate, not the throttle)', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), true)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), false)
    assert.equal(fake.calls.pushAlways.length, 1)
  })

  it('reset() empties the table and lets the same reason through again', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(h.notifier.tracked(), 1)
    h.notifier.reset()
    assert.equal(h.notifier.tracked(), 0)
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
  })
})

// ---------------------------------------------------------------------------
// 6. Injected clock / window boundary
// ---------------------------------------------------------------------------

describe('6. injected clock', () => {
  it('honours a custom throttleMs at the window boundary', () => {
    const h = setup({ throttleMs: 1000 })
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    h.advance(999)
    assert.equal(h.notifier.denial(PATH_DENIAL), false, 'one millisecond early is still inside')
    h.advance(1)
    assert.equal(h.notifier.denial(PATH_DENIAL), true, 'at exactly throttleMs the reason is free again')
    assert.equal(fake.calls.push.length, 2)
  })

  it('defaults to a 10000 ms window', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    h.advance(9999)
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
    h.advance(1)
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
  })

  it('treats throttleMs 0 as "no throttling" and an invalid value as the default', () => {
    const off = setup({ throttleMs: 0 })
    const offFake = fakeService()
    off.slot.service = offFake.service
    assert.equal(off.notifier.denial(PATH_DENIAL), true)
    assert.equal(off.notifier.denial(PATH_DENIAL), true)
    assert.equal(offFake.calls.push.length, 2)

    const bogus = setup({ throttleMs: -5 })
    const bogusFake = fakeService()
    bogus.slot.service = bogusFake.service
    assert.equal(bogus.notifier.denial(PATH_DENIAL), true)
    bogus.advance(9999)
    assert.equal(bogus.notifier.denial(PATH_DENIAL), false, 'an invalid window falls back to 10000')
  })

  it('reads only the injected clock, never Date.now', () => {
    // With startAt = 1 the wall clock would make every event look 10 minutes old;
    // the injected clock must decide on its own.
    const h = setup({ throttleMs: 60000, startAt: 1 })
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    h.advance(59999)
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
  })
})

// ---------------------------------------------------------------------------
// 7. Bounded throttle table
// ---------------------------------------------------------------------------

describe('7. bounded throttle table', () => {
  it('never grows past maxTracked and evicts the oldest reason first', () => {
    const h = setup({ maxTracked: 4 })
    const fake = fakeService()
    h.slot.service = fake.service
    const target = (i: number) => `D:\\many\\f${i}.txt`
    for (let i = 0; i < 20; i += 1) {
      assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: target(i) }), true)
    }
    assert.ok(h.notifier.tracked() <= 4, `table must stay bounded, got ${h.notifier.tracked()}`)
    assert.equal(h.notifier.tracked(), 4, 'it fills up to the cap and stops there')

    // The newest reason is still remembered ...
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: target(19) }), false)
    // ... while the oldest was evicted, which is the accepted trade-off of a
    // bounded table (its window is over anyway in a busy process).
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: target(0) }), true)
    assert.equal(fake.calls.push.length, 21)
  })

  it('keeps the table tiny for a long stream of distinct reasons', () => {
    const h = setup({ maxTracked: 8 })
    const fake = fakeService()
    h.slot.service = fake.service
    for (let i = 0; i < 500; i += 1) h.notifier.denial({ ...PATH_DENIAL, target: `D:\\s\\${i}` })
    assert.equal(h.notifier.tracked(), 8)
  })
})

// ---------------------------------------------------------------------------
// 8. Long inputs are truncated here
// ---------------------------------------------------------------------------

describe('8. long input', () => {
  it('caps the message at 400 characters for a 2000-character path', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    const target = `D:\\${'x'.repeat(2000)}`
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target }), true)
    const { title, message } = fake.calls.push[0]!
    assert.ok(message.length <= 400, `message was ${message.length} characters`)
    assert.ok(title.length <= 160)
    assert.ok(!message.includes('\n'))
    assert.match(message, /目标 D:\\x+/, 'the visible prefix of the target survives')
  })

  it('keeps the rule and the tier visible even when every field is 2000 characters', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(
      h.notifier.denial({
        kind: 'k'.repeat(2000),
        toolName: 't'.repeat(2000),
        target: 'x'.repeat(2000),
        access: 'a'.repeat(2000),
        rulePath: 'r'.repeat(2000),
      }),
      true,
    )
    const { message } = fake.calls.push[0]!
    assert.ok(message.length <= 400, `message was ${message.length} characters`)
    assert.match(message, /档位/, 'the tier must not be the field that truncation eats')
    assert.match(message, /规则/)
    assert.ok(!message.includes('\n'))
  })

  it('never cuts a surrogate pair in half', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: '😀'.repeat(300) }), true)
    const { message } = fake.calls.push[0]!
    assert.ok(message.length <= 400)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message), 'lone high surrogate in the payload')
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message), 'lone low surrogate in the payload')
  })

  it('collapses whitespace so the message stays a single line', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, target: 'D:\\a\nb\t c   d.txt' }), true)
    const { message } = fake.calls.push[0]!
    assert.match(message, /D:\\a b c d\.txt/)
    assert.ok(!/\s{2,}/.test(message))
  })
})

// ---------------------------------------------------------------------------
// 9. Robustness
// ---------------------------------------------------------------------------

describe('9. robustness', () => {
  it('returns false and warns when resolveService throws', () => {
    const h = setup({
      resolve: () => {
        throw new Error('service lookup exploded')
      },
    })
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
    assert.equal(h.notifier.malfunction('tools/pre-execute'), false)
    assert.ok(h.warns.length >= 1)
    assert.match(h.warns.join('\n'), /resolveService/)
    assert.deepEqual(h.errors, [], 'never the error level')
  })

  it('returns false and warns when the service lacks both methods', () => {
    const h = setup()
    // 此处故意违反契约：断言的是「服务对象两个方法都缺」时的降级与告警。
    h.slot.service = {} as unknown as NotifyService
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
    assert.match(h.warns.join('\n'), /push/)
    assert.deepEqual(h.errors, [])
  })

  it('returns false and warns when only the needed method is missing (no silent fallback)', () => {
    const h = setup()
    const fake = fakeService()
    // 此处故意违反契约：断言的是「只缺一个方法」时不做静默回退。
    h.slot.service = { push: fake.service.push } as unknown as NotifyService
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), false)
    assert.match(h.warns.join('\n'), /pushAlways/)
    assert.equal(fake.calls.push.length, 0, 'always:true must not fall back to the focus-gated push')
    assert.deepEqual(h.errors, [])
  })

  it('returns false and warns when push throws', () => {
    const h = setup()
    h.slot.service = fakeService({
      push: () => {
        throw new Error('peer backend died')
      },
    }).service
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
    assert.match(h.warns.join('\n'), /threw/)
    assert.match(h.warns.join('\n'), /peer backend died/)
    assert.deepEqual(h.errors, [])
  })

  it('treats undefined, null and non-boolean results as false', () => {
    for (const result of [undefined, null, 0, 'true', {}]) {
      const h = setup()
      // 此处故意违反契约：断言的是非布尔返回（undefined/null/0/'true'/{}）一律视为未入队。
      h.slot.service = fakeService({ push: () => result } as Partial<NotifyService>).service
      assert.equal(h.notifier.denial(PATH_DENIAL), false, `result ${String(result)} must not be true`)
    }
  })

  it('treats an asynchronous peer result as not queued and swallows its rejection', async () => {
    const h = setup()
    // 此处故意违反契约：断言的是「异步 peer 结果视为未入队，且吞掉 rejection」。
    h.slot.service = {
      push: () => Promise.reject(new Error('async peer')),
      pushAlways: () => Promise.resolve(true),
    } as unknown as NotifyService
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
    assert.equal(h.notifier.denial({ ...PATH_DENIAL, always: true }), false)
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(h.warns.join('\n'), /Promise/)
    assert.deepEqual(h.errors, [])
  })

  it('survives a logger whose warn() throws', () => {
    const h = setup({
      logger: {
        warn: () => {
          throw new Error('logger is broken too')
        },
      },
      resolve: () => {
        throw new Error('service lookup exploded')
      },
    })
    assert.equal(h.notifier.denial(PATH_DENIAL), false)
  })

  it('ignores malformed input without pushing or logging', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    for (const input of [null, undefined, 'deny', 42]) {
      // 此处故意违反契约：断言的是 denial() 对畸形输入的容错（false、不抛、不推）。
      assert.equal(h.notifier.denial(input as unknown as Parameters<typeof h.notifier.denial>[0]), false)
    }
    assert.equal(fake.pushed(), 0)
    assert.deepEqual(h.warns, [])
  })
})

// ---------------------------------------------------------------------------
// 10. malfunction()
// ---------------------------------------------------------------------------

describe('10. malfunction', () => {
  it('pushes the documented title and a fail-closed message naming the extension point', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.malfunction('tools/pre-execute'), true)
    assert.equal(fake.calls.push.length, 1)
    assert.equal(fake.calls.pushAlways.length, 0, 'malfunction is focus-gated: it uses push')
    const { title, message, urgency } = fake.calls.push[0]!
    assert.equal(title, '⚠️ Path Guard 内部错误')
    assert.ok(title.length <= 160)
    assert.match(message, /tools\/pre-execute/, 'names the extension point')
    assert.match(message, /插件已 fail-closed，相关调用被拒/, 'says the plugin failed closed')
    assert.ok(message.length <= 400)
    assert.ok(!message.includes('\n'))
    assert.ok(['low', 'normal', 'critical'].includes(urgency), `invalid urgency ${urgency}`)
    assert.deepEqual(Object.keys(fake.calls.push[0]!).sort(), ['message', 'title', 'urgency'])
  })

  it('is throttled per extension point (a fail-closed bug fires on every governed call)', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.malfunction('tools/pre-execute'), true)
    assert.equal(h.notifier.malfunction('tools/pre-execute'), false, 'one toast per site per window')
    assert.equal(fake.calls.push.length, 1)
    // A different extension point is a different reason.
    assert.equal(h.notifier.malfunction('tools/post-execute'), true)
    assert.equal(fake.calls.push.length, 2)
    // And the window still expires.
    h.advance(10000)
    assert.equal(h.notifier.malfunction('tools/pre-execute'), true)
    assert.equal(fake.calls.push.length, 3)
  })

  it('does not borrow the denial throttle', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.denial(PATH_DENIAL), true)
    assert.equal(h.notifier.malfunction('tools/pre-execute'), true)
    assert.equal(h.notifier.tracked(), 2)
  })

  it('caps a 2000-character extension point and falls back when it is missing', () => {
    const h = setup()
    const fake = fakeService()
    h.slot.service = fake.service
    assert.equal(h.notifier.malfunction('w'.repeat(2000)), true)
    assert.ok(fake.calls.push[0]!.message.length <= 400)
    assert.equal(h.notifier.malfunction(''), true)
    assert.match(fake.calls.push[1]!.message, /未提供扩展点/)
  })

  it('stays silent when the service is missing', () => {
    const h = setup()
    assert.equal(h.notifier.malfunction('tools/pre-execute'), false)
    assert.deepEqual(h.warns, [])
    assert.equal(h.notifier.tracked(), 0)
  })
})
