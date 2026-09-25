# 端到端验收手册

这份手册让你（或任何接手的人）在真实 DSH 里验证 dsh-path-guard。
所有断言都是「用一个工具调用去试，看结果是否符合预期」。

## 0. 前置条件

1. **必须重启 DSH 进程**。插件从源码目录以 `link:` 方式安装，改动源码后 Node 的 ESM
   模块缓存不会失效；只在前端重新启用加载到的可能仍是旧模块。
2. 确认 bundle 已安装：
   ```
   plugin_manager  action: install_bundle  target: D:\Program\dsh-path-guard
   ```
   然后在前端把 **dsh-path-guard** 启用（若之前被停用）。
3. 建立夹具：
   ```
   pwsh -File D:\Program\dsh-path-guard\scripts\make-fixture.ps1
   ```
   默认落在 `D:\dsh-path-guard-fixture`。

## 1. 配置规则

打开 **设置 → 路径守卫**，逐条加入下面 5 条规则（顺序无关，越具体的自动优先）：

| 路径 | 档位 | 意图 |
|---|---|---|
| `D:/dsh-path-guard-fixture/hidden` | 完全禁止 `none` | 档位一：连目录结构都看不到 |
| `D:/dsh-path-guard-fixture/listed` | 半访问·仅文件名 `list` | 档位二之一：看得见文件名，读不到内容 |
| `D:/dsh-path-guard-fixture/readonly` | 半访问·只读 `read` | 档位二之二：能读，不能写 |
| `D:/dsh-path-guard-fixture/sshlike` | 半访问·仅文件名 `list` | 豁免的父规则 |
| `D:/dsh-path-guard-fixture/sshlike/README.md` | 半访问·只读 `read` | **豁免**：更具体，覆盖上一条 |

其余开关保持默认（`searchRedaction: true`、`shell: scan`、`exoticTools: deny`、`selfProtection: true`）。

**先确认页面本身可用**（这同时是 G5 的验收）：改一项后不需重启、无需刷新页面即生效；
把 `enabled` 关掉应当立刻不再拦截。

## 2. 逐项断言

在**新开的 session** 里（避免旧上下文干扰）执行下面的调用，逐条核对。

### G1 / 档位一：完全无访问

| # | 调用 | 期望 |
|---|---|---|
| 1 | `read` `D:\dsh-path-guard-fixture\hidden\secret.txt` | **被拒绝**，文案是「访问被拒绝……由用户通过 dsh-path-guard 明确设置了访问限制」，并包含「不要尝试绕过这个限制」 |
| 2 | `glob` pattern `**/*` path `D:\dsh-path-guard-fixture\hidden` | 被拒绝（连根目录都不给列） |
| 3 | `glob` pattern `**/*` path `D:\dsh-path-guard-fixture` | 结果里 **不出现** `hidden` 这个目录名，也不出现 `secret.txt` / `another.txt` |
| 4 | `grep` pattern `TOP-SECRET` path `D:\dsh-path-guard-fixture` | 结果里 **完全没有** 任何 `hidden` 的内容或文件名 |
| 5 | `write` `D:\dsh-path-guard-fixture\hidden\x.txt` | 被拒绝 |

> 第 3、4 条是 `none` 档位的关键：即使搜索根是**父目录**，受保护条目也必须被剔除。
> 这走的是 `tools/post-execute` 的结构化脱敏，不是拒绝整个调用。

### G3 / 档位二之一：仅文件名

| # | 调用 | 期望 |
|---|---|---|
| 6 | `glob` pattern `**/*` path `D:\dsh-path-guard-fixture\listed` | **成功**，且结果里能看到 `visible-name.txt`（文件名可见） |
| 7 | `read` `D:\dsh-path-guard-fixture\listed\visible-name.txt` | **被拒绝**，文案说明「仅允许查看文件名与目录结构，不允许读取内容」 |
| 8 | `grep` pattern `LISTED-CONTENT` path `D:\dsh-path-guard-fixture` | 结果里 **没有** `listed` 的匹配内容 |

### G3 / 档位二之二：只读

| # | 调用 | 期望 |
|---|---|---|
| 9 | `read` `D:\dsh-path-guard-fixture\readonly\report.md` | **成功**，内容为 `READONLY-CONTENT-DDD` |
| 10 | `write` `D:\dsh-path-guard-fixture\readonly\report.md` | **被拒绝**，文案说明「允许读取，不允许写入或修改」 |
| 11 | `edit` `D:\dsh-path-guard-fixture\readonly\report.md` | 被拒绝 |

### G4 / 豁免

