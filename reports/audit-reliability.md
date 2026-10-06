# 审查一：可靠性对抗审查（task-18）

- 审查者：`verifier`（独立于实现者）；只写了本文件，未改动仓库其他文件，未运行 git。
- 审查对象：`src/index.ts`（71,957 B，2026-10-06 06:31）、`src/tracking.ts`（新，16,691 B）、`src/resource.ts`（38,854 B）、`src/policy.ts`、`src/scan.ts`、`src/redact.ts`、`src/fs-guard.ts`、`src/notify.ts`、`src/config.ts`、`src/deny.ts`、`src/tool-fields.ts`、`client/client.ts`（104,303 B）、`cordis.patch.yml`、`package.json`、`locale/*.json`。
- 方法：读源码 + **用真实模块做实验**（`apply()` 对假 Cordis ctx、真实临时 profile 目录、`DSH_PROFILE_DIR` 指向它）。脚本在 `%TEMP%\pg-audit\*.mjs`（`x1/x1b/x8/x9/x10`），可复跑。node v24.21.0。
- 状态标签：**已验证可利用** / **理论可行未验证** / **已正确防护**。
- 被测的两项改动我确认在位：`tracking.ts` 的 `createTracking/familyOf` 与 `resource.ts` 的 `learned` 第三参、`index.ts` 的 observe/learnFromDenial/750ms 防抖/端点 `records`（`src/index.ts:429,968,1003,1017,1510-1520`）；`client/client.ts` 的 `CONTROL`（`:620-631`）、`STATE_CSS`（`:957-975`）、`measureMenu`（`:1038-1050`）。

---

# A. 已验证可利用

## A1【高｜已验证可利用】追踪文件是 AI 可写、且被插件信任的输入：可抑制提示、可把"拒绝"降级为"放行"、可抹掉信任表

**结论**：`<profileDir>/path-guard-tools.json` 不在自我保护名单里，插件自己的策略**明确放行**对它的写入；而这份文件在下次激活时被当作事实读回（`fromJSON`）。于是 AI 可以（①）把任意未建模工具预置成 `notified: true` → 用户永远收不到"发现未建模工具"的日志与弹窗；（②）预置 `fields` + `capabilities` → **让本来必被拒绝的读取变成放行**；（③）覆写成空表 → 用户的信任表与全部观测记录消失。

**证据**
- 自我保护只覆盖三个文件：`src/index.ts:275` `const PROFILE_FILES = ['cordis.patch.yml', 'cordis.yml', 'package.json']`（本文件不复现）；追踪文件与它们**同目录**：`src/index.ts:193` + `:452` `join(dirname(patch), TRACKED_TOOLS_FILE)`。
- **实测放行**（`x8.mjs` X8a，config = 出厂默认 + `selfProtection: true`）：
  ```
  write(<tmp>\path-guard-tools.json) :: ALLOWED — the agent may author its own tracking file
  write(cordis.patch.yml) :: deny      write(cordis.yml) :: deny      write(package.json) :: deny
  ```
- 激活时读回且**只读一次**：`src/index.ts:463-471` `loadTracking()`（`JSON.parse` + `fromJSON`，try/catch）→ `:515` 调用点只在激活路径上；`fromJSON` 的 `notified: raw.notified === true`（`src/tracking.ts:415`）。
- **实测抑制**（X8b）：同一未建模调用，未预置时 `info` 日志有 "unmodelled tool" 且 `desktopNotify.push` 1 次；预置 `notified: true` 后**两者都为 0**（`src/index.ts:551` 早退）。
- **实测降级放行**（X8c，规则 `{<profile>/.ssh → list}`，"仅可见文件名"档）：
  ```
  无预置记录     → deny
  预置 {fields:['path'], capabilities:{path:'list'}} → allow
  ```
  机理：学到的字段在 `src/resource.ts:662-668` **先于**取值形态腿直接 `return`（值形态腿会要求 READ，list 档不放行）；而 `learnedCapabilityOf`（`src/resource.ts:410-422`）只把**不认识**的能力收紧为 `write`，`'list'` 是合法枚举值 → 被原样接受。这与该函数文档"a file we cannot vouch for may only ever make the plugin stricter, never looser"**直接矛盾**。
- **实测持久**（X8d）：插件自己的防抖重写会把预置记录（含弱能力）**原样写回**，所以这不是一次性的：`{"name":"mcp__acme__read",...,"capabilities":{"path":"list"},"notified":true}`。
- 生效时机：下一次激活（无其它 `fromJSON` 调用点），即用户重启 DSH / 重载插件之后——这在实际使用中是常规事件。

**复现**：`node %TEMP%\pg-audit\x8.mjs`（四段 A/B 对照）。

