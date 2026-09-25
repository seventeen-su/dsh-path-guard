# dsh-path-guard 实施计划

> 目标 DSH 版本：`0.1.7-rc.2`（检出 `D:\Program\deepseek-harness`，`package.json` 版本 `0.1.7-rc.2`）
> 当前 profile：`web`（`DSH_PROFILE_DIR=C:\Users\SuSeventeen\.dsh\profiles\web`）
> 文档状态：**第 2 版，待评审**（第 1 版已被研究结论推翻，见 §0）

---

## 0. 本版相对第 1 版的修订（先看这里）

第 1 版打算**接管 DSH 的 `ctx.fs` / `ctx.subprocess` / `ctx.shell` 三个服务**。两份深度研究报告完成后，两个承重前提被推翻：

| 第 1 版的假设 | 实际（有据） | 影响 |
| --- | --- | --- |
| 可以用「服务类默认导出 + 覆盖上游 row」接管 `ctx.fs`，只对 AI 生效 | 能接管，但 `ctx.fs` 还同时服务 GUI 文件树（`api/workspace-files`）与 prompt 装配（`agent-instructions`、`skill-filesystem`），会**连人一起挡**；且 `ctx.fs` **无法被增量包裹**（Cordis `provide` 拒绝重名；`internal/get` 会被 `ctx.get('fs')` 绕过，有 7 处真实消费者）| 放弃接管 |
| 可以在 `ctx.subprocess` 层给 ripgrep 注入 `--glob=!<路径>` 排除 | 技术上可行，但要接管一个**所有子进程共用**的中枢服务 | 放弃接管（理由见 §4.2，**不是**因为性能） |

**所以你提出的「不要接管、改用增量劫持」是对的方向**，而且比我原方案更省事：

- 新版**不替换任何现有服务、不覆盖任何上游 row**，只插入自己的一个 row；
- 全部防护通过 **4 个已有的扩展点**完成：`tools/pre-execute`（异步、可 await 真实路径）、`ctx.tools.guard()`（同步兜底）、`fs/write-intent`/`fs/edit-intent`（已解析目标的写否决）、`tools/post-execute`（结构化结果改写）；
- 「增量劫持」体现在 **`tools/post-execute` 直接改写工具的结构化 `value`**（不是解析渲染后的文本），`glob` 的路径列表、`grep` 的匹配项都以 JSON 结构到达，改起来精确、无格式漂移风险。

同时按你的其余三条答复改：拒绝语义改成**明确拒绝 + 禁止绕过 + 引导向用户申请**（§5）；`plugin_manager` **保留**，改为精确拦住「针对本插件自身」的那些动作（§6）。

---

## 1. 问题与目标

### 1.1 问题

当前 profile 默认 `danger-full-access`（`C:\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml:27-40`）。该档位下 DSH 文件沙箱完全不设限：

- `packages/fs/fs-sandbox/src/index.ts:5-8` —— "Reads pass through untouched: every mode permits reading."
- 同文件 `:125` —— `if (mode === 'danger-full-access') return target`，写也不围栏。
- `packages/shell/pwsh-sandbox/src/index.ts:99-104` —— shell 在同一档位直接委托本地执行器。

### 1.2 目标

| 编号 | 需求 | 验收方式 |
| --- | --- | --- |
| G1 | `danger-full-access` 下受保护路径无法被 AI 读取 | 端到端：模型调 `read` 被拒 |
| G2 | 档位一「完全无访问」：拿不到内容，也拿不到目录结构/文件名 | `read`/`glob`/`grep` 均不暴露 |
| G3 | 档位二「半访问」：可见文件名与结构但不可读内容；或可读不可写 | 三种能力独立可配 |
| G4 | 豁免：更具体路径覆盖更宽泛路径（`.ssh/**` 半访问，`.ssh/README.md` 可读） | 策略单测 + 端到端 |
| G5 | 通过 0.1.7-rc2 前端插件页面配置，热生效 | Settings → 内置插件 / Plugins 页改一项立即生效 |
| G6 | 不影响用户自己用 GUI 浏览同一路径 | 文件树/编辑器仍可打开被保护文件 |
| G7 | 可审计：每次拒绝有日志、可看当前生效策略 | Host 日志 + 页面状态区 |
| G8 | **不接管任何现有服务**，不改变既有权限档位语义 | 代码审查 + 卸载后无残留 |

### 1.3 非目标

