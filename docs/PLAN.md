# dsh-path-guard 实施计划

> 目标 DSH 版本：`0.1.7-rc.2`（检出目录 `D:\Program\deepseek-harness`，`package.json` 版本 `0.1.7-rc.2`）
> 当前 profile：`web`（`DSH_PROFILE_DIR=C:\Users\SuSeventeen\.dsh\profiles\web`）
> 文档状态：待评审。评审通过后按 §11 里程碑实施。

---

## 1. 问题与目标

### 1.1 问题

当前 profile 的权限预设默认是 `danger-full-access`（`C:\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml:27-40`，`defaultPreset: danger-full-access`）。DSH 的文件沙箱在该档位下**完全不做限制**：

- `packages/fs/fs-sandbox/src/index.ts:5-8` —— "Reads pass through untouched: every mode permits reading."
- `packages/fs/fs-sandbox/src/index.ts:125` —— `if (mode === 'danger-full-access') return target`，写操作也不设围栏。
- `packages/shell/pwsh-sandbox/src/index.ts:99-104` —— 同一档位下 shell 直接委托本地执行器，不设围栏。

因此 AI 可以读取本机任意文件（SSH 私钥、凭据、个人目录等）。用户需要一层**独立于权限预设**的策略，在完全权限下依然生效。

### 1.2 目标

构建插件 `dsh-path-guard`，满足：

| 编号 | 需求 | 验收方式 |
| --- | --- | --- |
| G1 | 在 `danger-full-access` 下，被保护路径无法被 AI 读取 | 端到端测试：模型调用 `read` 被拒 |
| G2 | 档位一「完全无访问」：AI 既拿不到内容，也拿不到目录结构/文件名 | 列表、`glob`、`grep`、父目录列举均不暴露该条目 |
| G3 | 档位二「半访问控制」：可见文件名与目录结构，但不可读内容；或可读不可写 | 三种能力（列出/读/写）可独立配置 |
| G4 | 支持豁免：更具体路径覆盖更宽泛路径（`.ssh/**` 半访问，`.ssh/README.md` 可读） | 策略单测 + 端到端 |
| G5 | 通过 DSH 0.1.7-rc2 前端插件页面配置，改动热生效 | 浏览器中打开 Settings → 内置插件 → dsh-path-guard，改一项后立即生效 |
| G6 | 不影响用户自己（GUI）浏览同一路径 | 文件树/编辑器仍可打开被保护文件 |
| G7 | 策略可审计：每次拒绝有日志，可查当前生效策略 | 拒绝事件出现在 session 日志与 Host 日志 |

### 1.3 非目标（本期不做）

- 不做内核级隔离（不修改文件系统 ACL / 不建受限令牌）。见 §9 残余风险。
- 不阻止用户自己通过 GUI、外部编辑器访问被保护路径。
- 不加密、不隐藏文件（磁盘上仍是普通文件）。

---

## 2. 侦察结论（DSH 0.1.7-rc.2 事实）

以下均为读源码/运行时检查器得到的事实，行号对应当前检出。

### 2.1 AI 可见的文件系统表面

| 表面 | 实现位置 | 底层通道 | 能否硬拦 |
| --- | --- | --- | --- |
| `read` / `read_image` / `write` / `edit` | `packages/fs/tool-fs/src/index.ts:22,61-78` | `ctx.fs` | ✅ |
| `glob` / `grep` | `packages/fs/tool-fs-search`、`search-core.ts:238-248` | **`ctx.subprocess.spawn()` 拉起打包 ripgrep** | ⚠️ 见 §4-L2 |
| `str_replace_editor`（若挂载）| `packages/fs/tool-str-replace-editor/src/index.ts:194` | `ctx.fs.listDir` | ✅ |
| `pwsh`（Windows）| `packages/shell/pwsh-sandbox/src/index.ts` | `ctx.shell` → `ctx.subprocess` | ⚠️ 仅命令文本扫描（§9）|
| `run_code`（PTC 模式）| `packages/extensions/tool-cordis` | 子调用仍走 tools 管线 | ✅ 继承 guard |
| 子代理 / workflow / agent-teams | `tool-subagent*`、`tool-workflow` | 子 agent 各自的工具 scope | ✅ 全局服务替换天然覆盖 |
| skills / agent-instructions / deliverables / document | 各自包（如 `skill-filesystem/src/index.ts:770`）| `ctx.fs` | ✅ |
| GUI 文件树、编辑器 | `ctx.workspaceFiles`（`packages/api/workspace-files/src/index.ts:322`）| `ctx.fs` | ⛔ **不应拦**（G6）|

