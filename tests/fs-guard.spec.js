/**
 * dsh-path-guard — 权威写否决层单测（src/fs-guard.js）。
 *
 * 运行：node --test tests/fs-guard.spec.js
 * 零依赖，仅用 node 内置测试器与断言。用假的 target / actor / next 直接驱动，
 * 不加载 Cordis，也不接触真实文件系统。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFsGuard } from '../src/fs-guard.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 与 DSH 的 FsError 同形状：message + code（+ cause）。 */
class TestFsError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'FsError';
    this.code = code;
  }
}

/** AI 发起的调用（真实的 actor 是 ToolExecution，这里只需要一个可辨识的对象）。 */
const AGENT = { name: 'write', agent: { session: { header: { cwd: 'D:/proj' } } } };

/** 用户 / GUI 发起的调用。 */
const USER_ACTOR = { source: 'gui', user: true };

/** 两个 handler 的名字，需求 6 要求同一份用例跑两遍。 */
const HANDLERS = ['writeIntent', 'editIntent'];

/** 一个普通的已解析目标。 */
const DISPLAY = 'D:/srv/secret/id_rsa';
const KEY = 'opaque\u0000D:/srv/secret/id_rsa';

/**
 * 造一个目标。
 * @param {string} displayPath - 展示/判定路径。
 * @param {unknown} targetKey - opaque 键。
 * @returns {{targetKey: unknown, displayPath: string}} 目标。
 */
function targetOf(displayPath = DISPLAY, targetKey = KEY) {
  return { targetKey, displayPath };
}

/**
 * 造一个记录调用的 next。
 * @param {unknown} value - next() 的解析值。
 * @returns {{next: Function, calls: unknown[][]}} next 与调用记录。
 */
function makeNext(value = { kind: 'createIfAbsent' }) {
  /** @type {unknown[][]} */
  const calls = [];
  const next = (...args) => {
    calls.push(args);
    return Promise.resolve(value);
  };
  return { next, calls };
}

/**
 * 造一个 guard。
 * @param {object} [overrides] - 覆盖 decide / actorIsAgent / FsError / logger。
 * @returns {{guard: object, warnings: unknown[][], debugs: unknown[][]}} guard 与日志记录。
 */
function makeGuard(overrides = {}) {
  /** @type {unknown[][]} */
  const warnings = [];
  /** @type {unknown[][]} */
  const debugs = [];
  const logger = Object.hasOwn(overrides, 'logger')
    ? overrides.logger
    : {
      warn: (...args) => warnings.push(args),
      debug: (...args) => debugs.push(args),
    };
  const guard = createFsGuard({
    decide: overrides.decide ?? (() => ({ access: 'write' })),
    actorIsAgent: overrides.actorIsAgent ?? ((actor) => actor === AGENT),
    FsError: overrides.FsError ?? TestFsError,
    logger,
  });
  return { guard, warnings, debugs };
}

/**
 * 断言一个 promise 以 FS_SANDBOX_DENIED 拒绝。
 * @param {Promise<unknown>} promise - 待断言。
 * @param {string} label - 断言上下文。
 * @returns {Promise<Error & { code: string }>} 捕获到的错误。
 */
async function rejectsDenied(promise, label) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, `${label}: 应当抛错`);
  assert.equal(caught.code, 'FS_SANDBOX_DENIED', `${label}: code 应为 FS_SANDBOX_DENIED`);
  assert.ok(caught instanceof TestFsError, `${label}: 应当是注入的 FsError 形状`);
  return caught;
}

/**
 * 让一个场景在两个 handler 上各跑一遍。
 * @param {(name: string) => Promise<void>} run - 场景体。
 * @returns {Promise<void>} 全部完成。
 */
async function forEachHandler(run) {
  for (const name of HANDLERS) await run(name);
}

// ---------------------------------------------------------------------------
// 1. 非 AI actor：绝不干预用户
// ---------------------------------------------------------------------------