- 不做内核级隔离。研究报告确认：**现有 `sandbox-windows-acl` 无法表达「按路径拒绝」**——它的策略词汇只有 `mode` + 一个 `workspaceRoot` 允许根 + 可选 `sessionId`（`packages/sandbox/sandbox/src/index.ts:40-73`），没有 deny 列表字段。原计划的 M6 因此**不可行**，已删除。
- 不阻止用户本人访问。
- 不加密、不隐藏文件。

---

## 2. 侦察结论（关键事实）

### 2.1 防护管线在完全权限下依然生效

`packages/core/tools/src/index.ts` 中没有任何地方读沙箱策略，`tools/pre-execute`、`ctx.tools.guard()`、`tools/post-execute` 在**所有档位下行为一致**（对照 `:1493-1539` 的执行准备流程，无 `sandboxPolicy` 读取、无早退）。

### 2.2 AI 文件访问分成三类，只有 A 类能被完全拦

| 类 | 表面 | 底层通道 | 可拦性 |
| --- | --- | --- | --- |
| **A** | `read`、`write`、`edit`、`read_image`、`str_replace_editor`、`present`、`lsp` | `ctx.fs` | ✅ 调用层可拦 |
| **B** | `glob`、`grep` | 打包 ripgrep 经 `ctx.subprocess`，**从不经过 `ctx.fs`、也不调 `ctx.sandbox.confine`**（`tool-fs-search/src/search-core.ts:222-248`，该包连 `'sandbox'` 都没注入）| ⚠️ 能拒绝调用、能改写结果，不能改参数 |
| **B'** | `mcp__*`、`cua_driver_native__*` | 外部进程，schema 由服务端给 | ⚠️ 只能按工具名拒绝 |
| **C** | `bash`、`pwsh`、`terminal_*`、`run_code`、外部 `subagent-claude-code`/`-codex`/`-acp` | 真实 OS 进程 | ❌ 插件层拦不住 |
| **D** | 指令文件 → 系统提示、skill 正文 → 上下文 | `ctx.get('fs')`，`agent-instructions` 还有裸 `node:fs` 兜底（`files.ts:146,330`）| ❌ **没有工具调用可拦** |

C 类不可拦的原因是结构性的：`run_code` 是一个真实 Node/Python 进程（`ptc-runtime-node/src/index.ts:68` 明说 "Node APIs are available through `await import(...)`"；`ptc-runtime-python:1038` 直接报 "sandbox policy is unsupported"），shell 命令串是图灵完备的，任何参数分析都不健全。**这一条必须如实告诉用户，不能靠文案掩盖。**

### 2.3 四个扩展点的确切契约

| 扩展点 | 契约 | 我们用它做什么 |
| --- | --- | --- |
| `tools/pre-execute`（waterfall，**异步**）| `(exec, next) => Promise<PreToolDecision>`；`PreToolDecision = allow \| deny{reason,info?} \| cancel \| ask{reason?}`（`:607-611`）。**不能改参数**（`:604-605` 明确排除）| **主决策点**：可 `await ctx.fs.resolve()` 拿到真实路径后判定 |
| `ctx.tools.guard()` | `(exec) => string \| undefined`，**同步**、只能拒绝、与注册顺序无关（`:723-731`、`:1136-1142`）| 同步词法兜底 |
| `fs/write-intent` / `fs/edit-intent` | waterfall，携带**已解析**的 `FsTarget`，签名里可 `throw` | `write`/`edit` 的写否决 |
| `tools/post-execute`（waterfall）| `PostToolDecision = accept{content?} \| accept{value} \| block{feedback}`（`:617-620`）| **结构化脱敏**：`value` 会重跑 `render` 与 `presentationMeta`，连持久化 `meta` 一起干净 |

执行顺序：`pre-execute` →（`ask` 走审批）→ `guard` → 调用工具体（`:1504-1535`）。guard 在 pre-execute **之后**且单调，任何监听器都无法把拒绝翻回来。

**三个容易踩的细节**（都会写进实现约定）：
1. `{kind:'accept', value}` 才会重算 `meta`；`{kind:'accept', content}` 只换模型可见文本，**不会**清掉持久化投影。脱敏必须用 `value`。
2. `value` 与 `content` 同时给会抛错；对**失败**结果给 `value` 也会抛错（`:1796-1806`）。必须先判 `isError`。
3. `{ prepend: true }` 在 Cordis 里是 `unshift`，即**最外层、最后发言**（`vendor/cordis/src/events.ts:255`）。脱敏监听器必须 `prepend`，并且在前一个监听器已经给了 `value` 时让位（照抄 `spill-policy:135` 的 `Object.hasOwn(decision,'value')` 判断）。