两条关键结论：

1. **`ctx.fs` 是唯一同时承载「大部分 AI 表面」与「GUI 表面」的接缝**，所以 L1 必须能区分调用者（§2.2）。
2. **AI 的目录/结构枚举主路径不是 `ctx.fs.listDir`，而是 ripgrep**：`read` 工具不列目录，`glob`（`rg --files`）/`grep`（`rg --json`）才是模型「看结构」的主要手段。因此 `none` 档位（G2）**必须在搜索层解决**，不能只靠 L1 的 `listDir` 过滤。

### 2.2 区分「AI 调用」与「GUI 调用」

`packages/core/agent-loop/src/agent.ts:234`：

```ts
this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
```

整个 turn（含工具派发）运行在 `withInitiator(agent)` 的 AsyncLocalStorage 作用域内；`ctx.agents.currentInitiator()`（`packages/core/agent/src/index.ts:295`）在工具调用期间返回该 Agent，在 Host 处理 GUI Remote 请求的异步链中返回 `undefined`。

→ **这就是「只对 AI 生效」的判定依据**，不需要区分工具名，也不会误伤 GUI。

### 2.3 可用扩展点（由弱到强）

| 机制 | 契约 | 用途 |
| --- | --- | --- |
| `ctx.tools.restrict()` | `{allow?, deny?}`，只做可见性裁剪 | 不适用（过粗）|
| `ctx.tools.guard()` | `type ToolGuard = (execution) => string \| undefined`，同步、只能拒绝、与注册顺序无关（`packages/core/tools/src/index.ts:723-731,1136`）| **硬拒绝**的首选 |
| `tools/pre-execute`（waterfall）| 可 `allow/deny/cancel/ask`，可 await | 需要异步决策时 |
| `tools/post-execute`（waterfall）| 接受/替换/丰富/阻断规范化结果 | **结果脱敏**（`glob`/`grep`/shell 输出）|
| 服务替换 | 插件以「服务类默认导出」注册，抢占同名服务 | `ctx.fs`、`ctx.shell` 的围栏 |
| `system-prompt/assemble` | 整体替换装配 | 不用 |

`packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:10` 明确要求「使用足够的最弱机制」；`references/practices.md:17` 明确「与顺序无关的拒绝要用 `ctx.tools.guard()`」。

### 2.4 前端插件配置页机制（0.1.7-rc2）

- `packages/settings/settings/src/index.ts:266-277` —— `ctx.settings.configure({ auto })`；`auto` 默认 `true`（`:312` `this.presentations.get(entry.fiber)?.auto ?? true`）。
- `packages/settings/settings/src/types.ts:22-45` —— `SettingsNamespaceView { autoGenerate, ns, schema, value, applies: 'live', secrets, revision }`；`autoGenerate` 注释即 "Generate a page if no custom page is registered for this instance"。
- `packages/client/ui-settings-plugins/src/client/index.ts:74-83` —— 该包拥有 Settings 的「内置插件」导航项，并声明列表插槽 `settings.plugins.tab`；`packages/client/ui-settings-plugin-inventory/src/client/index.ts:56-57` 是一个向该插槽注册页面的现成范例。
- schema 由插件导出的 `Config`（schemastery）投影而来；表单写入走 `remote.settings.mutate(ns, ops, expectedRevision)`，`applies: 'live'`。

→ **结论：插件只要导出 `Config`，且在 profile 补丁中有独立 `id`，就会自动获得一个可编辑的配置页（命名空间 = 该 row 的 `id`）。** 本期不需要自己写客户端页面；自研页面列为可选增强（§11 M4）。

### 2.5 当前 composition 中与本插件相关的 row

`packages/bundle/base/cordis.patch.yml`：

