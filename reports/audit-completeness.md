# 完整性与欠缺审查（task-19）

> 审查对象：working tree（HEAD 含 `da2eb55` 跟踪重写 · `c407269` UI 统一 · `dcff781` 新图标 · `613d5a2`/`d85203c` 缺陷修复与协议对齐）。
> 审查范围：`src/**`、`client/client.ts`、`tests/**`、`cordis.patch.yml`、`package.json`、`locale/**`、`docs/**`、`README.md`、`tsconfig*.json`、`.gitignore`。
> 只报「没做完 / 没接上 / 说了没做」，不报新功能想法。**未运行任何 git 命令。**
>
> **方法**：全部结论先用脚本机械提取，再逐文件阅读确认。脚本（`node --input-type=module` 走 stdin，未落盘）：
> ① 导出引用矩阵（68 个导出 × 本文件内/其它 src/其它 tests 的引用计数，含「被测试入口可达」判定）；
> ② `src/config.ts` 字段 × `client/client.ts` 控件 × zh/en 文案 × 各文档出现矩阵；
> ③ zh/en 字典键集合 diff + `label()` 使用点 diff（含 `${key}Hint` 模板与动态 `label(okKey)` 展开）；
> ④ docs 行号引用全量抽取 + 逐条解析（64 处，见 §3.7）；
> ⑤ spec ↔ src 模块 import 矩阵；⑥ `STYLE`/`CONTROL`/`SWITCH` 键引用计数。
> 实测命令：`npm test`（**301 pass / 0 fail**）、`npm run typecheck`（三份配置 **0 报错**）、`lib/` 与 `src/` 的 mtime 新鲜度对比（12 个源文件，0 缺失/0 过期）。

## 0. 摘要

| 档位 | 条数 | 一句话 |
|---|---|---|
| **必须补** | 7 | 5 条 README 与实现直接矛盾（含一个已被删除的功能、一个已不存在的 UI 入口、一条已失效的开发命令、两处契约不符），2 条核心行为完全无文档（跟踪模型、`unknownTools`） |
| **建议补** | 6 | 文案断言深度、tracking 残余分支、验收手册缺 tracking 条目、`records` 无消费者也无声明的对外契约、产物一致性的自动化护栏缺失 |
| **文档漂移** | 12 | 纯文字过期（`.js` 路径、字数与测试数、已完成但仍写「进行中/待补」的段落、未使用文案键） |

**先明确「没有欠缺」的部分**（都经过机械核对，不是印象）：

- **测试脚本无遗漏**：`tests/` 下 8 个 spec 与 `package.json` 的 `test` 脚本列出的 8 个文件**完全一致**（集合相等，无遗漏、无多余）；`npm test` 实测 301 pass / 0 fail。
- **配置面 UI 完整**：`src/config.ts` 的 10 个字段**每个都有 UI 控件**（`enabled`/`selfProtection`/`searchRedaction` 为开关，`defaultAccess`/`shell`/`exoticTools`/`unknownTools`/`notify` 为下拉，`rules`/`trustedTools` 为草稿式表格），**每个都有 zh 与 en 文案**；反向也干净——`write()` 的 10 个落点全部是 `Config` 认识的字段，**没有 UI 渲染了 host 不认的字段**。
- **locale 键集合无缺失**：zh 69 键 = en 69 键，键集合**逐一相同**；`label()` 的全部静态使用点与两个动态形式（`label(\`${key}Hint\`)`、`label(okKey)`）都不缺键。
- **没有真死代码**：68 个导出中，**「声明之外零引用」的导出为 0 个**；`STYLE` 的 36 个样式键全部被引用。完整清单见 §5。
- **tracking 的三个关键分支都已覆盖**：同族泛化、上限淘汰、坏数据 `fromJSON` 在 `tests/tracking.spec.ts` 里都有专测（§2.3 列残余缺口）。
- **fs-guard 权威层已落地且已 documented**：`src/fs-guard.ts` 存在、`{ prepend: true }` 注册（`src/index.ts:1370-1371`）、README:100/106 与 ARCHITECTURE §2.1/§4.0 都已写明写侧权威与读侧 TOCTOU 边界，三处口径一致。
- **docs 行号引用基本有效**：64 处引用中 59 处可解析且行号未超界，**行号超界 0 处**（§3.7）。

---

## 1. 必须补

### 1.1 README 描述的「常用位置一键加规则」功能已被删除，README 仍在教用户用它

