# 端到端验收手册

这份手册让你（或任何接手的人）在真实 DSH 里验证 dsh-path-guard。
所有断言都是「用一个工具调用去试，看结果是否符合预期」。

## 0.1 已完成的实际验收记录

**2026-09-25，活体 DSH（`danger-full-access`，配置：`~/.ssh → list` + `~/.ssh/README.md → read`，自我保护开启）。**
全部为真实工具调用，不是推演：

| 断言 | 调用 | 实测结果 |
| --- | --- | --- |
| 自保护的 shell 扫描 | `pwsh Get-Content '<profile>\cordis.patch.yml'` | ✅ 拒绝，报出命中规则 `…cordis.patch.yml → access: read` |
| `read` 档可读 | `read '<profile>\cordis.patch.yml'` | ✅ 放行 |
| `read` 档不可写 | `edit '<profile>\cordis.patch.yml'`（探针串故意不匹配） | ✅ 拒绝，文案写明「允许读取，不允许写入或修改」 |
| 自我保护（反绕过） | `plugin_manager install_bundle`，target **不含**本插件名 | ✅ 拒绝 |
| 不误伤 | `pwsh node --version` | ✅ 放行 |
| **豁免生效** | `read C:\Users\…\.ssh\README.md` | ✅ **放行并返回内容**（覆盖了更宽的 `list` 规则） |
| 半访问·仅文件名（拒绝读） | `read C:\Users\…\.ssh\config` | ✅ 拒绝，规则 `~/.ssh → access: list` |
| 半访问·仅文件名（允许列名） | `glob` `C:\Users\…\.ssh` `*` | ✅ 放行，全部文件名可见（含各私钥文件名） |
| grep 需要内容 ⇒ 拒绝 | `grep` `ProxyJump` 于 `~/.ssh` | ✅ 拒绝 |
| shell 扫描 | `pwsh Select-String … 'C:\Users\…\.ssh\config'` | ✅ 拒绝 |
| `list` 档不可写 | `edit C:\Users\…\.ssh\config`（探针串故意不匹配） | ✅ 拒绝 |

尚未在活体上跑的是第 2 节里依赖 `D:\dsh-path-guard-fixture` 的那些条目（隐藏目录、符号链接绕过、
超限搜索的 spill 行为）——夹具与步骤都已就绪，随时可跑。

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
| 19b | `pwsh` `Get-ChildItem D:\dsh-path-guard-fixture` | **成功**（未提到受保护路径） |
| 19c | `pwsh` `Get-Content (Join-Path 'D:\dsh-path-guard-fixture' 'hidden\secret.txt')` | **会成功**——这是**已知限制，不是缺陷**。命令里没有连续的字面路径，文本扫描抓不到，随后也没有可匹配的输出。要真正堵住只能把 `shell` 设为 `deny` |
| 19d | 把 `shell` 改成 `deny`，重试 19b | 也被拒绝（确认「宁可不可用也不漏」的档位真的接通） |

> 「扣留提到受保护路径的输出」是第二道网，只在命令绕过文本扫描、但输出里仍出现**完整字面路径**时才触发。单元测试覆盖了它；
> 手工构造这种情形需要刻意设计，不建议写进验收清单。
>
> 另外两条 shell 语义（都有单测覆盖）：
> - `selfProtection` 生成的规则使用 `read` 档 ⇒ shell 里引用 profile 组合文件会被拒；
> - **`write` 档的规则不参与 shell 扫描**——策略本来就完全放行该路径，`cd D:/项目 && npm test` 不该被拒。

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
| 23a | 任何 `mcp__*` 工具 | **被拒绝**（默认 `exoticTools: deny`） |
| 23b | `workflow`（脚本编排） | **被拒绝**。脚本在 `node:vm` 里跑且能逃逸到真正的 `process`，`danger-full-access` 下不受任何围栏约束，属插件层无法观察的通道 |
| 23c | `subagent`（同进程子代理） | **正常可用**，子代理的工具调用同样受规则约束——让它在子任务里 `read` 第 1 条的路径，应当同样被拒绝 |
| 23d | `todo_write` / `ask_user_question` | **始终可用**。插件内部即便出错也不会连这些工具一起拒（fail-closed 只覆盖它负责判定的调用） |

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