### 2.4 工具入参与拒绝文案

- `exec.arguments` 在任何策略运行前已被**快照并深冻结**（`:1441-1445`），可以安全读。
- 拒绝原因会**逐字**以 `Error: <reason>` 形式进入模型上下文（`:1526`）。所以文案要按 §5 精心写。
- 全局 guard 覆盖**同进程**的子代理 / workflow / agent-team 子会话（`scope/src/index.ts:176` 的无 tag 监听器分支 + `guardReason` 无条件读 `layers.global`，`:1146`）。跨进程子代理（claude-code/codex/acp）不受管。

### 2.5 前端配置页机制

- 命名空间 = **profile 补丁里该 row 的 `id`**（`settings/src/index.ts:315,382`）。
- 自动生成页由 `settings` 服务投影 `Config` schema 得到；`ctx.settings.configure({ auto })` 默认 `auto: true`（`:266-277,312`）。
- ⚠️ **只有标记为 `.volatile()` 的 schemastery 字段才会出现在表单里**：`settings/src/index.ts:308` 用 `volatileForm(schema)` 过滤，没有 volatile 字段的 schema **直接不生成表单**（`:309 return []`）；写入非 volatile 字段会抛 `Config field "<path>" is not volatile`（`:388,406`）。→ **本插件的每个可编辑字段都必须 `.volatile()`**，这是 G5 的硬前提。
- 若要自研页面：配置页插槽是 `plugins.item`（list/root，`plugins.item` 的 `view: 'summary'|'page'`），也可以用 `plugins.row.config`（key = `<包名>#<row id>`）。范例：`packages/client/ui-settings-agent-loop/src/client/index.ts:47-49`。
- `install_bundle` **只跑 `pnpm add`，不会构建包**（`plugin-manager/src/index.ts:461-559`）。→ 若做客户端半页，**必须直接发布手写的 `client.js`**（`apps/web/tests/fixtures/plugins/fixture-live-client/` 是唯一完整的纯 JS 可安装范例）。

### 2.6 现在这个会话的 GUI

客户端插件的热重载需要同一检出里 `pnpm run dev:web` 在跑。本插件**默认不带客户端半页**（§8 说明为什么），所以不受此约束。

---

## 3. 策略模型

### 3.1 能力档位

| `access` | 列目录 / 看结构 | 读文件内容 | 写 / 改 / 删 |
| --- | --- | --- | --- |
| `none` | ✗ | ✗ | ✗ |
| `list` | ✓ | ✗ | ✗ |
| `read` | ✓ | ✓ | ✗ |
| `write` | ✓ | ✓ | ✓ |

对应你的三种语义：完全隔离 = `none`；可见结构不可读内容 = `list`；可读不可写 = `read`。

### 3.2 规则与豁免

```yaml
rules:
  - path: "~/.ssh"
    access: list          # 半访问：能看到 .ssh 里有哪些文件名
  - path: "~/.ssh/README.md"
    access: read          # 豁免：更具体 → 覆盖上一条
  - path: "D:/secrets/**"
    access: none
```

**匹配**：对目标的**真实规范路径**，收集所有「自身或祖先」命中的规则，取**最具体**的一条：

1. 字面量前缀更长者优先；
2. 通配符更少者优先；
3. 仍相同则表中靠后者优先（`last-wins`）。

未命中任何规则时用 `defaultAccess`（默认 `allow`，保持向后兼容）。

> 取舍：用「最具体命中」而不是「首条匹配」，豁免天然成立（`.ssh/README.md` 比 `.ssh` 具体），不需要 `exempt` 字段或否定语法。

### 3.3 路径判定必须基于解析后的身份

`FsTarget.targetKey` 文档明确标注 opaque，**禁止解析**（`fs/src/types.ts:11-15`）。判定一律：

1. `await ctx.fs.resolve(raw, { cwd: exec.agent?.session.header.cwd })`（`fs-local/src/index.ts:133-138` 会 realpath）；
2. 用 `ctx.fs.contains(rootTarget, target)` 或 `ctx.fs.processPath(target)` 比较，**不拼字符串前缀**。

