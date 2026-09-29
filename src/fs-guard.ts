/**
 * dsh-path-guard — 权威写否决层（最终文件系统权威）。
 *
 * ## 为什么需要这一层
 *
 * `tools/pre-execute` 的链路是
 * `pre-execute → ctx.fs.resolve() → 判定 → 允许 → 工具自己再 resolve → 真正读写`。
 * 被检查的 `FsTarget` **不是**工具随后真正用于读写的那个目标，两者之间隔着一次
 * 重新解析，存在 check-then-use 竞态（docs/ARCHITECTURE.md §2.1）。
 *
 * DSH 在真正写入/编辑之前派发两个 waterfall 事件，参数里携带的 `FsTarget` 就是
 * 紧接着要交给 `writeText` / `editText` 的那个目标：
 *
 * - `fs/write-intent(target, actor, next)`（packages/fs/fs/src/index.ts:59）
 * - `fs/edit-intent(target, actor, next)`（packages/fs/fs/src/index.ts:67）
 *
 * 本模块把这两个事件接成**最终权威否决层**。监听器可以 `throw` 否决；Cordis 的
 * waterfall 是「不调用 `next()` 即否决整条链」的合成语义
 * （vendor/cordis/src/events.ts:234-243），抛错同样终止链并把错误交给调用方。
 * 于是上层 pre-execute 降级为快速预检，这里才是最后一道闸门。
 *
 * ## 接线约束（重要）
 *
 * `waterfall` 按**注册顺序**从最外层开始执行，任何不调用 `next()` 的监听器都会
 * 截断整条链。因此本模块的两个 handler 必须注册在其它「单槽决策」监听器
 * （例如 `@deepseek-ai/dsh-fs-observation-policy`，它刻意不调用 `next()`）**之前**；
 * 否则本层永远不会被调用（静默 fail-open）。放行时这里会 `return next()`，
 * 下游的 intent 提供者照常拿到决策权。
 *
 * ## 不变量
 *
 * - **只挡 AI**：`actorIsAgent(actor)` 为假 → 原样放行，绝不干预用户/GUI。
 * - **判定只用 `displayPath`**：`targetKey` 是 opaque 标识（types.ts:11-16 明文要求
 *   消费者不得解析），本模块只把它**原样转发**给 `decide`，不做任何解析或比较。
 * - **fail-closed**：判定不了（`decide` 抛错 / 返回 undefined / 返回无法识别的档位 /
 *   目标形状不可用 / 无法确定发起者）一律抛 `FS_SANDBOX_DENIED`，并 `logger.warn`。
 *
 * 本模块零依赖：不 import 任何 DSH 包，`FsError` 由调用方注入，便于单测与接线。
 *
 * @module dsh-path-guard/fs-guard
 */

/**
 * 明确**拒绝写入**的档位（policy.js 的访问阶梯：none < list < read < write）。
 * 三者的共同点是能力位 `write === false`。
 * @type {ReadonlySet<string>}
 */
const DENY_ACCESS = new Set(['none', 'list', 'read']);

/**
 * 明确**允许写入**的档位。
 *
 * `write` 是阶梯顶端的可写档位；`allow` 是配置层的「显式放行」档位
 * （config.js 的 `ACCESS_VALUES` 含 `allow`，policy.js 的 `capabilities('allow')`
 * 是「无限制」）。二者都不在拒绝集里，必须放行，否则会把用户显式放行的路径
 * 一并挡掉。
 * @type {ReadonlySet<string>}
 */
const ALLOW_ACCESS = new Set(['write', 'allow']);

/** 档位的人话说明，与 src/deny.js 的 ACCESS_TEXT 同源（此处自带一份以保持零依赖）。 */
const ACCESS_TEXT: Record<string, string> = {
  none: '完全禁止（不可见、不可读、不可写）',
  list: '仅允许查看文件名与目录结构，不允许读取内容',
  read: '允许读取，不允许写入或修改',
};

/** 本层执行的操作，用于错误文本。 */
const REQUIRED_TEXT = 'write（创建或修改文件内容）';