- **证据**：README:48 写「**常用位置**：`~/.ssh` / `~/.aws` / `~/.gnupg` / `~/.docker` 一键加规则（点一下即可，之后可改档位）」。
  全仓扫描（`.ts/.js/.json/.md/.yml`，排除 `node_modules`/`lib`）：`.gnupg`、`.aws`、`.docker` **三个字符串只出现在 README.md**，代码里一处都没有。
  而 `client/client.ts:911-912` 的注释直接写着：`// The two action buttons are the only inline-flex controls left; the pill chip style went with the one-click presets.` —— 即该功能是**被移除**的，不是没写文档。
- **影响**：用户按 README 去页面找四个一键按钮，找不到；这是「文档承诺了不存在的功能」。
- **建议**：删掉 README:48 这一行（或改写为「新增规则后手动填路径，输入框有 `~/.ssh` 等占位示例」）。同理检查 README:52 的「**「怎么用？看四个例子」：页内展开的使用说明**」——`client/client.ts:372-375` 的注释说明这个折叠控件也已被刻意移除（说明文字现在**常驻**显示），README 仍写成可展开的交互。

### 1.2 README 说配置页注册在三个地方，其中「设置导航项」已不存在

- **证据**：README:38-44 的表格列出三个位置，第一行是「设置对话框里独立的『路径守卫』导航项 | `settings.section`」。
  实际代码 `client/client.ts:1972-1987` 只注册两个槽：`plugins.row.config`（key `` `${PKG}#${NS}` ``）与 `plugins.bundle.config`（key `PKG`）；全仓 `settings.section` 只出现在 `client/client.ts:1961` 的**注释**里，且该注释的结论正是「NO shipped package registers both, so a second nav entry would be off-standard rather than helpful」。
- **影响**：用户去「设置」里找一个永远不会出现的导航项；同时 README 与代码注释给出的结论相反。
- **建议**：README:38-44 改为两行（`plugins.row.config` + `plugins.bundle.config`），并把「为何只有两处」的结论从代码注释搬到文档（见 §2.2 / §3.10）。

### 1.3 安装章节说「不需要构建步骤、纯 JS」，但包的实际入口是编译产物 `lib/`

- **证据**：README:29-31「**不需要任何安装脚本，也不需要构建步骤**：包是纯 JS，`install_bundle` 自己跑 `pnpm add`」。
  实际：`package.json:11-15` 的 `exports` 指向 `./lib/index.js` 与 `./lib/client/client.js`；`:17` 有 `build: tsc -p tsconfig.json && tsc -p tsconfig.client.json`；`:41-44` 有 `devDependencies`（typescript 6.0.3）；`.gitignore:10-14` 专门注释说明「`lib/` 是构建产物且**必须入库**，因为 `install_bundle` 从不构建」。
- **影响**：这句是 README 里最容易被照做的部分。读者改 `src/*.ts` 后不会想到要 `npm run build`，而运行时（含 DSH 重启后）加载的仍是旧 `lib/`——表现是「改了没生效」，且没有任何报错。这与 `docs/TS6-MIGRATION.md:134` 的硬红线（「收工前必须重新 emit，绝不能留过期产物」）是同一件事，但 README 教的是相反的流程。
- **建议**：改写安装/开发章节：包**必须**带 `lib/` 一起交付；改源码后必须 `npm run build`。

### 1.4 README「开发」章节的命令已失效

- **证据**：README:221-225 写 `node --test tests/host.spec.js tests/policy.spec.js tests/redact.spec.js`，并声明「零构建步骤，纯 JS」。
  实际：`tests/` 下**没有 `.js` spec**，只有 8 个 `.spec.ts`；`package.json:19` 的 `test` 是 8 个 `.ts` 的完整清单；`npm test` 实测 301 pass。
- **影响**：照抄命令会直接失败（文件不存在）。
- **建议**：改为 `npm test`（并说明它跑 8 个 spec / 301 项），或列出 `.ts` 路径。

### 1.5 README 记录的 `/path-guard/tools` 响应契约与实现不符（少两个字段）

- **证据**：README:176 写「经同源路由 `GET /path-guard/tools` 取（`{ "tools": [...] }`，去重、按字典序、上限 200）」。
  实际 `src/index.ts:1510-1520`：`const records = tracking.list()` … `res.end(JSON.stringify({ tools, lastUnmodelledAt, records }))`——响应体是**三字段**，`lastUnmodelledAt`（客户端「跳转到本插件那一行」的窗口判据，`client/client.ts:1067-1074`、`1889-1910`）与 `records`（每次目击次数、拒绝次数、学到的字段）都没写进 README。