| row id | 包 | 说明 |
| --- | --- | --- |
| `sandbox-policy`（:228）| `@deepseek-ai/dsh-sandbox-policy` | 唯一的沙箱策略来源 |
| `pwsh-sandbox`（:240）| `@deepseek-ai/dsh-pwsh-sandbox` | Windows 下注册 `ctx.shell` |
| `tool-fs`（:280）| `@deepseek-ai/dsh-tool-fs` | `read`/`read_image`/`write`/`edit` |
| `tool-fs-search`（:283）| `@deepseek-ai/dsh-tool-fs-search` | `glob`/`grep`（ripgrep 子进程）|
| `fs-sandbox`（:517）| `@deepseek-ai/dsh-fs-sandbox` | 注册 `ctx.fs`，只围栏写 |

---

## 3. 策略模型

### 3.1 能力档位（access ladder）

每条规则把「路径」映射到一档访问能力，能力**累积**：

| `access` | 列目录/看结构 | 读文件内容 | 写/改/删 |
| --- | --- | --- | --- |
| `none` | ✗ | ✗ | ✗ |
| `list` | ✓ | ✗ | ✗ |
| `read` | ✓ | ✓ | ✗ |
| `write` | ✓ | ✓ | ✓ |

这正好覆盖用户要的三种语义：完全隔离 = `none`；可见结构不可读内容 = `list`；可读不可写 = `read`。

### 3.2 规则与优先级

```yaml
rules:
  - path: "~/.ssh"          # 目录：作用到自身与其全部后代
    access: list            # 半访问：能看到 .ssh 里有那些文件名
  - path: "~/.ssh/README.md"
    access: read            # 豁免：更具体 → 覆盖上一条
  - path: "D:/secrets/**"
    access: none
```

**匹配算法**：对目标绝对规范路径，收集所有「路径本身或祖先」命中规则，取**最具体**的一条：

1. 字面量前缀更长者优先；
2. 通配符更少者优先；
3. 仍相同则规则表中靠后者优先（`last-wins`，便于用户追加覆盖）。

未命中任何规则时使用 `defaultAccess`（默认 `allow`，即不受限，保持向后兼容）。

> 设计取舍：用「最具体命中」而不是「先匹配优先」，让豁免天然成立（`.ssh/README.md` 比 `.ssh` 具体），不需要单独的 `exempt` 字段或否定语法。文档需给出优先级示例。

### 3.3 路径归一化

- 支持 `~`、`${workspace}`、绝对路径、相对路径（相对 session cwd）。
- 归一化在**解析（resolve）之后**进行：用 `ctx.fs.resolve()` 得到的规范 `targetKey` 做判定，避免符号链接绕过（`..`、大小写、短路径）。
- Windows 下大小写不敏感比较；同时比较 `targetKey` 与 `processPath()` 两种形态。
- 判定使用 fs provider 自身的 `contains()`，不自己拼字符串前缀（`packages/fs/fs/src/index.ts:173`）。

---

## 4. 架构：分层防护

```
  AI 文件读写 ─→ ┌──────────────────────────────────────────────┐
                 │ L1  ctx.fs 围栏 PathGuardFileSystem          │ ← 覆盖 read/read_image/write/edit/
                 │     仅 currentInitiator() 存在时武装          │   skills/instructions/deliverables…
                 └──────────────────────────────────────────────┘
  AI 结构搜索 ─→ ┌──────────────────────────────────────────────┐
                 │ L2a ctx.subprocess 围栏：给 ripgrep argv 追加 │ ← glob/grep 的结构化排除
                 │     --glob=!<受保护路径>  （结构性，无泄漏）  │
                 ├──────────────────────────────────────────────┤
                 │ L2b tools/post-execute：结果脱敏 + 兜底       │ ← 格式漂移时的保险
                 └──────────────────────────────────────────────┘
  AI 执行命令 ─→ ┌──────────────────────────────────────────────┐
                 │ L3  ctx.shell 围栏（命令文本扫描）+ 输出脱敏  │ ← 尽力而为，非安全边界
                 └──────────────────────────────────────────────┘

  横切：ctx.tools.guard() 对显式路径参数硬拒（顺序无关的兜底）
  L0  策略引擎（pathGuard 服务）＝ 以上各层的共同大脑，配置来自前端页面
```

