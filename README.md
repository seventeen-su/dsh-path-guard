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

> 从源码目录安装时是 `link:` 软链，改动源码后需要**重启 DSH 进程**才会加载新的 Host 模块
> ——Node 的 ESM 模块缓存不会因为文件变化而失效。

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
| `selfProtection` | `true` | 禁止 AI 改写本插件所在的 profile 组合文件，也禁止它用 `plugin_manager` 关掉本插件 |

## 能挡住什么、挡不住什么

**能挡住**（`ctx.fs` / 工具层，可靠）：
`read`、`read_image`、`write`、`edit`、`glob`、`grep`、`present`、`str_replace_editor`、`lsp`，
以及同进程的 `subagent` / `subagent_fork` / `workflow` 子代理（它们共用同一个工具注册表）。
符号链接也挡得住——判定基于 `ctx.fs.resolve()` 的真实路径，不是字符串前缀。

**挡不住**（请务必知情）：

| 通道 | 为什么 |
|---|---|
| `bash` / `pwsh` | 命令串图灵完备，`shell: scan` 只是文本扫描，变量拼接/编码/外部程序都能绕。要硬一点就把 `shell` 设为 `deny`。 |
| `run_code`、MCP 工具、外部子代理 | 独立进程或外部工具循环，插件层无法观察（所以默认直接拒绝） |
| 指令文件 / skill 正文 → 系统提示 | 走 `ctx.get('fs')`，**没有工具调用可拦**。放进 `AGENTS.md` 或 skill 目录的受保护内容挡不住 |
| 历史会话检索 | 任何**曾被记录**的内容都能被检索回来。已经泄漏过一次的内容收不回来 |
| 搜索超限的 spill 文件 | 结果超过内联上限时 DSH 会把完整结果落盘；本插件在需要脱敏时**不调用下游处理器**以避免写 spill，但这是依赖实现细节的缓解，不是结构性保证 |

## 出问题时

- 拒绝是**明确**的：会告诉模型是用户设了限制、点了名禁止绕过的手段、并引导它向用户申请。
  每次拒绝都会写 Host 日志（`path-guard: denied ...`）。
- **自锁急救**：在「设置 → 路径守卫」把 `enabled` 关掉，或在前端把 bundle 停用。
  插件内部出错时**默认拒绝**（fail-closed）并给出提示，不会静默放行。

## 开发

```powershell
node --test tests/host.spec.js tests/policy.spec.js tests/redact.spec.js
```

零构建步骤，纯 JS。`@deepseek-ai/schemastery` 是唯一运行时依赖（用于导出 `Config`）。

设计与调研过程见 [`docs/PLAN.md`](docs/PLAN.md)，
研究留档在 [`reports/`](reports/)。