- **影响**：这是本插件唯一的对外 HTTP 契约，第三方或未来的客户端半页按 README 实现会拿不到 `lastUnmodelledAt`。`tests/host.spec.ts:816-828` 已经在断言三字段形状，文档落后于测试。
- **建议**：README 该段补齐为 `{ tools, lastUnmodelledAt, records }`，并逐字段一句话说明。

### 1.6 跟踪模型（自学习 / 同族泛化 / 持久化 / 端点 records）在三份主文档中完全无描述

- **证据**：对 README.md / docs/ARCHITECTURE.md / docs/ACCEPTANCE.md 全量正则检索 `track|unmodelled|未建模|自学习|同族|泛化|家族|records|持久化|未知工具`：
  命中只有 README:107（取值形态启发式）、README:127/134/141（通知）、README:175-176（候选列表）、README:188/202（不访问文件系统的工具表），**没有任何一处**描述「拒绝即学习字段 → 同族传播 → 后续按字段名判定」。
  代码事实：`src/tracking.ts` 429 行（`learnFromDenial` / `familyOf` / `knownFields`）、`src/index.ts:1017-1026` 接线、`src/resource.ts:737` 的第三个参数 `learned` 把学到的字段喂进判定。这不是内部重构——它**改变了「未建模工具如何被判定」这一条用户可见行为**，并且新增了一个磁盘文件（见下）。
- **影响**：① 用户无法预判「为什么这个工具昨天放行、今天被拒」；② 插件会在 profile 目录静默写文件 `path-guard-tools.json`（`src/index.ts:193`、`:441-455`、`:474-482`，750ms 防抖，`tests/host.spec.ts:26-36,1502-1545`），**任何文档都没提过这个文件的存在、位置与作用**；③ 卸载/清理时用户不知道该删什么。
- **建议**：README 增一节「未建模工具的记忆」：学习触发条件、同族前缀规则（`mcp__<server>__` / 最后一个 `_` / 无 `_` 不成族）、`path-guard-tools.json` 的位置与删除后果（删了只是忘记，不降低防护）；ARCHITECTURE §2.2 把 `tracking.ts` 补进「已落地」；ACCEPTANCE 补一条活体验收（见 §2.4）。

### 1.7 配置项 `unknownTools` 在所有 `.md` 中零提及

- **证据**：对全部 `.md` 检索 `unknownTools` → **0 命中**（README / ARCHITECTURE / ACCEPTANCE / PLAN / TS6-MIGRATION 全部）。
  但它是 `src/config.ts:123` 的正式字段（`check` 默认 / `deny`），有 UI 下拉（`client/client.ts:1697-1700`）+ zh/en 文案（`unknownToolsHint` / `unknownToolsCheck` / `unknownToolsDeny`）+ 专门的拒绝文案（`src/deny.ts:116-131`，其中**逐字引用**了字段名与两个取值）。
  README 的「其余开关」表（README:81-87）列了 `defaultAccess`/`searchRedaction`/`shell`/`exoticTools`/`selfProtection`，**恰好漏掉 `unknownTools`**（`trustedTools` 与 `notify` 另有专节，`enabled` 在自锁急救一节有）。
- **影响**：这是唯一一个「会显著改变拒绝率」的开关（`deny` 会把所有取值像路径的未知工具调用一律拒掉），却没有任何用户文档说明它与 `check` 的区别，也不在「挡不住/能挡住」讨论里。
- **建议**：README:81-87 表补一行 `unknownTools`；README:107 的「未建模工具里的内嵌路径」段落补一句「`unknownTools: deny` 下取值像路径即拒」。

---

## 2. 建议补

### 2.1 4 个拒绝文案只被断言到「首句」，其独有内容与补救指引无人守

- **证据**（脚本按每个函数的标志性短语在 `tests/**` 检索，并对近义短语复核）：

  | 文案函数 | 断言深度 | 证据 |
  |---|---|---|
  | `denialText` | 独有短语已断言 | `tests/host.spec.ts:233` `/不要尝试绕过/` |
  | `installSourceDenialText` | 独有短语已断言 | `host.spec.ts:369` `/拒绝了这次安装来源/`、`:411`、`:420` |
  | `unknownToolDenialText` | 独有短语已断言 | `host.spec.ts`（`/已知工具表里/`） |
  | `internalErrorText` | 独有短语已断言 | `host.spec.ts:732,737,1120` `/内部出错/` |
  | `shellDenialText` | **仅首句** | 只断言 `/访问被拒绝/`（`:443`、`:1001`、`:1061`）与 `/pg-secrets/`；「只做文本扫描」「这不是系统错误」等独有内容无断言 |
  | `exoticDenialText` | **仅首句** | `:1001-1004` 只断言 `/访问被拒绝/`；「独立进程或外部工具循环」无断言 |
  | `selfDenialText` | **仅首句** | `:351-354` 只断言 `/自我保护/`；「plugin_manager 只读」「读取类动作不受限制」无断言 |
  | `redactionBlockedText` | **仅触发路径** | 触发路径已测（`host.spec.ts:555-560`「post-execute withholds an unrecognized structure…」），但该函数正文（「整体扣留」「宁可少给结果，也不泄露」）无断言 |

