# DSH Filesystem Fence Surface Report

Checkout: `D:\Program\deepseek-harness\` · version `0.1.7-rc.2` · commit `477b4f420553e8a52c2fbccc464d7561b239c443`
Deployment under analysis: DSH file policy = `danger-full-access`.

All paths below are relative to the checkout root. Line numbers are verbatim against the state above.

---

## 0. Bottom line

There are **three structurally different kinds of file access** in DSH, and only the first is fenced by a
`ctx.tools.guard()` plugin:

| Kind | Examples | Fenceable by a plugin? |
| --- | --- | --- |
| **A. In-process native tool calls** that go through `ctx.fs` | `read`, `write`, `edit`, `read_image`, `str_replace_editor`, `present`, `lsp` | **Yes** — `tools/pre-execute` (async, can resolve the real path) + `tools/post-execute` (can redact result content *and* `meta`) |
| **B. In-process native tool calls that do NOT go through `ctx.fs`** | `glob`, `grep` (spawn packaged ripgrep via `ctx.subprocess`), `job_output`/`job_list` (shell output), `terminal_*`, `mcp__*`, `cua_driver_native__*` | **Partially** — arguments are model-supplied and inspectable, so the *call* can be denied; but arbitrary-schema tools (MCP) have no extractable path field, and already-captured output cannot be un-leaked |
| **C. Real OS processes / foreign tool loops** | `bash`, `pwsh`, persistent PTY shells, `run_code` (Node/Python PTC program), external subagents (`subagent-claude-code`, `subagent-codex`, `subagent-acp`), hooks | **No** at the plugin layer. Only a real OS sandbox (`sandbox-windows-acl` / bwrap / Landlock / Seatbelt) confines these. A shell/`python3` is Turing-complete: argument pattern-matching is not enforcement |

**The single most important structural fact:** `danger-full-access` does **not** disable the plugin
pipeline. `tools/pre-execute`, `ctx.tools.guard()` and `tools/post-execute` all fire regardless of the
file policy — verified because nothing in `packages/core/tools/src/index.ts` reads `sandboxPolicy`.
So a guard plugin gives you a *sound* Level-A/Level-B fence for kind **A**, a *usable but
best-effort* fence for kind **B**, and **no** fence for kind **C**.

Two contract details decide the whole design:

1. **`tools/pre-execute` is a waterfall and is `async`.** A listener may `await ctx.fs.resolve(...)`
   itself and deny on the *canonical* (realpath'd) identity. This is the symlink-safe chokepoint that
   a synchronous `ctx.tools.guard()` cannot provide (`ToolGuard` returns `string | undefined`, not a Promise).
2. **`fs/observed` cannot veto; `fs/write-intent` / `fs/edit-intent` can.** There is **no** resolved-target
   veto event for reads. Mutations have one; reads do not.

---

## 1. Tool execution pipeline — the exact interception contract

All from `packages/core/tools/src/index.ts`.

### 1.1 Event declarations (`declare module '@deepseek-ai/cordis'`, lines 137–210)

```ts
// :153
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
// :164
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
// :176
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
// :190
'tools/ptc-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
// :198
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
// :208
'tools/change'(): void
```

Modes: `:151` `@mode waterfall` (pre-execute), `:162` waterfall (execute), `:174` waterfall
(post-execute), `:188` waterfall (ptc-dispatch-log), `:196` `@mode emit` (result), `:206` emit (change).

Docblock facts verbatim:

- pre-execute (`:143–152`): *"Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow;
  `cancel` selects the canonical pre-dispatch cancellation result, and missing approval support turns
  `ask` into denial. Async gates must observe `exec.signal`; the registry rechecks cancellation after
  they settle but never abandons their promise. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
  agent-scoped listeners receive only that agent's calls."*
- execute (`:154–163`): *"Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns a
  normalized result; wrappers may change only `exec.signal`, while call identity remains immutable."*
- post-execute (`:165–175`): *"Accept, replace, enrich, or block a normalized dispatch result. `next()`
  accepts it unchanged; thrown tools still reach this waterfall as errors."*

### 1.2 `ToolGuard` (lines 723–731) — verbatim

```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

**Synchronous by type.** It cannot await `ctx.fs.resolve`. It sees the frozen arguments.

### 1.3 `PreToolDecision` (lines 598–611) — verbatim

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }
```

Docblock (`:598–606`): *"Input rewriting is excluded because arguments are already logged and
presented."* → **a pre-execute listener cannot rewrite `read({file_path: ...})` into a different path.**
Deny or allow only.

### 1.4 `PostToolDecision` (lines 613–620) — verbatim

```ts
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

**Post-execute CAN replace result content, and CAN replace the canonical `value`.** It cannot replace both
(enforced at `:1796–1798`: `throw new TypeError('tools/post-execute accept decision cannot replace both value and content')`),
and `value` replacement is rejected for a failed result (`:1803–1806`).

### 1.5 `ToolExecutionInput` / `ToolExecution` (lines 321–398) — verbatim

```ts
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  readonly rootCallId?: ToolCallId
  readonly name: string
  readonly schema?: ToolSchema
  readonly arguments: unknown      // :337 "Losslessly JSON-serializable parsed arguments"
  readonly agent?: Agent           // :339
  readonly parent?: ToolExecutionToken  // :349
  readonly signal: AbortSignal     // :351
}

export interface ToolExecution extends ToolExecutionInput {
  readonly rootCallId: ToolCallId
  readonly token: ToolExecutionToken
}
```

`ToolExecutionToken` (`:319`): `export type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }`.

### 1.6 `ToolRunContext` (lines 418–435) — verbatim

```ts
export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void
  concludeTurn(): void
}
```

### 1.7 `ToolExecutionResult` (lines 571–596) — verbatim

```ts
export interface ToolExecutionSuccess {
  readonly isError: false
  readonly value: JsonValue          // :575 "Execution-local canonical value; deliberately omitted from durable events."
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}

export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

`ToolFailure` (`:497–502`), `ToolErrorInfo` (`:489–494`):
```ts
export interface ToolErrorInfo { name: string; code: string; reason?: string }
export interface ToolFailure { message: string; info?: ToolErrorInfo }
```

**Consequence for redaction:** a post-execute listener has direct read access to `result.value` (the
canonical, structured, *untruncated* value — e.g. every grep match before the inline cap). Returning
`{ kind: 'accept', value: <redactedValue> }` re-runs `tool.output.render` **and**
`tool.output.presentationMeta` (`:1832–1862`, esp. `:1839` and `:1845–1853`), so **both** the
model-facing text and the UI/durable `meta` are recomputed from the redacted value. Returning
`{ kind: 'accept', content: [...] }` replaces only the text and leaves `meta` intact — i.e. the
durable log + UI card still carry the original match text. **Use `value`, not `content`, to redact.**

### 1.8 Pipeline order (verbatim call sites)

`createExecution` (`:1391–1481`), argument materialization:

```ts
// :1441-1445
const detached = snapshotJsonValue(exec.arguments)
if (detached === undefined) throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
```

So **yes, a pre-execute listener and a guard see settled, deep-frozen, lossless-JSON arguments**
(`scoped.spec.ts:404` asserts `Object.isFrozen(exec.arguments) === true`). A malformed-argument call is
turned into a `final-result` *before* the waterfall (`:1476–1480`) — it never reaches pre-execute and
never reaches the body, so the fail-closed direction is correct.

`prepareExecution` (`:1493–1539`) — ordering of the three deny channels:

```ts
// :1504-1508
const carrier = scopeTarget(this, exec.agent)
const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
// :1509-1511
const askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false }
// :1516-1518
if (decision.kind === 'cancel') return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
// :1519-1520
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
const denialInfo   = decision.kind === 'deny' ? decision.info : undefined
// :1521-1531
if (denialReason !== undefined) {
  return await next({ kind: 'post-result', exec, result: this.materializeFinalResult({
    content: [{ type: 'text', text: `Error: ${denialReason}` }],
    isError: true,
    error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
  })})
}
```

Exact order: **pre-execute waterfall → (ask → approval) → `guardReason` → caller-cancellation recheck → body.**
Guards run **after** and therefore cannot be out-voted by a later pre-execute listener. A denial is
delivered to the model as the literal text `` Error: <reason> `` — so a denial reason must not encode
whether the path exists (an existence oracle).

`guardReason` (`:1144–1154`):

```ts
private guardReason(exec: ToolExecution): string | undefined {
  const globalReason = this.layers.global.guardReason(exec)
  if (globalReason !== undefined) return globalReason
  if (exec.agent === undefined) return undefined
  for (const layer of this.layers.chainLayers(exec.agent)) {
    const reason = layer.guardReason(exec)
    if (reason !== undefined) return reason
  }
  return undefined
}
```

Global layer first, then the agent's chain farthest-ancestor-first. `ToolLayer.guardReason`
(`:766–773`) returns the first non-`undefined` reason; there is no allow path.

`dispatchScheduledExecution` (`:1601–1631`) → `tools/execute` waterfall → `dispatchToolBody`
(`:1564–1592`) → `tool.execute(exec.arguments, exec)` at `:1581`.

`finalizeScheduledExecution` (`:1641–1659`) — **post-execute runs before the tool's own
`finalizeContent`**:

```ts
const project = this.contentProjectors.get(exec)          // :1643  tool projectContent
const content = project?.(exec, result)                   // :1645
const projected = content === undefined ? result : this.markCanonical(exec, this.materializeFinalResult({ ...result, content }))
const postResult = await this.postExecute(exec, projected) // :1649  tools/post-execute
return this.finishScheduledExecution(exec, postResult)     // :1650
```
and `finishScheduledExecution` (`:1669–1684`) → `materializeFinalResult` → `applyFinalContent`
(`:1687–1692`, the tool's `finalizeContent`) → `materializeFinalResult` → `notifyResult` (`:1695–1714`).

**Residual:** a tool that declares `finalizeContent` can overwrite a post-execute redaction. Audit
result (`finalizeContent` / `projectContent` declared anywhere):
`packages/jobs/tool-jobs/src/index.ts:225,320,378`, `packages/terminal/tool-terminal/src/index.ts:153,171,210,309,341,365,394`,
`packages/mcp/mcp-client/src/tools.ts:237`. **None of `read`, `write`, `edit`, `read_image`,
`str_replace_editor`, `grep`, `glob` declare either** — so for the file-content tools, post-execute
redaction is final.

`postExecute` (`:1781–1820`) — the three decision arms applied:
`:1787` block → `isError` with `feedback`; `:1803` accept-with-value → `createSuccessResult(exec, tool, decision.value)`
(re-render + re-project `meta`); `:1815` accept → `{ ...result, ...decision.content !== undefined ? { content: decision.content } : {} }`.

`materializeFinalResult` (`:1886–1901`) — strips `value` out of the durable projection:
```ts
const presentation = { content: result.content, ...result.meta !== undefined ? { meta: result.meta } : {}, ... }
```
so `{ content, meta }` are persisted on `tool/result`; **`value` is not** ("deliberately omitted from
durable events", `:575`). Consequence: replacing `value` in post-execute keeps the durable log clean as
well — another reason to prefer `value` replacement over `content` replacement.

### 1.9 `ctx.tools.guard()` registration (lines 1126–1142) — verbatim

```ts
  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.guards.append(guard),
      { label: 'tools.guard()', notify: false },
    )
  }
