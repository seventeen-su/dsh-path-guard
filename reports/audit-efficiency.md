# 审查三：工程实现与局部效率（热路径、分配、查询复杂度）

审查对象：`src/**`（`index.ts` 判定热路径、`resource.ts` 启发式扫描、`tracking.ts` 新数据结构、`scan.ts` 文本扫描、`redact.ts` 结果改写）、`client/client.ts`（渲染与事件）。
产出要求：每条含【现状 / 复杂度或实测 / 建议改法 / 预期收益 / 风险】；分「值得改 / 不值得改」两档。

测量环境：Windows，Node **v24.21.0**，直接 `import` 仓库 `src/*.ts`（Node 原生类型擦除，与 `npm test` 同一加载方式），每项 3k 预热 + 2 万次迭代取均值；关键比值连跑两遍，离散 <5%。基准脚本写在系统临时目录（`%TEMP%\pg-bench\`），**未入库**。原始输出见 §7。

---

## 0. 结论速览

### 值得改（按预期收益排序）

| # | 位置 | 一句话 | 实测 |
|---|---|---|---|
| **A1** | `src/index.ts:671-674`（调用点 `1072`、`1414`） | shell 扫描 needle **每次调用重建**，而它喂给的下游只是一次子串扫描 | 重建 **18.4 µs** vs 扫描 **1.28 µs** = **14.4×**；shell 调用前后各建一次 → **≈36.8 µs/次** |
| **A2** | `src/scan.ts:229-246` | `redactTextBlocks` 无「整块无命中就跳过」闸门，逐行做 needle 扫描 | 20×100 行：**2662 µs → 567 µs（4.7×）**，输出**逐字节相同** |
| **A3** | `src/index.ts:490-491` | `scheduleTrackingSave` 先算 `trackingFilePath()` 再判 timer，防抖窗口内白算 | **0.78 µs/次**（对比：整个 `observe` 0.74 µs；判定总计 136 µs） |

### 不值得改（已量化，逐条见 §4）

| # | 疑点 | 实测结论 |
|---|---|---|
| B1 | `knownFields` 每次判定是否线性扫描？ | **否**：`Map.get`，16 字段命中 **0.110 µs**、未跟踪 **0.012 µs**。**同族索引不需要预建** |
| B2 | 同族泛化是否 O(N) 拖慢判定？ | `learnFromDenial` 最坏 **7.8 µs**，且**不在判定路径上**（仅拒绝时），不值得加索引与失效逻辑 |
| B3 | `observe()` 的 materialize 是否浪费？ | 是：**94%**（0.693/0.736 µs）的可视快照被 `index.ts:538` 丢弃 —— 但只占未建模判定 136 µs 的 **0.5%** |
| B4 | 持久化写是否阻塞？ | 已防抖 750 ms + 定时器内执行，**不阻塞判定**；`writeFileSync` 最坏 **148 µs / 39 KB**（每 750 ms 一次） |
| B5 | `Object.entries`（`resource.ts:712`）该换 `for-in`？ | 只省 **4.0 µs / 148 µs = 2.7%**，且 `for-in` 会枚举**继承**的可枚举属性 —— **行为不等价，明确不改** |
| B6 | `redactGlobValue` 5000 路径 11 ms？ | 线性 **2.2 µs/路径**；唯一无副作用的缓解只对「没有 none/list 规则」的配置生效，不是主场景 → 记录触发条件 |
| B7 | 参数递归无规模上限？ | 线性 **≈1 µs/字符串**（500 字符串 = 516 µs）；加 cap 会改 fail-closed 语义 → 不改，仅记录形状 |
| B8 | 组合框**每次按键**重新 measure？ | **前提不成立**：`measureMenu` 只在**菜单打开那一刻**调用 1 次（`client.ts:1380`、`1299`），按键路径不 measure |
| B9 | 每次按键过滤 200 个工具名的成本？ | **5.33 µs/键**（连打 10 键 53 µs）→ 可接受 |
| B10 | `STYLE` 是否被新代码破坏？事件是否重复绑定？ | `STYLE` 仍在 bundle `factory`（`client.ts:63`）里只建一次（`675`）；三处监听都是 add/remove 成对且 `[open]` 依赖 → 无重复绑定 |

---

## 1. 每次工具调用的成本分解（实测）

| 阶段 | 组件 | 复杂度 | 实测 |
|---|---|---|---|
| 每次调用 | `isTrustedTool`（`index.ts:401`，读配置 + 逐条匹配） | O(trustedTools) | 未单独计量（配置通常个位数） |
| 每次调用 | `tracking.knownFields`（`tracking.ts:340-348`） | **O(1)** + O(字段数≤16) 分配 | 0.110 µs / 0.012 µs（未跟踪） |
| 未建模工具 | `resolveResources` 参数递归（`resource.ts:624-721`） | O(节点数 + 字符串总长)，深度上限 16 | **148 µs**（40 项嵌套）/ **250–435 µs**（500 字符串，随字段名而定，见 B7a） |
| 已建模工具 | `resolveResources`（`resource.ts:752-753`） | O(1) 查表 | 1.02 µs |
| 每个资源 | `match()`（已预编译 + 按快照身份记忆化，`index.ts:784-801`） | O(规则数 × 祖先链) | 1.45 µs |
| shell 前置 | `buildNeedles`（`scan.ts:102-151`，**每次重建**） | O(规则数 + needle 数 log needle 数) | **18.4 µs**（8 规则 → 56 needle） |
| shell 前置 | `scanCommand`（`scan.ts:160-172`） | O(needle 数 × 文本长) | 1.28 µs |
| shell 结果 | `buildNeedles` **再建一次** + `redactTextBlocks` | O(行数 × needle 数) | 18.4 µs + **2662 µs**（2000 行） |
| glob 结果 | `redactGlobValue`（`redact.ts:312-328`） | O(路径数 × 规则数) | **11008 µs**（5000 路径） |
| grep 结果 | `redactGrepValue`（`redact.ts:347-362`） | O(匹配数) | 418 µs（250 匹配） |
| **合成：未建模调用** | knownFields + resolve + match | — | **136.4 µs** |
| **合成：已建模调用** | knownFields(miss) + resolve + match | — | **2.6 µs** |
| 持久化 | `trackingFilePath()`（`index.ts:441-455`） | O(1) + 字符串 | 0.78 µs/次 |
| 持久化 | `writeFileSync`（`index.ts:478`） | O(快照字节) | 148 µs（39 KB，每 750 ms 一次） |

**读到的最重要结论：判定热路径本身没有系统性浪费。** 已建模工具 2.6 µs 全链路；未建模工具 136 µs 里 **92% 是字符串启发式**（同形状换成数字叶子后只剩 11.8 µs），那是该功能的本质成本，不是实现缺陷。真正的实现级浪费集中在 **shell 通道的 needle 重建** 与 **输出改写没有快路径** 两处。

---

## 2. 值得改

### A1 — shell 扫描 needle 每次调用重建（`src/index.ts:671-674`，调用点 `1072`、`1414`）

**现状**
```ts
// src/index.ts:671-674
const shellNeedles = (exec) => {
  const workspace = exec.agent?.session.header.cwd
  return buildNeedles(scanRules(), { home, windows, ...(workspace === undefined ? {} : { workspace }) })
}
```
`scanRules()`（`660-664`）每次新建数组 + filter；`buildNeedles`（`scan.ts:102-151`）对每条规则做 `expandPath`、`Set` 去重、每规则最多生成 12 个变体（原样/反斜杠/5 种 home 拼写×2），最后 `sort`（`150`）——**全部在一次工具调用内完成，然后丢掉**。`evaluateOpaque`（`1072`）建一次，post-execute 输出改写（`1414`）对**同一个 exec** 再建一次。

**复杂度或实测**
- `buildNeedles(8 规则)` = **18.4 µs** → 56 needle；单规则 **3.0 µs** → 12 needle。随规则数线性。
- 它喂给的下游 `scanCommand` = **1.28 µs** → **重建是下游扫描的 14.4 倍**。
- 每次 shell 调用：**≈36.8 µs**（前置 + 后置各一次；默认 `shell: 'scan'`，`index.ts:302`，两条路径都会执行）。相对 `policy()` 的 1.45 µs 匹配，这是 shell 通道最大的一笔固定开销。

**建议改法**
按 `policy()`（`index.ts:784-801`）的既有模式做身份键缓存：
```ts
let cachedNeedles: ReturnType<typeof buildNeedles> | null = null
let needleKey: unknown[] = []
const shellNeedles = (exec) => {
  const workspace = exec.agent?.session.header.cwd
  const configured = rulesOf(); const extra = selfRulesFor()
  if (cachedNeedles === null || needleKey[0] !== configured || needleKey[1] !== extra
      || needleKey[2] !== workspace) {
    cachedNeedles = buildNeedles(scanRulesFrom(configured, extra), { home, windows, ...(workspace === undefined ? {} : { workspace }) })
    needleKey = [configured, extra, workspace]
  }
  return cachedNeedles
}
```
可行性已核实：`rulesOf()` 返回配置的同一数组（保存才替换），`selfRulesFor()` 由 `selfRulePaths` 记忆化（`772-780`，返回冻结数组），`home/windows` 在激活期固定 —— 三者都是稳定引用，正是 `policy()` 依赖的前提。`scanRules()` 需要接受两个快照做无分配拼接（或缓存过滤结果）。

**预期收益**：**−18.4 µs/次**（只在 shell 前置）；**−36.8 µs/次**（shell 前后置都有）。规则越多收益越大（每条规则约 +2.3 µs）。
**风险**：中低。唯一风险是失效键漏项 —— 必须同时覆盖 `rules` 快照、`selfRules` 快照、**workspace**（逐会话变化）。needle 数组被下游只读使用（`scanText` 不写），共享安全。建议保留一个「规则/工作区一变就重建」的断言测试。

### A2 — `redactTextBlocks` 缺「整块无命中」快路径（`src/scan.ts:229-246`）

**现状**
```ts
// src/scan.ts:236-240 —— 每个 text 块先 split，再逐行 scanCommand
const kept = (block.text as string).split('\n').map((line: string) => {
  if (scanCommand(line, needles, windows) === undefined) return line
  ...
})
```
即使整块输出**一个受保护路径都没提到**（绝大多数情况），也要付 `split` + 每行 `toLowerCase` + 每行 56 次 `includes` + `join` 的钱。

**复杂度或实测**（20 块 × 100 行 = 2000 行 / 135 KB，56 needle）
| 输入 | 现状 | 加整块闸门 | 加速 |
|---|---|---|---|
| 全部干净（最常见） | 2662 µs | **567 µs** | **4.7×** |
| 20 块中 1 块含命中 | 2657 µs | **649 µs** | **4.1×** |

单行成本 **1.198 µs**，即成本 ≈ 1.2 µs × 行数，读者可按自己的输出规模换算（100 行 ≈ 132 µs）。

**建议改法**（`scanText` 之外零新增状态）
```ts
const text = block.text as string
// 可证明的跳过：某行含 needle ⇒ 整块必含该 needle；故整块无命中 ⇒ 每行都无命中
if (scanCommand(text, needles, windows) === undefined) return block
... 原来的逐行 map ...
```
**行为等价的理由**（不是"看起来像"）：
1. 任一行是该块的子串 → needle 出现在某行 ⇒ needle 出现在整块；
2. 第二遍扫描用的 `replaceAll('\\\\','\\')` 是**逐行局部**的：行尾单个 `\` 与下一行行首 `\` 之间隔着 `\n`，不构成 `\\` 对，因此 `transform(块) = transform(第1行) + '\n' + transform(第2行) + …`，行的变换结果仍是块变换结果的子串；
3. 闸门只做**跳过**，不做改写：一旦命中就落回原逐行逻辑，判定结果不可能不同。
   已验证：干净输入 `changed=false/false`、混合输入 `changed=true/true`，两条路径输出 `JSON.stringify` **逐字节相同**。

**预期收益**：干净输出 **4.7×**（2000 行省 ≈2.1 ms）；含命中的输出 4.1×。
**风险**：低。唯一需要小心的是「跨行 needle」（路径被换行截断）：闸门在整块里也找不到它（因为 needle 本身不跨行），于是跳过 —— 与原逐行行为一致（原本也找不到）。已有的文档化限制（`scan.ts:219-222`）不变。

### A3 — `scheduleTrackingSave` 判断顺序（`src/index.ts:490-497`）

**现状**
```ts
const scheduleTrackingSave = (): void => {
  if (trackingFilePath() === undefined || trackingSaveTimer !== undefined) return   // 491
  trackingSaveTimer = setTimeout(...)
}
```
`trackingFilePath()`（`441-455`）要过两次 `ctx.get(...)` + `Object.entries` 式的字段嗅探 + `dirname/join` + `process.env`，**每次未建模调用/拒绝都算一遍**，而目的是「防抖窗口内直接返回」。顺序反了：应该是先问 timer。

**复杂度或实测**：`trackingFilePath()` 等价体（stub `ctx.get`）= **0.779 µs/次**；作为对照，`tracking.observe` 整次 0.736 µs，未建模判定总计 136 µs。防抖窗口 750 ms（`202`），窗口内每次调用都白花 0.78 µs。

**建议改法**：`if (trackingSaveTimer !== undefined || trackingFilePath() === undefined) return`。
**行为等价的理由**：两个操作数都无副作用（`trackingFilePath` 只读 `ctx.get`/`process.env` 并 try/catch，返回 `string | undefined`），`||` 短路顺序对纯读取可交换。
**预期收益**：**−0.78 µs/次**（仅防抖窗口内有意义；一个 100 次调用的突发省 ≈78 µs）。**这是本报告里收益最小的一条**，只因为它是一行、零风险才列进「值得改」。
**风险**：无。

---

## 3. 自学习注册表专项（对应用户重点 3）

| 问题 | 结论 | 实测 |
|---|---|---|
| `knownFields` 是否每次判定线性扫描？ | **否**。`records.get(key)` 是 `Map`，O(1)；命中后只对 ≤16 个字段做 `map` | 16 字段命中 **0.110 µs**；未跟踪 **0.012 µs**；已跟踪但 0 字段 **0.016 µs** |
| 同族索引是否该预建？ | **不该**。判定路径完全不碰家族；唯一的 O(N) 家族扫描在 `learnFromDenial`（`tracking.ts:332-335`），而它只在**拒绝时**跑 | 200 条记录、**同族最坏** 7.8 µs；40 族 5.8 µs；`familyOf` 单次 0.021 µs。相对未建模判定 136 µs 占 5%，且不在热路径 |
| 持久化写是否防抖且不阻塞？ | **是**。750 ms 合并（`index.ts:202`、`490-497`）、`unref()`（`496`）、插件卸载时 flush（`502-513`）；写在 `setTimeout` 回调里 → **判定不等它** | `JSON.stringify(toJSON())` 56 µs + `writeFileSync` **148 µs**（200×16 最坏快照 **39 205 B**）；`fromJSON` 59 µs（仅激活期）；`list()`（HTTP 路由用，`index.ts:1510`）15.5 µs/请求 |
| `observe()` 每次分配快照？ | 是。`materialize`（`224-237`）复制 `fields` 数组 + `Object.fromEntries(capabilities)`，而 `index.ts:538` **丢弃返回值** | `observe` 0.736 µs，其中可视快照 **0.693 µs = 94%**；即每次未建模调用白分配 ≈0.69 µs |
| `evict()` 是否每次创建都 O(N)？ | 否。`while (records.size > MAX)` 在未超限时零次迭代 → O(1)；超限时每加一条淘汰一条 | 新增记录（含 cap=200 时的 evict 扫描）= **1.515 µs** |

**这一档的整体判断：注册表的数据结构选择是对的，不建议改。** 2 条「看起来该优化」的点（B1 线性扫描、B2 同族索引）经实测都不成立；B3 的 0.69 µs 相对 136 µs 的判定成本是 0.5%，为它新增 API（如 `touch()`）不划算。

---

## 4. 不值得改（逐条给实测理由）

### B1 `knownFields` 线性扫描 —— 不成立
`Map.get` + ≤16 元素 map。0.110 µs（16 字段）/0.012 µs（未跟踪）。若为「同族查询」预建索引，唯一受益者是 `learnFromDenial`（7.8 µs，非热路径），却要引入索引与 `records.delete/clear/fromJSON` 三处失效同步 —— 负收益。

### B2 家族泛化 O(N) —— 不值得
最坏 7.8 µs（200 条单族）。它只在拒绝时执行一次，且拒绝本身随后要走日志、通知、UI 上报。

### B3 `observe()` 丢弃的可视快照 —— 不值得（收益 0.5%）
`index.ts:538` 不用返回值。若确实要省，只能在 `tracking.ts` 增加一个不 materialize 的 `touch(name, at)`（附加 API、`tracking.spec.ts` 需同步），换来 0.69 µs / 136 µs。**收益与改动面不成比例。**

### B4 同步 `writeFileSync` —— 保持现状（附触发条件）
148 µs/次、每 750 ms 至多一次、且发生在定时器回调里 —— 相对 16.6 ms 的帧预算可忽略。异步化会引入写序竞争与错误处理复杂度。**触发条件**：若快照逼近 ~1 MB（当前 39 KB，约 25 倍余量），再改 `await writeFile` 并加写序串行化。

### B5 `Object.entries` → `for-in` —— 明确不改（行为不等价）
枚举本身 `Object.entries` 10.1 µs vs `for-in` 6.1 µs（1.67×），但放在 148 µs 的参数扫描里只占 **2.7%**（字符串启发式占 **92%**）。更关键：`for-in` 会枚举**原型链上的可枚举属性**，而工具参数是外部传入的对象；`Object.entries` 只看自有属性。为 2.7% 换来一个语义面更宽的遍历，**违反"不得以行为一致性为代价"**。

### B6 `redactGlobValue` 5000 路径 11 ms —— 记录，不改
2.2 µs/路径（`match` 1.45 + `path.resolve` 0.163 + 判定包装），严格线性、无上限；250 匹配的 grep 是 418 µs。唯一**无副作用**的缓解是规则级前置判断：若所有已编译规则 `access ∈ GLOB_KEEP`（`redact.ts:140`）且 `defaultAccess ∈ keep`，则任何判定都不可能丢弃条目，可整段跳过 —— 但这要求配置里**一条 `none`/`list` 规则都没有**，而 `none` 规则恰恰是本插件的主场景。**建议不改**；若线上确实出现超大 glob 且规则全为 `read/write`，再上这个 guard（届时它是 O(规则数) 换 O(路径数)）。

### B7 参数递归无规模上限 —— 记录形状，不改
线性、可预测：40 项嵌套 148 µs，500 个数字 1.8 µs，深度上限 16（`resource.ts:89`、`695`）已能防爆栈。加「节点数/字符数预算」会把当前的 fail-closed 语义改成截断语义（截断意味着可能漏看路径）—— 安全性倒退，不值得。注：参数规模由工具 schema 约束，不是模型可无限放大的输入面。

### B7a 同一份 500 字符串，成本随**字段名**在 250–435 µs 间变化 —— 机制已定位，不改
初次两轮测量出现 236 µs 与 516 µs 的差异，追查后确认**不是噪声，也不是迭代次数**，而是容器字段名决定了走哪条启发式腿（同机交替顺序两轮复现）：

| 入参形状（各 500 个字符串） | 实测 | 原因 |
|---|---|---|
| `{files:[…D:/…]}` | **248 / 261 µs** | `files ∈ PATH_NAME_TOKENS`（`resource.ts:308-313`）→ `named = true`，**跳过**取值形态正则组，直接建资源 |
| `{a:[…D:/…]}` | **441 / 430 µs** | `a` 不是路径名 → 每个字符串都要跑 `looksLikeProgramField` + `looksLikePathValue` 正则组 |
| `{a:[500 × 同一路径串]}` | **433 / 432 µs** | 同上（命中与不命中差别不大） |
| `{a:[500 × 普通散文串]}` | **323 / 327 µs** | 同上，但 `looksLikePathValue` 在更早的判定点返回 |

结论：**per-string 成本 ≈0.5–0.9 µs，且由字段名分档**（路径名字段 ≈0.5 µs/串，普通字段 ≈0.86 µs/串）；`looksLikePathValue` 的正则组是主导项。这印证 §1 的「92% 是字符串启发式」。**不建议改**：让普通字段也跳过形态判断会直接改变判定语义（`{dir:'asc'}` 那类必须靠形态腿兜住，见 `resource.ts:679-684` 的注释），这正是该功能的设计代价。

### B8 组合框「每次按键重新 measure」 —— 前提不成立
`measureMenu`（`client.ts:1038-1050`）只读 1 次 `window.innerWidth` + 1 次 `getBoundingClientRect()`（一次强制布局），调用点只有两处：
- `ToolMatchField.openMenu`（`1380`）—— 而 `onChange`（`1463-1469`）只在 `open === false` 时调 `openMenu(true)`，已经打开时只 `setFiltering(true)`；
- `MenuControl` 的触发器 `onClick`（`1299`）。

即 **打开菜单 1 次 = measure 1 次；连续打字 0 次 measure**。这是该交互的下限，可接受。

### B9 每次按键的过滤 —— 可接受
`client.ts:1376-1377` 对 ≤200 个工具名做 `toLowerCase + includes`：**5.33 µs/键**（10 键 53 µs）。相对一次 React 渲染与 DOM 提交可忽略。列表行与 `STYLE` 展开（`1445、1462`）每渲染分配几个小对象，属该渲染模型的正常成本。

### B10 `STYLE` / 事件绑定 —— 未被新代码破坏
`STYLE` 定义在 bundle 的 `factory`（`client.ts:63`）作用域内（`675`），每次 bundle 装载一次，**不在渲染路径**（新组合框只做 `{...STYLE.comboWrap}` 这类浅展开）。三处监听（`1251-1275` 菜单、`1394-1409` 组合框、`1944-1949` 插件面板）都是 `add` 与 `remove` 成对、依赖数组为 `[open]` 或 `[]`，且以 `if (!open) return undefined` 守卫 —— **没有重复绑定**；菜单/组合框的监听器只在打开期间存在，是更省的做法。

### B11 policy 预编译 —— 已到位，不重复报（按要求）
`index.ts:784-801` 以「规则快照身份」记忆化 `compile()`，`match` 1.45 µs。本次只把它作为 A1 的**实现范式**引用。

---

## 5. 未实测 / 超出本次口径的部分

- `isTrustedTool`（`index.ts:401`）单次成本未单独计量（读配置 + 逐条前缀/精确匹配，O(trustedTools)）。
- `ctx.fs.resolve()`（`decidePath`，`index.ts:882`）是宿主异步服务，不在本仓库、不属本审查对象；它是每次判定里最可能的真实大头（每个资源一次）。
- 客户端**渲染与 DOM 成本**无法在 Node 下计量（无 DOM）：本次只测了与 DOM 无关的过滤逻辑（B9），`getBoundingClientRect` 只做**调用次数**统计（B8）。React 协调/提交成本未测。
- 所有数字是单机均值；比值已连跑两遍验证稳定（A2：4.7×/4.8×；A1：18.4/18.8 µs）。

---

## 6. 复现

脚本（**未入库**，均在系统临时目录）：`%TEMP%\pg-bench\bench-core.mjs`、`bench2-redact-client.mjs`、`bench3-combined.mjs`、`bench4-walk.mjs`。
运行方式：`node %TEMP%\pg-bench\bench-core.mjs`（直接 import 仓库 `src/*.ts`）。
关键原始输出（节选）：

```
knownFields: hit, 16 learned fields                            0.110 µs/op
knownFields: unknown tool (Map miss -> [])                     0.012 µs/op
observe: existing record, 16 fields (materialize)              0.736 µs/op
get: same materialize path (attribution only)                  0.693 µs/op
materialize share of observe                                   94 %
learnFromDenial: 200 records, ONE family (worst)               7.789 µs/op
JSON.stringify(toJSON()) [200x16]                             56.485 µs/op
writeFileSync of that JSON (blocking)                        147.997 µs/op
file size on disk                                            39205 bytes
trackingFilePath() equivalent (stub ctx.get)                   0.779 µs/op
needles built from 8 rules                                    56 needles
buildNeedles(8 rules) [currently PER CALL]                    18.826 µs/op
scanCommand on a ~70-char command                              1.277 µs/op
redactTextBlocks: 20x100 lines (current)                    2484.665 µs/op
match(): 4 rules, compiled                                     1.452 µs/op
redactGlobValue: 5000 paths, keep-all                       11008.003 µs/op
redactGrepValue: 250 matches, keep-all                       418.105 µs/op
resolveResources: unmodelled, 40-item nested args            135.613 µs/op
resolveResources: modelled tool (read_file)                    1.023 µs/op
resolveResources: 500 string args (field `files`)               236.566 µs/op   (同形状换字段名 `a` 为 430-441 µs，见 B7a)
unmodelled call: knownFields + resolveResources + match x N  136.366 µs/op
modelled call: knownFields(miss) + resolveResources + match    2.599 µs/op
string-heuristic share (40 items)                                92 %
Object.entries walk (as src/resource.ts:712)                  10.100 µs/op
for-in walk (equivalent enumeration)                           6.057 µs/op
enumeration-only speedup                                       1.67x
build : scan ratio (8 rules)                                   14.4x
redactTextBlocks (current): all-clean 2000 lines            2662.4 µs/op
redactTextBlocks + whole-block skip gate: same input          567.3 µs/op
speedup: clean 4.7x   mixed 4.1x
equivalence: clean changed=false/false identical=true
equivalence: mixed changed=true/true identical=true
one keystroke over 200 tracked tools                          5.33 µs
10 keystrokes (a word typed)                                 53.27 µs
```

---

## 7. 一句话总结

判定热路径（已建模 2.6 µs、未建模 136 µs）**没有需要抢救的性能问题**；自学习注册表的查询是 O(1)、持久化已防抖不阻塞，**都不该改**。真正值得动的只有三处：shell needle 缓存（−36.8 µs/次）、输出改写整块闸门（4.7×，字节等价）、以及一行判断顺序（−0.78 µs/次）。另外 `Object.entries → for-in` 与「组合框每键 measure」这两个常见直觉，实测分别是**行为不等价**与**前提错误**，不应照做。