- **影响**：`src/deny.ts:1-13` 自己声明「Whatever this module returns reaches the model verbatim … 措辞是产品的一部分，不是调试输出」。这 4 条的措辞（尤其是「下一步该怎么做」）可以整段被改坏而测试全绿。
- **建议**：每条补一个 `assert.match(reason, /…独有短语…/)`，与 `denialText` 现有做法一致。

### 2.2 UI 统一结论只存在于代码注释，`docs/UI-REVIEW.md` 不存在

- **证据**：ARCHITECTURE:162-164 把「设置界面 + 插件页面重复出现」列为待确认问题，并写「证据见 `docs/UI-REVIEW.md`（待补）」；该文件**不在仓库里**。
  结论其实已经做出并写进了 `client/client.ts:1960-1971` 的注释（「Verified against every shipped client package … NO shipped package registers both」）。
- **影响**：文档指向一个不存在的证据文件，且已做出的决策没有落进文档（连带 README:38-44 仍是三处，见 §1.2）。
- **建议**：把该注释的结论搬进 ARCHITECTURE §5（或补一份 `docs/UI-REVIEW.md` 记录核对了哪些包、看到什么），并同步修 README:38-44。

### 2.3 `tests/tracking.spec.ts` 未覆盖的残余分支

已覆盖（无欠缺）：`familyOf` 三种族规则与畸形 MCP 名、`observe` 计数/时间戳回退/不 trim、`learnFromDenial` 同族传播与「无族不传播」、字段上限 16「先学先留」、工具上限 200「最久未见先淘汰 + 重见刷新」、`toJSON/fromJSON` 往返（含 `notified` 不重复通知）、裸数组与 envelope 两种入参、坏数据不抛且逐字段修复、同名去重、载入后同样受上限约束。

未覆盖的残余分支（机械对照 `src/tracking.ts` 与 spec 得到）：

- `materialize()`（`tracking.ts:224-237`）返回的是**拷贝**——`list()`/`get()` 的快照被调用方改动不应影响注册表，无断言；这是「注册表 vs 快照」边界，改动 `materialize` 会造成静默污染。
- `markNotified` 作用于**未跟踪**工具时应为 no-op（`tracking.ts:358-362` 有 `undefined` 守卫），无断言。
- `evict()`（`tracking.ts:252-267`）的三级 tie-break（`lastSeenAt` 相同 → 比 `firstSeenAt` → 再比 `name`）：现有淘汰测试用的是**互不相同**的时间戳，第 2/3 级比较从未被执行。
- `learnFromDenial` 在**兄弟已达字段上限**时 `teach()` 返回 `false`（`tracking.ts:295`），该兄弟不进 `affected`——只测了自身到上限，没测兄弟到上限。
- `tracking.familyOf(name)`（实例方法，`tracking.ts:350`）与导出的自由函数 `familyOf` 是两条路径，前者无断言（21 处测试引用全部指向自由函数）。

### 2.4 验收手册缺 tracking 的活体验收条目

- **证据**：`docs/ACCEPTANCE.md` 最近一次活体验收是 §6（2026-09-30，基线路径 `resource.ts` + `fs-guard.ts`，见 :181-184），**早于 tracking 落地**；§0.1 的记录是 2026-09-25。全文没有任何「观察 → 拒绝 → 学习 → 同族传播 → 重启仍在」的验收步骤。
- **影响**：tracking 是当前唯一「跨会话保留状态」的机制，也是最依赖真实时序/文件系统的一环（防抖写盘、`ctx.effect` 卸载冲刷、profile 目录解析顺序 `profileContext.patchPath` → `configEditor.documentPath` → `DSH_PROFILE_DIR`，`src/index.ts:441-455`）。单元测试用的是假 ctx，覆盖不到真实 profile 目录。
- **建议**：§6 追加 4 条：① 用一个未建模工具调一次 → `records` 出现 `seen: 1`；② 让它命中受保护路径被拒 → 同一 `records` 出现 `refused: 1` 与 `fields`；③ 同族另一个工具被拒时能看到 `path-guard: learned field …` 日志（`src/index.ts:1022`）并把字段传播过去；④ 重启 DSH 后 `records` 仍在、且不再重复弹「发现未建模的工具」通知。

