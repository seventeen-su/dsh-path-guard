# TS 6.0.3 迁移：状态与续做配方

> 本文件是**进行中**迁移的交接文档。基线：迁移前 `node --test` 六个 spec = **239 pass / 0 fail**。

## 目标形态

```
src/*.ts           源（strict + erasableSyntaxOnly）
client/client.ts   客户端源
tests/*.spec.ts    测试（直接跑 src，Node 24 剥离类型，无需 flag）
lib/**             tsc 产物 —— 必须入库（install_bundle 不构建包）
tsconfig.json          src    -> lib
tsconfig.client.json   client -> lib/client
tsconfig.test.json     测试，noEmit + allowImportingTsExtensions
```

`package.json`：`exports["."] → ./lib/index.js`、`exports["./client"] → ./lib/client/client.js`；
`devDependencies` 精确 `typescript@6.0.3` + `@types/node@26.6.3`（后者是 `strict` 的**必需项**，
不是可选优化：它目前只是传递依赖，锁文件一重生成 `tsc` 就会因 `Cannot find module 'node:os'` 崩）。

## 已完成（已验证，勿重做）

| 项 | 证据 |
|---|---|
| 改名骨架、三份 tsconfig、package.json | 见上 |
| **逻辑零改动** | `pg-verify-tokens.cjs`（剥类型后的 token 流 vs 迁移前 `lib/*.js`）10 个文件 **0 差异**；`pg-verify-params.cjs`（TS AST 参数绑定名 vs 原件）**零差异** |
| 六文件 strict 干净 | `policy.ts`、`scan.ts`、`tool-fields.ts`、`deny.ts`、`fs-guard.ts`、`config.ts` |
| 运行时零回归 | `node --test tests/*.spec.ts` → **239 pass / 0 fail** |
| 产物可加载 | `lib/index.js` → `Config, apply, inject, name, unwrap`；`lib/client/client.js` 存在且 `node --check` 通过 |
| `.gitignore` | 已取消忽略 `lib/` 与 `package-lock.json`（`install_bundle` 不构建，产物必须在磁盘上） |

## 剩余工作（`tsc` 错误数，实测）

| 文件 | 错误 | 归属 |
|---|---|---|
| `src/index.ts` | 81 | task-11 |
| `src/resource.ts` | 24 | task-12 |
| `src/redact.ts` | 22 | task-13 |
| `src/notify.ts` | 11 | task-13 |
| `client/client.ts` | 47 | task-14 |
| `tests/*.spec.ts` | 见下（**不是级联**） | task-15 |

### ⚠️ 更正：「tests 的 418 个错误多数是级联」是错的

本文档初稿写的这条判断**已被实测证伪**。`verifier` 用相隔 3 分钟的两次 `tsc -p tsconfig.test.json`
做了差分（正好跨过队友落地）：

| | run1 | run2 | Δ |
|---|---|---|---|
| `src/` 合计 | 127 | 21 | **−106** |
| `tests/` 合计 | 418 | 424 | **+6** |

其中 `policy.spec.ts`(138)、`fs-guard.spec.ts`(86)、`notify.spec.ts`(92) 三个 spec 的 src 依赖
**早已 strict 干净**（`any` 计数 0），却仍背着 316 个错误——**不可能**是级联。
结论：src 清零后 test 错误不会大幅下降，**真正的工作量在测试自身**。

根因分布（实测）：

| spec | 错误 | 主因 |
|---|---|---|
| policy | 138 | 125 个是 `match()` / `compiled.rules[i]` 的 `\| undefined`（src 类型正确，测试缺守卫）；8 个本地助手参数无注解 |
| notify | 92 | **55 个来自一行**：`notify.spec.ts:58` 的 `const slot = { service: undefined }` 把 `slot.service` 推断成 `undefined` |
| fs-guard | 86 | 26 个助手参数无注解；25 个 `guard[name]` 动态索引；7 个 `makeGuard(overrides = {})` |
| host | 36 | `fakeCtx(options = {})`、本地数组、rest 参数 |
| redact | 41 | 16 个源自 `src/redact.ts:313` 写死 `value: unknown` |
| resource | 31 | 19 个测试自身（联合未窄化）；5 个是 src 常量精度 |

**方法论教训（值得保留）**：验收要看**逐文件**基线（policy 56 / resource 42 / fs-guard 23 / host 48 /
redact 29 / notify 41），不能只看总数——否则某个 spec 悄悄不跑也能让总数不变。

### 14 处「故意喂非法输入」的对抗性用例：裁决 = 调用点 cast

`fs-guard.spec.ts:511-516`(6)、`redact.spec.ts:218/237/243/244/440/446/447`(7)、`notify.spec.ts:577`(1)
断言的是入参校验行为（TypeError / fail-closed），而签名正确地禁止了这种调用。