test('1. 非 AI actor → next() 被调用、返回值透传、不抛错', async () => {
  await forEachHandler(async (name) => {
    const sentinel = { kind: 'createIfAbsent' };
    const { guard } = makeGuard();
    const { next, calls } = makeNext(sentinel);

    const result = await guard[name](targetOf(), USER_ACTOR, next);

    assert.equal(calls.length, 1, `${name}: next 应被调用一次`);
    assert.equal(result, sentinel, `${name}: 返回值应原样透传`);
  });
});

test('1b. 用户调用连 decide 都不会调用（不消耗策略层，也不受其故障影响）', async () => {
  await forEachHandler(async (name) => {
    let decideCalls = 0;
    const { guard } = makeGuard({
      decide: () => {
        decideCalls += 1;
        throw new Error('策略层故障也不应影响用户');
      },
    });
    const { next, calls } = makeNext('ok');

    assert.equal(await guard[name](targetOf(), USER_ACTOR, next), 'ok');
    assert.equal(decideCalls, 0, `${name}: 用户调用不应进入策略判定`);
    assert.equal(calls.length, 1, `${name}: next 应被调用`);
  });
});

// ---------------------------------------------------------------------------
// 2-4. AI actor：档位判定
// ---------------------------------------------------------------------------

test('2. AI actor + access none → 抛 FS_SANDBOX_DENIED，next 未被调用', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => ({ access: 'none' }) });
    const { next, calls } = makeNext();

    await rejectsDenied(guard[name](targetOf(), AGENT, next), name);
    assert.equal(calls.length, 0, `${name}: 拒绝时 next 不得被调用`);
  });
});

test('3. AI actor + access read（不可写）→ 抛 FS_SANDBOX_DENIED，next 未被调用', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => ({ access: 'read' }) });
    const { next, calls } = makeNext();

    const error = await rejectsDenied(guard[name](targetOf(), AGENT, next), name);
    assert.match(error.message, /access: read/, `${name}: 消息应写明命中档位`);
    assert.equal(calls.length, 0, `${name}: 拒绝时 next 不得被调用`);
  });
});

test('3b. AI actor + access list（不可写）→ 同样拒绝', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => ({ access: 'list' }) });
    const { next, calls } = makeNext();

    await rejectsDenied(guard[name](targetOf(), AGENT, next), name);
    assert.equal(calls.length, 0, `${name}: 拒绝时 next 不得被调用`);
  });
});

test('4. AI actor + access write → next() 被调用，返回值透传', async () => {
  await forEachHandler(async (name) => {
    const sentinel = { kind: 'replaceIfVersion', version: 'v1' };
    const { guard } = makeGuard({ decide: () => ({ access: 'write' }) });
    const { next, calls } = makeNext(sentinel);

    const result = await guard[name](targetOf(), AGENT, next);

    assert.equal(calls.length, 1, `${name}: next 应被调用一次`);
    assert.equal(result, sentinel, `${name}: 下游 intent 应原样透传`);
  });
});

test('4b. AI actor + access allow（配置层的显式放行档）→ 放行，不能被误挡', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => ({ access: 'allow', ruleId: 'r1' }) });
    const { next, calls } = makeNext();

    await guard[name](targetOf(), AGENT, next);

    assert.equal(calls.length, 1, `${name}: 显式放行档必须放行`);
  });
});

test('4c. decide 返回带 ruleId/pattern 的完整决策对象 → 只读 access，其余忽略', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({
      decide: () => ({ access: 'write', ruleId: '#0', pattern: 'D:/srv/**' }),
    });
    const { next, calls } = makeNext();

    await guard[name](targetOf(), AGENT, next);

    assert.equal(calls.length, 1, `${name}: 完整决策对象应正常判定`);
  });
});

// ---------------------------------------------------------------------------
// 5. decide 抛错 / 返回 undefined / 返回未知档位 → fail-closed
// ---------------------------------------------------------------------------

test('5. decide 抛错 → 抛 FS_SANDBOX_DENIED、next 未被调用、logger.warn 被调用', async () => {
  await forEachHandler(async (name) => {
    const boom = new Error('策略引擎炸了');
    const { guard, warnings } = makeGuard({
      decide: () => {
        throw boom;
      },
    });
    const { next, calls } = makeNext();

    const error = await rejectsDenied(guard[name](targetOf(), AGENT, next), name);

    assert.equal(calls.length, 0, `${name}: fail-closed 时 next 不得被调用`);
    assert.ok(warnings.length >= 1, `${name}: fail-closed 必须 logger.warn`);
    assert.equal(error.cause, boom, `${name}: 应保留原始错误作为 cause`);
    assert.match(error.message, /fail-closed/, `${name}: 消息应说明是 fail-closed`);
  });
});