### 2.5 `records` 字段没有任何在仓消费者，也没被声明为对外 API

- **证据**：`client/client.ts` 对路由的解析只取 `tools` 与 `lastUnmodelledAt`（`:1013`、`:1067-1074`、`:1119`、`:1910`；脚本检索 `records` 在 client 中 0 命中）。`records` 目前只被 `tests/host.spec.ts:1424-1427` 读取。
  代码注释（`src/index.ts:1518-1519`）把它定位为「additive view … that makes the tracking legible」，即**有意提供**，不是死载荷。
- **影响**：不是缺陷，但属于「做了但没交付到任何地方」的悬空：既没进 README 的契约（见 §1.5），也没有 UI 或消费方。
- **建议**：二选一并写进文档——(a) 明确声明为对外只读 API（README 补字段说明即可，成本最低）；(b) 若判定为测试专用，则在 §1.5 的文档里标注「仅诊断用」。

### 2.6 `lib/` 与 `src/` 的一致性没有自动化护栏

- **证据**：`docs/TS6-MIGRATION.md:134-135` 把它写成硬红线（「收工前必须重新 emit …… 绝不能留过期产物」），但唯一相关的 `tests/build.spec.ts` 只断言产物**存在**、可 import、是经典脚本（`:37-47`、`:49-59`、`:80-115`），**不比对产物与源码的对应关系**。
  本次人工核对：12 个 `.ts` 源文件的 `lib/` 产物**全部存在且 mtime 不早于源码**（0 缺失 / 0 过期），即**当前是一致的**；缺的是「下次不一致时会被抓住」。
- **影响**：忘记 `npm run build` 是本仓最容易发生、最难察觉的交付事故（运行时加载旧代码、测试全绿——`npm test` 跑的是 `src/*.ts`，不是 `lib/`）。
- **建议**：给 `build.spec.ts` 加一条最小断言（例如产物中必须出现源码某个近期新增的导出名/字符串常量）。低优先，但它是唯一能防住 §1.3 那类事故的机制。

---

## 3. 文档漂移

> 全部为「文字过期、行为无影响」，但会让读者做出错误判断。按文件分组。

### 3.1 ARCHITECTURE 抬头基线过期

`docs/ARCHITECTURE.md:3`：「插件 `dsh-path-guard`（**宿主侧纯 JS**，20+ 提交，**143 项测试**）」——现在是 TS 6.0.3（`tsconfig.json` `erasableSyntaxOnly` + 三份配置）+ `npm test` **301 项**。同一行的「20+ 提交」也无法在禁 git 的前提下核对，建议改成不带易腐数字的写法。

### 3.2 ARCHITECTURE 仍用 `.js` 指代已改名的 `.ts` 源文件

`docs/ARCHITECTURE.md:39`（`src/scan.js`）、`:84`（`src/resource.js`、`tool-fields.js`）、`:122-123`（`policy.js`）；`src/resource.ts:5,20,226,251,284,558,578` 的注释同样引用 `src/tool-fields.js`。实际文件是 `.ts`。这类引用不会指向错误内容，但会让「按图索骥」的人找不到文件。

### 3.3 ARCHITECTURE §2.2.1 记录的签名与导出清单落后于实现

`:81-84` 写「导出 `CAPABILITY` / `KNOWN_TOOLS` / `OPAQUE_TOOLS` / `resolveResources(toolName,args)` / `isGoverned(toolName)` / `policyAccessFor(capability)`」。
实际 `src/resource.ts:737` 是 `resolveResources(toolName, args, learned?)`（第三个参数就是 tracking 学到的字段），且还导出了 `RESOURCE_FREE_TOOLS`（`:258`）——文档里两处都没提。「41 项测试通过」也是当时的快照。

### 3.4 ARCHITECTURE 内部自相矛盾：服务接管「待重新确认」 vs 「已拍板不接管」

`:63-66` 仍写「评估接管 `ctx.fs` …… （用户此前否决过服务接管，待重新确认）」；而 `:127-133` 的 §4.0 ① 明确写「**不接管 `ctx.fs`（用户明确决定）**」并给出了理由。以 §4.0 为准，`:63-66` 应改为「已评估并否决，理由见 §4.0 ①」。

### 3.5 ARCHITECTURE §5 指向不存在的 `docs/UI-REVIEW.md`

`:164` 的「证据见 `docs/UI-REVIEW.md`（待补）」——文件不存在（见 §2.2）。

### 3.6 `docs/TS6-MIGRATION.md` 整篇仍是「进行中」，但工作已全部完成