### L0 策略引擎（`pathGuard` 服务）

- 拥有 Config 与编译后的规则表；`evaluate(target) → { access, ruleId }`。
- 纯函数核心（`src/policy.js`）不依赖 Cordis，便于单测。
- 配置变更后原子替换编译结果；发 `path-guard/changed` 事件。

### L1 `ctx.fs` 围栏（主防线）

新服务类 `PathGuardFileSystem extends SandboxedFileSystem`（`@deepseek-ai/dsh-fs-sandbox`），通过 bundle 补丁**覆盖 `fs-sandbox` row 的 `name`** 来接管 `ctx.fs`（这正是 `fs-sandbox` 文档描述的官方替换方式：`packages/fs/fs-sandbox/src/index.ts:48-54`）。

- **继承**而非重写，保留原有 `read-only` / `workspace-write` 围栏语义（先跑原沙箱检查，再跑 path-guard）。
- 覆写下列方法，插入 path-guard 检查：
  - 读族：`readText`、`streamText`、`readBytes`、`readByteRange`  → 需 `read`
  - 观察族：`stat`、`lstat`、`watch`、`fileUrl`、`processPath` → 需 `list`
  - 列举族：`listDir` → 自身需 `list`；**并过滤掉 access=`none` 的子条目**（G2 的关键）
  - 写族：`writeText`、`editText` → 需 `write`
- **门控**：仅当 `ctx.agents.currentInitiator() !== undefined` 时启用。GUI/宿主调用原样放行（G6）。
- 服务缺失兜底：若 `pathGuard` 服务不可用（配置校验失败等），**退化为父类行为**并打 warning，避免整机不可用；同时在前端页面显示「未武装」状态。

### L2a `ctx.subprocess` 围栏（搜索层，结构性）

`glob`/`grep` 的真实通道是 `ctx.subprocess.spawn()` 拉起打包的 ripgrep（`search-core.ts:238-248`），argv 形如：

```
[rg, --no-config, --files, --glob=<模型给的 pattern>, --sort=modified,
 --no-ignore, --hidden, ...VCS 排除, --, <path>?]
```

做法：`PathGuardSubprocess extends LocalSubprocessRuntime`（`packages/subprocess/subprocess-local/src/index.ts:59`），只覆写 `spawn(spec)`，识别 ripgrep 调用后在 **`--` 分隔符之前**插入否定 glob：

```
--glob=!**/<相对路径>      --glob=!**/<相对路径>/**
```

（两种形式都需要，正是 `glob.ts:96-103` 对 VCS 目录采用同一技巧的原因：当搜索根**位于**目标目录内部时，只有 `/**` 形式会命中。）

排除范围按档位区分 —— 这是「可见名字但不可读内容」的关键：

| 工具 | 排除哪些档位 | 效果 |
| --- | --- | --- |
| `glob`（`rg --files`，只出文件名）| 仅 `none` | `list`/`read` 路径的文件名**照常出现**（满足 G3）|
| `grep`（`rg --json`，带匹配内容）| `none` + `list` | 受保护文件根本不被搜索，**内容零泄漏** |

优点：ripgrep 从头就不会打开受保护文件，不存在「输出里被截掉一行的痕迹」，也不依赖文本解析。我们的否定 glob 追加在模型给的 `--glob` **之后**，按 ripgrep「后者覆盖前者」的语义，模型无法用更宽的 pattern 把保护覆盖掉。

若搜索根本身就是受保护路径（或落在其内部），ripgrep 无意义，直接在 L2b 的 guard 层拒绝整次调用。

### L2b 工具层

1. **硬拒绝（guard）**：对 `read`/`read_image`/`write`/`edit`/`glob`/`grep` 的**显式路径参数**做 L0 判定，不足则拒绝。这是与注册顺序无关的兜底（`ctx.tools.guard()` 的语义保证），也负责给出可读的拒绝理由。
2. **结果兜底过滤**（`tools/post-execute`）：对 `glob`/`grep` 的文本结果再逐行过一遍 L0，剔除仍命中受保护路径的条目。定位是**防格式漂移的保险**，不是主机制——如果兜底解析拿不准，就在「搜索范围与受保护路径有交集」时**整体阻断**该次结果（fail-closed），宁可少给结果也不泄漏。

