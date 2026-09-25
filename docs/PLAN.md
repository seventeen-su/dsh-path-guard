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

| 表面 | 实现位置 | 是否经过 `ctx.fs` | 能否硬拦 |
| --- | --- | --- | --- |
| `read` / `read_image` / `write` / `edit` | `packages/fs/tool-fs/src/index.ts:22,61-78` | ✅ 全部经 `ctx.fs` | ✅ |
| `glob` / `grep` | `packages/fs/tool-fs-search/src/index.ts`、`search-core.ts:3-12,238` | ❌ 直接 `ctx.subprocess.spawn()` 拉起打包的 ripgrep | ⚠️ 需工具层过滤/拒绝 |
| `pwsh`（Windows）| `packages/shell/pwsh-sandbox/src/index.ts` | ❌ 经 `ctx.shell` → `ctx.subprocess` | ⚠️ 仅能命令文本扫描（见 §9）|
| `run_code`（PTC 模式）| `packages/extensions/tool-cordis` | 子调用仍走 tools 管线 | ✅ 继承 guard |
| 子代理 / workflow / agent-teams | `tool-subagent*`、`tool-workflow` | 子 agent 使用自己的 scope | ✅ 全局 `ctx.fs` 天然覆盖；工具 guard 需验证 scope 继承 |
| skills / agent-instructions / deliverables / document | 各自包 | ✅ 经 `ctx.fs` | ✅ |
| GUI 文件树、编辑器 | `ctx.workspaceFiles`（Host Remote）| ✅ 经 `ctx.fs` | ⛔ **不应拦**（G6）|

关键结论：**`ctx.fs` 是唯一同时覆盖「大部分 AI 表面」与「GUI 表面」的接缝**，所以必须能区分调用者。

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
                 ┌─────────────────────────────────────────────┐
   AI 工具调用 → │ L2 tools 层：guard(硬拒) + post-execute(脱敏) │
                 └─────────────────────────────────────────────┘
                                     │
                 ┌─────────────────────────────────────────────┐
   AI 文件访问 → │ L1 ctx.fs 围栏（PathGuardFileSystem）        │ ← 主防线，覆盖 read/write/edit/
                 │   仅当 currentInitiator() 存在时启用         │   read_image/skills/instructions…
                 └─────────────────────────────────────────────┘
                                     │
                 ┌─────────────────────────────────────────────┐
   AI 执行命令 → │ L3 ctx.shell 围栏 + shell 结果脱敏（尽力）   │
                 └─────────────────────────────────────────────┘

   L0 策略引擎（pathGuard 服务）＝ 上面三层的共同大脑，配置来自前端页面
```

### L0 策略引擎（`pathGuard` 服务）

- 拥有 Config 与编译后的规则表；`evaluate(target) → { access, ruleId }`。
- 纯函数核心（`src/policy.ts`）不依赖 Cordis，便于单测。
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

### L2 工具层

1. **硬拒绝（guard）**：对 `read`/`read_image`/`write`/`edit`/`glob`/`grep` 的显式路径参数做 L0 判定，不足则拒绝。作为 L1 之外的**顺序无关**保险（例如 L1 未接管时）。
2. **`glob` 结果过滤**：`tools/post-execute` 中对返回的路径列表逐条过 L0，剔除 `none` 条目。
3. **`grep` 结果处理**：命中文件按能力分流——
   - `none`：整条丢弃，且不出现文件名；
   - `list`：保留文件名，**移除匹配行内容**；
   - `read`/`write`：保留。
   由于 `grep` 走 ripgrep 子进程、可递归整个 cwd，这一层是 `none` 语义不被 `grep` 绕过的必要环节（§2.1）。

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
├─ cordis.patch.yml          # Loader 补丁：接管 fs/shell row + 插入本插件 row
├─ icon.svg                  # 插件卡片图标
├─ locale/{zh,en}.json       # 插件显示名与描述
├─ src/
│  ├─ index.js               # 主插件：注册 pathGuard 服务 + L2 guard/post-execute
│  ├─ policy.js              # L0 纯策略引擎（匹配、优先级、归一化）
│  ├─ config.js              # schemastery Config（前端页面由此生成）
│  ├─ fs.js                  # L1 PathGuardFileSystem
│  ├─ shell.js               # L3 PathGuardShellExecutor
│  └─ result-filter.js       # glob/grep/shell 结果脱敏
├─ tests/
│  ├─ policy.spec.js
│  ├─ fs-guard.spec.js
│  ├─ tool-guard.spec.js
│  └─ e2e.spec.js
└─ docs/PLAN.md
```

> 说明：bundle 为纯 JS（`references/host-plugin.md:7` 明确「Host-only bundle needs no dependencies, install scripts, or build tool」）。三个服务模块通过 `package.json` 的 `exports` 暴露为子路径（`.`、`./fs`、`./shell`），Loader 的 row `name` 直接写 `dsh-path-guard/fs` 这类说明符。

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

# 2) 接管 Windows shell 围栏（非 Windows 部署对应改写 pwsh→bash）
- id: pwsh-sandbox
  name: 'dsh-path-guard/shell'

# 3) 插入策略所有者与工具层
- insert:
    - id: path-guard
      name: 'dsh-path-guard'
      config:
        defaultAccess: allow
        enforce: { fs: true, tools: true, search: true, shell: scan }
        rules: []