```

`register` (`:1063–1088`), `restrict` (`:1097–1124`) — `restrict()` throws unless called on a **scoped**
context (`:1099–1101`: *"a context-global restriction would mask every agent"*). A new plugin therefore
**cannot** use `restrict()` to remove `bash`/`grep`/`run_code` globally; it must use `guard()` or
`tools/pre-execute`. It **can** deny by name from a global `guard()`, which is strictly stronger.

### 1.10 Cordis waterfall / prepend semantics (needed for ordering guarantees)

`vendor/cordis/src/events.ts`:

```ts
// :111-117
export interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  global?: boolean
}
// :224-243
  /**
   * Compose listeners around the final `next` callback.
   * The last dispatch argument is treated as the innermost `next`. Listeners
   * run outermost-first; a listener that does not call `next()` vetoes the
   * rest of the chain, including the built-in behavior.
   */
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }
    args.push(next)
    return next()
  }
// :254-255  register(): const method = options.prepend ? 'unshift' : 'push'
```

**`prepend: true` ⇒ `unshift` ⇒ outermost ⇒ its post-`next()` code runs last and its return value wins.**
For post-execute redaction a path-guard MUST register with `{ prepend: true }` so no later listener
(including `spill-policy`, which itself uses `{ prepend: true }` at
`packages/spill/spill-policy/src/index.ts:150`) can re-inflate the result. Precedent for both orderings:
`spill-policy` prepends; `guard/repeat-tool-reminder` and `guard/timeout-policy` append.

### 1.11 Scope-filtered dispatch — do global listeners see subagent calls? **YES**

`packages/core/scope/src/index.ts:158–185`:

```ts
/**
 * Build an opaque receiver that preserves the base filter, admits untagged
 * listeners globally, and admits tagged listeners for a matching key or any
 * of its ancestors (`bindScopeParent`): a listener owned by an enclosing
 * scope receives every descendant scope's events, which is what lets one
 * standing composition observe each of the agents composed under it. A tag
 * BELOW the dispatch key stays excluded — events flow up the chain, never down.
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = ...
  const carrier = { [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)
      if (tag === undefined) return true          // <-- line 176: untagged (global) listeners see everything
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
  }}
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}
```

`packages/core/scope/src/scoped-events.generated.ts:32–36` routes `tools/pre-execute`, `tools/execute`,
`tools/post-execute`, `tools/ptc-dispatch-log`, `tools/result` on `args[0]['agent']`.

Same for guards: `ToolRuntime.guardReason` consults `this.layers.global` unconditionally (`:1146`), and
the layer store is a single `ScopedLayers` instance on the one `ToolRuntime` service (`:833–836`).

---

## 2. Every model-facing tool that can touch the filesystem

Registered names verified against the generated `docs/tool-catalog.md` (lines 18–47, the
"Tool Package Map" table) and the `defineTool({ name: ... })` sites.

### 2.1 Via `ctx.fs` — kind A

| Name | Registering package | Register site | Path/glob/cwd fields | I/O path |
| --- | --- | --- | --- | --- |
| `read` | `@deepseek-ai/dsh-tool-fs` | `packages/fs/tool-fs/src/read.ts:77` (name at `:78`) | `file_path: string` (required), `offset: number`, `limit: number` | `read-target.ts:24` `ctx.fs.resolve` → `:25` `ctx.fs.stat` → `read.ts:146` `ctx.fs.streamText` / `:147` `ctx.fs.readText` |
| `write` | same | `packages/fs/tool-fs/src/write.ts:72` (name `:73`) | `file_path: string` (required), `content: string` (required), `sandbox_permissions?: string`, `justification?: string` (only when `ctx.fs.sandboxMode !== undefined`) | `write.ts:112` `ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, sandboxPolicy?.workspaceRoot))` → `:115` `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` → `:118` `ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)` |
| `edit` | same | `packages/fs/tool-fs/src/edit.ts:84` (name `:85`) | `file_path`, `old_string`, `new_string`, `replace_all?: boolean`, + escalation pair | `edit.ts:118` `ctx.fs.resolve` → `:127` `ctx.waterfall('fs/edit-intent', ...)` → `:128` `ctx.fs.editText` |
| `read_image` | same | `packages/fs/tool-fs/src/read-image.ts:209` (name `:210`) | `file_path: string` (required) | `read-image.ts:258` `resolveRegularReadTarget` → `:263` `ctx.fs.readBytes(target, exec.signal, byteCap)` → `:273` `attachments.saveImage(...)` |
| `str_replace_editor` | `@deepseek-ai/dsh-tool-str-replace-editor` | `packages/fs/tool-str-replace-editor/src/index.ts:429` (name `:430`) | `command` enum `view\|create\|str_replace\|insert` (required), `path` (required, **absolute only** — `:96–98` rejects relative), `file_text`, `insert_line`, `new_str`, `old_str`, `view_range` | `:99` `ctx.fs.resolve(path, { signal })`; `:108` `stat`; `:194` `ctx.fs.listDir` (recursive `view` of a directory, `:193–207`, filters `.`-prefixed names, `node_modules`, `__pycache__`); `:236` `readText`; `:262` / `:314` / `:364` `writeText` |
| `present` | `@deepseek-ai/dsh-tool-present` | `packages/deliverables/tool-present/src/index.ts:38` (name `:39`) | `files: [{ path: string (required), description?: string }]` | `:87` `ctx.fs.lstat(file.path, { cwd }, exec.signal)`; `:89` `ctx.fs.resolve`; `:90` `ctx.fs.stat`. Metadata only — no content. `cwd = exec.agent.session.header.cwd` (`:81`) |
| `lsp` | `@deepseek-ai/dsh-tool-lsp` | `packages/lsp/tool-lsp/src/index.ts:109` (name `:110`) | `operation` enum, `file_path: string` (required, "relative to the workspace or absolute"), `line`, `character` | Indirect: `ctx.lsp` → `packages/lsp/lsp-stdio/src/index.ts:47` `inject = ['fs','lsp','subprocess']`, `:154` passes `ctx.fs` into the host; **and spawns a language server process** (`ctx.subprocess`) that reads the workspace itself |

Argument schemas verbatim (tool-catalog `parameters`, cross-checked against the `parameters:` blocks):

```ts
// read.ts:80-84
parameters: {
  file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
  offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
  limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
},
// read-image.ts (per docs/tool-catalog.md:1017-1029)
parameters: { file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' } }
```

`sessionResolveOptions` — the shared cwd convention (`packages/fs/tool-fs/src/session-cwd.ts:27–36`):

```ts
export function sessionResolveOptions(
  exec: ToolExecution,
  policyWorkspaceRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = policyWorkspaceRoot ?? sessionCwd(exec)
  return { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal }
}
```
with `sessionCwd` at `:17–19` = `exec.agent?.session.header.cwd`.

### 2.2 Spawn-backed discovery — kind B (does **not** use `ctx.fs`)

`packages/fs/tool-fs-search/src/index.ts:70`:

```ts
export const inject = ['tools', 'systemPrompt', 'subprocess']
```
— deliberately **not** `fs`, stated at `index.ts:7–19` ("## Spawn-backed, not a `ctx.fs` provider method …
these tools execute through `ctx.subprocess.spawn()` with fixed ripgrep argv templates — never `ctx.shell`").

| Name | Register site | Argument schema (verbatim from `grep.ts:288–292` / `glob.ts`) | Result content |
| --- | --- | --- | --- |
| `grep` | `packages/fs/tool-fs-search/src/grep.ts:285` | `pattern: string` (required, "ripgrep syntax"), `path?: string` ("File or directory to search. Defaults to the session workspace; a relative path resolves against it."), `include?: string` ("One glob filter … Not a list; negation is not supported.") | **matched line text** — `grep.ts:306–309` output schema `{ path, lineNumber, line }`; `:328–332` builds each `line` from raw `rg` stdout |
| `glob` | `packages/fs/tool-fs-search/src/glob.ts:307` | `pattern: string` (required), `path?: string` ("Directory to search in. Defaults to the session workspace") | **file paths only**, no content (`glob.ts:345` `toWorkdirRelative(line, run.workdir)`) |

The spawn (`packages/fs/tool-fs-search/src/search-core.ts:222–248`):

```ts
export async function runRipgrep(
  ctx: Context, exec: ToolExecution, toolName: string, argv: readonly string[],
  rawOutputMaxBytes: number, graceMs: number, stderrMaxBytes: number,
): Promise<RipgrepRun> {
  if (exec.signal.aborted) { throw new SearchError(...) }
  const cwd = exec.agent?.session.header.cwd
  const workdir = cwd ?? process.cwd()
  handle = ctx.subprocess.spawn({
    argv: [await resolveRgPath(), '--no-config', ...argv],
    cwd: workdir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: rawOutputMaxBytes }, stderr: { maxBytes: stderrMaxBytes } },
    graceMs, signal: exec.signal,
  } satisfies SubprocessSpawnSpec)
```

The glob argv (`glob.ts:89–107`):

```ts
export function buildGlobCommand(input: GlobInput): string[] {
  const parts = [
    '--files',
    `--glob=${input.pattern}`,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    ...GLOB_VCS_EXCLUDES.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
  ]
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}
```

Four consequences that matter for a fence:

1. **No `ctx.sandbox.confine()` call anywhere on this path.** Under `danger-full-access` — and, notably,
   under every mode — `grep`/`glob` run **unconfined**. The sandbox service is never consulted
   (`search-core.ts` has no `sandboxPolicy` reference).
2. `--no-ignore --hidden` means **hidden files are searched and listed**; only `GLOB_VCS_EXCLUDES`
   (`glob.ts:29–31`) is excluded — VCS metadata, not `.ssh`, `.aws`, `.env`.
3. A workdir-relative `path` is not confined either: `parts.push('--', input.path)` accepts `..\..\Users`
   or an absolute path.
4. `SEARCH_META_MAX_BYTES = 65_536` (`search-core.ts:65`) caps the persisted `meta`; the *matched line
   text* is in both `content` and `meta`.

`grep`'s own post-execute listener (`grep.ts:342–365`) prepends nothing and appends a spill notice; it
bails out of its own re-projection when a downstream decision replaced either projection —
`packages/fs/tool-fs-search/src/direct-call.ts:24–26`:

```ts
  if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.parent !== undefined || exec.name !== tool.name || result.isError
    || ctx.tools.get(exec.name, exec.agent) !== tool) return undefined
  return result.value
```
so a `{ kind: 'accept', value }` redaction from an outer (prepended) listener suppresses the spill path too.

### 2.3 Shell / process tools — kind C

| Name | Package | Register site | Fields | Path to execution |
| --- | --- | --- | --- | --- |
| `bash` | `@deepseek-ai/dsh-tool-bash` | `packages/shell/tool-bash/src/index.ts:371` (name `:372`) | `command: string` (required), `description: string` (required), `timeoutMs?: number`, `workdir?: string`, `run_in_background?: boolean`, + escalation pair | `:507` / `:515` / `:524` `ctx.shell.execute(ctx.shell.resolve({...request, signal: exec.signal}))`; request built at `:490–496` with `sandboxPolicy` at `:495` |
| `pwsh` | `@deepseek-ai/dsh-tool-pwsh` | `packages/shell/tool-pwsh/src/index.ts` | same shape, PowerShell dialect | same `ctx.shell` seam |
| `bash` (persistent) | `@deepseek-ai/dsh-tool-bash-persistent` | `packages/shell/tool-bash-persistent/src/index.ts:413` | `command: string` (required) only | `ctx.terminals` PTY; state persists across calls |
| `pwsh` (persistent) | `@deepseek-ai/dsh-tool-pwsh-persistent` | `packages/shell/tool-pwsh-persistent/src/index.ts:425` | `command: string` (required) only | `ctx.terminals` PTY |
| `terminal_open` | `@deepseek-ai/dsh-tool-terminal` | `packages/terminal/tool-terminal/src/index.ts:163` | `type: string` (required), `name?: string`, `cwd?: string` | `:185` `ctx.terminals.spawn(...)` |
| `terminal_send` | same | `:198` | `sessionId: string` (required), `text: string` (required), `submit?: boolean`, `run_in_background?: boolean` | `:264` / `:280` `ctx.terminals.startSend(...)` |
| `terminal_read` | same | `:302` | `sessionId`, offsets/count | `:325` `ctx.terminals.read(...)` |
| `terminal_signal` | same | `:335` | `sessionId`, `signal` | `:354` |
| `terminal_close` | same | `:360` | `sessionId` | `:384` |
| `terminal_list` | same | `:391` | `{}` | `:400` |
| `run_code` | `@deepseek-ai/dsh-tools` (reserved transport) | `packages/core/tools/src/ptc.ts:336` (`RUN_CODE_NAME = 'run_code'` at `:30`) | `code: string` (required), `description: string` (required), `timeoutMs?`, `sandbox_permissions?` (only when the runtime confines), `justification?` | see §5.3 — the program is a **real Node/Python process** |
| `job_output` / `job_list` / `job_kill` | `@deepseek-ai/dsh-tool-jobs` | `packages/jobs/tool-jobs/src/index.ts:310,351,371` | job ids; `finalizeContent` at `:225` truncates output | Can carry the stdout of a backgrounded shell command |
| `mcp__<server>__<rawName>` | `@deepseek-ai/dsh-mcp-client` (one plugin per server) | `packages/mcp/mcp-client/src/tools.ts:150` `disposers.set(publicName, ctx.tools.register(definition))`; naming at `:82` ``const joined = `mcp__${serverName}__${rawName}` `` | **arbitrary JSON Schema supplied by the MCP server** | The server process does its own I/O. An `mcp__filesystem__read_file` server (`packages/mcp/mcp-client/tests/mcp-client.e2e.ts:418–450`) is a complete bypass |
| `read_mcp_resource`, `list_mcp_resources`, `list_mcp_resource_templates` | `@deepseek-ai/dsh-mcp-resources` | `packages/mcp/mcp-resources/src/tools.ts:33,42,51` | `server`, `uri` / `cursor` | Resource URI fetched from the MCP server |
| `cua_driver_native__<tool>` | `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | `packages/experimental/computer-use-cua-driver-native/src/index.ts:117` `inner.tools.register(definition)`; name at `:97` ``const publicName = `cua_driver_native__${tool.name}` `` | driven by the native driver's catalog (`:93` `activeDriver.listToolsJson`) | Screen/keyboard/mouse control of the desktop — can read any file the user can via a GUI |
| `stagehand_*` | `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | `packages/experimental/browser-use-stagehand-native/src/index.ts` | `pageId`, `instruction`, `url`, … | Browser rendering; `file:` URLs are a plausible read channel |

### 2.4 Content-ingestion surfaces (no tool call required)

These read the filesystem **without any model tool call**, so no `tools/*` fence can see them:

| Surface | Site | What it reads | Seam |
| --- | --- | --- | --- |
| Instruction files → system prompt | `packages/context/agent-instructions/src/index.ts:119` `const fileSystem = ctx.get('fs')`; discovery/reads in `files.ts` | `AGENTS.md`, `CLAUDE.md`, user-global `~/.agents/AGENTS.md`, from `cwd` up to the project root | `ctx.fs` **when present**; `files.ts:146` `fileSystem === undefined ? nodeStatFile(...) : fsStatFile(...)` and `:330` `createReadStream(path, { encoding: 'utf8', signal })` — a **raw `node:fs` fallback** |
| Skill bodies → model context | `packages/skill/skill-filesystem/src/index.ts:843` `return ctx.get('fs')`; `:769–770` `resolve`+`listDir`; `:885` `readText` | skill directories, `customSkillDirs`, bundled skills | `ctx.get('fs')` — **bypasses the `internal/get` waterfall** (see §3.3) |
| `@file` autocomplete index | `packages/context/file-reference-local/src/search.ts:9` `import { lstat, readdir } from 'node:fs/promises'`; `:201–232` `scanWorkspace` | whole workspace tree, path names only, up to `maxEntries` (default 50 000) | **raw `node:fs/promises`**, no `ctx.fs` at all. Host/GUI-facing (feeds the Web composer), not model-facing |
| Hooks → model context | `packages/hooks/hooks-claude-code/src/index.ts:169` `await runHook(ctx.shell, hook, {...})`; `:198` `contextFrom(merged)` | operator-configured hook commands, output folded into `additionalContext` | **`ctx.shell` directly** — not a tool call, so `tools/pre-execute` never sees it |
| Session history full-text search | `packages/session-query/tool-session-query/src/index.ts:66–113` (`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`) | prior session logs, verbatim event text | Session store. **A residual content leak: anything ever logged (by shell before the fence, or by a since-tightened rule) is retrievable** |

`docs/tool-catalog.md` scope note (`:10`): the catalog globs `packages/*/tool-*`, so MCP server tools,
computer-use tools, and plugin internal shell use are *outside* its completeness guard — the list above
supersedes the catalog for security purposes.

---

## 3. The `FileSystem` service — the one read/write seam for kind A

### 3.1 Complete abstract surface, verbatim signatures

`packages/fs/fs/src/index.ts`, `export abstract class FileSystem extends Service` (`:87`),
constructor `super(ctx, 'fs')` (`:89`).

```ts
// :100  (concrete default, not abstract)
watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
// :119  (concrete default, not abstract)
get sandboxMode(): SandboxMode | undefined
// :132
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
// :142
abstract processPath(target: FsTarget): string
// :152  (concrete default)
processPathFromHostPath(hostPath: string): string | undefined
// :164
abstract fileUrl(target: FsTarget): string
// :173
abstract contains(parent: FsTarget, child: FsTarget): boolean
// :181
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
// :197
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
// :205
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
// :216
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
// :228
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
// :243
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
// :252
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
// :266-272
abstract writeText(
  target: FsTarget,
  content: string,
  expected?: FsWriteIntent,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<FsWriteOutcome>
// :287-293
abstract editText(
  target: FsTarget,
  edit: FsEditRequest,
  expected?: { version: FsVersion },
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<FsEditOutcome>
```

Declared context member: `:46–48`
```ts
  interface Context {
    fs: FileSystem
  }
```
There is **no** `delete`/`rm`/`mkdir`/`rename`/`copy` on the seam. Session-deletion-style filesystem
mutation is simply not part of this service.

**Confirmed:** `readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`, `stat`, `lstat`,
`writeText`, `editText`, `watch` all route through this one `ctx.fs` service. Verified at the
consumer side: `read.ts:146–147`, `read-image.ts:263`, `read-target.ts:24–25`,
`write.ts:112,118`, `edit.ts:118,128`, `tool-str-replace-editor/src/index.ts:99,108,194,236,262,314,364`,
`tool-present/src/index.ts:87,89,90`.

`packages/fs/fs-local/src/index.ts` implements them over `node:fs` via `./fsio.ts`
(`:25–41` import list; `resolveLocalTarget` used at `:135`). Crucially, the class docblock says
(`:62–67`):

> *"The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
> (a resolution default, NOT a containment boundary — see the filesystem capability-seam Agent Note);
> enforce containment with a stricter backend or a `tools/execute` permission plugin."*

That is the harness authors naming this exact plugin as the sanctioned enforcement point.

`LocalFileSystem.resolve` (`:133–138`) → `resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)`
— realpath-derived `targetKey` (`:2–4` docblock: *"Realpath-derived target identity makes aliases share
stale guards"*). `processPath` (`:140–142`) returns `String(target.targetKey)` — i.e. for the local
backend `targetKey` **is** the canonical absolute path. `contains` (`:152–155`) is `path.relative`-based.
`lstat` (`:165–173`) uses `probeNoFollow` on `localDisplayPath(cwd, path)` — the *one* path-shaped
probe that does not follow a final-component symlink.

### 3.2 `FsTarget` / `FsDirEntry` / `FsInfo` — verbatim (`packages/fs/fs/src/types.ts`)

```ts
// :16
export type FsTargetKey = Branded<'FsTargetKey'>
// :35
export type FsVersion = Branded<'FsVersion'>

// :52-54
export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }

// :60-68
export interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}

// :76-83
export interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

// :91-98
export interface FsPathInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

// :104-115
export interface FsDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  type: 'file' | 'directory' | 'other'
  /** Resolved child target for follow-up operations. */
  target: FsTarget
  version?: FsVersion
  size?: number
}

// :123-125
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

// :128-144
export interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
  before: string | null
  after: string
}

// :147-154
export interface FsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

// :157-168
export interface FsEditOutcome { version: FsVersion; before: string; after: string }

// :175-188
export type FsErrorCode =
  | 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

// :196-202
export class FsError extends HarnessError {
  override readonly code: FsErrorCode
  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) { ... }
}
```

Note: `FsTarget.targetKey` is documented as opaque — *"Consumers MUST NOT parse it or assume it is a
local absolute path"* (`:11–15`). A deny-list must therefore compare via `processPath()` (which local
backends document as the OS-openable path, `index.ts:134–142`) or `contains()` (`index.ts:166–173`),
never by string-matching `targetKey` directly. `contains(parent, child)` is the supported containment
predicate: *"Both targets must come from this provider."*

### 3.3 Every consumer of `ctx.fs` — AI-facing vs Host/GUI-facing

`ctx.fs` (property access) and `ctx.get('fs')` are **not** the same read path — see §3.4. Consumers:

**AI-facing (reachable from a model tool call):**

| Consumer | Site | Notes |
| --- | --- | --- |
| `tool-fs` (`read`/`write`/`edit`/`read_image`) | `read.ts:146,147,163`; `read-target.ts:24,25,27`; `write.ts:112,118,125`; `edit.ts:118,127,128,141`; `read-image.ts:263`; `sandbox.ts:44` | All mutations + reads |
| `tool-fs-search` | none | injects `subprocess`, not `fs` (`index.ts:70`) |
| `tool-str-replace-editor` | `index.ts:71,72,99,108,194,236,251,262,296,314,347,364`; `inject` at `:503` | `view` lists directories recursively |
| `tool-present` | `index.ts:87,89,90`; `inject` at `:26` | metadata only |
| `lsp-stdio` (behind `tool-lsp`) | `src/index.ts:47` (`inject = ['fs','lsp','subprocess']`), `:154` | reads query sources, and spawns the language server |
| `ssh` helper / `fs-ssh` | `packages/ssh/ssh/src/helper.ts:88,89,100,150,154,155,159,173,214,215,228,232`; `helper-processes.ts:178` | **`ctx.fs` over a wire protocol** — a remote fs backend serving `fs.resolve`/`fs.stat`/`fs.list`/`fs.stream`/`fs.read`/`fs.write`/`fs.edit`. This is the layer that makes a remote execution world possible |
| `spill-policy` | `packages/spill/spill-policy/src/index.ts:82` `ctx.get('fs')`, used at `:84` | only `processPathFromHostPath` for image attachment locators |
| `ptc-runtime-node` | `src/index.ts:53` `static inject = ['fs','subprocess','sandbox','sandboxPolicy']`, `:223` `bootstrapArgs(this.ctx.fs, ...)` | paths handed to the spawned program |

**Host / GUI / system-facing (a `ctx.fs` wrapper would affect these):**

| Consumer | Site | What breaks if you deny here |
| --- | --- | --- |
| `@deepseek-ai/dsh-api-workspace-files` (the Web file API) | `packages/api/workspace-files/src/index.ts:184` `static inject = ['fs','sandboxPolicy','sessions','typert']`; `:268` `readByteRange`, `:273` `readBytes`, `:317` `stat`, `:322` `listDir`, `:324,350` `fileUrl`/`processPath`, `:392–404` `resolve`/`lstat`/`contains`, `:424–446` `resolve`/`stat`/`streamText`; `changes.ts:56,61,67,71,79,97` (`watch`) | The GUI's file tree, viewer, binary/RPC streaming, and the workspace change watcher. **Denying a path here would also blind the human** |
| `@deepseek-ai/dsh-session-controller` | `packages/api/session-controller/src/media-references.ts:64,74` (`serveFile(request, ctx.fs, maxBytes)`) | UI media serving |
| `agent-instructions` | `packages/context/agent-instructions/src/index.ts:119` `ctx.get('fs')` | system-prompt instruction loading |
| `skill-filesystem` | `packages/skill/skill-filesystem/src/index.ts:843` `ctx.get('fs')`; `:769,885,967` | skill discovery/body loading into context |
| `attachment`/image locators | `packages/spill/spill-policy/src/index.ts:82`; `packages/llm/llm/src/index.ts:1024`; `packages/llm/llm-deepseek/src/host.ts:34`; `packages/llm/llm-pi-ai/src/index.ts:219` | all use only `processPathFromHostPath` |
| `document/office-to-pdf` | `packages/document/office-to-pdf/src/index.ts:188` `const fs = this.ctx.get('fs')` | conversion plugin |
| `snapshot-*` scripts | `scripts/snapshot-spill-locators.ts:8,26`; `scripts/session-query-spill-command.spec.ts:54` | build/test tooling |

**Answer to the crux question:** wrapping/denying at the `ctx.fs` layer is **not** a safe universal
fence, for two independent reasons.

1. It is **not additive**. Cordis `provide` refuses a duplicate (`vendor/cordis/src/reflect.ts:289–291`:
   ``if (this.store[key]) throw new Error(`service "${name}" has been registered at <...>`)``), and
   `ctx.set` refuses a cross-fiber write (`:260–262`: `cannot set property "..." in multiple fibers`).
   The only shipped way to swap the backend is a **composition** change — the `fs-sandbox` pattern of
   *extending* `LocalFileSystem` and loading the subclass **instead of** `fs-local`
   (`packages/fs/fs-sandbox/src/index.ts:48–55`, `:55` `export class SandboxedFileSystem extends LocalFileSystem`;
   `packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts:225–232` proves the registration/unregistration).
2. It would **blind the human too** — the Web file API (`api/workspace-files`) and the change watcher
   share the same service. A path-guard at `ctx.fs` must distinguish caller identity, which `ctx.fs`
   method signatures do not carry.

### 3.4 Can a plugin wrap `ctx.fs` additively? Two sub-answers — both "not reliably"

`vendor/cordis/src/reflect.ts`:

```ts
// :135-142  the context proxy get trap
get: (target, prop, ctx: Context) => {
  if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx)
  if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx))   // <-- early return
  ...