### L3 shell 尽力围栏

- 覆盖 `pwsh-sandbox` row（Windows）为 `PathGuardShellExecutor extends SandboxPwshExecutor`，在 `resolve(request)`（`packages/shell/pwsh-sandbox/src/index.ts:92`）里扫描命令文本：出现受保护路径的字面量 / `~` 展开 / 变量展开结果时拒绝。
- 对 shell 工具输出做 `post-execute` 脱敏（按路径前缀剥离行）。
- **明确标注为尽力而为**，不是安全边界；理由与残余风险见 §9。

---

## 5. 仓库结构

```
dsh-path-guard/
├─ README.md
├─ package.json              # bundle 清单：dsh.bundle.patch
├─ cordis.patch.yml          # Loader 补丁：接管 fs/subprocess/shell row + 插入本插件 row
├─ icon.svg                  # 插件卡片图标
├─ locale/{zh,en}.json       # 插件显示名与描述
├─ src/
│  ├─ index.js               # 主插件：注册 pathGuard 服务 + L2b guard/post-execute
│  ├─ policy.js              # L0 纯策略引擎（匹配、优先级、归一化）
│  ├─ config.js              # schemastery Config（前端页面由此生成）
│  ├─ fs.js                  # L1 PathGuardFileSystem
│  ├─ subprocess.js          # L2a PathGuardSubprocess（ripgrep argv 排除）
│  ├─ shell.js               # L3 PathGuardShellExecutor
│  └─ result-filter.js       # L2b/L3 结果脱敏
├─ tests/
│  ├─ policy.spec.js
│  ├─ fs-guard.spec.js
│  ├─ search-exclude.spec.js
│  ├─ tool-guard.spec.js
│  └─ e2e.spec.js
└─ docs/PLAN.md
```

> 说明：bundle 为纯 JS（`references/host-plugin.md:7` 明确「Host-only bundle needs no dependencies, install scripts, or build tool」）。四个服务模块通过 `package.json` 的 `exports` 暴露为子路径（`.`、`./fs`、`./subprocess`、`./shell`），Loader 的 row `name` 直接写 `dsh-path-guard/fs` 这类说明符。**该写法有官方先例**：shipped bundle 已用子路径作为 row 名，如 `@deepseek-ai/dsh-tool-subagent/list-agents`（`packages/bundle/web-app/presets/standard.patch.yml:89`）、`@deepseek-ai/dsh-tool-cordis/host`（同文件 :151）。

---

## 6. 包清单与 Loader 补丁

`package.json`：

```json
{
  "name": "dsh-path-guard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.js",
    "./fs": "./src/fs.js",
    "./subprocess": "./src/subprocess.js",
    "./shell": "./src/shell.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "icon": "./icon.svg",
  "meta": { "title": "Path Guard", "description": "在完全权限下仍阻止 AI 访问指定路径" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`（要点）：

```yaml
# 1) 接管文件系统围栏
- id: fs-sandbox
  name: 'dsh-path-guard/fs'

# 2) 接管子进程围栏（ripgrep 搜索排除）
- id: subprocess
  name: 'dsh-path-guard/subprocess'

# 3) 接管 Windows shell 围栏（非 Windows 部署对应改写 pwsh→bash）
- id: pwsh-sandbox
  name: 'dsh-path-guard/shell'

# 4) 插入策略所有者与工具层
- insert:
    - id: path-guard
      name: 'dsh-path-guard'
      config:
        defaultAccess: allow
        enforce: { fs: true, search: exclude, tools: true, shell: scan }
        rules: []
```

被覆盖的三个 row 在上游的位置：`subprocess` `packages/bundle/base/cordis.patch.yml:219-220`、`pwsh-sandbox` `:240-242`、`fs-sandbox` `:517-518`。

前端配置页面 = row `id: path-guard` 的命名空间，schema 来自 `Config`。

**安装方式**：用 Harness 的 `plugin_manager` 工具 `action: install_bundle`，`target` 为本目录绝对路径；**不要**手工改 profile 的 `package.json`/`cordis.patch.yml`（`references/host-plugin.md:58`）。