这条直接决定 §2.3 里「主决策点必须是异步的 `tools/pre-execute`」——同步 guard 只能做词法匹配，而**工作区里一个指向 `~/.ssh` 的符号链接就能骗过纯词法判定**。

### 3.4 残留 TOCTOU

resolved 判定与工具体自己再 `resolve` 一次之间存在窗口。这与 `fs-sandbox` 自己声明的威胁模型一致（`fs-sandbox/src/index.ts:10-18`：「This is containment, not a security boundary … residual TOCTOU … is accepted for this threat model」）。如实列在 §9。

---

## 4. 架构：纯增量，不接管服务

```
  AI 工具调用
      │
      ├─ L1  tools/pre-execute（异步）      ← 主决策：resolve 真实路径 → 按档位 允许/拒绝
      ├─ L2  ctx.tools.guard()（同步）       ← 词法兜底，顺序无关
      ├─ L3  fs/write-intent / fs/edit-intent ← write/edit 的写否决（已解析目标）
      ├─ L4  tools/post-execute（prepend）   ← 结构化脱敏 glob/grep/shell 的 value
      ├─ L5  不可拦表面的按名拒绝（可配）     ← bash/pwsh/terminal_*/run_code/subagent*/mcp__*
      └─ L6  自我保护                        ← 拦住针对本插件与 profile 组合的动作
      ┌──────────────────────────────────────────────────────────┐
      │ L0 策略引擎（pathGuard 服务）— 上面各层的共同大脑          │
      │ 配置来自前端页面；纯函数核心，可单测                       │
      └──────────────────────────────────────────────────────────┘
```

### 4.1 L4 为什么用「改写结构化 value」而不是解析文本

`glob` 的返回值是路径列表、`grep` 的返回值是带上文件路径的匹配项——都是 JSON 结构，在 `tools/post-execute` 里能精确按条剔除，不存在「解析渲染文本」的格式漂移问题。这正是你说的**增量劫持**：不动服务，只改这一次调用的结果。

- `glob`：剔除命中 `none` 的路径（`list`/`read` 的文件名照常出现 → 满足 G3）。
- `grep`：剔除命中 `none` **或** `list` 的匹配项（`grep` 带内容，所以 `list` 也不能给内容）。
- 判不准时 **fail-closed**：整体 `{kind:'block'}`，宁可少给结果。

### 4.2 为什么最终没有去劫持 `ctx.subprocess`（回答你的问题）

**`ctx.subprocess` 是什么**：DSH 抽象出来的**子进程服务**，是「跑一个子进程」的唯一接缝——`packages/subprocess/subprocess/src/index.ts:117` `abstract class SubprocessRuntime extends Service`、`:153` `abstract spawn(spec)`，由 `@deepseek-ai/dsh-subprocess-local` 在 row `subprocess` 注册（`packages/bundle/base/cordis.patch.yml:219-220`）。走它的人包括：`pwsh`/`bash` 执行器、`glob`/`grep` 背后的 ripgrep、终端、以及跨进程子代理。

**第 1 版为什么想接管它**：在 ripgrep 的 argv 里插 `--glob=!<受保护路径>`，让 ripgrep **根本不去打开**受保护文件。相比「读完再删结果」，这是结构性保证。

**为什么放弃**，两个理由，**第一个才是我真正在意的，不是性能**：

1. **爆炸半径**（真实理由）：它是所有子进程的必经之路。包装函数本身很便宜（每次 spawn 一次函数调用 + 一次 argv 扫描，不是逐字节成本），但一旦这里出错，受影响的是 shell、终端、搜索、子代理——是整台机器，不是本插件。收益（搜索层多一层结构性保证）与这个风险不成比例。
2. **收益可以用更小的代价拿到大部分**：L4 的结构化脱敏对「模型看到什么」是等价的，且完全可回滚。

**代价我也如实说**（§9 有完整表）：L4 是「ripgrep 读到了、我们删掉了」。如果搜索结果超过内联上限，`search-core.ts:382-399` 会**把完整结果落盘为 spill 文件**（`suggestedName: 'grep-results.txt'`），模型之后可能通过 `job_output` 拿到。这是我放弃 argv 方案后**唯一真正变差的地方**，已在 §9 列为已知缺口，并在 §12 留了「要不要为它单独做增量劫持」的决策点。