test('5b. decide 返回 undefined → fail-closed 且 logger.warn', async () => {
  await forEachHandler(async (name) => {
    const { guard, warnings } = makeGuard({ decide: () => undefined });
    const { next, calls } = makeNext();

    await rejectsDenied(guard[name](targetOf(), AGENT, next), name);

    assert.equal(calls.length, 0, `${name}: fail-closed 时 next 不得被调用`);
    assert.ok(warnings.length >= 1, `${name}: fail-closed 必须 logger.warn`);
  });
});

test('5c. decide 返回未知 / 非法档位 → fail-closed 且 logger.warn', async () => {
  const bad = [
    { access: 'rw' },
    { access: 'admin' },
    { access: '' },
    {},
    { access: 3 },
    null,
    'write',
  ];
  await forEachHandler(async (name) => {
    for (const decision of bad) {
      const { guard, warnings } = makeGuard({ decide: () => decision });
      const { next, calls } = makeNext();

      await rejectsDenied(guard[name](targetOf(), AGENT, next), `${name} / ${JSON.stringify(decision)}`);

      assert.equal(calls.length, 0, `${name}: 非法决策不得放行`);
      assert.ok(warnings.length >= 1, `${name}: 非法决策必须 logger.warn`);
    }
  });
});

test('5d. decide 是异步的（返回 Promise）→ 正常判定', async () => {
  await forEachHandler(async (name) => {
    const allow = makeGuard({ decide: async () => ({ access: 'write' }) });
    const allowNext = makeNext();
    await allow.guard[name](targetOf(), AGENT, allowNext.next);
    assert.equal(allowNext.calls.length, 1, `${name}: 异步放行判定应生效`);

    const deny = makeGuard({ decide: async () => ({ access: 'none' }) });
    const denyNext = makeNext();
    await rejectsDenied(deny.guard[name](targetOf(), AGENT, denyNext.next), name);
    assert.equal(denyNext.calls.length, 0, `${name}: 异步拒绝判定应生效`);
  });
});

// ---------------------------------------------------------------------------
// 6. 两个 handler 行为一致
// ---------------------------------------------------------------------------

test('6. writeIntent 与 editIntent 在同一输入矩阵上行为一致', async () => {
  const scenarios = [
    { label: 'agent/none', actor: AGENT, decide: () => ({ access: 'none' }) },
    { label: 'agent/list', actor: AGENT, decide: () => ({ access: 'list' }) },
    { label: 'agent/read', actor: AGENT, decide: () => ({ access: 'read' }) },
    { label: 'agent/write', actor: AGENT, decide: () => ({ access: 'write' }) },
    { label: 'agent/allow', actor: AGENT, decide: () => ({ access: 'allow' }) },
    { label: 'agent/undefined', actor: AGENT, decide: () => undefined },
    { label: 'agent/throw', actor: AGENT, decide: () => { throw new Error('x'); } },
    { label: 'user/none', actor: USER_ACTOR, decide: () => ({ access: 'none' }) },
    { label: 'user/write', actor: USER_ACTOR, decide: () => ({ access: 'write' }) },
  ];

  /** @type {Map<string, string>} */
  const outcomes = new Map();
  for (const name of HANDLERS) {
    for (const scenario of scenarios) {
      const { guard } = makeGuard({ decide: scenario.decide });
      const { next, calls } = makeNext();
      let outcome;
      try {
        await guard[name](targetOf(), scenario.actor, next);
        outcome = `allow/next=${calls.length}`;
      } catch (error) {
        outcome = `throw/${error.code ?? error.name}/next=${calls.length}`;
      }
      const key = `${scenario.label}`;
      if (outcomes.has(key)) {
        assert.equal(outcome, outcomes.get(key), `${key}: 两个 handler 行为必须一致`);
      } else {
        outcomes.set(key, outcome);
      }
    }
  }
  assert.equal(outcomes.size, scenarios.length);
});