- `:3`「本文件是**进行中**迁移的交接文档。基线：迁移前 `node --test` 六个 spec = **239 pass / 0 fail**」。
- `:32-41`「剩余工作（`tsc` 错误数，实测）」表：`src/index.ts` 81、`resource.ts` 24、`redact.ts` 22、`notify.ts` 11、`client/client.ts` 47、tests 若干。**实测 `npm run typecheck` 三份配置 0 报错**，该表已全部清零。
- `:136-137`「**待 Lead 验证**：`lib/client/client.js` 能否被 `window.__ModuleLoader__` 正常装载（无浏览器控制权）」——已由 `docs/ACCEPTANCE.md:196-203` 第 9 条关闭（`registrant: path-guard-client`、`key: dsh-path-guard#path-guard`、`active: true`）。
- **建议**：改为「已完成」并把已关闭项标注掉，或把该文件移到 `reports/` 归档；否则下一个接手的人会以为还有 185 个类型错误要修。

### 3.7 docs 行号引用核查结果：64 处，超界 0 处（5 处为外部/相对引用，需人工判读）

方法：正则抽取 `README.md` 与 `docs/*.md` 中形如 `path:LINE` / `path:A-B` 的引用，先在 DSH checkout 与仓库内按路径解析，失败再按 basename 在 `packages/`、`vendor/`、`apps/` 索引中定位，然后读该文件真实行数与引用区间比较。

- **行号超界：0 处。**
- **本仓与 DSH 侧引用全部有效**，抽查 10 处（要求 ≥10）：
  | 引用 | 状态 |
  |---|---|
  | README:109 / ARCHITECTURE:137 / PLAN:53、430 → `packages/sandbox/sandbox/src/index.ts:40-73` | 有效（该文件 183 行） |
  | ARCHITECTURE:18 → `packages/boot/app-boot/src/plugin-compatibility.ts:52-54` | 有效（104 行） |
  | ARCHITECTURE:51 → `packages/fs/fs-sandbox/src/index.ts:122-144` | 有效（148 行） |
  | ARCHITECTURE:60 → `packages/fs/fs-observation-policy/src/index.ts:119,122` | 有效（131 行） |
  | ARCHITECTURE:61 → `vendor/cordis/src/events.ts:234-243` | 有效（353 行） |
  | ARCHITECTURE:57 → `tool-str-replace-editor/src/index.ts:254/289/342` | 有效（basename 解析到 `packages/fs/tool-str-replace-editor/src/index.ts`） |
  | src/index.ts:6 → `packages/fs/fs-sandbox/src/index.ts:5-8,125` | 有效 |
  | src/config.ts:8-17 → `vendor/schemastery/src/index.ts:488-509`、`packages/llm/llm-deepseek/src/config.ts:88` | 有效 |
  | PLAN:415 → `packages/core/tools/src/index.ts:1493-1539` | 有效（1986 行） |
  | PLAN:423/424/425/426 → `fs/src/index.ts:59`、`fs/src/types.ts:11-15`、`fs-local/src/index.ts:133-138`、`tool-fs-search/src/search-core.ts:222-248` | 有效 |
- **5 处无法用自动化判读，需人工确认（不是已证伪）**：
  1. `README.md:142` 的 `lib/client.js:187`、`src/client.ts:163` —— 指的是 **`dsh-desktop-notify` 的产物**，不在本仓、也不在 DSH checkout 内；本仓无法校验（该段同时在说「这是上游的已知边界」，属外部事实）。
  2. `docs/PLAN.md:32` → `\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml:27-40` —— 用户本机 profile 文件，属外部路径。
  3. `docs/PLAN.md:105`、`:243` 的 `plugin-manager/src/index.ts:461-559`、`boot/plugin-manager/src/tools.ts:22-32` —— 相对路径写法，实际文件在 `packages/boot/plugin-manager/`；同文件 `:439`、`:434` 用全路径引用同一目标且行号有效，属**写法不统一**而非失效。

### 3.8 README 的「4 个既有扩展点」与当前挂载点数量不符

`README.md:15`「只经 **4 个**既有扩展点做增量拦截」。当前实际挂载（`src/index.ts`）：`ctx.on('tools/pre-execute')`（`:1259`）、`ctx.tools.guard()`（`:1286`）、`ctx.on('fs/write-intent')`（`:1370`）、`ctx.on('fs/edit-intent')`（`:1371`）、`ctx.on('tools/post-execute')`（`:1396`）、`webServer.register({ path: '/path-guard/tools' })`（`:1494`）。即 **6 处**（若把两个 fs-intent 记作一层、HTTP 路由不算拦截，则是 4；口径不同结论不同）。
**建议**：把这句话改成可核对的形式（「不接管服务、不覆盖上游 row；挂载点清单见 `<file:line>`」），避免数字口径漂移。