> 备选方案对比（互斥、二选一）：
> - **A. 接管 `ctx.subprocess` row**：结构性无泄漏，但动中枢服务，卸载/升级都要靠 row id 不变。
> - **B. 纯增量（本版选定）**：零服务接管、可回滚、覆盖「模型可见面」等价；残留 spill 缺口。
> - 选 B 的理由是爆炸半径与可回滚性；A 不是被性能否掉的。
> - **可证伪点**：如果实测发现 `grep` 在受保护目录上经常触发 spill，B 的缺口就从「理论」变成「常见」，那时应当重新评估 A，或对 `tool-fs-search` 的 `rawOutputMaxBytes` 做 row 配置覆盖（这是纯配置覆盖，不接管服务）。

---

## 5. 拒绝语义（按你的答复）

被拒时返回 `{ kind: 'deny', reason }`，文案逐字进模型上下文（`:1526`）。统一模板：

```
该路径已被用户通过 dsh-path-guard 明确禁止访问，这不是系统错误，也不是权限不足。

- 路径：<displayPath>
- 生效规则：<ruleId>（access: <none|list|read>）
- 当前禁止：查看内容 / 列目录与文件名 / 写入

不要尝试绕过此限制：换用其他工具、其他路径写法、相对路径、符号链接、大小写变体、
压缩/编码后再读、或通过 shell 命令间接读取，都会同样被拒绝，并且会被记录。

如果任务确实需要该路径，请向用户说明用途并请求其调整策略；经用户同意后由用户
在本插件的配置页修改规则。
```

要点：
- **明确说是「用户设定」**，不是 bug、不是 entitlement 问题；
- **点名禁止的绕过手段**（对应 §9 残余风险的常见路径）；
- **给出合法出口**（向用户申请），避免模型陷入死循环或反复重试；
- 对 `list` 档位读内容的场景，文案改成「该路径仅允许查看名称，不允许读取内容」。

模型可见的 `access` 档位名与拒绝原因会**同时写 Host 日志**（G7）。

---

## 6. 防绕过（保留 `plugin_manager`，精确拦截）

你问「能否在保留的情况下依旧阻止模型绕过」——**能，但要分层说清楚**。

### 6.1 拦住「针对本插件自身」的动作

`plugin_manager` 工具的参数是可见的（`boot/plugin-manager/src/tools.ts:22-32`：`action` ∈ `list_plugins|list_bundles|set_plugin|set_bundle|install_bundle|remove_bundle|list_version_exemptions|set_version_exemption`，加 `target`）。在 L1 里按参数拒绝：

| `action` | 拒绝条件 |
| --- | --- |
| `set_plugin` / `set_bundle` | `target` 命中本插件 row id 或本 bundle 包名 |
| `remove_bundle` | `target` 命中本 bundle 包名 |
| `install_bundle` | `target` 解析后指向本包（防「重装覆盖」）|
| `set_version_exemption` | `target` 以本包名开头 |

**列表类动作（`list_*`）一律放行**——保留可观测性，模型仍然能看到装了哪些插件。这满足你「保留但不让它绕过」的要求，也避免把工具整个禁掉带来的副作用。

### 6.2 堵住不经过 `plugin_manager` 的改写路径

模型还有别的办法关掉防护，需要一起堵：

| 路径 | 处置 |
| --- | --- |
| 用 `write`/`edit` 直接改 profile 的 `cordis.patch.yml` / `package.json` / `cordis.yml` | L1 内置**自我保护规则**：这些路径永远视为 `read`（可读不可写）。注意 `plugin_manager` **不**通过模型的 `write` 工具写文件（它走 Host 的 `configEditor`），所以这条**不会破坏正常装插件** |
| 用 `pwsh`/`run_code` 改上述文件 | L5 的 shell 扫描覆盖（尽力）；`deny-all` 档位直接禁掉 |
| 改本插件自己的配置（把规则清空）| 配置页写入走 Host `configEditor`，模型无对应工具；直接改补丁文件被上一条挡 |

### 6.3 诚实结论

这三层之后，「模型主动关掉防护」这条路径**从一条命令变成了需要连续绕过三层**，且每次都会留日志。但**不是绝对不可能**——C 类表面（§2.2）本就拦不住。所以 §12 仍保留「是否要把 `shell` 默认档位收紧」的问题。

---

## 7. 模块与文件结构