// ---------------------------------------------------------------------------
// 7. 错误消息内容
// ---------------------------------------------------------------------------

test('7. 拒绝消息里出现 displayPath，并说明是最终解析后的目标', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => ({ access: 'none' }) });
    const { next } = makeNext();

    const error = await rejectsDenied(guard[name](targetOf(), AGENT, next), name);

    assert.ok(error.message.includes(DISPLAY), `${name}: 消息必须包含 displayPath`);
    assert.match(error.message, /最终解析后的目标/, `${name}: 消息必须说明这是最终解析后的目标`);
    assert.match(error.message, /不是调用方传入的原始路径/, `${name}: 消息必须区分原始路径`);
  });
});

test('7b. fail-closed 消息里也出现 displayPath', async () => {
  await forEachHandler(async (name) => {
    const { guard } = makeGuard({ decide: () => undefined });
    const { next } = makeNext();

    const error = await rejectsDenied(guard[name](targetOf(), AGENT, next), name);

    assert.ok(error.message.includes(DISPLAY), `${name}: fail-closed 消息必须包含 displayPath`);
  });
});

// ---------------------------------------------------------------------------
// 8. targetKey 是 opaque：只转发，不解析
// ---------------------------------------------------------------------------

test('8. targetKey 原样转发给 decide，不被解析，也不出现在错误消息里', async () => {
  await forEachHandler(async (name) => {
    /** @type {unknown[][]} */
    const seen = [];
    const weirdKey = 'weird\u0000key::not-a-path::\\\\?\\C:\\other';
    const { guard } = makeGuard({
      decide: (...args) => {
        seen.push(args);
        return { access: 'write' };
      },
    });
    const { next, calls } = makeNext();

    await guard[name](targetOf(DISPLAY, weirdKey), AGENT, next);

    assert.equal(seen.length, 1, `${name}: decide 应被调用一次`);
    assert.equal(seen[0][0], weirdKey, `${name}: targetKey 必须原样转发`);
    assert.equal(seen[0][1], DISPLAY, `${name}: 第二个参数必须是 displayPath`);
    assert.equal(seen[0][2], AGENT, `${name}: 第三个参数必须是 actor`);
    assert.equal(calls.length, 1);

    // 判定只用 displayPath：即使 targetKey 指向别的路径，也按 displayPath 判定。
    const denySeen = [];
    const denyGuard = makeGuard({
      decide: (...args) => {
        denySeen.push(args);
        return { access: 'none' };
      },
    });
    const denyNext = makeNext();
    const error = await rejectsDenied(
      denyGuard.guard[name](targetOf(DISPLAY, weirdKey), AGENT, denyNext.next),
      name,
    );
    assert.equal(denySeen[0][1], DISPLAY, `${name}: 判定必须使用 displayPath`);
    assert.ok(!error.message.includes(weirdKey), `${name}: 错误消息不应泄露/回显 targetKey`);
  });
});

// ---------------------------------------------------------------------------
// 9. 目标形状不可用 / 发起者不可判定 → fail-closed
// ---------------------------------------------------------------------------

test('9. target 形状不可用（displayPath 缺失/空/非字符串）→ fail-closed 且 warn', async () => {
  const badTargets = [
    undefined,
    null,
    {},
    { targetKey: KEY },
    { targetKey: KEY, displayPath: '' },
    { targetKey: KEY, displayPath: 42 },
    'D:/srv/secret/id_rsa',
  ];
  await forEachHandler(async (name) => {
    for (const target of badTargets) {
      const { guard, warnings } = makeGuard();
      const { next, calls } = makeNext();

      await rejectsDenied(guard[name](target, AGENT, next), `${name} / ${String(target)}`);

      assert.equal(calls.length, 0, `${name}: 目标不可判定时不得放行`);
      assert.ok(warnings.length >= 1, `${name}: 目标不可判定必须 logger.warn`);
    }
  });
});