**建议修法**（任一都不必牺牲功能）
1. 把追踪文件纳入自我保护：`PROFILE_FILES` 增加 `path-guard-tools.json`，或对 `<profileDir>` 下的 `path-guard-tools.json` 单独加一条 `access: 'read'` 的隐式规则（AI 可读、不可写）。
2. 纵深防御：`learnedCapabilityOf` 把**已知但更弱**的值也收紧——learned 字段只接受 `write`（或至少 `>= read`），因为"学到的字段"永远来自一次真实拒绝；`list`/`enumerate`/`export` 都是合法枚举但语义更弱，不该被持久文件指定。
3. 让持久化的 `notified` 与内存状态分离：把"已提示"记为**不可由文件提升**的状态（例如只把 `notified` 写入一个只读的审计文件、或对文件里的 `notified` 一律忽略）。
4. 最小成本版：`fromJSON` 只接受 `version` 匹配且**由本插件写出**的指纹（例如写一个 HMAC/进程随机前缀不可行时，至少在接受 `fields` 前要求 `seen >= 1 && refused >= 1`，纯手写记录缺少这两个计数就丢弃）。

**是否可利用**：是（已验证，端到端；前提是攻击者能写该文件 + 一次重启/重载）。

---

## A2【中｜已验证可利用】超大追踪文件让激活卡死：`evict()` 是 O(n²)，200k 条记录实测 **115 秒**（阻塞 Host 启动）

**结论**：`fromJSON` 对文件里的记录数没有上限检查，逐条 `records.set` 之后调用一次 `evict()`；而 `evict()` 每删一条都要全表扫描找最旧（`while (size > 200)` + 内层 O(n)）。于是文件记录数 n 的激活代价是二次的。文件是 AI 可写的（A1），所以这是一个廉价的可用性 DoS：让插件（乃至 Host 启动）卡住。

**证据**（`x10.mjs` / `x9.mjs`，实测）
```
n= 1000     5.4 ms      n= 8000   124.0 ms
n= 2000     8.4 ms      n=16000   521.1 ms
n= 4000    31.1 ms      n=32000  1818.3 ms      ← 4× per 2× ⇒ O(n²)
经 apply() 端到端：10k 条 → armedIn=183ms；200k 条（约 7MB）→ armedIn=115190ms
```
代码：`src/tracking.ts:252-267`（evict 的双层循环）、`src/tracking.ts:374-427`（fromJSON 无条数上限，只在末尾 `evict()` 一次）。

**复现**：`node %TEMP%\pg-audit\x10.mjs`；端到端见 `x9.mjs` 最后两行。

**建议修法**：`evict()` 改成一次排序/一次扫描——按 `(lastSeenAt, firstSeenAt, name)` 排序后保留最后 200 条，或插入时维护最小堆；并在 `fromJSON` 里对 `source.length` 设上限（例如 `> TRACKED_TOOLS_MAX * 10` 直接当作损坏文件丢弃或只取末尾 N 条）。修完 200k 条应该是毫秒级。

**是否可利用**：是（可用性；需要写 7MB 文件——用 `pwsh` 生成即可，`shell: 'scan'` 不拦与受保护路径无关的命令）。

---

## A3【中｜已验证（注册表级）】去重位被淘汰复位 → 循环 >200 个未建模工具名可无限重复提示

**结论**：`notified` 存在记录上，而记录受 200 上限淘汰；被淘汰的工具再次出现时是**新记录**（`notified: false`），于是日志与弹窗再来一次。这不是"每工具一次"，而是"每工具每次重新进入注册表一次"。

**证据**（`x1.mjs` X3，实测）
```
size at cap :: 200
t_0 still tracked? :: NO (evicted)
re-observe t_0 → notified :: false      ← 弹窗会再发一次
```
代码：`src/tracking.ts:252-267`（evict）+ `:270-284`（create 的 `notified: false`）+ `src/index.ts:551`（`notified === true` 才早退）。端到端的"弹窗重复"未实测（需要 201 个真实工具名），但早退条件就是 `notified`，所以是同一事实的推论。

**建议修法**：把"已提示"集合与"记录"解耦——单独的、有界（例如最近 1000 条 FIFO）的 `notified` 名字集合，淘汰记录时**不**淘汰它；或对同一工具有 1 小时冷却窗口。

**是否可利用**：是（噪声 DoS，用户可见；需要调用 200+ 个不同工具名）。

---

## A4【中｜已验证】自学习引入"历史相关的非确定性"，且 family 是**名字前缀**而非归属边界 → 跨插件/跨 DSH 工具污染