```
dsh-path-guard/
├─ README.md
├─ package.json          # bundle 清单：dsh.bundle.patch（纯 JS，无构建步骤）
├─ cordis.patch.yml      # 只 insert 自己的一个 row，不覆盖任何上游 row
├─ icon.svg
├─ locale/{zh,en}.json
├─ src/
│  ├─ index.js           # apply()：注册 pathGuard 服务 + 四个扩展点
│  ├─ policy.js          # L0 纯策略引擎（匹配/优先级/归一化），无 Cordis 依赖
│  ├─ config.js          # schemastery Config（每个可编辑字段 .volatile()）
│  ├─ paths.js           # 各工具的路径字段抽取表 + resolve 判定
│  ├─ deny.js            # 拒绝文案模板
│  ├─ redact.js          # L4：glob/grep/shell 的结构化脱敏
│  └─ self-guard.js      # L6：plugin_manager 参数拦截 + 自我保护路径表
├─ tests/
│  ├─ policy.spec.js
│  ├─ extract.spec.js
│  ├─ redact.spec.js
│  ├─ self-guard.spec.js
│  └─ e2e.spec.js
├─ docs/PLAN.md
└─ reports/              # 研究证据（只读留档）
```

`cordis.patch.yml` 全文：

```yaml
- insert:
    - id: path-guard
      name: 'dsh-path-guard'
      config:
        defaultAccess: allow
        rules: []
```

**没有 row 覆盖，没有服务接管。** row id `path-guard` 同时就是前端配置页的命名空间。

---

## 8. 配置 Schema 与前端页面

```js
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  defaultAccess: z.union(['none','list','read','write','allow']).default('allow').volatile(),
  rules: z.array(z.object({
    id: z.string().default('').volatile(),
    path: z.string().default('').volatile(),
    access: z.union(['none','list','read','write']).default('none').volatile(),
    note: z.string().default('').volatile(),
  })).default([]).volatile(),
  unfenceable: z.union(['deny','allow']).default('deny').volatile(),   // §2.2 C/B' 类表面
  shell: z.union(['off','scan','deny-all']).default('scan').volatile(),
  selfProtection: z.boolean().default(true).volatile(),
})
```

- **每个字段都 `.volatile()`**——否则表单不会生成（§2.5）。
- `unfenceable: deny`（默认）——对 `bash`/`pwsh`/`terminal_*`/`run_code`/`subagent*`/`mcp__*` 直接拒绝，`allow` 交给 shell 扫描。这是「安全 vs 可用」的主开关，默认偏安全。
- `selfProtection`——§6 的开关。

**页面形态**：默认走**自动生成的配置页**（命名空间 = row id `path-guard`），零客户端代码、零构建步骤、不受 `dev:web` 约束。
**自研页面**列为可选（§11 M5），只在自动页不够用时才做——它需要手写 `client.js`、`exports['./client']`、`dsh.client.platform: 'web'`，并注册到 `plugins.item` 插槽。

---

## 9. 残余风险（如实清单）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **shell / PTY / `terminal_send`** | 命令串图灵完备，任何参数分析都不健全 | `unfenceable: deny` 默认拒绝；`shell: scan` 只做尽力扫描 + 输出脱敏 |
| **`run_code`** | 真实 Node/Python 进程，可 `await import('node:fs')`；`ptc-runtime-python` 完全无围栏 | 同上，默认拒绝 |
| **跨进程子代理** | `subagent-claude-code`/`-codex`/`-acp` 有自己的一套权限模式（含 `bypassPermissions`）| 默认拒绝整个 `subagent` 工具 |
| **MCP 服务** | `mcp__filesystem__read_file` 是一等公民的绕过通道，参数 schema 由服务端定义 | 按工具名拒绝 |
| **搜索 spill 落盘** | 搜索结果超限时 `search-core.ts:382-399` 把完整结果写成 spill 文件，`job_output` 之后可能读到 | **本版已知缺口**；见 §4.2 决策点 |
| **prompt 期摄取** | `agent-instructions`（含裸 `node:fs` 兜底）与 `skill-filesystem` 走 `ctx.get('fs')`，**没有工具调用可拦** | 无——文档明示：放进指令文件/skill 目录的受保护内容挡不住 |
| **历史会话检索** | `session_*` 全文检索能捞回任何**曾被记录**的内容 | 无——一旦泄漏过就在日志里 |
| **L4 脱敏可被工具自身的 finalize 覆盖** | `:1649-1650` → `:1687-1692` 在 post-execute 之后跑 | 已审计：`read`/`write`/`edit`/`glob`/`grep` 都没声明 `finalizeContent`，当前无影响；升级后需复核 |
| **TOCTOU** | resolved 判定与工具体再 resolve 之间的窗口 | 与 `fs-sandbox` 同一威胁模型，声明接受 |
| **`str_replace_editor` 不派发 `fs/*-intent`** | L3 对它无效 | 已由 L1 覆盖；不依赖 L3 |
| **`lsp` 会拉起语言服务器** | 子进程自己读工作区，`hover`/`references` 可能漏内容 | 按路径拒绝调用；文档标注 |