test('9b. actorIsAgent 抛错 → fail-closed 且 warn（并保留 cause）', async () => {
  await forEachHandler(async (name) => {
    const boom = new Error('actor 判定炸了');
    const { guard, warnings } = makeGuard({
      actorIsAgent: () => {
        throw boom;
      },
    });
    const { next, calls } = makeNext();

    const error = await rejectsDenied(guard[name](targetOf(), AGENT, next), name);

    assert.equal(calls.length, 0, `${name}: 无法判定发起者时不得放行`);
    assert.ok(warnings.length >= 1, `${name}: 必须 logger.warn`);
    assert.equal(error.cause, boom, `${name}: 应保留原始错误作为 cause`);
  });
});

test('9c. AI 路径上 next 不可调用 → fail-closed 且 warn', async () => {
  await forEachHandler(async (name) => {
    const { guard, warnings } = makeGuard();

    await rejectsDenied(guard[name](targetOf(), AGENT, undefined), name);

    assert.ok(warnings.length >= 1, `${name}: 必须 logger.warn`);
  });
});

// ---------------------------------------------------------------------------
// 10. 下游错误原样透传、日志器与依赖健壮性
// ---------------------------------------------------------------------------

test('10. 放行时下游 next() 抛错原样透传，不被包装成 FS_SANDBOX_DENIED', async () => {
  await forEachHandler(async (name) => {
    const downstream = new TestFsError('下游策略拒绝', 'FS_NOT_OBSERVED');
    const { guard } = makeGuard({ decide: () => ({ access: 'write' }) });

    let caught;
    try {
      await guard[name](targetOf(), AGENT, () => Promise.reject(downstream));
    } catch (error) {
      caught = error;
    }

    assert.equal(caught, downstream, `${name}: 下游错误必须原样透传（identity）`);
    assert.equal(caught.code, 'FS_NOT_OBSERVED', `${name}: 下游 code 不得被改写`);
  });
});

test('10b. logger 抛错 / 缺失都不影响判定', async () => {
  const throwingLogger = {
    warn: () => {
      throw new Error('日志炸了');
    },
    debug: () => {
      throw new Error('日志炸了');
    },
  };

  await forEachHandler(async (name) => {
    // 放行路径 + 抛错日志器 → 仍然放行。
    const allow = makeGuard({ decide: () => ({ access: 'write' }), logger: throwingLogger });
    const allowNext = makeNext();
    await allow.guard[name](targetOf(), AGENT, allowNext.next);
    assert.equal(allowNext.calls.length, 1, `${name}: 日志故障不得影响放行`);

    // 拒绝路径 + 抛错日志器 → 仍然是结构化的 FS_SANDBOX_DENIED。
    const deny = makeGuard({ decide: () => ({ access: 'none' }), logger: throwingLogger });
    await rejectsDenied(deny.guard[name](targetOf(), AGENT, makeNext().next), name);

    // 完全不传 logger。
    const quiet = makeGuard({ decide: () => undefined, logger: undefined });
    await rejectsDenied(quiet.guard[name](targetOf(), AGENT, makeNext().next), name);
  });
});

test('10c. 依赖缺失 / 类型不对 → 构造期抛 TypeError（加载期暴露接线错误）', () => {
  assert.throws(() => createFsGuard(), TypeError);
  assert.throws(() => createFsGuard(null), TypeError);
  assert.throws(() => createFsGuard({ actorIsAgent: () => true, FsError: TestFsError }), TypeError);
  assert.throws(() => createFsGuard({ decide: () => undefined, FsError: TestFsError }), TypeError);
  assert.throws(() => createFsGuard({ decide: () => undefined, actorIsAgent: () => true }), TypeError);
  assert.throws(() => createFsGuard({ decide: 1, actorIsAgent: () => true, FsError: TestFsError }), TypeError);
});

test('10d. 返回的 guard 恰好导出 writeIntent / editIntent 两个 handler', () => {
  const { guard } = makeGuard();
  assert.deepEqual(Object.keys(guard).sort(), ['editIntent', 'writeIntent']);
  assert.equal(typeof guard.writeIntent, 'function');
  assert.equal(typeof guard.editIntent, 'function');
  // 两个 handler 是各自独立的函数（不共享闭包状态以外的东西）。
  assert.notEqual(guard.writeIntent, guard.editIntent);
});