---

## 7. 配置 Schema

```js
export const Config = z.object({
  enabled: z.boolean().default(true),
  defaultAccess: z.union(['none', 'list', 'read', 'write', 'allow']).default('allow'),
  denyShape: z.union(['not-found', 'denied']).default('not-found'),
  enforce: z.object({
    fs: z.boolean().default(true),                              // L1 是否接管 ctx.fs
    search: z.union(['exclude', 'filter', 'off']).default('exclude'), // L2 搜索层档位
    tools: z.boolean().default(true),                            // guard/post-execute 兜底
    shell: z.union(['off', 'scan', 'deny-all']).default('scan'), // L3
  }).default({}),
  rules: z.array(z.object({
    path: z.string().role('text'),
    access: z.union(['none', 'list', 'read', 'write']).default('none'),
    note: z.string().default(''),
  })).default([]),
})
```

- `denyShape: not-found`（默认）—— `none` 档位的拒绝伪装成「文件不存在」，**不泄露路径存在性**；`denied` 则显式报拒绝，便于调试。
- `enforce.shell: deny-all` —— 对担心 shell 绕过的用户提供「直接用不了 shell」的强档。

前端表单体验：`rules` 渲染为可增删的列表；每行是「路径 / 档位 / 备注」三列。改动经 `remote.settings.mutate` 写回 profile 补丁，`applies: live` 热生效。

---

## 8. 关键实现细节

### 8.1 拒绝形态

复用 DSH 既有错误码，让工具层自动渲染成模型可理解的提示（`packages/fs/fs/src/types.ts:175-188`）：

| 档位 | 表现 |
| --- | --- |
| `none` + `denyShape: not-found` | 抛 `FS_NOT_FOUND`（与真实不存在同构）|
| `none` + `denyShape: denied` | 抛 `FS_SANDBOX_DENIED`，消息注明 `path-guard` |
| `list` 读内容 | `FS_PERMISSION_DENIED`，消息提示「该路径仅允许查看名称」|
| `read` 写 | `FS_SANDBOX_DENIED`，消息提示「只读豁免」|

### 8.2 父目录列举（G2 核心）

`listDir(dir)` 返回前过滤：对每个 `entry.target` 跑 L0，`access === 'none'` 的条目**整个移除**。因此 `~` 的列表里不会出现 `.ssh`。

但注意 §2.1 的结论：**模型「看结构」主要靠 ripgrep（`glob`/`grep`），不是 `listDir`**。所以 G2 的完整达成依赖三处协同：L1 的 `listDir` 过滤（覆盖 `str_replace_editor`、skills 与 GUI）、L2a 的 argv 排除（覆盖 `glob`/`grep` 的结构枚举）、L2b 的 guard（覆盖显式点名受保护路径的调用）。

### 8.3 符号链接与规范化

- 一律先 `resolve()` 再判定（真实路径），防止 `link → protected` 绕过。
- `lstat`（不跟随末段）按**路径本身**判定，防止通过检查链接本身推断目标。

### 8.4 审计

- 每次拒绝：`ctx.logger.warn`（Host 日志）+ 可选 `session.append`。
- 页面顶部展示：已生效规则数、最近 N 次拒绝、L1/L3 是否成功接管（自检结果）。

### 8.5 自检（防静默失效）

插件启动时校验：`ctx.fs.constructor.name === 'PathGuardFileSystem'`、`ctx.shell.sandboxMode !== undefined` 等；不满足则显示醒目告警——因为 row 覆盖依赖上游 row id 不变，DSH 升级可能使其静默失效。

---