### 3.9 README 的开发提示仍写 `client/client.js`

`README.md:58`「客户端半页（`client/client.js`）**热重载**」——源文件现为 `client/client.ts`，产物才是 `lib/client/client.js`（`package.json:12`）。宿主半页那句（`:59` 的 `src/*.js`）同理。

### 3.10 `src/index.ts` 模块注释与新的分层口径不一致

`src/index.ts:14`「**`tools/pre-execute` is the authority on paths, not `ctx.tools.guard()`**」。这句在原文语境里是在说「异步路径判定不能放在同步 guard 里」（理由 `:15-19` 成立、无需改），但用词是 "the authority on paths"，与 ARCHITECTURE §2.1/§4.0 和 README:106 的新口径（**写侧权威 = `fs/*-intent`；`pre-execute` = 上层快速检查**）冲突。同文件 `:1335` 附近的 fs-intent 注释已是新口径。
**建议**：把 `:14` 改成「`tools/pre-execute` 是**读侧与快速预检**的路径判定点；写侧最终权威是 `fs/*-intent`（见 `:1335` 与 `docs/ARCHITECTURE.md` §2.1）」。

### 3.11 未使用文案键 `required`（zh + en 各一条）

脚本核对结果：zh 69 键与 en 69 键集合完全相同、无缺失；在展开 `${key}Hint` 模板、`label(okKey)` 动态键（`'saved'`）与 `saveFailed` 字面量之后，**唯一未被任何 `label()` 路径使用的键是 `required`**（`client/client.ts:445` zh「必填」/ `:558` en「Required」）。
**建议**：删除这两个键，或补到某个必填字段的 UI 上（它看起来是为规则表校验预留的，但当前草稿式表格不做校验）。

### 3.12 ACCEPTANCE 的「尚未在活体上跑」段落已持续两周未更新

`docs/ACCEPTANCE.md:25-26`：「尚未在活体上跑的是第 2 节里依赖 `D:\dsh-path-guard-fixture` 的那些条目（隐藏目录、符号链接绕过、超限搜索的 spill 行为）——夹具与步骤都已就绪，随时可跑。」
`D:\dsh-path-guard-fixture` 的夹具脚本 `scripts/make-fixture.ps1` 存在，但 §6（`:181-216`）的活体验收没有覆盖这些条目。这不是代码欠缺，而是**验收状态陈述过期**：要么补跑，要么明确写「本轮不跑」。

---

## 4. 两向差异总表（声明 vs 实现）

**文档说了、代码没有**：

| 文档位置 | 声称 | 实际 |
|---|---|---|
| README:48 | `~/.ssh`/`~/.aws`/`~/.gnupg`/`~/.docker` 一键加规则 | 功能已删除（`client/client.ts:911-912`），全仓无 `.aws`/`.gnupg`/`.docker` |
| README:38-44 | 配置页注册在 3 处，含 `settings.section` 导航项 | 只注册 2 个槽（`plugins.row.config`、`plugins.bundle.config`） |
| README:52 | 「怎么用？看四个例子」页内展开 | 折叠已移除，说明常驻（`client/client.ts:372-375`） |
| README:29-31 / 221-225 | 无需构建步骤、纯 JS、`node --test tests/*.js` | `exports → lib/`、有 `build` 脚本、spec 全是 `.ts` |
| README:176 | 路由响应 `{ tools: [...] }` | `{ tools, lastUnmodelledAt, records }`（`src/index.ts:1520`） |
| README:15 | 4 个扩展点 | 实际 6 处挂载（口径见 §3.8） |
| ARCHITECTURE:162-164 | 证据见 `docs/UI-REVIEW.md` | 文件不存在 |
| ARCHITECTURE:81-84 | `resolveResources(toolName,args)`、导出清单 | 三参（`resource.ts:737`）、多一个 `RESOURCE_FREE_TOOLS` |
| ARCHITECTURE:63-66 | 服务接管「待重新确认」 | §4.0 ① 已明确否决 |
| TS6-MIGRATION:3,32-41,136 | 迁移「进行中」，余 185 个类型错误，客户端装载待验证 | `npm run typecheck` 0 报错；客户端装载已由 ACCEPTANCE §6 #9 验证 |

**代码有、文档没写**：