// :153-167
  return ctx.events.waterfall('internal/get', ctx, prop, error, () => { ...resolve through fibers... })
```
`internal/get` **is** a declared waterfall extension point (`vendor/cordis/src/events.ts:344–345`:
*"Waterfall: a service is being read through the context proxy."*), so a global listener could return a
wrapping Proxy for `'fs'`. **Three reasons it is not a fence:**

- `:140` early-returns once the property exists on the target — the traceable wrapper installed by
  `provide`/`_checkImpl` shadows the trap. Interception is conditional on context/proxy details.
- `ctx.get('fs')` **bypasses it entirely**: `ctx.get` is the mixin of `ReflectService.get`
  (`reflect.ts:219` `this.mixin('reflect', ['get', ...])`), and `ReflectService.get` reads
  `this._getImpl(name, strict)?.value` directly (`:233–235`) — no waterfall.
  Real consumers on that path: `agent-instructions/src/index.ts:119`, `skill-filesystem/src/index.ts:843`,
  `spill-policy/src/index.ts:82`, `office-to-pdf/src/index.ts:188`, `llm/src/index.ts:1024`,
  `llm-deepseek/src/host.ts:34`, `llm-pi-ai/src/index.ts:219`.
- `ctx.reflect.get('fs')` bypasses it too, as does anything holding a previously resolved reference.

The **only** additive technique that covers all consumers is **monkey-patching the live service instance
methods** (`ctx.fs.readText = ...`, own-property shadowing of the prototype) — exactly what the test
suite does (`packages/fs/tool-str-replace-editor/tests/tools.spec.ts:320` `ctx.fs.listDir = async (...) => {...}`;
`:509` `ctx.fs.stat = async () => ...`). It is technically available to a plugin (the plugin receives the
same instance) but it is unsupported, unmentioned in any public contract, and fragile under HMR; and it
still cannot distinguish AI from GUI callers. **Recommendation: do not build the fence here.**

---

## 4. `fs/*` events — exact payloads and veto semantics

Declarations, `packages/fs/fs/src/index.ts:50–78` (verbatim):

```ts
    /**
     * Single-slot decision for the next {@link FileSystem.writeText}. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision for the next {@link FileSystem.editText}. Calling
     * `next()` yields an unconditional edit; the first returned guard wins.
     * @param target - the resolved target about to be edited.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record an authoritative positive or negative observation. Listeners must
     * be synchronous recorders: throws fail the tool call and returned promises
     * are not awaited.
     * @param target - the target whose presence or absence was observed.
     * @param observation - present with its version, or confirmed absent.
     * @param actor - the observing tool-execution context; undefined records nothing useful.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
```

| Event | Mode | Can veto? | Payload | Call sites |
| --- | --- | --- | --- | --- |
| `fs/write-intent` | **waterfall** | **Yes** — return an intent without calling `next()` (occupies the slot), or **throw** | `(target: FsTarget, actor: object \| undefined, next)`; `target` is the **already-resolved** target; `actor` is the `ToolExecution` | `packages/fs/tool-fs/src/write.ts:115` `const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)` |
| `fs/edit-intent` | **waterfall** | **Yes** — same, and the shipped policy demonstrates throwing to deny | `(target, actor, next)`; `next()` → `undefined` means unconditional edit | `packages/fs/tool-fs/src/edit.ts:127` `const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` |
| `fs/observed` | **emit** | **No** — fire-and-forget, return value ignored, promises not awaited | `(target: FsTarget, observation: FsObservation, actor)` | `read.ts:163`; `read-target.ts:27` (absent); `write.ts:125`; `edit.ts:141`; `tool-str-replace-editor/src/index.ts:110` and its mutation sites |

Throwing from a waterfall listener propagates into the tool's `try`/`catch` and is surfaced through
`remediateFsError` + `sandbox.mapError` (`edit.ts:135–140`, `write.ts:119–124`) and
`packages/fs/tool-fs/src/error.ts:21–34`:

```ts
export function remediateFsError(error: unknown, displayPath: string): unknown {
  if (!(error instanceof FsError)) return error
  if (error.code === 'FS_NOT_OBSERVED') {
    return new FsError(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, error.code, { cause: error })
  }
  if (error.code === 'FS_STALE_VERSION') {
    return new FsError(`${error.message} — re-read the file, then retry`, error.code, { cause: error })
  }
  return error
}
```
So a path-guard that throws `new FsError('...', 'FS_SANDBOX_DENIED')` from `fs/write-intent` /
`fs/edit-intent` gets the same model-facing treatment as a real sandbox denial, **but only when the
mutation came through `tool-fs`**. `str_replace_editor` and `present` do **not** dispatch these
waterfalls — `str_replace_editor` runs its own `MutationPolicy` (`tool-str-replace-editor/src/index.ts:71–72,428`)
and calls `ctx.fs.writeText` directly (`:262`, `:314`, `:364`). **Residual: the intent waterfalls cover
only the `write`/`edit` tools.**

Pinned observation: **there is no `fs/read-intent` and no resolved-target read veto.** Reads reach the
provider with no interception point between `resolve()` and `readText/streamText/readBytes`.
`fs/observed` is deliberately a *post-hoc recorder* — the shipped policy's docblock states it
(`fs-observation-policy/src/index.ts:124–126`): *"`fs/observed` must remain synchronous and non-throwing:
emit does not await promises, and successful mutations have already committed."*

The one shipped policy, `packages/fs/fs-observation-policy/src/index.ts` (130 lines), is the cleanest
waterfall-veto template:

```ts
// :119  fs/write-intent: occupy the single decision slot — do NOT call next().
ctx.on('fs/write-intent', (target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor)))
// :122  fs/edit-intent: occupy the single decision slot — do NOT call next().
ctx.on('fs/edit-intent', (target, actor) => Promise.resolve().then(() => gate.editIntent(target, actor)))
// :127-129
ctx.on('fs/observed', (target, observation, actor) => { gate.observe(target, observation, actor) })
```
Owner derivation (`:36–41`): `(actor as FsObservationActor | undefined)?.agent?.session` — i.e. **the
`actor` object handed to the `fs/*` waterfalls is the `ToolExecution`, and `actor.agent.session` is the
per-session identity key.** No `inject` (`:100–105` docblock: *"No `inject` — this plugin reads no
services; it operates only on its own `WeakMap`"*).

---

## 5. Shell and sandbox

### 5.1 `ctx.shell` — the executor seam

`packages/shell/shell/src/index.ts:64–94`:

```ts
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }

  /** The sandbox mode this executor applies by default, or `undefined` when it does not sandbox commands. */
  get sandboxMode(): SandboxMode | undefined { return undefined }

  /** Apply implementation-owned defaults and caps to a request before execution. */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /** Prepare and spawn the command under its resolved deadline. */
  abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
}
```

Request/spec shapes, `packages/shell/shell/src/types.ts`:

```ts
// :61-104
export interface ShellExecRequest {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  onExpiry?: ShellExpiryPolicy | undefined
  stdoutMaxBytes?: number | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  /** Fully resolved per-call sandbox policy; sandboxing executors default it. */
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}
// :111-137
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  onExpiry: ShellExpiryPolicy
  stdoutMaxBytes: number
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  sandboxPolicy: SandboxExecutionPolicy | undefined
}
```

**`command` is an opaque string.** There is no argv-level interception on the seam: `resolve()` fills
defaults, `execute()` spawns. The tool builds the request at `tool-bash/src/index.ts:490–496`:

```ts
const request: ShellExecRequest = {
  command: args.command,
  ...workdir !== undefined ? { workdir } : {},
  ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
  dshEnv,
  ...policy !== undefined ? { sandboxPolicy: policy } : {},
}
```
and `resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)` (`:488`), whose policy comes
from `sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })` (`:221`).

**Can a plugin intercept the command before execution?** Three candidate points, assessed:

1. **`tools/pre-execute` / `guard` on `bash`/`pwsh`/`terminal_send`.** Sees `exec.arguments.command`.
   Can only allow/deny the whole call. Pattern-matching a shell string is **not** enforcement
   (`cat ~/.ssh/id_rsa`, `$(printf %s …)`, `python -c`, `base64`, a heredoc, `find / -name id_rsa`,
   `git` plumbing, …). Sound only as "deny all shell access".
2. **Wrapping `ctx.shell`.** Same duplicate-service blocker as `ctx.fs` (`reflect.ts:289–291`) — a
   composition change, not a plugin. And `ShellExecRequest.command` is still a string.
3. **`tools/execute` around-dispatch wrapper** (the `timeout-policy` pattern,
   `guard/timeout-policy/src/index.ts:56–80`). The docblock constrains it: *"wrappers may change only
   `exec.signal`, while call identity remains immutable."* It returns a `ToolExecutionResult` for the
   *whole* call, so it can replace the result but cannot pre-empt the spawn.

**Conclusion: the shell surface is not plugin-fenceable. It is sandbox-fenceable only.**

### 5.2 `ctx.sandbox` — argv wrapper, mode + allow-root, **no deny-list**

`packages/sandbox/sandbox/src/index.ts`:

```ts
// :30
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
// :33
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
// :40-53
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  sessionId?: SessionId
}
// :70-73
export interface SandboxPolicy extends SandboxExecutionPolicy { mode: ConfinedSandboxMode }
// :96-117
export interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}
// :159-178
export abstract class SandboxProvider extends Service {
  constructor(ctx: Context) { super(ctx, 'sandbox') }
  abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}
