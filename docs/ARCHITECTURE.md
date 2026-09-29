# 架构评审与重构计划

> 基线：DSH `0.2.0-rc.2`（已从 0.1.7-rc.2 升级）· 插件 `dsh-path-guard`（宿主侧纯 JS，20+ 提交，143 项测试）
> 本文记录 2026-09-30 评审提出的问题、已确认的证据、以及分阶段的重构计划。

## 0. 兼容性结论（0.2.0-rc.2）

**运行时兼容：通过。** 升级后插件仍正常加载并工作——评审期间的 `pwsh` 调用被它连续拦截两次
（命令行含受保护路径字面量），说明 guard / 路径策略 / 自我保护在 0.2.0-rc.2 上行为正常。

**已补的声明**：`package.json` 增加

```json
"peerDependencies": { "@deepseek-ai/dsh": "^0.2.0-rc.2" },
"engines": { "node": ">=22.19.0" }
```

依据 `packages/boot/app-boot/src/plugin-compatibility.ts:52-54`：`@deepseek-ai/dsh` 与
`@deepseek-ai/dsh-*` 的 peer 会被逐个校验，且**预发布版本参与范围匹配**，因此
`^0.2.0-rc.2` 能匹配当前运行时与后续 0.2.x，并会在 0.3 上正常拒绝（那时应当重新验证）。

## 1. 已确认并修复的问题

### 1.1 `shell: scan` 对带通配符的规则静默漏检（严重，已修）

**实测证据**（修复前）：

| 规则 | needle 数 | `cat <home>/.ssh/id_rsa` |
|---|---|---|
| `.ssh`（无通配） | 12 | hit |
| `.ssh/**` | 12 | **MISS** |
| `.ssh/*` | 12 | **MISS** |
| `D:/secrets/**` | 2 | **MISS** |

根因：`buildNeedles` 把 pattern **原样展开**，`**` / `*` 作为字面字符进入 needle，
而真实命令里永远不会出现 `**`。更糟的是 needle 数不为 0，所以「无 needle 则拒绝」的
兜底也不会触发——**静默 fail-open**。

修复（`src/scan.js`）：新增 `literalNeedlePrefix()`，先取 pattern 的字面前缀再展开。
- 可归约：尾部通配且在段边界上 → `.ssh/**` → `.ssh` ✅
- 不可归约：段内通配（`D:/sec*`）、尾部有字面量（`D:/a/<any>/secret`）→ 不生成 needle，
  由 `unscannablePatterns()` 收集，并在激活/改配置时 **warn 列出**，不再静默。

## 2. 架构级问题（待重构）

### 2.1 核心授权停在 `tools/pre-execute`，不是最终文件系统权威层 —— 最严重

现状链路：`tool call → pre-execute → ctx.fs.resolve() → 判定 → 允许 → 工具自己再 resolve → 真正读写`。
检查到的 `FsTarget` 不是之后实际使用的那个目标，存在 check-then-use 竞态。

DSH 自己的做法（`packages/fs/fs-sandbox/src/index.ts:122-144`）：在真正 `writeText`/`editText` 前
**再次 canonicalize，并用新得到的 target 执行写入**，以缩小 symlink 交换窗口。

**计划**：
1. `fs/write-intent` / `fs/edit-intent` 是 waterfall 且携带**已解析**的 `FsTarget`，可 `throw` 否决——
   把它们接成**权威写否决层**（`src/fs-guard.js`，已完成）。覆盖范围**比初稿写的大**：
   `str_replace_editor` 也派发这两个事件（`tool-str-replace-editor/src/index.ts:254/289/342`），
   并不像本文件初稿说的那样"不走它们"。
   **注册顺序是硬约束**：`fs-observation-policy` 刻意不调用 `next()` 以占据唯一决策槽
   （`packages/fs/fs-observation-policy/src/index.ts:119,122`），而 waterfall 按注册序执行、
   不调 `next()` 即截断整条链（`vendor/cordis/src/events.ts:234-243`）。所以本层必须
   **`{ prepend: true }` 注册在最外层**，否则永不执行 = 静默 fail-open。