| # | 调用 | 期望 |
|---|---|---|
| 12 | `read` `D:\dsh-path-guard-fixture\sshlike\README.md` | **成功**，内容为 `EXEMPT-READABLE-EEE` |
| 13 | `read` `D:\dsh-path-guard-fixture\sshlike\id_rsa` | **被拒绝**（父规则 `list` 生效） |
| 14 | `glob` pattern `**/*` path `D:\dsh-path-guard-fixture\sshlike` | 成功，`README.md` 与 `id_rsa` 两个文件名都能看到 |

> 第 12 条同时证明「更具体规则胜出」：同一个目录下两条规则，一个 `list` 一个 `read`。

### 符号链接

| # | 调用 | 期望 |
|---|---|---|
| 15 | `read` `D:\dsh-path-guard-fixture\open\innocent-link` | **被拒绝**。链接指向 `hidden\secret.txt`，判定基于解析后的真实路径 |

> 这条是「为什么主决策放在异步 `tools/pre-execute` 而不是同步 guard」的证据。

### 对照组：不误伤

| # | 调用 | 期望 |
|---|---|---|
| 16 | `read` `D:\dsh-path-guard-fixture\open\normal.txt` | **成功**，内容 `NORMAL-GGG` |
| 17 | `glob` pattern `**/*` path `D:\dsh-path-guard-fixture\open` | 成功，`normal.txt` 在结果里 |

### 用户自己（G6）

| # | 操作 | 期望 |
|---|---|---|
| 18 | 在 DSH 的 GUI 文件树/编辑器里打开 `hidden\secret.txt` | **能正常打开**。防护只针对 AI 的工具调用，不针对用户 |

### shell（尽力而为）

| # | 调用 | 期望 |
|---|---|---|
| 19 | `pwsh` `Get-Content 'D:\dsh-path-guard-fixture\hidden\secret.txt'` | **被拒绝**（命令文本里出现了受保护路径） |
| 20 | `pwsh` `Get-ChildItem D:\dsh-path-guard-fixture` | **成功**（未提到受保护路径） |

> 把 `shell` 改成 `deny` 再试第 20 条，应当也被拒绝——这是「宁可不可用也不漏」的档位。

### 自我保护

| # | 调用 | 期望 |
|---|---|---|
| 21 | `plugin_manager` `action: list_plugins` | **成功**（保留可观测性） |
| 22a | `plugin_manager` `action: set_plugin, target: path-guard, enabled: false` | **被拒绝**，文案说明自我保护开启时 plugin_manager 只读 |
| 22b | `plugin_manager` `action: install_bundle, target: D:\tmp\whatever` | **也被拒绝**。这条是关键：早期实现按 target 字符串匹配本插件名，模型把插件复制到别的路径再安装就能绕过；现在一律拒绝 |
| 22c | `write` `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml` | **被拒绝**（可读不可写） |
| 22d | 把 `selfProtection` 关掉后重试 22a | 成功（确认开关真的接通） |

### 不可拦通道

| # | 调用 | 期望 |
|---|---|---|
| 24 | 任何 `mcp__*` 工具、`run_code`、`subagent_codex` | **被拒绝**（默认 `exoticTools: deny`） |
| 25 | `subagent`（同进程子代理） | **正常可用**，子代理的工具调用同样受规则约束——让它在子任务里 `read` 第 1 条的路径，应当同样被拒绝 |

> 第 25 条是「不影响你正常用 Agent Teams」的验收。

## 3. 回归

| # | 检查 | 期望 |
|---|---|---|
| 26 | 把 `shell` 设为 `off` | 第 19 条不再被拒（确认开关真的接通） |
| 27 | 把 `enabled` 设为 false | 第 1、6、9 条全部放行，且 `plugin_manager` 不再拦截 |
| 28 | 卸载 bundle | 所有约束消失，无残留（本插件不接管任何服务） |

## 4. 失败时怎么定位

- 每次拒绝都会写 Host 日志：`path-guard: denied <tool> — <首行>`。
- 内部错误写 `path-guard: internal error in <扩展点>` 并**拒绝**该次调用（fail-closed）。
- 插件启动时写一行清单：`path-guard: armed (N rule(s), defaultAccess=..., shell=..., exoticTools=...)`。
  看不到这行 = 插件没激活。
- 自锁急救：在「设置 → 路径守卫」里关掉 `enabled`，或在前端停用 bundle。

## 5. 已知会失败/不适用的场景（不是缺陷）

- `bash`/`pwsh` 的混淆绕过（变量拼接、编码、外部程序）——见 README 的「挡不住」表。
- 指令文件（`AGENTS.md`）与 skill 正文的内容——它们在 prompt 装配期读取，没有工具调用可拦。
- 历史会话检索——已经进入日志的内容收不回来。