**结论**：三条独立但同源的问题：
1. **同一调用、同一参数，判定结果取决于历史**：一次无关的拒绝会把某字段名升级为"按名字判定"，此后该字段里**任何非空字符串**都被当作路径并参与拒绝。
2. **family 用名字前缀，不是归属**：`list_agents` 与 `list_bundles`（DSH 自己的两个不同工具）共族 `list_`；`create_goal` 与任何 `create_*` 共族。一次拒绝会教给不同插件/不同包的工具。
3. **畸形 MCP 名产生伪族**：`mcp__read_file` → `mcp__read_`；`mcp__` → `mcp__`。

**证据**（`x1.mjs` X1/X2/X4，实测）
```
familyOf("list_agents") :: "list_"        familyOf("list_bundles") :: "list_"
familyOf("mcp__read_file") :: "mcp__read_"   familyOf("mcp__") :: "mcp__"
拒绝 list_agents 的 path 后 → stamped onto ["list_bundles"]；list_bundles 学到的字段 [{"field":"path","capability":"read"}]
{name:"notes"} 学习前 actionable=[]（放行）
{name:"notes"} 学习后 actionable=[name="notes"(read)]（若 notes 落在受保护路径上 ⇒ 拒绝）
```
代码：`src/tracking.ts:107-118`（familyOf）、`:327-337`（同族盖章）、`src/resource.ts:662-668`（学到的字段短路取值形态腿、任何非空串皆路径）。

**建议修法**
- family 改为**工具归属**而非名字前缀：MCP 用 `mcp__<server>__`（这一支已经对），其余工具应优先用插件/包标识（`exec` 的 owner 信息、或 `KNOWN_TOOLS` 之外的显式注册），无法确定归属时**不泛化**（只教该工具自己）——"宁可少学，不可错学"。
- 畸形 MCP 名（`mcp__` 后没有第二段 `__`）不参与泛化。
- 学到的字段参与判定时，除 `actionable` 之外再保留"这是学到而非值形态"的标记（`resource.ts:766-780` 已经区分了文案，判定上也可要求 learned 命中**同时**具备路径形态或 `write` 能力才拒绝），可以消掉"纯历史导致拒绝"这一类。

**是否可利用**：是（可复现；但多数情形是自伤/噪声，真正有害的是与 A1 组合）。

---

# B. 理论可行未验证

## B1【低-中】多进程并发写同一个 profile 文件 → 后写覆盖，可能撕裂
两个 DSH 进程（例如 CLI 与 Web）共享一个 profile 时，各自持有一份内存注册表，各自 `writeFileSync` 整个文件（`src/index.ts:478`）。后写者覆盖先写者（丢数据）；同时写则可能产生交错内容——**但不会崩**：读路径的 `JSON.parse` 与 `fromJSON` 都有 try/catch（`src/index.ts:466-470`、`tracking.ts:422-426`），实测损坏文件仍正常武装（C1）。**未验证**：我没有真的起两个进程。**建议**：写临时文件 + `rename`（原子替换），既解决撕裂也让"最后写入者"至少是完整文件。

## B2【低】防抖 + `unref()` 的丢失窗口
`:492-496` 的 750ms 定时器 `unref()`，干净卸载有 flush（`:502-513`），但**进程硬退出**（Ctrl-C、crash）会丢掉窗口内的观测；短命 CLI 会话基本等于不落盘。功能上是"便利丢失"，不是防护丢失。未实测（要杀进程）。

## B3【低】`notify` 对等插件的版本漂移（文档而非行为）
插件注释声称核对过 `dsh-desktop-notify@1.5.4`（`src/notify.ts`）与 `1.7.0`（`client/client.ts` 的 SWITCH 注释），而**已安装的是 2.0.0**。我核对了 2.0.0 的实际接口，三项假设仍然成立：服务名 `desktopNotify`（`src/index.ts:886`）、`page:'plugins'` 在白名单里（`protocol.ts:78`）、`v` 字段被接受且更高主版本不中断（`api.ts:35`）。所以**不是缺陷**，但注释里的版本号已经过期，建议改成"以已安装版本的这些 file:line 为准"。

---

# C. 已正确防护（我按"错了会看到什么不一样"逐条试过）