/**
 * 把判定结果归类。未知档位、非对象、缺 `access` 一律算「无法判定」，
 * 由调用方按 fail-closed 处理。
 *
 * @param {unknown} decision - `decide()` 的返回值。
 * @returns {{kind: 'allow' | 'deny' | 'invalid', access?: string}} 归类结果。
 */
function classify(decision: unknown): { kind: 'allow'; access: string } | { kind: 'deny'; access: string } | { kind: 'invalid'; access?: string | undefined } {
  if (decision === null || typeof decision !== 'object') return { kind: 'invalid' };
  const access = (decision as { access?: unknown }).access;
  if (typeof access !== 'string') return { kind: 'invalid' };
  if (ALLOW_ACCESS.has(access)) return { kind: 'allow', access };
  if (DENY_ACCESS.has(access)) return { kind: 'deny', access };
  return { kind: 'invalid', access };
}

/**
 * 目标形状可用时取用于展示/判定的路径；否则给出占位文本。
 * @param {string | undefined} displayPath - 已校验的 displayPath。
 * @returns {string} 供错误文本使用的路径。
 */
function shownPath(displayPath: string | undefined): string {
  return displayPath === undefined ? '(displayPath 不可用)' : displayPath;
}

/**
 * 档位明确不允许写入时的否决文本。要求写明：路径、命中的档位、
 * 以及「这是最终解析后的目标，不是调用方传入的原始路径」。
 *
 * @param {{eventName: string, displayPath: string | undefined, access: string}} input - 判定事实。
 * @returns {string} 面向模型/用户的拒绝原因。
 */
function denialMessage({ eventName, displayPath, access }: { eventName: string; displayPath: string | undefined; access: string }): string {
  const shown = shownPath(displayPath);
  return [
    `拒绝写入「${shown}」：该路径由用户通过 dsh-path-guard 限制为 access: ${access}，不允许写入。`,
    '',
    `- 事件：${eventName}`,
    `- 最终解析目标：${shown}`,
    `- 命中档位：access: ${access}（${ACCESS_TEXT[access] ?? access}）`,
    `- 本次操作需要：${REQUIRED_TEXT}`,
    '- 判定层：文件系统权威层（fs/*-intent）。判定针对的是「最终解析后的目标」'
      + '（canonical FsTarget，符号链接等别名已被跟随），不是调用方传入的原始路径；'
      + '上层 tools/pre-execute 的检查只是快速预检，不能替代这里。',
    '',
    '不要尝试绕过这个限制：换用别的工具或参数名、改用相对路径或 `..`、符号链接、'
      + '短路径(8.3)、大小写变体、编码/压缩/改名，或经由 shell、脚本间接写入，都会被同样拒绝。',
    '',
    '如果任务确实需要写这个路径，请向用户说明用途，请他在「设置 → 路径守卫」中调整规则。',
  ].join('\n');
}

/**
 * 无法判定（fail-closed）时的否决文本。要说清「为什么判定不了」，
 * 让用户能区分「策略命中」与「守卫/接线故障」。
 *
 * @param {{eventName: string, displayPath: string | undefined, reason: string}} input - 失败事实。
 * @returns {string} 面向模型/用户的拒绝原因。
 */
function failClosedMessage({ eventName, displayPath, reason }: { eventName: string; displayPath: string | undefined; reason: string }): string {
  const shown = shownPath(displayPath);
  return [
    `拒绝写入「${shown}」：路径守卫无法确定该目标的访问档位，按最严处理（fail-closed）。`,
    '',
    `- 事件：${eventName}`,
    `- 最终解析目标：${shown}`,
    `- 原因：${reason}`,
    `- 本次操作需要：${REQUIRED_TEXT}`,
    '- 判定层：文件系统权威层（fs/*-intent），针对的是最终解析后的目标'
      + '（canonical FsTarget），不是调用方传入的原始路径。',
    '',
    '这条拒绝不是用户设置的规则命中，而是守卫拿不到可判定的策略结果'
      + '（常见于接线或配置问题）。请让用户检查 dsh-path-guard 的配置与加载顺序。',
  ].join('\n');
}