| 代码位置 | 能力 | 文档状态 |
|---|---|---|
| `src/tracking.ts`（429 行）+ `src/index.ts:1017-1026` + `src/resource.ts:737` | 拒绝自学习、同族泛化、按学到的字段名判定 | 三份主文档零描述（§1.6） |
| `src/index.ts:193,441-482` | 持久化文件 `path-guard-tools.json`（防抖写、卸载冲刷、坏文件容错） | 无任何文档提及 |
| `src/index.ts:1510-1520` | 路由的 `lastUnmodelledAt` / `records` 字段 | README 只写 `tools`（§1.5） |
| `src/config.ts:123` | `unknownTools: check \| deny` | 全部 `.md` 零提及（§1.7） |
| `client/client.ts:1960-1971` | 「为何只注册两个槽」的核对结论 | 只在代码注释里（§2.2） |

---

## 5. 机械生成：「没有测试直接引用的导出」清单

方法：对 `src/**`、`client/**` 抽取全部 `export function|const|class|interface|type|enum`，统计标识符在「声明文件自身」「其它 src/client 文件」「`tests/**`」中的出现次数（词边界匹配），再判定是否被某个「测试直接引用的导出」所在文件引用（文件级可达性）。**这是名字级近似，不是执行级覆盖**，所以「间接可达」只表示「有一条从被测入口出发的引用路径」。

- **导出总数 68；声明之外零引用的导出：0 个**（无真死导出）。
- **`tests/**` 中零次出现的导出：27 个**，其中：
  - **10 个导出函数**（全部「间接可达」，即被 `src/index.ts` 或 `src/resource.ts` 引用，而这两者有 spec）：
    `denialText`、`shellDenialText`、`installSourceDenialText`、`unknownToolDenialText`、`exoticDenialText`、`selfDenialText`、`internalErrorText`、`redactionBlockedText`、`redactTextBlocks`、`scriptOf`。
    → 其中 4 个的**正文断言深度**不足，见 §2.1；其余是纯 helper。
  - **6 个类型/接口**（编译期符号，运行时不可能被测试「引用」，属正常）：
    `RuleInput`、`Needle`、`TrackedField`、`ToolRecord`、`Tracking`、`TrackingSnapshot`。
  - **11 个常量**（9 个仅本文件内或经被测文件间接使用，2 类属公共面）：
    `config.ts` 的 6 个取值清单 `DEFAULT_ACCESS_VALUES`/`SHELL_VALUES`/`EXOTIC_VALUES`/`UNKNOWN_TOOL_VALUES`/`NOTIFY_VALUES`/`ACCESS_VALUES`（最后一个另被 `fs-guard.ts` 引用，属 schema 公共面，故意导出）；
    `resource.ts` 的 `RESOURCE_FREE_TOOLS`（仅本文件内使用，`:258`）；
    `tool-fields.ts` 的 `OP`/`SCRIPT_TOOLS`/`EXOTIC_TOOLS`/`EXOTIC_TOOL_PREFIXES`（均被 `resource.ts` 引用，间接可达）。
  - 计数核对：10 函数 + 6 类型 + 11 常量 = **27**，与「tests 零出现」的总数一致。
- **每个 `src/*.ts` 模块的 spec 对应关系**（脚本按 import 语句判定）：
  `policy`→policy.spec ✓、`resource`→resource.spec ✓、`fs-guard`→fs-guard.spec ✓、`index`→host.spec ✓、`redact`→redact.spec ✓、`notify`→notify.spec ✓、`tracking`→tracking.spec ✓、`scan`/`tool-fields`→host.spec（+resource.spec）✓、**`config.ts` 与 `deny.ts` 无专属 spec**（`config` 经 `host.spec.ts:17` 的 `Config` 与 host 集成用例间接覆盖；`deny` 的 8 个文案函数经 host.spec 触发，断言深度见 §2.1）。
- **样式键**：`STYLE` 36 键**全部被引用**（0 未用）；`SWITCH` 4 键全部被引用；`CONTROL` 的 10 个「未引用」项是 CSS 属性名本身（对象被整体 spread 使用），非死键。

---

## 6. 复查建议（给 Lead）

1. §1.1–§1.5 是**五分钟内可改完的 README 修正**，其中 §1.3/§1.4 会直接害到下一个照做的人，建议优先。
2. §1.6/§1.7 需要写新文档段落，建议与 `tracking.ts` 的模块注释对齐措辞，避免又产生一次「代码注释 vs 文档」漂移。
3. §3.6（TS6-MIGRATION「进行中」）与 §3.7（行号引用 0 失效）一起看：文档的行号卫生很好，坏的是**状态描述**——即「写下的东西准，但没更新」。
4. 本报告未发现：真死代码、缺失的 spec 文件、未接线的配置字段、locale 缺失键、失效的行号引用。这几项可以当作已核对。