## 9. 已知限制与残余风险（必须如实告知）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **shell 命令可混淆** | `pwsh` 中变量拼接、编码、外部程序可绕过文本扫描读取 `none` 路径 | 提供 `shell: deny-all`；长期方案见 §11 M5（ACL）|
| **覆盖上游 row 依赖 row id** | DSH 升级若改 id/包名，围栏静默消失 | §8.5 自检 + 页面告警 + 单测断言；升级后必须重跑 §10 验收 |
| **L2a argv 注入依赖 ripgrep argv 形态** | `tool-fs-search` 若改变 argv 结构（如 `--` 位置）则注入点失效 | 注入点按「`--` 之前」计算并对无 `--` 情形回退；L2b 兜底过滤；单测直接断言生成的 argv |
| **TOCTOU** | 检查后路径被替换成符号链接 | 与 `fs-sandbox` 同等威胁模型，判定在 resolve 后、操作前紧邻执行 |
| **插件自身可被 AI 关闭** | 模型有 `plugin_manager` 工具（web-app 预设含 `tool-plugin-manager`）| 建议 `ctx.tools.restrict()` 对该 agent 隐藏 `plugin_manager`（M3 可选项，见 §12-3）|
| **模型可读本插件配置** | 规则本身若在被保护路径内会泄露 | 文档提示把插件配置/本仓库设为 `none` |
| **不防用户本人** | 用户仍可自行查看 | 符合 G6，非缺陷 |

---

## 10. 测试与验收

### 10.1 单元测试

- `policy.spec.js`：优先级（最具体胜出）、`~`/`${workspace}` 展开、Windows 大小写、祖先命中、last-wins、空规则表。
- `fs-guard.spec.js`：用内存/临时目录 + 桩 `agents`，断言各档位下 `readText`/`listDir`/`writeText` 的行为；**断言 `currentInitiator()===undefined` 时全部放行**（G6）。
- `search-exclude.spec.js`：直接对生成的 argv 断言——`glob` 只为 `none` 注入否定 glob、`grep` 为 `none`+`list` 注入、注入位置在 `--` 之前、模型自带的 `--glob` 无法覆盖。
- `tool-guard.spec.js`：guard 对显式受保护路径的拒绝；`post-execute` 兜底过滤与 fail-closed 分支。

### 10.2 端到端验收（必须在本机真实运行）