```

`SandboxPolicyService.resolve(...)` is consulted per call by `tool-fs` (`sandbox.ts:89`), `tool-bash`
(`:221`) and `ptc.ts` (`:951`).

**Answer to "can `sandbox-windows-acl` target arbitrary path deny-lists?" — No.** The vocabulary is a
**mode plus a single allow root** (`workspaceRoot`) plus an optional `sessionId`. There is no
`denyPaths`/`readDenyList` field anywhere in the policy shape, and the API is *allow-root* semantics
(`mode: 'read-only'` permits only required sinks; `'workspace-write'` permits the workspace plus a
backend temp area — `:25–29`). Files present and relevant:
`packages/sandbox/sandbox-windows-acl/src/{index,acl,grant,token,spawn,runner,workspace-sid,path-boundary}.ts`.
The Windows backend's enforcement model is a **restricted token + per-workspace SID + ACL grants** the
runner spawns under (`grant.ts`, `workspace-sid.ts`, `token.ts`) — i.e. it makes a *workspace* readable/
writable and everything else denied, which is exactly an allow-list. To deny `.ssh` while allowing the
workspace you would have to grant an ACL that excludes that subtree, which the shipped grant vocabulary
does not express. `packages/sandbox/sandbox-local/src/{index,profiles}.ts` is the bwrap/Landlock/Seatbelt
counterpart (e2e tests at `sandbox-local/tests/{bwrap,landlock,seatbelt}.e2e.ts`).

The same conclusion is stated in `tool-fs`'s own sandbox controller — `packages/fs/tool-fs/src/sandbox.ts:44–49`:

```ts
constructor(private readonly ctx: Context) {
  const defaultMode = ctx.fs.sandboxMode
  this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
  this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && this.policy === undefined) {
    throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  }
}
```
and the escalation path (`:87–108`) can only ever *widen* the mode
(`approveEscalation({ requestedMode, justification, effectiveMode, subject: 'operation' }, ...)`) — a
path-deny fence cannot be built by narrowing it either, since `read-only` denies *all* writes rather
than selected paths.

### 5.3 `run_code` — a real process with raw Node/Python APIs

`packages/ptc-runtime/ptc-runtime-node/src/index.ts`:

```ts
// :51-53
/** Node provider; direct file effects use the same sandbox service as Bash. */
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
// :67-69
  override get executionInstructions(): string {
    return 'Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.'
  }