2. 评估**接管 `ctx.fs`**（`SandboxedFileSystem` 子类）作为最终权威层，用
   `ctx.agents.currentInitiator()` 区分 AI 与用户，避免连 GUI 一起挡。
   读侧**没有对应的 intent 事件**，所以这是唯一能覆盖读侧 TOCTOU 的做法，代价是接管一个上游 row
   （用户此前否决过服务接管，待重新确认）。
3. 明确分层语义：**pre-execute = 上层快速策略检查**；`fs-intent` = 写侧最终权威；`ctx.fs` = 读侧最终权威（若接管）。

### 2.2 `PATH_TOOLS` 是静态工具名单 → 天然 fail-open

DL：`tool → path string → policy`，且**没列进 `PATH_TOOLS` 的工具直接放行**。
DSH 的工具系统是开放注册的（第三方工具、MCP、动态注册），所以现在的安全模型是
「我认识这个工具 → 能管；不认识 → 放行」，而不是「这个操作在访问某个资源 → 能管」。

**计划**：从 **tool-name policy** 转向 **resource/capability policy**。
- 统一 capability 词表：`read` / `write` / `list` / `enumerate` / `export` / `execute`。
- 未知工具若参数里出现**路径形态的字符串** → **fail-closed**（可配置），而不是静默放行。
- 让 `read` / `grep` / `lsp` / MCP `filesystem.read_file` / workflow / terminal
  都能投影到同一个授权模型。

### 2.2.1 已落地：`src/resource.js`（task-5）

导出 `CAPABILITY` / `KNOWN_TOOLS` / `OPAQUE_TOOLS` / `resolveResources(toolName,args)` /
`isGoverned(toolName)` / `policyAccessFor(capability)`。41 项测试通过，`tool-fields.js` 暂未改动。

**接线时不可违反的四条**（`resource-policy` 的实测边界，未接线 = 仍是旧的静态表语义）：

1. `known:false && resources.length>0` ⇒ **必须拒绝**，并附上它给出的 `reason`
   （「工具未建模但参数疑似路径」）。
2. **不能只凭「参数名像路径」就拒绝**：名字腿偏宽，`{dir:'asc'}` 会被判成 LIST、
   `{target:'all'}` 会被判成 WRITE。**必须要求取值形态也像路径**（或由用户在配置里明确开启严格模式），
   否则会大面积误拦——这正是 0.1.x 阶段反复出现的「错误拦截」。
3. **不透明工具（`opaque:true`）且 `resources` 为空、`reason` 为 undefined** ⇒ 路由到 scan 通道，
   **不得直接放行**（那是 fail-open）。
4. **内嵌路径识别不到**：`{content:'see C:/tmp/x'}` 这类只在字符串内部出现、非起始锚定的路径不报，
   只有 `opaque` 通道能覆盖。这是已知的 fail-open 面，接线时必须写进 README 的「挡不住」表。

**`present` 的能力投影 = `EXPORT → list`（裁决）**：`present` 只取 `lstat`/`stat`/`resolve` 元数据，
不返回内容，所以模型得到的是「存在性 + 元数据」，`list` 档已足够；改成 `read` 会把「把文件呈现给
有权查看它的用户」也拒掉，没有安全收益。

### 2.3 `selfProtection` 是启发式自防御，不是策略不变量

现在做的是「阻止针对我自己的动作」+ 文本搜索 row id。已承认的绕过面：
动态生成 patch、`!!js` 计算 row id、注册表包不可预检。它能提供的**不是**强不变量。

**计划**：改为 **policy invariant**——
```
profile composition → validate → path-guard row 必须存在
                                 → 不得被 disable
                                 → policy source 不得被后续 patch 覆盖
                                 → 配置结构必须合法
```
并在不变量被破坏时**主动告警/拒绝**，而不是只在安装动作上做启发式拦截。

## 3. 中等问题（待重构）