## 6. 活体验收：TS 迁移 + 架构重构后（2026-09-30，重启后进行）

适用配置：`~/.ssh → list`、`~/.ssh/README.md → write`、`defaultAccess: allow`、`exoticTools: deny`、
`selfProtection: true`（默认）。基线：迁移到 TS 6.0.3、接入 `resource.ts` 与 `fs-guard.ts` 之后。

| # | 探测 | 期望 | 实测 |
|---|---|---|---|
| 1 | 不含受保护路径的 `pwsh`（`node --version` / `git log`） | 放行 | ✅ 放行（无误伤） |
| 2 | `read` profile 补丁（`read` 档：可读不可写） | 放行 | ✅ 读到全文 78 行 |
| 3 | `pwsh` 命令含受保护路径字面量 | 拒绝 | ✅ 拒绝，命中 `~/.ssh → list` |
| 4 | `workflow`，脚本不含受保护路径 | **放行** | ✅ 运行成功并返回结果 |
| 5 | `read` 受豁免文件（`~/.ssh/README.md`，`write` 档） | 放行 | ✅ 读到全文 82 行 |
| 6 | `write` 受保护目录下的新文件 | 拒绝 | ✅ 拒绝，规则 `~/.ssh (#0) → list` |
| 7 | `write` 允许路径（`reports/*.txt`） | 成功 | ✅ 创建成功 |
| 8 | `edit` 同一允许文件（走 `fs/edit-intent`） | 成功 | ✅ 修改成功 |
| 9 | 客户端 `Slots.listSubTree('plugins.row.config')` | 有本插件占位且 `active` | ✅ `registrant: path-guard-client`、`key: dsh-path-guard#path-guard`、`active: true` |

**第 4 条是「加载的是新代码还是旧代码」的判别器**：`workflow` 曾因 `exoticTools: deny` 被一刀切拒绝，
重构后改为「扫描脚本文本」。它现在跑得通 ⇒ 重启后加载的是新构建的 `lib/index.js`，不是旧的 `src/index.js`。

**第 9 条证明了此前无人能验证的环节**：客户端半页编译成经典脚本后**真的被装载并注册了**。
（背景：`package.json` 的 `"type": "module"` 会让 tsc 给产物补 `export {};`，而加载器是 `<script src>`，
解析期即失败；而 `node --check` 因按 ESM 解析会通过，不能作为验收手段。）

### 仍未验证 / 无法构造的验证

- **`fs/*-intent` 层的运行时执行无法用差分实验证明**。理由是构造性的，不是借口：该层是**兜底**，
  只有当「`pre-execute` 检查到的目标 ≠ 之后真正写入的目标」时才会与上层结论不同，而那需要赢下一次
  符号链接竞态；对任何外部可构造的输入，两层结论**必然一致**，因此无法隔离观测。
  已有的间接证据：① 第 4 条证明新 `apply()` 已执行；② 第 7、8 条证明 `prepend` 注册的监听器
  **没有破坏正常写入链**（若它排在最前却不调 `next()`，进程内所有写入都会失败）；③ Host 事件检查器确认
  `mode: waterfall`、"the first listener that returns an intent owns the decision"、
  `actor: object | undefined`（与适配器 `actor => actor !== null && typeof actor === 'object'` 一致）。
  **剩余不确定性**：无法排除「该监听器排在 `fs-observation-policy` 之后因而从不执行」这一失效模式，
  只能依赖 `prepend: true` 的源码事实与单元测试。
- **浏览器内的实际渲染观感**（深/浅色、对比度、hover/focus）——第 9 条只证明注册发生，不证明好看。