// :97
  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }
```
So the `run_code` **program body can `await import('node:fs')` and read anything**, fenced only by
`ctx.sandbox.confine`. Under `danger-full-access` it is unrestricted.

`packages/ptc-runtime/ptc-runtime/src/index.ts:128`:
```ts
  get sandboxMode(): SandboxMode | undefined { return undefined }
```
`packages/experimental/ptc-runtime-python/src/index.ts` does **not** override it, and:
```ts
// :1038
if (request.sandboxPolicy !== undefined) throw new Error('dsh-ptc-runtime-python: sandbox policy is unsupported')
// :1046 (docblock)
* Execute a resolved Python program; this experimental provider has no file confinement.
```
`packages/core/tools/src/ptc.ts:122` gates the escalation fields on `runtime.sandboxMode`:
```ts
...runtime.sandboxMode === undefined ? {} : { sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions, ... }
```
and `:391` `const standingPolicy = runtime.sandboxMode === undefined ? undefined : options.resolveSandboxPolicy(exec)`.
So mounting `ptc-runtime-python` yields `run_code` with **no confinement control at all**.

Crucially for the fence design, **nested `run_code` sub-dispatches re-enter the full pipeline**:
`docs/tool-catalog.md:566` — *"bindings … re-enter the complete guarded tool pipeline and link each
nested execution to this outer result."* Confirmed in code: the bridge dispatches through
`ToolRuntime` (`packages/core/tools/src/ptc.ts`, sub-dispatch path) and nested calls arrive at
pre-execute with `exec.parent` set (`index.ts:349`, `:1352` `collapses(name, scope, nested)`), so a guard
sees `exec.name` for every SDK tool call. Guarding `run_code` itself is the only way to stop raw-API access.

### 5.4 `grep`/`glob` are never sandboxed

Restating because it is the least obvious hole: `packages/fs/tool-fs-search/src/search-core.ts:222–248`
calls `ctx.subprocess.spawn` and **never** `ctx.sandbox.confine`. The package does not even `inject`
`'sandbox'` (`index.ts:70`). Under every mode, ripgrep runs with the harness process's own privileges
and `--no-ignore --hidden`.

---

## 6. Subagents, workflows, agent teams — do guards propagate?

**Yes for in-process children; no for out-of-process ones.**

### 6.1 In-process children (default)

- `packages/subagent/subagent/src/child-agent.ts:200–219` `applyChildComposition(childCtx, parent, composition)`:
  ```ts
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  childCtx.systemPrompt.context({ name: 'subagent:delegation', ... text: SUBAGENT_DELEGATION_CONTEXT })
  if (composition.persona !== undefined) { childCtx.systemPrompt.section({ name: 'deployment:persona-prefix', ... }) }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
  ```
  The child's context is a **derived context of the same plugin scope**
  (`packages/core/scope/src/index.ts:137–147` `createScope`: `const fiber = ctx.plugin(scope); const scoped = fiber.ctx.extend({ [kScope]: key })`),
  so `childCtx.tools` resolves to the **same `ToolRuntime` service instance** — the same `layers`
  store (`index.ts:833–836`). Therefore `this.layers.global.guardReason(exec)` (`:1146`) applies to the
  child's calls, and the child's own `restrict()` is an *additional* intersection, never a bypass.
  `ChildComposition.toolFilter?: ToolRestriction` (`:164`) with the doc at
  `packages/subagent/subagent/src/types.ts:188`: *"`tools.restrict()` in the child's creation window: the
  named tools vanish …"*. Note `restrict()` **cannot** name the reserved `run_code` (`index.ts:1111–1113`).
- `subagentDepth` guard (per README/tool description in this very session: *"maxDepth 1"* — my own
  three `subagent` calls at depth 1 were rejected with `Error: subagent depth 2 exceeds maxDepth 1`),
  so depth limits are enforced by the runtime, not by the tool set.
- `packages/experimental/agent-team/src/roster.ts:134` registers `lead`; `tool-agent-team` registers the
  nine team tools (`docs/tool-catalog.md:43`) — all ordinary `tools.register` calls, all in-process.
- `packages/workflow/tool-workflow/src/index.ts:328` (`workflow`) and
  `packages/workflow/tool-ralph/src/index.ts:410` (`ralph`) parent every script child to the calling
  agent (`docs/tool-catalog.md:37,45`: *"a calling Agent (exec.agent parents every fresh round)"*).
  The workflow **script** itself has no filesystem API — the `workflow` tool description states
  *"The script has no filesystem, network, timer, or Node.js APIs; the agents do the work."* — so a
  workflow reaches the filesystem only through its children's tools, which the global guard covers.
- `packages/core/scope/src/scoped-events.generated.ts:31` routes `system-prompt/assemble` by `args[1]['scope']`
  — a prompt section can be per-scope, which is how one would narrow *guidance* per agent (not enforcement).

### 6.2 Out-of-process children — **ungoverned**

`packages/subagent/subagent-claude-code/src/index.ts:113–116`:
```ts
      permissionMode: this.config.permissionMode,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