/**
 * 建立权威写否决层的两个事件 handler。
 *
 * @param {{
 *   decide: (targetKey: string, displayPath: string, actor: unknown) => { access: string } | undefined,
 *   actorIsAgent: (actor: unknown) => boolean,
 *   FsError: new (message: string, code: string, options?: { cause?: unknown }) => Error & { code: string },
 *   logger?: { warn?: Function, debug?: Function },
 * }} deps - 依赖注入。`FsError` 必须是 DSH 的 `FsError`（或同形状的双），
 *   本模块不 import 任何 DSH 包。`decide` 允许返回 Promise（内部会 await）。
 * @returns {{
 *   writeIntent: (target: unknown, actor: unknown, next: Function) => Promise<unknown>,
 *   editIntent: (target: unknown, actor: unknown, next: Function) => Promise<unknown>,
 * }} 与 `fs/write-intent` / `fs/edit-intent` 事件签名一致的 handler。
 * @throws {TypeError} 依赖缺失或类型不对（接线错误，加载期就报，避免静默 fail-open）。
 */
export function createFsGuard(deps: {
  decide: (targetKey: unknown, displayPath: string, actor: unknown) => unknown
  actorIsAgent: (actor: unknown) => unknown
  FsError: new (message: string, code: string, options?: { cause?: unknown }) => Error
  logger?: unknown
}) {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('createFsGuard: deps 必须是对象 { decide, actorIsAgent, FsError, logger? }');
  }
  const { decide, actorIsAgent, FsError } = deps;
  if (typeof decide !== 'function') {
    throw new TypeError('createFsGuard: deps.decide 必须是函数');
  }
  if (typeof actorIsAgent !== 'function') {
    throw new TypeError('createFsGuard: deps.actorIsAgent 必须是函数');
  }
  if (typeof FsError !== 'function') {
    throw new TypeError('createFsGuard: deps.FsError 必须是构造函数（DSH 的 FsError 或同形状替身）');
  }

  /** 可选 logger。 */
  const logger = deps.logger;

  /**
   * 安全日志：日志器自身抛错绝不能改变安全判定。
   * @param {'warn' | 'debug'} level - 日志级别。
   * @param {...unknown} args - 透传给日志器的参数。
   * @returns {void}
   */
  const log = (level: 'warn' | 'debug', ...args: unknown[]): void => {
    const fn = logger === null || typeof logger !== 'object' ? undefined : (logger as Record<string, unknown>)[level];
    if (typeof fn !== 'function') return;
    try {
      fn.apply(logger, args);
    } catch {
      // 日志失败不影响判定结果。
    }
  };

  /**
   * 构造结构化否决错误。
   * @param {string} message - 面向模型/用户的原因。
   * @param {unknown} [cause] - 可选原因链。
   * @returns {Error & { code: string }} `FS_SANDBOX_DENIED` 错误。
   */
  const denied = (message: string, cause?: unknown) => (cause === undefined
    ? new FsError(message, 'FS_SANDBOX_DENIED')
    : new FsError(message, 'FS_SANDBOX_DENIED', { cause }));

  /**
   * 为某个 intent 事件生成 handler。两个 handler 行为完全一致，
   * 只有错误文本里的事件名不同。
   *
   * @param {'fs/write-intent' | 'fs/edit-intent'} eventName - 事件名。
   * @returns {(target: unknown, actor: unknown, next: Function) => Promise<unknown>} handler。
   */
  const makeHandler = (eventName: 'fs/write-intent' | 'fs/edit-intent') => async function intentHandler(target: unknown, actor: unknown, next: () => unknown) {
    // 只读取 target 的公开字段，不解析 targetKey（types.ts:11-16：opaque，禁止解析）。
    // 属性读取本身也可能抛（异常后端 / Proxy 目标）：读不到就当形状不可用，
    // 但不能因此把用户调用也炸掉，所以这里吞掉异常、交给后面的分支处理。
    let targetKey: unknown;
    let rawDisplayPath: unknown;
    try {
      if (target !== null && typeof target === 'object') {
        targetKey = (target as { targetKey?: unknown }).targetKey;
        rawDisplayPath = (target as { displayPath?: unknown }).displayPath;
      }
    } catch {
      // 读不到字段 → 下面的形状校验会按 fail-closed 处理。
    }
    const displayPath = typeof rawDisplayPath === 'string' && rawDisplayPath !== '' ? rawDisplayPath : undefined;

    // 1) 发起者判定。用户 / GUI 调用必须原样放行——这是本插件
    //    「只挡 AI、不挡用户」的核心约定。
    let isAgent;
    try {
      isAgent = actorIsAgent(actor);
    } catch (error) {
      // 无法判定发起者：既不能证明它是用户，也不能在无法判定时放行。
      log('warn', 'path-guard: %s 的 actorIsAgent 抛出异常，无法判定发起者，按 fail-closed 拒绝：%s', eventName, String(error));
      throw denied(failClosedMessage({
        eventName,
        displayPath,
        reason: `发起者判定失败（actorIsAgent 抛出：${String(error)}）`,
      }), error);
    }
    if (!isAgent) {
      log('debug', 'path-guard: %s 非 AI 调用，放行 %s', eventName, shownPath(displayPath));
      return next();
    }

    // 2) 走到这里说明这是一次 AI 发起的写入。要放行就必须能调用 next()；
    //    拿不到 next 就无法把决策交还给事件链，只能按最严处理。
    if (typeof next !== 'function') {
      log('warn', 'path-guard: %s 的 next 不是函数，无法交还决策，按 fail-closed 拒绝', eventName);
      throw denied(failClosedMessage({
        eventName,
        displayPath,
        reason: '事件参数 next 不可调用（不是 waterfall 派发或接线错误）',
      }));
    }

    // 3) 目标形状不可用则无法判定。
    if (displayPath === undefined) {
      log('warn', 'path-guard: %s 的 target.displayPath 缺失或非字符串，无法判定，按 fail-closed 拒绝', eventName);
      throw denied(failClosedMessage({
        eventName,
        displayPath,
        reason: `target.displayPath 缺失、为空或不是字符串（收到 ${typeof rawDisplayPath}）`,
      }));
    }

    // 4) 交给策略层判定。targetKey 原样转发，绝不解析。
    //    decide 允许是异步的（await 对同步返回值同样成立）。
    let decision;
    try {
      decision = await decide(targetKey, displayPath, actor);
    } catch (error) {
      log('warn', 'path-guard: %s 的策略判定抛出异常，无法判定 %s，按 fail-closed 拒绝：%s', eventName, displayPath, String(error));
      throw denied(failClosedMessage({
        eventName,
        displayPath,
        reason: `策略判定失败（decide 抛出：${String(error)}）`,
      }), error);
    }

    const verdict = classify(decision);

    if (verdict.kind === 'allow') {
      log('debug', 'path-guard: %s 允许写入 %s（access: %s）', eventName, displayPath, verdict.access);
      return next();
    }

    if (verdict.kind === 'deny') {
      log('debug', 'path-guard: %s 拒绝写入 %s（access: %s）', eventName, displayPath, verdict.access);
      throw denied(denialMessage({ eventName, displayPath, access: verdict.access }));
    }

    // 5) decide 返回 undefined 或无法识别的档位 —— 判定不了就是最严。
    let reason;
    if (decision === undefined) {
      reason = '策略判定没有给出结论（decide 返回 undefined）';
    } else if (verdict.access === undefined) {
      reason = `策略判定的返回值不是决策对象（收到 ${decision === null ? 'null' : typeof decision}），没有可用的 access 档位`;
    } else {
      reason = `策略判定返回了无法识别的档位（access: ${JSON.stringify(verdict.access)}）`;
    }
    log('warn', 'path-guard: %s %s，无法判定 %s，按 fail-closed 拒绝', eventName, reason, displayPath);
    throw denied(failClosedMessage({ eventName, displayPath, reason }));
  };

  return {
    writeIntent: makeHandler('fs/write-intent'),
    editIntent: makeHandler('fs/edit-intent'),
  };
}
