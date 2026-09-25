# dsh-path-guard

在 DSH 开启 **完全权限（`danger-full-access`）** 时，仍然按路径阻止 AI 读取/写入。

- **四档访问能力**（半访问是两档，不是一个）：
  | 档位 | 看目录结构/文件名 | 读文件内容 | 写 |
  |---|---|---|---|
  | `none` | ✗ | ✗ | ✗ |
  | `list` | ✓ | ✗ | ✗ |
  | `read` | ✓ | ✓ | ✗ |
  | `write` | ✓ | ✓ | ✓ |
- **豁免 = 更具体的规则**：`~/.ssh` 设为 `list`，再加一条 `~/.ssh/README.md` 设为 `read`，只读那一个文件。
- **只对 AI 生效**：用户自己用 GUI 文件树/编辑器打开被保护文件不受影响。
- **配置面**：DSH Web UI 的「设置 → 路径守卫」页面，改完立即生效。
- **实现原则**：不接管任何服务、不覆盖任何上游 row，只经 4 个既有扩展点做增量拦截；卸载后无残留。

## 安装

用 Harness 的 `plugin_manager` 工具：

```
action: install_bundle
target: D:\Program\dsh-path-guard
```

安装后 bundle 出现在 profile 的 bundles 列表里，插件行 `path-guard` 生效。
配置页在 **设置 → 路径守卫**（命名空间 = row id `path-guard`）。

**不需要任何安装脚本，也不需要构建步骤**：包是纯 JS，`install_bundle` 自己跑 `pnpm add`；
唯一的运行时依赖 `@deepseek-ai/schemastery` 写在 `dependencies` 里，由它一并装好。
包名 `dsh-path-guard` 在 npm 上未被占用（不像 `dsh-desktop-notify` 那样存在同名包冲突风险）。

> 从源码目录安装时是 `link:` 软链，改动源码后需要**重启 DSH 进程**才会加载新的 Host 模块
> ——Node 的 ESM 模块缓存不会因为文件变化而失效。

## 在配置页里怎么改

打开 **设置 → 路径守卫**：

- **常用位置**：`~/.ssh` / `~/.aws` / `~/.gnupg` / `~/.docker` 一键加规则（点一下即可，之后可改档位）。
- **每行的「浏览…」**：调 DSH 的目录选择器，把选中的目录填进该行，不用手打路径。
- **档位下拉**：四档，选项文字直接写明该档允许什么。
- **保存**：规则表是草稿式的——改完点「保存」才写回 profile；其余开关（总开关、默认档位、shell、exoticTools、自我保护）改一下即时生效。
- **「怎么用？看四个例子」**：页内展开的使用说明，含「完全禁止 / 仅文件名 / 只读 / 豁免」四个范例。

**豁免怎么写**：不需要特殊语法，**再加一条更具体的规则**就行。例如
`~/.ssh` 设「仅文件名」，再写一条 `~/.ssh/README.md` 设「只读」——只有那一个文件可读。
优先级是自动算的：先比命中目录的深度，再比字面量前缀长度，然后比通配符多少。

## 规则写法

| 写法 | 含义 |
|---|---|
| `~/.ssh` | 家目录下的 `.ssh`，含全部后代 |
| `D:/secrets/**` | 绝对路径，含全部后代 |
| `${workspace}/private` | 相对当前会话工作区（没有工作区时该规则不生效） |
| `src/**` | 相对路径一律按 `${workspace}` 展开 |
| `*` | 匹配一段（不跨路径分隔符） |
| `**` | 匹配任意层（跨分隔符） |
| `?` | 匹配单个字符 |

**优先级**：更具体的路径覆盖更宽泛的路径。具体的排序键是「命中的祖先越深越优先 → 字面量前缀越长越优先 → 通配符越少越优先 → 规则表里越靠后越优先」。
所以豁免不需要特殊语法，只要写一条更具体的规则。

> 裸 `**` 属于相对模式，只在有会话工作区时生效。要「全局兜底」请写绝对形式。