**决定：在调用点加 cast，不放宽公开签名。** 理由：把 `createFsGuard(deps)` 改成收 `unknown` 会让每个
正常调用方失去补全与检查，只为迁就 14 个用例；而 cast 本身就是「我故意违约」的自证标记。
**断言语义一处都不许动。**

（`resource.ts` 的三个入参放宽 —— `resolveResources(toolName)` / `isGoverned(toolName)` 收 `unknown`、
`policyAccessFor(capability)` 收 `string | undefined` —— 是**另一类**：它们处理的是**外部输入**
（动态注册的工具名、模型给的参数），函数体本就有 `typeof` 守卫，签名如实描述契约。
`createFsGuard(deps)` 收的是**插件作者自己写的接线对象**，写错是我方 bug，签名应当帮忙拦住。）

## ⚠️ 客户端产物必须是**经典脚本**（否则配置页永远不渲染）

客户端半页由 `packages/client/modules/src/client/system.ts:15-29` 以**经典脚本**加载
（`document.createElement('script')` + `src`，**没有** `type="module"`）。

而 `package.json` 的 `"type": "module"` 会让 tsc 把 `client.ts` 判定为 ES module，并在产物末尾补
`export {};` —— 对经典脚本而言这是**解析期 SyntaxError**，注册不会发生，配置页永远不渲染。

**陷阱**：`node --check lib/client/client.js` **会通过**（Node 因 `"type": "module"` 按 ESM 解析它），
所以它**不能**证明可装载。

**修法**（已落地）：`tsconfig.client.json` 加 `"moduleDetection": "legacy"`，产物即为无 import/export 的脚本。

**验收方式**：必须用经典脚本语义解析，例如
`new vm.Script(readFileSync('lib/client/client.js', 'utf8'))` → 不抛。
检查 `export`/`import` 前**必须先剥掉注释**——文件里的注释本来就会*提到* `export {}`
（解释为什么用 legacy），朴素的 `includes('export {}')` 会误报（我们的校验器第一版就犯了这个错）。


## 每个文件的固定套路

1. `npx tsc -p tsconfig.json --noEmit 2>&1 | Select-String '^src/<file>'` 拿错误清单。
2. 读错误行附近窗口，按错误码修：
   - **TS7006 / TS7031**：JSDoc 类型是 `import('@deepseek-ai/...')` 或 `{object}`（codemod 故意不转）
     → 写**本地结构化类型**，注释注明「镜像自 `<DSH 源>:<file:line>`」。**不要** import DSH 包。
   - **TS2339 ... on type 'object'**：`{object}` 注解过宽 → 改结构类型，或
     `(x as Record<string, unknown>).f`（`as` 到本地类型，**不许 `any`**）。
   - **TS18046 'x' is of type 'unknown'**：原 JSDoc 的 `/** @type {...} */ (expr)` 在 `.ts` 里失效 → 换成 TS 的 `as`。
   - **TS18048 / TS2532 / TS2554**：`noUncheckedIndexedAccess` → 有守卫时用 `!`，否则给显式类型。
   - **TS7053**：字面量对象被字符串下标索引 → 把常量声明成 `Record<string, T>`（`deny.ts`/`fs-guard.ts` 就是这么修的）。
3. 收尾三查：该文件 `tsc` 清零 → 跑相关 spec → 跑 tokens/params 校验器。

## 批量改动协议（**强制**）

≥2 个文件的批量改动（尤其 codemod）之后，**必须**依次跑：

1. `node %TEMP%\pg-verify-tokens.cjs` → 期望 10 个文件 0 差异；
2. `node %TEMP%\pg-verify-params.cjs` → 期望零差异；
3. `node --test tests/*.spec.ts` → 期望 ≥ 239 pass / 0 fail。

**为什么强制**：作者的 JSDoc→注解 codemod 曾有一个偏移 bug，会把第 2 个及以后参数的注解写到错位处，
产生语法错误与**静默改名**（当时 16 个测试失败）。修好后正是靠这两个校验器把损伤清干净的。

## 硬红线

- **只加类型，不改逻辑**；断言语义一个字都不许改（只允许改 import 说明符与类型标注）。
- **不许 `any` 泛滥**；外部类型写本地结构化镜像。
- **`erasableSyntaxOnly`**：禁 `enum`（用 `const` + `as const`）、禁构造函数参数属性、禁 `namespace`。
- 只用 `tsc`，不得引入打包器。
- 收工前必须 `npx tsc -p tsconfig.json` 与 `tsconfig.client.json` 重新 emit，**让 `lib/` 与 `src/` 一致**
  （即使还有类型错误，tsc 也会 emit——但绝不能留过期产物，那会让重载加载到旧代码）。
- **待 Lead 验证、不要声称已验证**：`lib/client/client.js` 能否被 `window.__ModuleLoader__` 正常装载
  （无浏览器控制权）。
