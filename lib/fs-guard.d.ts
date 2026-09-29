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
export declare function createFsGuard(deps: {
    decide: (targetKey: unknown, displayPath: string, actor: unknown) => unknown;
    actorIsAgent: (actor: unknown) => unknown;
    FsError: new (message: string, code: string, options?: {
        cause?: unknown;
    }) => Error;
    logger?: unknown;
}): {
    writeIntent: (target: unknown, actor: unknown, next: () => unknown) => Promise<unknown>;
    editIntent: (target: unknown, actor: unknown, next: () => unknown) => Promise<unknown>;
};