| # | 问题 | 计划 |
|---|---|---|
| 3.1 | shell 扫描的通配符漏检 | ✅ **已修**（见 1.1） |
| 3.2 | 搜索结果脱敏用的是 `path.resolve()` 词法解析，而非 `ctx.fs.resolve()` 的 canonical identity | 脱敏统一走 canonical identity，与主路径判定同源 |
| 3.3 | Windows 路径模型不完整：UNC（`\\server\share` 被折成 `/server/share`）、`C:foo`、`\\?\`、`\\.\`、8.3、ADS、junction、大小写折叠 | 在 `policy.js` 里建立独立的 Windows 路径规范化层，不再借用 POSIX 语义 |
| 3.4 | `match()` 对每条规则×每个祖先都可能重建 regex；脱敏逐项重判 | `compile()` 预编译 matcher（按 workspace 缓存），必要时上 trie / 前缀索引 |

## 4. 迭代优先级（用户给定）

### 4.0 两项已拍板（2026-09-30）

**① 不接管 `ctx.fs`（用户明确决定）。** 因此 §2.1 只做到「写侧权威」：
`fs/write-intent` / `fs/edit-intent` 是写侧的最终权威层，`tools/pre-execute` 在上层做快速策略检查。
**读侧没有对应的 intent 事件**，所以读侧 TOCTOU 保持「上层快速检查」的定位——这不是遗漏，而是一个
被明确接受的边界：读侧防护依赖 `ctx.fs.resolve()` 给出的 canonical 身份，而不是「检查与使用之间没有窗口」。
README 的「挡不住」表必须写明这一条。

**② opaque 通道（shell / workflow / terminal）：不在插件侧继续加复杂度，但也不能现在就交给 sandbox
（Lead 决策）。** 事实依据：DSH 的沙箱策略词表只有 `mode` + 一个 `workspaceRoot` + 可选 `sessionId`
（`packages/sandbox/sandbox/src/index.ts:40-73`），**没有路径 deny 列表**，因此
「shell → sandbox executor + path deny policy」这条路上**当前没有可表达的接口**。决定：
- 保留 scanner 作为**明确标注为 best-effort 的辅助层**（不再改造成半吊子 parser，也不再扩充语法支持）；
- 把「DSH 需要为 sandbox policy 增加 path deny 能力」记为**上游前置条件**，待其具备后再把
  shell/workflow 的路径约束迁过去；
- 期间 `shell: deny` 是唯一真正堵住该通道的档位，配置页文案已如此表述。

1. **Resource Identity Policy**（对应 2.2）：`tool → operation → resource identity → capability decision`
2. **canonical target 成为策略核心对象**（对应 2.1）：
   `raw path → ctx.fs.resolve() → FsTarget → PolicyEngine.authorize(target, operation)`
3. **opaque execution 交给 sandbox**：不在 shell/workflow scanner 上继续加复杂度，
   而是把 `shell → sandbox executor`、`terminal → 沙箱后端`、`workflow/run_code → 受限运行时`，
   与 DSH 既有的 `sandbox` / `sandboxPolicy` / `bash-sandbox` / `fs-sandbox` 组合，
   做 **dsh sandbox + path deny policy**，而不是自造 shell 安全模型。
4. **Policy Invariant / Anti-Tamper**（对应 2.3）
5. **对抗性测试**，标准是「模型能否通过另一条 capability channel 得到同一个 resource」，
   而不是「这个工具名有没有被测试过」。重点：symlink race、junction、UNC/NT 路径、
   大小写别名、8.3 别名、并发工具调用、workspace 切换、新注册工具、MCP 工具、
   组合变更、搜索 spill、terminal 状态、workflow 混淆。

## 5. 工程形态

- **TS 6.0 重写，并为 TS 7 铺路**。顺序必须**先架构后迁移**，否则 TS 迁移要做两遍。
  迁移时的硬要求：保持零构建发布（`install_bundle` 不构建包，必须随包发布编译产物）、
  保持 `Config` 的 schemastery 语义、保持纯 JS 可加载性（必要时同时发布 `lib/` 与 bundle 入口）。
- **前端界面**：使用 DSH 标准字体与样式 token。关于「设置界面 + 插件页面」重复出现：
  需先确认这是否是 DSH 自身的标准设计（其他官方插件是否也两处都注册），
  **是标准设计则不额外修改，不是则只保留插件页面**。证据见 `docs/UI-REVIEW.md`（待补）。
- **路径函数增强**：支持按**文件名**豁免（如所有 `readme.md` 一律可读）、大小写智能匹配。

## 6. 不在本轮范围

- 内核级隔离（DSH 的 ACL 沙箱无法表达按路径 deny，见 `docs/PLAN.md` §1.3）。
- 已明确写在 README「挡不住」表里的通道。