1. 造样例目录：`D:\dsh-path-guard-fixture\{open,hidden,listed,ro}\`。
2. 安装 bundle，在页面配置规则。
3. 新开 session，逐条执行并核对：
   - `read` `hidden/secret.txt` → 不存在/拒绝；`glob '**/*'` → **不含 `hidden`**（含其文件名）；`grep` 命中 → 完全不出现。
   - `read` `listed/a.txt` → 拒绝，但 `glob` 能看到 `a.txt`（G3 半访问）；`grep` 搜 `listed` 内内容 → 无结果、无内容泄漏。
   - `write` `ro/b.txt` → 拒绝；`read` 成功。
   - `.ssh` 半访问 + `.ssh/README.md` 可读 → **豁免生效**。
   - `pwsh` 直接 `Get-Content hidden/secret.txt` → 拒绝（scan 档）。
4. 用 **GUI 文件树**打开被保护文件 → 必须仍可打开（G6）。
5. 页面改一条规则 → 无需重启立即生效（G5）。

### 10.3 回归

- `danger-full-access` 下原沙箱行为不变（`workspace-write`/`read-only` 档位仍按原语义工作）。
- 卸载 bundle 后 `ctx.fs` 回到 `fs-sandbox`，无残留。

---

## 11. 里程碑

| 里程碑 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| **M0** | 规划、git 初始化、计划文档 | 本文件 | ✅ 完成 |
| **M1** | 骨架：`policy.js` + `config.js` + 单测；bundle 可被 `install_bundle` 识别；**先验证 §6 的 row 覆盖与子路径 `name` 在真实 profile 中生效**（这是全案最大假设）| 可安装、页面出现配置表单 | 待办 |
| **M2** | L1 `ctx.fs` 围栏 + L2b 工具层（read/write/edit/glob/grep 的 guard 与兜底过滤）| G1、G3、G4、G6 | 待办 |
| **M3** | L2a `ctx.subprocess` ripgrep 排除（G2 的结构性解法）| G2 | 待办 |
| **M4** | 自检、审计日志、页面告警；可选隐藏 `plugin_manager` | G7 | 待办 |
| **M5** | L3 shell 扫描 + 输出脱敏（`scan`/`deny-all`）| shell 场景尽力覆盖 | 待办 |
| **M6** | （可选）Windows ACL 强隔离档位，把 `none` 提升为内核级 | 消除 §9 首行风险 | 待定 |
| **M7** | （可选）自定义客户端页面（富表格、拖拽排序、拒绝日志面板）| 替代自动生成表单 | 待定 |

---

## 12. 待确认的决策点

1. **本方案要覆盖 3 个上游 row**（`fs-sandbox`/`subprocess`/`pwsh-sandbox`）。替代的「保守版」只做 L1+L2b，不动 `subprocess`：代价是 `glob`/`grep` 只能靠结果过滤，G2 从「结构性保证」降级为「解析后过滤」。**建议：先按保守版打通 M1–M2，M3 再决定是否加 L2a**，用真实回归数据判断风险。
2. **默认拒绝形态**：`none` 是否默认伪装成「文件不存在」（不泄露存在性）？建议：是。
3. **shell 档位默认值**：建议默认 `scan`（尽力扫描 + 输出脱敏），把 `deny-all` 留给高安全需求。
4. **是否同时隐藏 `plugin_manager` 工具**，防止模型自行关闭本插件？建议：是，但需你确认（会改变模型可见工具集）。
5. **是否要做 M6（Windows ACL 内核级）**：工作量最大，但只有它能真正堵住 shell 绕过。
6. **规则路径写法偏好**：`~/.ssh` 这类家目录写法是否够用，还是需要 `${env:VAR}`、正则等更复杂语法？

---

## 附录 A：证据索引

| 事实 | 位置 |
| --- | --- |
| 读操作完全不过沙箱 | `packages/fs/fs-sandbox/src/index.ts:5-8` |
| `danger-full-access` 写也不围栏 | `packages/fs/fs-sandbox/src/index.ts:122-125` |
| `ctx.fs` 官方替换方式 | `packages/fs/fs-sandbox/src/index.ts:48-54` |
| turn 全程在 initiator 作用域 | `packages/core/agent-loop/src/agent.ts:234` |
| `currentInitiator()` | `packages/core/agent/src/index.ts:295-298` |
| `ToolGuard` 契约（同步、只能拒绝）| `packages/core/tools/src/index.ts:723-731` |
| `ctx.tools.guard()` | `packages/core/tools/src/index.ts:1136` |
| `tools/pre-execute` / `tools/post-execute` | Host Event 目录（运行时 `cordis_inspect_query`）|
| `glob`/`grep` 走 ripgrep 子进程 | `packages/fs/tool-fs-search/src/search-core.ts:3-12,238-248` |
| ripgrep argv 结构（`--` 分隔、双重否定 glob 技巧）| `packages/fs/tool-fs-search/src/glob.ts:89-107` |
| `SubprocessRuntime.spawn` 抽象方法 | `packages/subprocess/subprocess/src/index.ts:117,153` |
| `LocalSubprocessRuntime` 与 `subprocess` row | `packages/subprocess/subprocess-local/src/index.ts:59`；`packages/bundle/base/cordis.patch.yml:219-220` |
| `listDir` 的 AI 侧消费者 | `packages/fs/tool-str-replace-editor/src/index.ts:194`、`packages/skill/skill-filesystem/src/index.ts:770` |
| GUI 文件树经 `ctx.fs` | `packages/api/workspace-files/src/index.ts:322` |
| 子路径 row 名先例 | `packages/bundle/web-app/presets/standard.patch.yml:89,151` |
| pwsh 执行器 `resolve()` 与完全权限放行 | `packages/shell/pwsh-sandbox/src/index.ts:92-104` |
| 设置表单自动生成 | `packages/settings/settings/src/index.ts:266-277,312` |
| `SettingsNamespaceView.autoGenerate` | `packages/settings/settings/src/types.ts:22-45` |
| `settings.plugins.tab` 插槽 | `packages/client/ui-settings-plugins/src/client/index.ts:74-83` |
| 插槽注册范例 | `packages/client/ui-settings-plugin-inventory/src/client/index.ts:56-57` |
| `FsErrorCode` 词表 | `packages/fs/fs/src/types.ts:175-188` |
| 相关 row（fs-sandbox 等）| `packages/bundle/base/cordis.patch.yml:240,280,283,517` |
| bundle 清单与安装方式 | skill `cordis-plugin-development/references/host-plugin.md` |
| 扩展点强弱与选用原则 | skill `.../references/practices.md:10,17` |