```
with `:52` (*"`bypassPermissions` explicitly skips permission checks"*) and `:63`
`permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES])`, plus `run.ts:331` `disallowedTools: spec.permissionMode === 'plan' ? ... `.
`packages/subagent/subagent-codex/src/wire.ts:605` returns `{ permissions: {}, scope: 'turn' }`.
`packages/subagent/subagent-acp/`, `packages/subagent/subagent-dsh-sdk/` likewise delegate to a foreign
agent loop.

These children hold **their own tool registries and their own filesystem access**. A DSH
`tools/pre-execute` listener never runs for them. The only lever is denying the `subagent` tool
(externally named `subagent` / `subagent_fork`, `docs/tool-catalog.md:40`) or fencing the child process
at the OS level.

### 6.3 MCP and computer-use tools

Both register ordinary `ctx.tools` entries (`mcp-client/src/tools.ts:150`;
`computer-use-cua-driver-native/src/index.ts:117`), so a global guard **does** see the calls and can deny
them **by name** (`mcp__filesystem__*`, `cua_driver_native__*`). It cannot inspect their arguments
generically — schemas are server/driver-supplied (`:107` `inputSchema: tool.inputSchema`).

### 6.4 Hooks

`packages/hooks/hooks-claude-code/src/index.ts:169` runs hook commands through `ctx.shell` **inside the
plugin**, not via a tool call, so `tools/pre-execute` never sees them; `:198` `contextFrom(merged)` folds
their `additionalContext` into the model's next request. Operator-configured, not model-invocable — but
it is a real, unguarded shell surface.
`packages/hooks/hook-protocol/src/runner.ts` owns the execution; `hooks-codex` mirrors it.

---

## 7. Precedent plugins — templates for a `ctx.tools.guard` plugin

### 7.1 `fs-observation-policy` — the `fs/*` watermark veto template

`packages/fs/fs-observation-policy/` = `src/index.ts` (130 lines), `src/types.ts`.
No `inject`, no service, no Config — pure event listeners, private `WeakMap` state, `ctx.effect`
teardown that clears the map for HMR (`:109–114`). Full registration quoted in §4. This is the exact
shape for a resolved-target **mutation** fence.

### 7.2 `guard/repeat-tool-reminder` — advisory `tools/post-execute` enricher

`packages/guard/repeat-tool-reminder/src/index.ts` (240 lines). Config verbatim (`:52–57`):

```ts
export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
})
```
Listener (`:220–231`):
```ts
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return { ...downstream, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
  })
```
Relevant idioms to copy: **`await next()` first, then enrich the downstream decision** (this is how you
compose without stealing the decision); `argumentsPreviewChars` for bounding model-visible text;
`wildcardToRegExp` (`:115–118`) for path-glob → RegExp compilation (`*`-only wildcards, everything else
escaped) — directly reusable for a path deny-list; the "cannot rewrite, only enrich" design note at
`:1–7`. Also note the deliberate *absence* of `{ prepend: true }` here (advisory ⇒ innermost is fine).

### 7.3 `guard/timeout-policy` — the `tools/execute` wrapper template

`packages/guard/timeout-policy/src/index.ts` (81 lines). `:31` `export const inject = ['tools']`.
`:56–80`:
```ts
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    if (timeoutMs === undefined) return next()
    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) return toolTimeoutResult(timeoutMs)
      return result
    } finally { exec.signal = upstream }
  })
```
Shows the contract: swap `exec.signal`, delegate, **restore**, and return a *replacement*
`ToolExecutionResult` with a package-owned structured code (`:25` `export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'`;
`:41–48` builds `{ content, isError: true, error: { message, info: { name, code } } }`).

### 7.4 `spill-policy` — the outermost-post-execute-redactor template

`packages/spill/spill-policy/src/index.ts:133–150`:
```ts
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.name === 'read') return decision
    ...
    return { kind: 'accept', content: retained, ...additionalContexts.length > 0 ? { additionalContexts } : {} }
  }, { prepend: true })
```
Three reusable lessons: (1) `{ prepend: true }` for the last word; (2) `Object.hasOwn(decision, 'value')`
to defer to a listener that already replaced the value — a path-guard redactor must do the same for
`content`; (3) `exec.name === 'read'` is a shipped special case — the list of "tools whose content must
never be re-shaped" is currently maintained ad hoc, which a path-guard would need to own centrally.
Also `:152–155` shows the PTC log-only variant on `tools/ptc-dispatch-log`.

### 7.5 `fs-sandbox` — the composition-level backend-replacement template

`packages/fs/fs-sandbox/src/index.ts` (147 lines). `:55` `export class SandboxedFileSystem extends LocalFileSystem`;
`:56` `static inject = ['sandboxPolicy']`; `:80–88` / `:101–109` override `writeText`/`editText` to run
`checkedTarget` then `super.*`; `:122–144`:
```ts
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') { throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED') }
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) { if (await isPathUnder(fresh.targetKey, root)) { contained = true; break } }
    if (!contained) { throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED') }
    return fresh
  }
```
Its docblock names the residual honestly (`:10–18`): *"The fence is a policy check in TRUSTED code over a
MODEL-CONTROLLED path, NOT a kernel boundary … The residual TOCTOU (an ancestor symlink swapped between
the containment re-check and the syscall) is narrowed by re-canonicalizing immediately before delegating
and is accepted for this threat model."* — **the same accepted TOCTOU applies to a pre-execute
re-resolve fence.** And `:48–53`: *"Registers as `ctx.fs` (loading it INSTEAD OF `dsh-fs-local`, together
with a `ctx.sandboxPolicy`, is the whole swap — the model-facing tools are untouched)."* This is the
**only** shipped mechanism for a path-level read fence at the service layer.

### 7.6 How a new plugin gets mounted

Bundle patches are Loader YAML. Example structure (`packages/bundle/web-app/cordis.patch.yml:44–52`):
```yaml
- insert:
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
```
with override-by-id rows (`:16–38`) and a documented layering order (`:1–12`): *"Applied after dsh-base's
insert; rows here override base rows by id, with the profile's own `cordis.patch.yml` and any `--patch`
overlays still to come."* Bundle variants: `packages/bundle/{base,acp-app,headless,sdk-app,sdk-minimal,web-app}/cordis.patch.yml`,
plus `packages/bundle/web-app/presets/{cordis,minimal,ptc,standard}.patch.yml`. Because a patch row
**replaces the targeted row's whole `config`** (`:5–6`), a path-guard plugin row must restate every key
it owns. `plugin_manager` (the model-facing tool at `packages/boot/plugin-manager/src/tools.ts:19`,
name `:20`) can install/enable/disable bundles — **so the model can, in principle, disable the fence
plugin if it has that tool and the approval channel allows**. That is a first-class residual to call out.

---

## 8. Master table — surface → interception point → blockable?

Legend: **A** = full denial achievable (no names, no content); **B** = names/structure visible, content
or write blocked; **C** = partial (see note); **N** = not blockable at the plugin layer.

| # | Surface (model-facing name) | Reaches disk via | Interception point available to a plugin | Level A? | Level B? | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `read` | `ctx.fs.resolve`→`stat`→`readText`/`streamText` | `tools/pre-execute` (async re-resolve of `file_path` vs `session.header.cwd`), `ctx.tools.guard` (lexical), `tools/post-execute` (redact `value`) | ✅ | ✅ | Args are one path string; `fsp.resolve` gives a realpath'd `targetKey`/`displayPath` for a symlink-safe compare; `prepend` post-execute gives the last word on content |
| 2 | `write` | `ctx.fs.resolve`→`writeText` | pre-execute/guard (deny) **plus `fs/write-intent`** (resolved target, can throw) | ✅ | ✅ | The resolved-target veto exists only for this tool's path |
| 3 | `edit` | `ctx.fs.resolve`→`editText` | pre-execute/guard **plus `fs/edit-intent`** | ✅ | ✅ | same, per-tool |
| 4 | `read_image` | `ctx.fs.resolve`→`stat`→`readBytes`→`attachments.saveImage` | pre-execute/guard; post-execute redaction of an image block | ✅ | ✅ | Deny works; "read but not write" is moot |
| 5 | `str_replace_editor` | `ctx.fs.resolve`/`lstat`/`listDir`/`readText`/`writeText` | pre-execute/guard only — **`fs/write-intent`/`fs/edit-intent` are NOT dispatched** (own `MutationPolicy`, `index.ts:428`) | ✅ | ✅ | Per-command grading needed: `view` vs `create`/`str_replace`/`insert`; `path` is absolute-only |
| 6 | `present` | `ctx.fs.lstat`/`resolve`/`stat` | pre-execute/guard | ✅ | ✅ | Metadata only; `path` required |
| 7 | `lsp` | `ctx.lsp` → `ctx.fs` + a spawned language server | pre-execute/guard on `file_path` | ⚠️ C | ⚠️ C | Denying `lsp` is clean. The language-server **child process** reads the workspace itself and can surface content in `hover`/`references` results → content leak even with `file_path` allowed |
| 8 | `grep` | `ctx.subprocess.spawn(packaged rg)` — **never `ctx.fs`, never `ctx.sandbox`** | pre-execute/guard (deny the call; `pattern`/`path`/`include` are inspectable), post-execute `{kind:'accept', value}` redaction | ⚠️ C | ✅ | Cannot rewrite `path`/`pattern`, so per-path grading degenerates to "deny all `grep`" or "allow and redact". Redaction is sound because the result *is* the only output |
| 9 | `glob` | same | pre-execute/guard; post-execute redaction of the path list | ⚠️ C | ✅ | `--no-ignore --hidden` lists `.ssh`/`.env`/`.aws` under any searched root. Level A requires denying `glob` entirely (or filtering every returned path) |
| 10 | `bash` | `ctx.shell.execute` → real OS process | pre-execute/guard can deny the call; **cannot filter the command** | ❌ N | ❌ N | Turing-complete string; `cat`, `find /`, `python -c`, `$(…)`, base64, git plumbing. Sound options: deny `bash`, or OS sandbox |
| 11 | `pwsh` | same | same | ❌ N | ❌ N | same |
| 12 | `bash`/`pwsh` **persistent** | `ctx.terminals` PTY | pre-execute/guard on `command` | ❌ N | ❌ N | Same, plus **state persists across calls** (a `cd` + later `cat` defeats per-call argument analysis entirely) |
| 13 | `terminal_send` | `ctx.terminals.startSend` | pre-execute/guard on `text` | ❌ N | ❌ N | PTY keystrokes: `text` can be `cat ~/.ssh/id_rsa\n`; interactive editors/REPLs make static analysis meaningless |
| 14 | `terminal_open`/`read`/`list` | `ctx.terminals` | pre-execute/guard | ⚠️ C | ⚠️ C | Deny `terminal_open` → the rest become inert; `terminal_read` alone can surface an already-running session's scrollback |
| 15 | `run_code` (PTC) | a fresh **Node or Python process** with raw `node:fs`/`os` | pre-execute/guard on `run_code`; **nested SDK sub-dispatches DO re-enter the guard** | ❌ N | ❌ N | The program body is arbitrary code (`await import('node:fs')`). Denying `run_code` denies the whole wire surface under `mode:'ptc'`. Neither `ctx.fs` nor `tools/post-execute` can constrain it |
| 16 | `job_output`/`job_list` | `ctx.jobs` ring buffers + spill files | pre-execute/guard (deny) | ⚠️ C | ⚠️ C | Carries stdout of a previously-launched background command (`finalizeContent` at `tool-jobs/src/index.ts:225` only truncates) |
| 17 | `mcp__<server>__<tool>` | the MCP server process | pre-execute/guard **by name only** (args are server-defined JSON) | ⚠️ C | ⚠️ C | `mcp__filesystem__read_file` is a complete bypass. Deny the `mcp__filesystem__` namespace, or all MCP |
| 18 | `read_mcp_resource` | MCP server | pre-execute/guard by `server`/`uri` | ⚠️ C | ⚠️ C | URI scheme is server-defined |
| 19 | `cua_driver_native__*` | native desktop driver | pre-execute/guard by name | ⚠️ C | ⚠️ C | GUI control is an out-of-band read/write channel |
| 20 | `subagent` / `subagent_fork` (**in-process** child) | same `ToolRuntime` | **global guard covers the child's calls** (`scopeTarget` admits untagged listeners; `guardReason` reads `layers.global`) | ✅ | ✅ | Proven by `scope.ts:176` + `tools/index.ts:1146` |
| 21 | `subagent` routed to **claude-code / codex / acp / dsh-sdk** | `ctx.subprocess.spawn` of a foreign agent | pre-execute/guard on `subagent` only | ❌ N | ❌ N | `subagent-claude-code/src/index.ts:113–116` spawns its own CLI whose own tool loop reads the filesystem; `permissionMode` (incl. `bypassPermissions`) is deployment config, not a DSH guard |
| 22 | `workflow` / `ralph` | in-process children + a script with **no fs API** | pre-execute/guard; the script's children are guarded | ✅ | ✅ | `docs/tool-catalog.md:37,45`; the tool description states the script has no fs/network/Node APIs |
| 23 | `skill`, `ask_user_question`, `todo_write`, `get_goal`/`create_goal`/`update_goal`, `schedule_*`, `session_*`, `list_agents`, `send_message`, `interrupt_agent`, `spawn_teammate`, `team_task_*`, `wait_agent`, `web_*`, `plugin_manager`, `cordis_inspect_*`, `list_subagent_models`, `exit_plan_mode`, `load_workspace_dependencies`, `stagehand_*` | not a direct file path (except `skill` and `plugin_manager`) | pre-execute/guard | — | — | **`plugin_manager` can disable the fence plugin itself** — treat as a residual. `skill` loads skill bodies through `ctx.get('fs')` |
| 24 | **Instruction files → system prompt** (`AGENTS.md`, `CLAUDE.md`, `~/.agents/AGENTS.md`) | `agent-instructions` at prompt-assembly time, **no tool call** | none; `ctx.get('fs')` bypasses `internal/get`; `files.ts:146,330` falls back to raw `node:fs` | ❌ N | ❌ N | Content enters the prompt before any tool runs |
| 25 | **Skill bodies → model context** | `skill-filesystem` via `ctx.get('fs')` (`index.ts:843`) | none for the load path | ❌ N | ❌ N | Same class |
| 26 | **`@file` autocomplete index** | `file-reference-local/src/search.ts:9` raw `node:fs/promises` | none | n/a | n/a | Host/GUI-facing (path names only, to the Web composer), but it is an unguarded workspace walk |
| 27 | **Hooks** | `runHook(ctx.shell, …)` inside `hooks-claude-code`/`hooks-codex` | none at the tool layer | ❌ N | ❌ N | Operator-configured shell; output can enter `additionalContext` |
| 28 | **Web file API** (`api/workspace-files`) | `ctx.fs` directly | none wanted | n/a | n/a | Human-facing; must **not** be fenced |
| 29 | **`fs/*` mutation waterfalls** | `write`/`edit` only | `fs/write-intent`, `fs/edit-intent` — resolved target, can throw | ✅ | ✅ | Best available mutation chokepoint; **not** dispatched by `str_replace_editor` |
| 30 | **`fs/observed`** | emit | observation only, cannot veto | ❌ | ❌ | By contract |

---

## 9. Residual leaks — surfaces no plugin can fence

Ranked by severity for the stated goal (deny AI read of user-specified paths under `danger-full-access`):

1. **`bash` / `pwsh` / persistent PTY / `terminal_send`.** Category C. A shell reads any path the
   harness process can read. No argument analysis is sound. **Mitigation: deny these tools by name, or
   mount a real OS sandbox** (`sandbox-windows-acl` on Windows; bwrap/Landlock/Seatbelt elsewhere) —
   and note the sandbox vocabulary is allow-root based, so "allow the workspace, deny `.ssh` inside it"
   is not expressible today.
2. **`run_code` (PTC).** A real Node/Python process with raw `node:fs` (documented at
   `ptc-runtime-node/src/index.ts:68`). With `ptc-runtime-python` there is **no confinement at all**
   (`ptc-runtime-python/src/index.ts:1038,1046`). Mitigation: deny `run_code` — which under
   `tools.mode: 'ptc'` removes the entire tool surface.
3. **`subagent-claude-code` / `subagent-codex` / `subagent-acp` / `subagent-dsh-sdk`.** A foreign agent
   loop in a subprocess, with its own tools and its own `permissionMode` (including
   `bypassPermissions`). Mitigation: deny the `subagent`/`subagent_fork` tool, or OS-sandbox the child.
4. **MCP servers** (`mcp__*`). Arbitrary server code with arbitrary argument schemas. `mcp__filesystem__*`
   is a first-class bypass. Mitigation: deny by name prefix, or don't mount such servers.
5. **`job_output` / `job_list` and spill files.** Content already captured by an earlier shell command
   or search is retrievable, and search spill files hold the *complete* result
   (`tool-fs-search/src/search-core.ts:382–399`, `suggestedName: 'grep-results.txt'`). A path fence
   installed after the fact does not retract it.
6. **`session_*` full-text search over prior session history**
   (`tool-session-query/src/index.ts:66–113`). Anything ever logged — including a file's content read
   before the rule existed, or via `bash` — is searchable verbatim.
7. **System-prompt content ingestion** (`agent-instructions` #24, `skill-filesystem` #25). No tool call
   is involved, and both go through `ctx.get('fs')`, which bypasses the `internal/get` waterfall. DSH's
   own tests confirm instruction content rides `ctx.fs` when present
   (`packages/context/agent-instructions/tests/agent-instructions.spec.ts:2049,2218`).
8. **`--hidden --no-ignore` ripgrep** (`glob.ts:94–95`). Even a *read-only* fence leaks names at
   Level B unless the result is filtered; at Level A every `glob`/`grep` call must be denied.
9. **`plugin_manager`.** The model can, with approval, enable/disable/install bundles — including
   unloading a fence plugin. This is a self-protection gap, not a filesystem gap.
10. **`fs/*` mutation waterfalls cover only `write`/`edit`.** `str_replace_editor` and `present` bypass
    them (`tool-str-replace-editor/src/index.ts:428` own `MutationPolicy`, `:262/:314/:364` direct
    `writeText`).
11. **TOCTOU on any pre-execute re-resolve.** The tool resolves again after the guard. `fs-sandbox`
    accepts the same residual and narrows it by re-canonicalizing immediately before delegating
    (`fs-sandbox/src/index.ts:10–18`, `:132`). A pre-execute fence inherits that limitation. Closing it
    requires the composition-level backend swap (§3.4 / §7.5).
12. **`internal/get` is not a fence.** Even if a listener wrapped `'fs'`, `ctx.get('fs')`,
    `ctx.reflect.get('fs')`, and the `:140` early return all bypass it. Consumers on that path:
    `agent-instructions:119`, `skill-filesystem:843`, `spill-policy:82`, `office-to-pdf:188`,
    `llm:1024`, `llm-deepseek/host.ts:34`, `llm-pi-ai:219`.
13. **Post-execute redaction can be overwritten by a tool's own `finalizeContent`**, which the registry
    applies *after* post-execute (`index.ts:1649–1650` → `:1687–1692`). Currently harmless for the
    fs/search tools (none declare it); it would matter if a future `read`/`grep` gained one.

---

## 10. Recommended architecture (derived strictly from the contracts above)

**Two layers, both needed.**

**Layer 1 — additive plugin: `tools/pre-execute` + `tools/post-execute` + `ctx.tools.guard`.**

- Register a **global `tools/pre-execute`** listener (plain context ⇒ applies to every agent and every
  nested `run_code` sub-dispatch; `scope.ts:176`). It is async, so:
  - resolve the model-supplied path **through the very same `ctx.fs` the tool will use**:
    `await ctx.fs.resolve(rawPath, { cwd: exec.agent?.session.header.cwd })`, then compare the canonical
    identity via `ctx.fs.processPath(target)` / `ctx.fs.contains(rootTarget, target)` — **never** by
    parsing `targetKey` (`fs/src/types.ts:11–15`) and never by lexical `path.resolve` alone (a symlink
    inside the workspace pointing at `~/.ssh` defeats lexical matching).
  - return `{ kind: 'deny', reason }` for Level A, `{ kind: 'allow' }` for Level B, and
    `{ kind: 'cancel' }` when the denial must not even reveal that a policy exists (the deny reason is
    echoed to the model verbatim as `` Error: <reason> `` at `index.ts:1526` — keep it
    existence-neutral).
- Add a **synchronous `ctx.tools.guard()`** for cheap lexical/normalized checks and as a monotonic
  backstop that a later pre-execute listener cannot re-open (`:1519`, `:731`).
- Per-path *levels* must be graded **per tool, per argument field**: `read`/`read_image` →
  `file_path`; `write`/`edit` → `file_path`; `str_replace_editor` → `path` (+ `command` to distinguish
  `view` from mutations); `present` → `files[].path`; `lsp` → `file_path`; `glob` → `path` + `pattern`;
  `grep` → `path` + `include`; `bash`/`pwsh`/`terminal_*`/`run_code`/`mcp__*` → whole-call decision.
- Register the **`tools/post-execute` redactor with `{ prepend: true }`** (outermost ⇒ last word;
  `events.ts:255` `unshift`), returning `{ kind: 'accept', value: <redacted> }` so that
  `render` **and** `presentationMeta` are recomputed (`index.ts:1839,1845–1853`) and the durable `meta`
  is clean too. Defer when a downstream decision already replaced the value
  (`Object.hasOwn(decision, 'value')`, mirroring `spill-policy:135` and `direct-call.ts:24`).
  Redaction targets: `read`'s `lines[].text`, `str_replace_editor`'s string value,
  `grep`'s `matches[].line` (names only ⇒ strip `line`), `glob`'s path list (Level A ⇒ drop denied
  paths), `read_image` (drop the image block).
- Also register **`fs/write-intent` and `fs/edit-intent`** listeners to deny mutations on the *resolved*
  target by throwing `FsError(..., 'FS_SANDBOX_DENIED')` — the model then sees the standard
  `[sandbox: …]` marker. Remember this covers `write`/`edit` only, not `str_replace_editor`.

**Layer 2 — composition change for anything that must survive a determined model.**

- For **read** fencing with no TOCTOU and no `ctx.get('fs')` hole: a new backend plugin modelled on
  `packages/fs/fs-sandbox/` — `export class GuardedFileSystem extends LocalFileSystem`, override
  `resolve`, `readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`, `stat`, `lstat`,
  `writeText`, `editText`. Load it **instead of** `dsh-fs-local`/`dsh-fs-sandbox`. This is the only
  mechanism that catches *every* `ctx.fs` consumer, but it also fences `api/workspace-files` and
  `agent-instructions` — so it must distinguish callers, or apply the deny only to paths the human
  does not need (a **path** deny-list is fine here; a caller-identity rule is not expressible).
- For **category C** (shell, PTY, `run_code`, foreign subagents): an OS sandbox is the only real
  enforcement. The shipped `SandboxPolicy` cannot express a path deny-list, so either extend
  `ctx.sandbox` (a composition change; `confine(argv, policy)` is the extension point) or deny the
  category-C tools outright in the guard.
- Mount everything through a bundle patch row (`- insert: [{ id, name }]`, precedented at
  `packages/bundle/web-app/cordis.patch.yml:44–52`), and consider denying `plugin_manager` so the model
  cannot unload the fence.

**Reference implementation shape:** `packages/fs/fs-observation-policy/src/index.ts` (event-only, no
service, `WeakMap` state, `ctx.effect` cleanup) for the `fs/*` half;
`packages/guard/timeout-policy/src/index.ts` (`inject = ['tools']`, package-owned structured error code)
for the pipeline half; `packages/guard/repeat-tool-reminder/src/index.ts` for Config-schema style
(`z.object({...})` with `.default(...)`, load-time fail-loud validation in `apply`) and for its
`wildcardToRegExp` path-pattern compiler.