---

## 10. 测试与验收

### 10.1 单元测试
- `policy.spec.js`：优先级（最具体胜出）、`~`/`${workspace}` 展开、Windows 大小写不敏感、祖先命中、last-wins、空规则表。
- `extract.spec.js`：各工具的路径字段抽取（`read`/`read_image`/`write`/`edit` → `file_path`；`str_replace_editor`/`present`/`lsp`/`glob`/`grep` 各自字段）。
- `redact.spec.js`：`glob` 只剔 `none`、`grep` 剔 `none`+`list`；`isError` 时不动 `value`；`Object.hasOwn(decision,'value')` 时让位；判不准时走 `block`。
- `self-guard.spec.js`：§6.1 的四类 `plugin_manager` 动作拦截；`list_*` 必须放行；profile 文件写保护。

### 10.2 端到端验收（本机真实运行）
1. 造 fixture：`D:\dsh-path-guard-fixture\{open,hidden,listed,ro}\` + 一个指向 `hidden` 的符号链接。
2. 安装 bundle，在配置页写规则。
3. 新开 session 逐条核对：
   - `read hidden/secret.txt` → 明确拒绝（§5 文案）；`glob '**/*'` → **不含 `hidden` 及其文件名**；`grep` → 无该文件任何内容。
   - `read listed/a.txt` → 拒绝但 `glob` 能看到 `a.txt`（G3）。
   - `write ro/b.txt` → 拒绝；`read` 成功。
   - `.ssh` 半访问 + `.ssh/README.md` 可读 → **豁免生效**。
   - **符号链接**指向受保护目录 → 同样被拒（验证走的是 realpath 而非词法）。
   - `pwsh Get-Content hidden/secret.txt` → 默认档位下拒绝（`unfenceable: deny`）。
   - 让模型 `plugin_manager set_plugin {target: path-guard, enabled: false}` → 拒绝（§6.1），而 `list_plugins` 正常返回。
4. GUI 文件树打开被保护文件 → **仍可打开**（G6）。
5. 配置页改一条规则 → 无需重启立即生效（G5）。

### 10.3 回归
- `read-only` / `workspace-write` 档位行为不变。
- 卸载 bundle 后无残留（无服务被改过，理论上天然满足 → 用第 3 条验收证明）。

---

## 11. 里程碑

| 里程碑 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| **M0** | 规划、git 初始化、计划文档、深度研究 | 本文件 + `reports/` | ✅ 完成 |
| **M1** | 骨架：`policy.js` + `config.js` + 单测；bundle 可安装；**验证自动生成配置页真的出现（且字段确实 `.volatile()` 生效）** | 可安装、页面可改配置 | 待办 |
| **M2** | L1 `tools/pre-execute`（resolve 真实路径判定）+ L2 guard 兜底 | G1、G3、G4、G6 | 待办 |
| **M3** | L3 `fs/*-intent` 写否决 + L4 结构化脱敏 | G2 | 待办 |
| **M4** | L5 不可拦表面按名拒绝 + L6 自我保护；审计日志与页面状态区 | G7、防绕过 | 待办 |
| **M5** | （可选）自研客户端页面（富表格、拖拽排序、拒绝日志面板）| 替代自动生成表单 | 待定 |
| ~~M6~~ | ~~Windows ACL 内核级~~ | **不可行**：现有 ACL 沙箱无法表达按路径拒绝（§1.3）| 删除 |

---

## 12. 待你确认的决策点

1. **`unfenceable` 默认值**：默认 `deny`（拒绝 `bash`/`pwsh`/`run_code`/`subagent`/`mcp__*`）最安全，但会显著改变你现在的使用体验（这一会话就在用 `pwsh`）。要不要默认 `deny`？
2. **shell spill 缺口**（§4.2）：是否接受「`grep` 大结果可能经 spill + `job_output` 泄漏」这一处已知缺口？若不可接受，唯一结构性解法仍是增量劫持 `ctx.subprocess.spawn`（**不是 row 接管**：只包装实例方法，卸载时还原），需要先做一个可行性验证（Cordis 服务实例是否可被安全地就地包装）。建议：先做 M1–M4，用真实数据决定。
3. **自我保护要不要挡 profile 文件写入**（§6.2）：会连带影响你以后让 AI 帮忙改 `cordis.patch.yml`。
4. **拒绝文案**：§5 的模板是否照用，还是要调整语气/详略。
5. **规则路径语法**：`~` / `${workspace}` / `**` 是否够用，还是要 `${env:VAR}`、正则。

---

## 附录 A：证据索引

| 事实 | 位置 |
| --- | --- |
| 读操作完全不过沙箱 | `packages/fs/fs-sandbox/src/index.ts:5-8` |
| `danger-full-access` 写也不围栏 | 同上 `:122-125` |
| 防护管线不读沙箱策略 | `packages/core/tools/src/index.ts:1493-1539` |
| `PreToolDecision` / `PostToolDecision` | 同上 `:607-611`、`:617-620` |
| 参数深冻结、不可改写 | 同上 `:604-605`、`:1441-1445` |
| guard 同步、单调、顺序无关 | 同上 `:723-731`、`:1136-1142`、`:1504-1535` |
| 拒绝文案逐字进上下文 | 同上 `:1526` |
| `value` 重算 `meta`；`content` 不会 | 同上 `:1796-1806`、`:1839`、`:1845-1853` |
| `finalizeContent` 在 post-execute 之后 | 同上 `:1649-1650`、`:1687-1692` |
| `prepend` = 最外层 = 最后发言 | `vendor/cordis/src/events.ts:255` |
| `fs/*-intent` 可 throw；`fs/observed` 不能 | `packages/fs/fs/src/index.ts:59,67,77` |
| `targetKey` 是 opaque，禁止解析 | `packages/fs/fs/src/types.ts:11-15` |
| `resolve` 做 realpath | `packages/fs/fs-local/src/index.ts:133-138` |
| glob/grep 走 ripgrep 子进程、不调沙箱 | `packages/fs/tool-fs-search/src/search-core.ts:222-248`；`src/index.ts:70` |
| 搜索 spill 落盘 | 同上 `:382-399` |
| `ctx.subprocess` 契约与 row | `packages/subprocess/subprocess/src/index.ts:117,153`；`packages/bundle/base/cordis.patch.yml:219-220` |
| shell 完全权限放行 | `packages/shell/pwsh-sandbox/src/index.ts:99-104` |
| ACL 沙箱无路径 deny 词汇 | `packages/sandbox/sandbox/src/index.ts:40-73` |
| `run_code` 是真实进程、Python 无围栏 | `packages/ptc-runtime/ptc-runtime-node/src/index.ts:68`；`packages/experimental/ptc-runtime-python/src/index.ts:1038,1046` |
| 全局 guard 覆盖同进程子代理 | `packages/core/scope/src/index.ts:176`；`packages/core/tools/src/index.ts:1146` |
| prompt 期摄取绕过工具层 | `packages/agent-instructions/src/files.ts:146,330`；`packages/skill/skill-filesystem/src/index.ts:843` |
| `plugin_manager` 参数 schema | `packages/boot/plugin-manager/src/tools.ts:19-32` |
| 配置页命名空间 = row id | `packages/settings/settings/src/index.ts:315,382` |
| 自动页默认开启 | 同上 `:266-277,312` |
| **只有 volatile 字段进表单** | 同上 `:308-309,388,406` |
| 配置写入 = 改补丁 + Loader 重放 | `packages/boot/config-editor/src/index.ts:75-142` |
| `install_bundle` 不构建包 | `packages/boot/plugin-manager/src/index.ts:461-559` |
| 客户端半页/插槽规范 | `packages/client/modules/src/client/manifest.ts:9-16,80-94`；`packages/client/ui-plugin-manager/src/client/slot-contract.ts:79-102` |
| 纯 JS 可安装 bundle 范例 | `apps/web/tests/fixtures/plugins/fixture-live-client/` |
| bundle 清单与安装方式 | skill `cordis-plugin-development/references/host-plugin.md` |
| 扩展点强弱与选用原则 | skill `.../references/practices.md:10,17,19,20,35` |

完整研究留档：`reports/fs-fence-surface-report.md`（文件系统防护面全景，含逐条 file:line）。