```

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
    fs: z.boolean().default(true),
    tools: z.boolean().default(true),
    search: z.boolean().default(true),
    shell: z.union(['off', 'scan', 'deny-all']).default('scan'),
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

`listDir(dir)` 返回前过滤：对每个 `entry.target` 跑 L0，`access === 'none'` 的条目**整个移除**。因此 `~` 的列表里不会出现 `.ssh`。同理 `glob` 的结果集在 L2 过滤。

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
| **`grep`/`glob` 走子进程** | 不经过 `ctx.fs`，只能靠 L2 过滤 | 已设计结果过滤；`none` 条目整条剔除 |
| **上游 row id 变化** | 覆盖失效，围栏静默消失 | §8.5 自检 + 页面告警 + 测试断言 |
| **TOCTOU** | 检查后路径被替换成符号链接 | 与 `fs-sandbox` 同等威胁模型，判定在 resolve 后、操作前紧邻执行 |
| **插件自身可被 AI 关闭** | 模型有 `plugin_manager` 工具（`web-app` 预设含 `tool-plugin-manager`）| 建议同时用 `ctx.tools.restrict()` 对该 agent 隐藏 `plugin_manager`（列为 M3 可选项，需用户确认）|
| **模型可读本插件配置** | 配置文件本身若在被保护路径内会泄露规则 | 建议规则中把插件配置文件设为 `none`（文档提示）|
| **不防用户本人** | 用户仍可自行查看 | 符合 G6，非缺陷 |

---

## 10. 测试与验收

### 10.1 单元测试

- `policy.spec.js`：优先级（最具体胜出）、`~`/`${workspace}` 展开、Windows 大小写、祖先命中、last-wins、空规则表。
- `fs-guard.spec.js`：用内存/临时目录 + 桩 `agents`，断言各档位下 `readText`/`listDir`/`writeText` 的行为；**断言 `currentInitiator()===undefined` 时全部放行**（G6）。
- `tool-guard.spec.js`：`glob`/`grep` 结果过滤（`none` 剔除条目、`list` 保留文件名去掉内容）。

### 10.2 端到端验收（必须在本机真实运行）

1. 造样例目录：`D:\dsh-path-guard-fixture\{open,hidden,listed,ro}\`。
2. 安装 bundle，在页面配置规则。
3. 新开 session，逐条执行并核对：
   - `read` `hidden/secret.txt` → 不存在/拒绝；`glob '**/*'` → 不含 `hidden`；`grep` 命中被剔除。
   - `read` `listed/a.txt` → 拒绝但 `glob` 能看到 `a.txt`。
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
| **M0** | 规划、git 初始化、计划文档 | 本文件 | ✅ 进行中 |
| **M1** | 骨架：`policy.js` + `config.js` + 单测；bundle 清单可被 `install_bundle` 识别 | 可安装、页面出现配置表单 | 待办 |
| **M2** | L1 fs 围栏 + L2 工具层（read/write/edit/glob/grep）| G1–G4、G6 达成 | 待办 |
| **M3** | 自检、审计、页面告警；可选隐藏 `plugin_manager` | G7 | 待办 |
| **M4** | L3 shell 扫描 + 输出脱敏 | shell 场景尽力覆盖 | 待办 |
| **M5** | （可选）Windows ACL 强隔离档位，把 `none` 提升为内核级 | 消除 §9 首行风险 | 待定 |
| **M6** | 自定义客户端页面（富表格、拖拽排序、拒绝日志面板）| 替代自动生成表单 | 待定 |

---

## 12. 待确认的决策点

1. **默认拒绝形态**：`none` 是否默认伪装成「文件不存在」（不泄露存在性）？建议：是。
2. **shell 档位默认值**：建议默认 `scan`（尽力扫描 + 输出脱敏），把 `deny-all` 留给高安全需求。
3. **是否同时隐藏 `plugin_manager` 工具**，防止模型自行关闭本插件？建议：是，但需你确认（会改变模型可见工具集）。
4. **是否要做 M5（Windows ACL 内核级）**：工作量最大，但只有它能真正堵住 shell 绕过。
5. **规则路径写法偏好**：`~/.ssh` 这类家目录写法是否够用，还是需要 `${env:VAR}`、正则等更复杂语法？

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
| `glob`/`grep` 走 ripgrep 子进程 | `packages/fs/tool-fs-search/src/search-core.ts:3-12,238` |
| pwsh 执行器 `resolve()` 与完全权限放行 | `packages/shell/pwsh-sandbox/src/index.ts:92-104` |
| 设置表单自动生成 | `packages/settings/settings/src/index.ts:266-277,312` |
| `SettingsNamespaceView.autoGenerate` | `packages/settings/settings/src/types.ts:22-45` |
| `settings.plugins.tab` 插槽 | `packages/client/ui-settings-plugins/src/client/index.ts:74-83` |
| 插槽注册范例 | `packages/client/ui-settings-plugin-inventory/src/client/index.ts:56-57` |
| `FsErrorCode` 词表 | `packages/fs/fs/src/types.ts:175-188` |
| 相关 row（fs-sandbox 等）| `packages/bundle/base/cordis.patch.yml:240,280,283,517` |
| bundle 清单与安装方式 | skill `cordis-plugin-development/references/host-plugin.md` |
| 扩展点强弱与选用原则 | skill `.../references/practices.md:10,17` |