1. **损坏/半写/非 JSON/类型错乱/巨量文件都不会影响武装**（`x9.mjs`，12 种输入）：`truncated JSON`、`not JSON at all`、`records` 非数组、`null`、元素为 `1/"x"/null/{name:""}`、capabilities 为对象、嵌套 20k 深 —— 全部 `read=deny`、`guard=reason`、`armedIn ≤ 2ms`、**0 条 error 日志**。若这里错了，我会看到激活抛异常或 `read=allow`。
2. **`fromJSON` 是总函数**：`try/catch` 兜底 + 逐条 schema 校验 + 去重 + 字段数上限（`:374-427`）；`cleanName/cleanField/cleanTime/cleanCount/cleanCapability` 对 NaN/负数/超长/空白一律降级。
3. **持久化写不进入请求路径、也不抛**：`saveTracking` 的 try/catch（`:477-481`）、`trackingFilePath` 的 `lookup` 自带 try/catch（`:442-450`）、定时器 `unref`（`:496`）、`ctx.effect` 缺失时仍能武装（`:502-513`）。**注意**：`trackingFilePath()` 在 `saveTracking` 里位于 `try` 之外，但它自身不抛（`ctx.get` 被包住、`join/dirname` 只吃字符串），所以不构成未捕获异常路径。
4. **未建模工具的自学习只加不减**：`learnedCapabilityOf` 对**不认识**的值收紧为 `write`（实测：缺 capability → `write`）；`actionable` 与 `noted` 分离，名字腿命中不构成拒绝依据（`resource.ts:674-684`）——这正是"`{dir:'asc'}` 不会大面积误拦"的护栏。
5. **端点响应纯增量，旧客户端不受影响**：`/path-guard/tools` 返回 `{tools, lastUnmodelledAt, records}`（`src/index.ts:1520`），前两个字段形状不变；`client/client.ts` **完全不读 `records`**（grep 无命中），所以旧客户端/新 Host、旧 Host/新客户端两个方向都安全。`tools` 仍 `sort().slice(0,200)`。未认证请求先被 `admit` 拒（`:1502-1508`）。
6. **通知与节流有界**：`notified` 每工具一次（除 A3 的淘汰复位）、注册表 200 上限、对等插件自身 1.5s 去重/200ms 间隔/队列 32（`dsh-desktop-notify@2.0.0` `src/index.ts:748-756`、`api.ts:131-145`）；`noteUnmodelledTool` 里 `ctx.get`/`push` 全在 try/catch（`:566-598`）。
7. **UI 改动的三个点都成立**：`CONTROL`（`client.ts:620-631`）无边框、32px、`--dsw-radius-sm`、`--dsw-alias-bg-module-platform`；`STATE_CSS`（`:957-975`）对 `button`/`input` 都写了完整 `outline` 简写（宿主规则只给颜色与宽度）、菜单项以填充为焦点指示；`measureMenu(null)` → `{side:'left'}`、先左后右再收缩（`:1043-1049`）。用到的 token 全部在 shipped CSS 里有定义：`--dsw-alias-bg-module-platform`（`ui-theme/src/styles/design-platform.css:179/297`）、`--dsw-radius-sm`（`ui-theme/src/styles/base.css:17` = 8px）、`--dsw-alias-interactive-bg-hover`（`design-platform.css:213/331`）、`-active`（`:209/327`）、`--dsw-alias-label-dimmed`（`:217/335`）。**未验证**：浏览器里的实际观感与焦点环可见性（无浏览器控制权）。
8. **`lastUnmodelledAt` 的纠正链是防御式的**：`readUnmodelledAt` 对任意 body 返回 `null`（`client.ts:1072-1074`）、读取有 1s 节流（`:1061`）、纠正窗口 20s 有界（`:1057`）、且**不持久化**（`index.ts:531`，重启后为 null ⇒ 不触发纠正，符合"只在刚发过提示后纠正"的意图）。
9. **DSH 镜像抽查一致**（task 第 5 项）：`profileContext.patchPath`（`D:\Program\deepseek-harness\packages\boot\app-boot\src\profile-context.ts:20`，值来自 `profile.ts:98/688` 的 profile `cordis.patch.yml` 绝对路径）；`configEditor.documentPath`（`packages\boot\config-editor\src\index.ts:34`，同值）；`desktopNotify` 服务名与 `click.page` 白名单见 B3。

---

# D. 需要 Lead 决策 / 建议的修复顺序

1. **A1 最高优先**：把 `path-guard-tools.json` 纳入自我保护（一行规则即可），并收紧 `learnedCapabilityOf` 只接受 `write`。这两条合起来就切断了"AI 用文件改写自己的判定"。
2. **A2 次之**：`evict()` 去二次化 + `fromJSON` 条数上限（纯性能，风险最低，收益明显）。
3. **A3/A4**：`notified` 与记录解耦；family 改为归属制（无法判定归属就不泛化）。A4 的改动会影响已写好的 `tracking.spec`，需要你排期。
4. **A1 的 `notified` 语义**需要你定：文件里的 `notified` 一律忽略（更安全，重启后会再提示一次）还是保留（当前行为，但可被伪造）。我倾向忽略文件里的该字段。
5. 我没有改任何代码；以上 4 项都需要你分派，避免与其它审查者撞车。