## 其余开关

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultAccess` | `allow` | 没有规则命中时的档位。改成 `none` 就是「默认全禁，只放行白名单」。 |
| `searchRedaction` | `true` | 把 `glob`/`grep` 结果里落在受保护路径上的条目剔除 |
| `shell` | `scan` | `scan` 扫描 shell 命令文本；`deny` 直接禁掉 shell；`off` 不处理（已知漏洞） |
| `exoticTools` | `deny` | 拒绝插件层无法观察的通道（MCP 工具、`run_code`、外部子代理） |
| `selfProtection` | `true` | 自我保护：禁止 AI 用文件工具改写 profile 组合文件，并让 `plugin_manager` 变为**只读**（列插件仍可用，任何增删改都拒绝）。关掉它 AI 才能管理插件。 |

## 能挡住什么、挡不住什么

**能挡住**（`ctx.fs` / 工具层，可靠）：
`read`、`read_image`、`write`、`edit`、`glob`、`grep`、`present`、`str_replace_editor`、`lsp`，
以及同进程的 `subagent` / `subagent_fork` / `workflow` 子代理（它们共用同一个工具注册表）。
符号链接也挡得住——判定基于 `ctx.fs.resolve()` 的真实路径，不是字符串前缀。

**挡不住**（请务必知情）：

| 通道 | 为什么 |
|---|---|
| `bash` / `pwsh` | 命令串图灵完备。`shell: scan` 只是**字面子串匹配**命令文本，并整段扣留提到受保护路径的输出块；`$(echo ~)`、`Join-Path`、通配符、借用其他解释器拼路径都能绕过。**只有 `shell: deny` 真正堵住。** |
| `workflow` | 脚本在 `node:vm` 里跑，而 DSH 自己的 e2e 测试就证明它能逃逸拿到真正的 `process`；`danger-full-access` 下它派生的运行时不设围栏。脚本不是工具调用，`tools/pre-execute` 结构上看不到它。**默认已被 `exoticTools: deny` 拒绝。** |
| `run_code`、MCP 工具、外部子代理 | 独立进程或外部工具循环，插件层无法观察（默认直接拒绝） |
| 指令文件 / skill 正文 → 系统提示 | 走 `ctx.get('fs')`，**没有工具调用可拦**。放进 `AGENTS.md` 或 skill 目录的受保护内容挡不住 |
| 历史会话检索 | 任何**曾被记录**的内容都能被检索回来。已经泄漏过一次的内容收不回来 |
| 搜索超限的 spill 文件 | 结果超过内联上限时 DSH 会把完整结果落盘；本插件在需要脱敏时**不调用下游处理器**以避免写 spill，但这是依赖实现细节的缓解，不是结构性保证 |

**已知的规则边界**：UNC 路径（`\\server\share\x`）会被归一成 `/server/share/x`，可能与同名 POSIX 路径混淆；POSIX 下 `/` 不能作为根规则（Windows 的 `C:/` 可以）。

## 出问题时

- 拒绝是**明确**的：会告诉模型是用户设了限制、点了名禁止绕过的手段、并引导它向用户申请。
  每次拒绝都会写 Host 日志（`path-guard: denied ...`）。
- **自锁急救**：在「设置 → 路径守卫」把 `enabled` 关掉，或在前端把 bundle 停用。
  插件内部出错时**默认拒绝**（fail-closed）并给出提示，不会静默放行。

## 桌面通知（与 dsh-desktop-notify 联动）

同 profile 装了 [`dsh-desktop-notify`](https://github.com/Mvyvn/dsh-desktop-notify) 时，
本插件会在拦截发生时推一条系统通知，让你在别的窗口也能立刻知道 AI 撞到了限制：

- 🚫 **Path Guard 拦截** —— 哪个工具、被拒的目标、命中的规则与档位。
- ⚠️ **Path Guard 内部错误** —— 插件自己出故障、已 fail-closed 时告警（这类通知不受节流影响之外的抑制）。

实现方式：调用它对外注册的 Cordis 服务 `desktopNotify`（`push` / `pushAlways`），
**按可选服务处理**（`ctx.get('desktopNotify')` 每次现取）——没装该插件就什么都不发生，
中途装上也能立即生效。同一拦截原因有 10 秒节流，避免模型反复重试时刷屏。

配置项 `notify`：`focused`（默认，走它的聚焦门控——你正在看的那个会话不弹，避免和聊天区重复）、
`always`（绕过门控，任何情况都弹）、`off`。

## 许可证

**GNU General Public License v3.0 或更高版本（GPL-3.0-or-later）** —— 全文见 [LICENSE](LICENSE)，
版权与署名：**© 2026 苏拾柒 &lt;seventeen_su@proton.me&gt; 及贡献者**。

- **可以**：自由使用、复制、分发、修改，**包括商业用途**。
- **必须**：① **署名**——分发原版或修改版都必须带上作者署名与版权声明，不得删除或替换成自己的名字；
  ② **开源**——分发修改版时必须按同一许可证公开完整对应源码并标明改动。
- 不提供任何担保（详见 GPL 第 15、16 条）。

> 本程序是自由软件：你可以按自由软件基金会发布的 GNU 通用公共许可证（第 3 版，或你选择的任何更高版本）
> 条款重新分发和/或修改它。本程序希望它有用，但**没有任何担保**，甚至没有适销性或特定用途适用性的默示担保。

## 开发

```powershell
node --test tests/host.spec.js tests/policy.spec.js tests/redact.spec.js
```

零构建步骤，纯 JS。`@deepseek-ai/schemastery` 是唯一运行时依赖（用于导出 `Config`）。

设计与调研过程见 [`docs/PLAN.md`](docs/PLAN.md)，
研究留档在 [`reports/`](reports/)。
