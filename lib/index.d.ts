/**
 * dsh-path-guard — host half.
 *
 * Enforces a per-path access policy on model-driven tool calls, independently
 * of the DSH file sandbox, so it still applies under `danger-full-access`
 * (where `packages/fs/fs-sandbox/src/index.ts:5-8,125` deliberately fences
 * nothing, and reads are never fenced in any mode).
 *
 * Design constraints this file honours:
 *
 * 1. **No service takeover, no row override.** The plugin only inserts its own
 *    row and attaches to existing extension points. Unloading it restores the
 *    previous behaviour exactly.
 * 2. **`tools/pre-execute` is the authority on paths, not `ctx.tools.guard()`.**
 *    `ToolGuard` is synchronous by type (packages/core/tools/src/index.ts:731)
 *    while `FileSystem.resolve` returns a Promise, and only a resolved path is
 *    symlink-safe: `FsTarget.targetKey` is documented opaque and must not be
 *    parsed (packages/fs/fs/src/types.ts:11-15). A workspace symlink pointing
 *    into `~/.ssh` defeats any purely lexical check.
 * 3. **The guard handles only what is unambiguous without I/O** — surfaces the
 *    plugin refuses by name, and `plugin_manager` actions aimed at itself.
 * 4. **Result redaction rewrites the structured `value`, not rendered text.**
 *    See the ordering note at the post-execute registration.
 * 5. **Configuration is read through the volatile protocol on every decision.**
 *    A schemastery `.volatile()` field resolves to a frozen `{ get() }`
 *    reference, not a plain value (vendor/cosmokit/src/volatile.ts:39-45), and
 *    that reference is updated in place when the user saves the settings page.
 *    Capturing `config.rules` once at activation would therefore pin the policy
 *    to whatever existed at boot, and treating it as an array throws.
 *
 * @module dsh-path-guard
 */
import { Config } from './config.ts';
/**
 * 工具调用对象。结构镜像自 DSH `packages/core/tools/src/index.ts` 的 `ToolExecution`，
 * 只列出本插件真正读取的字段（`name` / `arguments` / `signal` /
 * `agent.session.header.cwd` / `agent.session.header.id`）。
 */
type ToolExecution = {
    name: string;
    arguments: Record<string, unknown>;
    signal?: unknown;
    agent?: {
        session: {
            header: {
                cwd: string;
                id?: string;
            };
        };
    } | undefined;
};
/**
 * Cordis 上下文子集。结构镜像自 DSH `packages/core` 各包的 `src/index.ts` 与
 * `vendor/cordis/src/events.ts`，只列出本插件用到的成员。
 */
type CordisContext = {
    logger: {
        info: (...args: unknown[]) => unknown;
        warn: (...args: unknown[]) => unknown;
        error: (...args: unknown[]) => unknown;
        debug: (...args: unknown[]) => unknown;
    };
    fs?: {
        resolve: (path: string, opts?: {
            cwd?: string;
            signal?: unknown;
        }) => Promise<{
            targetKey: unknown;
            displayPath: string;
        }>;
        processPath: (target: unknown) => string;
        readText?: (target: unknown, signal?: unknown) => Promise<string>;
    } | undefined;
    tools?: {
        guard: (handler: (exec: ToolExecution) => unknown) => unknown;
    } | undefined;
    on: (...args: unknown[]) => unknown;
    get: (name: string) => unknown;
};
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "path-guard";
/** Services this plugin needs: the tool registry and the resolved-path source. */
export declare const inject: string[];
export { Config };
/**
 * Read a schemastery volatile reference, which is a frozen `{ get() }` object.
 * Plain values pass through, so tests and direct construction behave the same.
 * @param {unknown} value - a resolved config field or a plain value.
 * @returns {unknown} the current snapshot.
 */
export declare function unwrap(value: unknown): unknown;
/**
 * Register the policy enforcement points.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} config - the row config, volatile fields still wrapped.
 */
export declare function apply(ctx: CordisContext, config: Record<string, unknown>): void;
