# dsh-path-guard — 对抗性验证报告

- 验证者：`verifier`（独立于实现者）
- 工作目录：`D:\Program\dsh-path-guard`；参考源码：`D:\Program\deepseek-harness`（只读，未修改）
- 被审代码快照：`src/*.js`、`client/client.js`、`cordis.patch.yml`、`package.json`（本报告只读这些文件，未改动仓库中除本文件外的任何文件；未运行任何 git 命令）
- 运行环境事实：Node v24.12.0、`process.platform==='win32'`、`DSH_PROFILE_DIR=C:\Users\SuSeventeen\.dsh\profiles\web`、本会话 DSH file policy = `danger-full-access`、当前活跃预设 = `packages/bundle/web-app/presets/cordis.patch.yml`（profile 里 `agent-preset-registry.selectedDefault: cordis`）

## 方法与证据等级

我自己写脚本、**直接 import 仓库里真实的 `src/*.js` 与真实的 `@deepseek-ai/schemastery@3.18.4`** 驱动，而不是复述测试。可复现脚本（在系统临时目录，不在仓库内）：

```
$env:TEMP\pg-verify\exp1.mjs   # shell 扫描绕过 / 过度拒绝 / plugin_manager target / fail-closed / 策略边界
$env:TEMP\pg-verify\exp2.mjs   # defaultAccess vs shell / 工具覆盖 / volatile 漂移 / over-cap 脱敏
$env:TEMP\pg-verify\exp3.mjs   # 真实 schemastery 契约（volatile ref）端到端 + 实时改配置
$env:TEMP\pg-verify\exp5.mjs   # 复刻 settings Host 的写入校验（validatePaths/isVolatilePath/volatileForm）
$env:TEMP\pg-verify\exp6.mjs   # realpath.native 规范化、8.3、\\?\、~ 无 home
$env:TEMP\pg-verify\exp7.mjs   # 长格式规则 vs 8.3/\\?\ 拼写（规范化解法是否成立）
```

另外用 `cordis_inspect_query(host, Config, listConfigs)` 直读**当前运行中 Host** 的 Loader 树（只读查询）。

基线：`node --test tests/host.spec.js tests/policy.spec.js tests/redact.spec.js` → **85 pass / 0 fail**（我复跑确认）。本报告的所有问题都**不是**测试失败——它们是测试没有覆盖的契约面。`client/client.js` 与 wiring 的真实性完全没有任何测试覆盖。

状态标签：**已验证可利用** / **源码可证、未端到端验证** / **待确认** / **已正确防护**。

## 必查清单对照

| # | 清单项 | 结论 | 位置 |
|---|---|---|---|
| 1 | `tool-fields.js` 字段映射 vs 真实工具；已挂载但未映射的工具 | 9 个映射逐字正确；`workflow` 是已挂载且完全没有被映射的文件访问工具（**严重**）；`skill`/`job_output` 与若干第三方插件的检索类工具属路径/内容弱披露或已被其他机制覆盖 | D-2、V-2 |
| 2 | `plugin_manager` 自我保护可否绕过 | `set_plugin`/`remove_bundle` 打不到自己（entryId = `include:path-guard` 仍含子串）；但 `install_bundle` 可用不含子串的绝对路径装一个"停用 path-guard"的 bundle 绕过 —— **源码可证、未端到端验证** | V-5 |
| 3 | 子代理是否继承防护 | **是**，同进程 provider 下 guard 落在 global 层 + 未打标签监听者收到所有子 scope 事件；外部 provider 已被 exoticTools 默认拒绝 | D-4 |
| 4 | redact 的路径基准 | 与 `search-core.ts:234-235` 的 workdir 逐字一致，`path.resolve(cwd, entry)` 是 `toWorkdirRelative` 的正确逆运算；相对/平台分隔符/绝对三类结果都正确 | D-5 |
| 5 | `list` 档位语义一致性 | 未被破坏：`read`/`str_replace_editor view`/`lsp` 都需要 `read` 档 ⇒ 在 `list`/`none` 档直接拒绝，不会泄露内容；`glob` 与 `present` 的"仅文件名可见"是设计意图本身 | E.3 |
| 6 | 策略引擎边界 | 逐项构造后**未发现**"以为受保护实际没保护"的组合；`\\?\`/8.3 由规范路径 pass 兜住；UNC 与 POSIX 路径键碰撞是过度保护（低） | D-11、V-8、V-11、V-12 |
| 7 | fail-closed 会不会自锁 | 不会静默自锁，但爆炸半径是**整个工具面**（含 `ask_user_question`），且 `defaultAccess` 与规则形状漂移各有 fail-open / 全量 block 的极端 | V-10、V-6、V-7、V-3 |
| 8 | 客户端配置页写入是否会被 settings 拒绝 | 不会：用真实 `Config` 复刻 Host 的 `validatePaths`/`isVolatilePath`/`volatileForm` 全部 ACCEPTED，`form.set` 签名/返回、快照字段、插槽 props、client loader handoff 全部与出厂先例一致 | D-7 |
| 9 | 实现者没想到的隐蔽问题 | shell 无输出过滤却在三处宣称有（V-1）；`defaultAccess: none` 反而放开 shell（V-3）；shell 忽略 access 档位与"豁免"设计矛盾（V-4）；`workflow` 逃逸（V-2）；"空策略惰性"分支生产不可达（V-6）；`rules` 形状漂移 fail-open（V-7）；**当前 profile 里插件根本没挂载**（V-9） | A/B/C 段 |

---

# A. 已验证可利用

## V-1（严重）shell 扫描可被任意"拼写变体"绕过，而 shell 输出**完全没有**过滤

**结论**：`shell: 'scan'`（默认值）对 shell 的防护 = 在命令文本里做字面子串匹配。任何不把受保护路径写成连续字面量的写法都能通过；通过之后命令的**输出原样回到模型**，插件根本没有"过滤输出"这一步。三处文档都声称有输出过滤。

**证据**
- `src/tool-fields.js:44-46`："the plugin scans it for protected paths instead of parsing it, **and filters the output**"
- `client/client.js:55` / `:102`（中文/英文 hint）："插件只能扫描命令文本**并过滤输出**"
- `src/index.js:434-439`：`tools/post-execute` 只处理 `glob`/`grep`，其他工具（含 `bash`/`pwsh`）一律 `next()` → 输出零处理
- `src/scan.js:30-66`：needle 只有「展开后的绝对路径 / 反斜杠拼写 / `~`、`$HOME`、`${HOME}`、`$env:USERPROFILE`、`%USERPROFILE%` 前缀拼写」

**复现**（`exp1.mjs` E1/E1b，规则 `~/.ssh → none`）：

| 命令 | guard |
|---|---|
| `cat C:/Users/SuSeventeen/.ssh/id_rsa` | DENIED |
| `cat ~/.ssh/id_rsa` | DENIED |
| `cat "$(echo ~)/.ssh/id_rsa"` | **ALLOWED** |
| `Get-Content (Join-Path $HOME '.ssh/id_rsa')` | **ALLOWED** |
| `cat ~/.ss*/id_rsa` | **ALLOWED** |
| `node -e "process.stdout.write(require('fs').readFileSync(require('os').homedir()+'/.ssh/id_rsa','utf8'))"` | **ALLOWED** |
| `Get-Content ($env:USERPROFILE + '\.ssh\id_rsa')` | **ALLOWED** |

E1b：`post-execute(pwsh, {content:[{type:'text',text:'PRIVATE KEY MATERIAL'}]})` → 返回下游 `{kind:'accept'}`，内容原样进入上下文。

**如果它其实是对的，我会看到什么不一样**：`$(echo ~)` 那条会命中 needle 并返回拒绝串。实际返回 `undefined`。

**建议**：① 立刻改掉 UI/注释里的"过滤输出"措辞（现在是在向用户承诺一个不存在的功能）；② 若确实要过滤输出，`tools/post-execute` 需要按 needle 扫 `result.content` 的文本块并对命中块整体替换（成本低、可做，但同样只是 best-effort）；③ 安全取向的用户必须用 `shell: 'deny'`——建议把该选项在 UI 里提到首位并写清代价。

---

## V-2（严重）`workflow` 工具是完全不受管的文件读写通道，`exoticTools: 'deny'` 不覆盖它

**结论**：`workflow` 既不在 `PATH_TOOLS`、也不在 `SHELL_TOOLS`、也不在 `EXOTIC_TOOLS`，插件对它**一行代码都不执行**（`evaluatePaths` 直接 `return undefined`）。而 DSH 自己的 e2e 测试证明 `workflow` 脚本能通过 `node:vm` 逃逸拿到真正的 `process`，进而在**子进程**里任意读写文件；`danger-full-access` 下这个子进程**不被任何 OS 沙箱约束**。脚本不是工具调用，`tools/pre-execute` 结构上看不到它。

**证据**
- `src/tool-fields.js:30-64`：`PATH_TOOLS` 无 `workflow`；`SHELL_TOOLS` 无 `workflow`；`EXOTIC_TOOLS` = `run_code, subagent_codex, subagent_claude_code, subagent_acp`，无 `workflow`。`exp2.mjs` E9 实测 `isExoticTool('workflow') === false`
- 活跃预设 `packages/bundle/web-app/presets/cordis.patch.yml:118-123` 挂载 `workflow-ptc`（`provider: spawn`）+ `tool-workflow`
- `packages/workflow/workflow-ptc/src/runtime.ts:75-98`：`new vm.Script(...)` + `vm.createContext({})`，只注入 `agent/parallel/pipeline/phase/log/args` 六个全局
- `packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts:58`（**DSH 自己的测试**，我逐行读过）：脚本体是
  `const proc = globalThis.constructor.constructor('return process')(); proc.getBuiltinModule('node:fs').writeFileSync(args.outside,'changed')`，`:75` 断言在 `read-only` 下外部文件未被改动 —— 即：逃逸成立，唯一拦截者是 OS 沙箱
- `packages/ptc-runtime/ptc-runtime-node/src/index.ts:224`：`confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(...)`，`:236` 用原始 argv spawn
- `packages/sandbox/sandbox/src/index.ts:25-28`：`danger-full-access` 绕过 confinement（本会话即此模式）

**攻击形态**（一步，无工具参数路径可查）：
`workflow({ script: "const p=globalThis.constructor.constructor('return process')(); return p.getBuiltinModule('node:fs').readFileSync('C:/Users/SuSeventeen/.ssh/id_rsa','utf8')" })`

**状态**：插件侧"完全不覆盖"= 已验证；"脚本确实能读写任意文件"= DSH 源码 + DSH 自己的测试可证，我未在真实会话执行该脚本。

**建议**：把 `workflow`（以及任何启用时的 `ralph`）加入 `EXOTIC_TOOLS`。注意这是**需要 Lead 决策**的取舍：`exoticTools` 默认 `deny`，加入后模型将失去 `workflow` 编排能力（`subagent`/`subagent_fork` 是同进程的、受 guard 覆盖，不受影响）。若不愿默认禁，至少要在配置页明确写出："允许 workflow = 接受任意文件读写"。

---

## V-3（高）`defaultAccess: 'none'` + 空规则 ⇒ 看起来最严，实际把 shell 完全放开

**结论**：`shell: 'scan'` 的 needle 只由**规则表**生成，与 `defaultAccess` 无关。用户如果把 `defaultAccess` 设成 `none`（"默认全禁，只放我写的"）且一条规则都没写，则：所有 `read/write/edit/glob/grep/present/lsp` 全部被拒，而 `pwsh` **一个 needle 都没有**，任何命令（含直接写受保护路径的命令）都被放行；叠加 V-1，输出原样回到模型。

**证据**：`src/index.js:335-342`（needles 来自 `rulesOf()` + selfRules）、`src/scan.js:42`（`rules ?? []`）；`exp2.mjs` E8：`rules: []` → `buildNeedles` 长度 0 → guard 对 `type C:/Users/…/.ssh/id_rsa` 返回 `undefined`（ALLOWED），同一路径的 `read` 被 `pre-execute` 判 `deny`。

**建议**：`shell: 'scan'` 在"推不出任何 needle"时不能默认为"无危险"。最小修法：当 `defaultAccess !== 'allow'` 且有效规则为 0 时，把 shell 视为 `deny` 并在激活日志/配置页给出显式警告（fail-closed 是与本插件其余部分一致的方向）。

---

## V-4（高）shell 扫描忽略 access 档位 ⇒ 用户明确"豁免"的路径在 shell 上仍被整体拒绝，与"豁免=更具体的规则"这一核心设计直接矛盾

**结论**：`evaluateShell` 命中任一 needle 就无条件拒绝，从不看该规则的 `access`。因此 (a) 为豁免而写的更具体规则（`~/.ssh/README.md → read`）在 shell 上无效；(b) 完全放行的 `write` 档规则（如 `D:/proj → write`）会让**任何提到该路径的 shell 命令**被拒——包括 `cd D:/proj; npm test`。

**证据**：`exp1.mjs` E2（同一份规则）：`read` 受豁免的 `README.md` → `pre-execute` = `allow`，而 guard 对 `Get-Content '<README.md 绝对路径>'` = DENIED；`cd D:/proj; npm test` = DENIED。代码：`src/index.js:337-349`（`buildNeedles` 收全量规则，无 access 过滤；命中即返回 `shellDenialText`）。

**为什么这很重要**：用户按文档加了豁免规则、验证 `read` 通过，就会认为 shell 也按同一套语义工作。实际是"只要出现过路径字面量就全拒"。

**建议**（Lead 决定取向）：
- 最小、无争议的一步：`buildNeedles` 跳过 `access: 'write'` 的规则（策略已完全允许该路径，shell 引用它不构成越权）。
- `read`/`list`/`none` 档必须继续拒绝 shell（shell 里无法区分读/写），但拒绝文案应说明"shell 无法逐路径判定，`read` 豁免不延伸到 shell"，并考虑给规则加一个显式的 `shell: allow|deny` 覆盖位。

---

## V-9（严重 — 部署状态）**当前 profile 里 dsh-path-guard 根本没有被挂载**

**结论**：这个 profile 只把 `dsh-path-guard` 放在 `dependencies` 里，**没有放进 `dsh.profile.bundles`**；按 `app-boot` 的组合规则，只有 `dsh.profile.bundles` 里列出的包才会套用其 `dsh.bundle.patch`。因此 `cordis.patch.yml` 的 `- insert: id: path-guard` 从未生效，**运行中的 Host 里没有这个 row**。85 个通过的测试描述的是一个没有接进当前组合的插件。

**证据**
- `C:\Users\SuSeventeen\.dsh\profiles\web\package.json:4-18`：`dsh.profile.bundles = [dsh-base, dsh-web-app, dsh-experimental-agent-team-profile, dsh-desktop-notify, @omb/plugin]`；`dependencies` 里有 `"dsh-path-guard": "link:D:/Program/dsh-path-guard"`
- `C:\Users\SuSeventeen\.dsh\profiles\web\cordis.yml`：198 个 row，`Select-String 'path-guard'` 零命中
- **运行中 Host 的权威证据**：`cordis_inspect_query({platform:'host', provider:'Config', method:'listConfigs', input:{name:'path-guard'}})` → `{entries: [], total: 0}`；同一 provider 查 `include:tool-fs` 正常返回（说明查询本身可用、`entryId` 形如 `include:<patchId>`）
- 规则出处：`packages/boot/app-boot/src/profile.ts:6-14`（"applying each bundle's patch lists in `dsh.profile.bundles` order … then the profile's own patches"）

**影响**：本会话（以及任何未改动的会话）实际上**没有任何路径限制**在生效；`guard`/`pre-execute`/`post-execute` 三个拦截点全部缺席。同时它也掩盖了 A 段所有问题——没人再撞上它们。

**建议**：把 `dsh-path-guard` 加入 `dsh.profile.bundles`（或走 `plugin_manager install_bundle` 正规安装路径），重启后用上面那条 `cordis_inspect_query` 复核 row 存在，再重跑一次真实激活验证（V-1/V-2/V-3 的问题会在真实使用中暴露）。注意 bundle 会被追加在列表**末尾**，其 patch 层晚于 `dsh-base`，所以 `path-guard` row 会正常 insert。

---

# B. 源码可证、未端到端验证（我拒绝在活 profile 上做实弹）

## V-5（中高）`plugin_manager` 自我保护可被 `install_bundle` 间接绕过

**结论**：自我保护判据是「action ∈ 黑名单 且 target 字符串包含 `dsh-path-guard` 或 `path-guard`」。而 `install_bundle` 接受**绝对本地路径 / git URL / tarball URL**，且目标串由模型自由填写。一个名字与内容都不含这两个子串的包，其 patch 层可以 `- id: path-guard` + `disabled: true` 直接停掉本插件；安装后的 bundle 追加在 `dsh.profile.bundles` 末尾，因此它的 patch 层晚于本插件的层。此外在本 profile 的默认权限预设下，该操作**不需要任何审批**。

**证据**
- `src/index.js:359-366`：`target.includes(...)` 子串判据
- `packages/boot/plugin-manager/src/tools.ts:76-82`（`install_bundle` 直接吃 `args.target`）、`src/install-spec.ts:68-91`（`kind: 'path' | 'git' | 'tarball'`，仅要求本地路径为绝对路径）
- **同一种 patch 方言确实能按 id 停掉上游层的 row**：`packages/bundle/web-app/cordis.patch.yml:444-553` 大量 `- id: tool-fs` / `disabled: true`（关掉 base 层的 row）
- `packages/boot/plugin-manager/src/index.ts:730`：`setBundleEnabled`/安装把 bundle 名 append 到 `dsh.profile.bundles` → 层序在后
- `packages/sandbox/sandbox/src/escalation.ts:173`：`if (mode === effectiveMode) return effectiveMode` → 本 profile 默认 `danger-full-access`（`cordis.patch.yml:27-40` 的 `defaultPreset: danger-full-access`），所以 `plugin_manager` 的每次调用都**不触发审批**
- `exp1.mjs` E3 实测：`install_bundle('./evil-bundle')` / `install_bundle('file:C:/Users/x/evil')` / `install_bundle('evil-bundle@1.0.0')` 全部 `ALLOWED`，而 `set_plugin('path-guard')` / `remove_bundle('dsh-path-guard')` 被拒

**攻击步骤**（未执行）：① 用 `write` 在任意可写目录建一个最小包，`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`；② patch 内容 `- id: path-guard` + `disabled: true`；③ `plugin_manager { action: 'install_bundle', target: 'C:\\...\\<该目录绝对路径>' }` —— target 不含被禁子串 → 放行 → 防护 row 被后置层停用。

**建议**：自我保护不能建立在"自由格式字符串包含子串"上。改为：`selfProtection` 为真时，除 `list_*` 外**整体拒绝** `install_bundle`/`set_bundle`/`remove_bundle`（这几类操作的副作用集合无法在调用前被字符串判定），或由 manager 先解析出本次操作会触碰的 row id 集合、与自身 `patchId` 求交后拒绝。另外一个便宜且有效的加固：deny 时把 `SELF_ROW_ID`/`SELF_PACKAGE` 之外再加上**本插件的安装路径**（`D:\Program\dsh-path-guard`）与 bundle 名，至少挡住"直接改本插件"的最短路径。

**附带确认（已正确防护）**：`set_plugin` 的 target 是 Loader `entryId`，实测当前 profile 的 entryId 形如 `include:tool-fs`（带 `include:` 前缀），所以本插件的 entryId 是 `include:path-guard`，**仍然包含** `path-guard` → 子串判据在这条路径上成立（不是随机 id；`vendor/loader/lib/types/config/tree.js:53-60` 的 `ensureId` 只在 `options.id` 缺失时才生成随机 id，而 patch 明确写了 `id: path-guard`）。

---

# C. 中低 / 设计脆弱点（已核实的事实）

## V-6（中）"空策略保持惰性"在生产中不可达：结构漂移会整块扣留 glob/grep

**结论**：`src/index.js:449` 的 `if (policy().rules.length === 0) return next()` 想表达"没有规则就别管"。但 `policy()` 在 `selfProtection`（默认 true）且 `DSH_PROFILE_DIR` 存在时总会追加 3 条 selfRules（`src/index.js:174-181,195`），而真实部署里 `DSH_PROFILE_DIR` **总是存在**。所以 `rules: []`（出厂的 `cordis.patch.yml` 默认值）时 `rules.length === 3`，一旦 `glob`/`grep` 的 value 结构与 `redact.js` 的识别不符，**整个结果被 block**。

**证据**：`exp2.mjs` E4（真实环境变量下 `DSH_PROFILE_DIR` 已设置）：`rules: []` + 默认 `selfProtection` + 漂移的 glob value → `{kind:'block'}`。方向是 fail-closed（安全），但注释所声明的行为与代码不符，且后果是"两个搜索工具对全体用户静默失效"。

**建议**：把惰性判据改成 `rulesOf().length === 0 && read('selfProtection') !== true`；或让漂移走"只丢弃无法核验的条目"而不是整块 block。至少改掉注释。

## V-7（中）`rules` 形状漂移 ⇒ fail-open，与插件反复强调的 fail-closed 相反

**结论**：`rulesOf()`（`src/index.js:168-171`）把任何非数组值折叠成 `[]`，于是策略静默变成"无规则"，shell 与文件路径全部放行；只有 `logger.warn`（且只对数组内的坏条目），没有 error。

**证据**：`exp2.mjs` E10：一个 `get()` 返回字符串的 rules 引用 → guard 对写入受保护路径的命令返回 `undefined`（静默放行）。同类：`compile()` 对 `home` 缺失时的 `~` 规则不报 invalid（`exp6.mjs` P3：`~/.ssh` 编译成永远匹配不上的模式，且 `invalid` 为空、无任何告警）。

**建议**：`rules` 存在但不是数组 ⇒ 与三个拦截点的内部错误同样的待遇（`logger.error` + fail-closed），不要静默降级。`~` 规则在 `home` 不可用时也应进 `invalid`。

## V-8（低-中）词法 pass 不认 `\\?\` / 8.3 拼写；兜底完全依赖 `ctx.fs.resolve` 的规范化 pass（该 pass 本身**已正确工作**）

**结论**：词法层把 `\\?\C:\Users\x\.ssh\id_rsa` 归一成 `/?/C:/Users/x/.ssh/id_rsa`，与任何规则都不匹配（`exp1.mjs` E5）。安全性完全由 pre-execute 里第二次 `ctx.fs.resolve` → `processPath` 的规范路径判定兜住。**实测这条兜底是有效的**：`fs-local` 用 `realpath.native`（`packages/fs/fs-local/src/fsio.ts:18,161-166`），它会把 `\\?\` 前缀剥掉、把 8.3 短名展开成长名（`exp6.mjs` P1、`exp7.mjs`：长格式规则对 8.3 与 `\\?\` 两种拼写都判 `none`）。不存在的目标走"最近存在祖先 realpath + 追加后缀"（`fsio.ts:176-198`），同样规范化。

**残留风险**（非当前可利用）：① 若 `fs.resolve` 抛错，`src/index.js:268-272` 只 debug 日志后回落到词法结论——对 `glob`/`grep`（它们根本不走 `ctx.fs`，`search-core.ts:228-248` 用 `cwd: workdir`、把原始 path 放进 argv 交给 ripgrep）而言，插件自己的 resolve 与工具实际访问是两条代码路径；② 换一个 `processPath` 返回原始拼写的 fs 后端会静默丢掉这层保护。建议：`decidePath` 在 `fs.resolve` 失败且该工具属于 glob/grep 时，不要静默回落（记 warn 或对无法规范化的搜索根直接拒绝）。

## V-10（中，设计决策）fail-closed 的爆炸半径是整个工具面，而不是它管辖的那部分

**结论**：`tools/pre-execute` 的 try 包住了 `read('enabled')` 与全部判定（`src/index.js:374-387`），catch 返回 `{kind:'deny'}`。于是**任何**内部故障（哪怕只是读一个 volatile 字段抛错）都会拒绝**所有**工具调用，包括 `todo_write`、`ask_user_question`、`exit_plan_mode`——即模型向用户求助所需的通道。历史上那次事故（把 volatile 当数组）正是这一条：guard 抛异常把整个 shell 打死；现在不会抛了，但会变成"整个工具面被拒"。

**建议**：fail-closed 只应对"本插件负责判定的调用"生效：非 `PATH_TOOLS`/非 shell/非 exotic 的工具在内部错误时应 `next()`（或至少永不拒绝 `ask_user_question` 这类人工逃生通道）。这属于 Lead 决策：更严格 vs 更不易自锁。

## V-11（低）UNC 与 POSIX 绝对路径被折叠成同一个键

`src/policy.js:39-41` 把 `\\srv\share\sec` 归一为 `/srv/share/sec`。`exp1.mjs` E5：规则 `\\srv\share\sec` 同时命中 `/srv/share/sec`（反之亦然）→ 非 Windows 上会误伤同名 POSIX 路径。建议在归一化时给 UNC 保留可区分前缀（`//`）。

## V-12（低）`/` 不能作为根规则

`compile()` 把 `path: '/'` 判为 invalid（"path does not resolve to a usable pattern"，`src/policy.js:384-386`），而 `C:/` 可以。POSIX 上用户无法写"整个文件系统"的根规则（会影响默认档位的直觉）。当前至少会 warn，属可接受，但值得在文档里写明。

---

# D. 已正确防护（我试图攻破但失败 / 逐条核对通过）

| # | 项目 | 证据 |
|---|---|---|
| D-1 | **volatile 契约**（历史事故的那一类） | 用**真实** `@deepseek-ai/schemastery@3.18.4` 跑 `Config({...})`：`resolved.rules` 是冻结的 `{get, [Symbol.for('cosmokit.volatile.write')]}`（`exp3.mjs` C1）；`unwrap` 命中；整插件在真实 config 下 pre-execute=deny、guard=reject 正常（C2）；模拟 settings 的 `updateVolatile` 后立即生效（C3）。与 `vendor/cosmokit/src/volatile.ts:39-45`、`vendor/schemastery/src/index.ts:521-526` 一致 |
| D-2 | **字段映射与真实工具一致** | `read/read_image/write/edit → file_path`（`tool-fs/src/read.ts:81`、`read-image.ts:214`、`write.ts:76`、`edit.ts:88`）、`glob/grep → path`（`glob.ts:318`、`grep.ts:290`）、`present → files[].path`（`tool-present/src/index.ts:51`）、`lsp → file_path`（`tool-lsp/src/index.ts:120`）、`str_replace_editor → command+path`。均逐字核对 |
| D-3 | **`plugin_manager set_plugin` 打不到自己** | 活 Host 实测 entryId 形如 `include:tool-fs`；本插件对应 `include:path-guard`，仍含 `path-guard` → 子串判据成立（见 V-5 附带确认） |
| D-4 | **子代理继承防护** | 本插件是 bundle/profile 层 row（未带 scope tag）→ `guard()` 落在 `layers.global`，`ToolRuntime.guardReason` 无条件先查 global（`core/tools/src/index.ts:1144-1154`）；事件侧 `scopeTarget` 对未打标签的监听者一律放行（`core/scope/src/index.ts:170-185`）。旁证（我逐行读过）：`subagent/subagent-in-process-driver/tests/structured.spec.ts:187-198` —— 在 root ctx 上注册的 pre-execute 监听器能收到**子代理**的工具调用，且该测试断言子代理的工具副作用未发生。**前提**：仅限同进程 provider（本预设只有 `spawn`/`fork`；codex/claude-code 被 `disabled: true` 且在 EXOTIC_TOOLS 里被默认拒绝） |
| D-5 | **脱敏基准与搜索工具一致** | `search-core.ts:234-235`：`const cwd = exec.agent?.session.header.cwd; const workdir = cwd ?? process.cwd()`，与 `src/index.js:441-442` 逐字相同；`toWorkdirRelative`（`search-core.ts:300-306`）以 workdir 为基准、workdir 外的绝对路径原样保留、相对输入不变 → `path.resolve(cwd, entry)` 正是它的正确逆运算；over-cap 时 value 仍是完整列表 → 脱敏完整（`exp2.mjs` E11：500 条中 3 条 secrets 全被剔除，497 条保留） |
| D-6 | **post-execute 与 spill 的顺序陷阱已消除** | `spill-policy/src/index.ts:133-136` 先 `await next()`，且当下游决策带 `value` 时立即返回 → 无论注册顺序如何，都不会把未脱敏内容写进 spill；`tool-fs-search/src/direct-call.ts:24` 同理让搜索工具自己的监听器跳过 |
| D-7 | **配置页写入路径成立** | `form.set(field, value): Promise<boolean>` 与 `ConfigFormController.set`（`client/ui-settings/src/client/config-form.ts:114-116`）签名/返回一致；快照字段 `status/value/writable/mode/revision` 全部存在（同文件 `:79-94`）；用**真实 Config** 复刻 Host 的 `validatePaths`/`isVolatilePath`/`volatileForm`（`settings/settings/src/index.ts:399-409`、`schema.ts:37-79`）：`rules` 与其余 6 个字段全部 ACCEPTED，未声明的字段 REJECTED（`exp5.mjs`）；`slots.register({name:'settings.section', id, order, label, locale})` 与出厂先例 `ui-settings-agent-loop/src/client/index.ts:47-49` 同形；`window.__ModuleLoader__.load({id, factory})` 与 `client/modules/src/client/manifest.ts:10,327` 一致 |
| D-8 | **`web_fetch` 不能读本地文件** | provider 层 scheme 白名单（`web-fetch-http/src/policy.ts:32-34`）+ 每个重定向重新校验（`provider.ts:87-99`）+ 只用 undici（`network.ts:199-206`）；`file:`、`\\?\`、file-重定向均被拒 |
| D-9 | **`tool-cordis` 只读** | 只有 `cordis_inspect_list/query` 两个工具，Host provider 仅 Service/Event/Config/Tool，全部只读；`Config.listConfigs` 只投影 id/patchId/name/status 与 `packageDir` 路径，不返回文件内容；registry 的 `query` 只能调 provider handler（`cordis-host-runner/src/inspect-registry.ts:107-126`） |
| D-10 | **相对路径的基准不一致不存在** | `sandboxPolicy.workspaceRoot` 在有 session cwd 时**就是** `session.header.cwd`（`sandbox-policy/src/index.ts:168` + `tool-fs/src/session-cwd.ts:31`），所以 guard 与 `write`/`edit`/`read` 的 resolve 基准是同一个字符串；仅"session 无 cwd + 两个部署默认值不同"这一种组合会产生分歧（当前 profile 两者都是 `process.cwd()`） |
| D-11 | **策略引擎边界** | `exp1.mjs` E5 逐一验证：`D:/a/**/b` 命中 `a/b`、`a/x/b`、`a/x/y/b`；`**`/`/**` 匹配自身与后代；尾斜杠、`.//`、`..` 上溯、Windows 大小写折叠、`${workspace}` 分量拼接、规则去重、`C:/` 作为根规则、`D:/work/proj` 同时被自身与 `/**` 命中且取 spec 更具体者 —— 均符合设计说明。我构造不出"用户以为受保护、实际没保护"的组合（构造过的方向都被正确判为更具体者胜） |

---

# E. 我认为不该修 / 不能修的点

1. **shell 命令是图灵完备的，没有 sound 的静态约束**。V-1 的根因不可修复；能修的只有文案与默认值。不要试图写 shell 解析器。
2. **`workflow` 之外的进程型通道（`run_code`、MCP、外部子代理循环、hooks、`agent-instructions` 读取 `~/.agents/AGENTS.md`）**：除已列入 `EXOTIC_TOOLS` 的以外，其余要么被默认拒绝，要么根本不经工具层（指令文件注入 system prompt、hooks 走 `ctx.shell`）。这些**不该**在本插件层修——真正的边界是 OS 沙箱，而 `danger-full-access` 下它被设计性关闭。建议在 README 顶部用一句话写清这个前提。
3. **`glob` 保留 `list` 档条目**：这是设计意图（"可见文件名"），`grep` 剔除 `list` 也正确；`present` 用 `list` 档、`read` 用 `read` 档，语义自洽。不建议改。
4. **`str_replace_editor` 不在当前预设里**：映射本身正确，保留无害。
5. **客户端配置页**：结构、API、插槽用法都与出厂先例一致，我不建议在没有真实浏览器验证前大改；它唯一的问题是**零测试覆盖**，建议后续补一个 `apply.client.spec.ts` 级别的冒烟测试（而不是现在动它）。

---

# F. 需要 Lead 决策的点

1. **V-9 优先**：是否立刻把 `dsh-path-guard` 加进 `dsh.profile.bundles` 并重启复核？否则其余所有结论都停留在"未被激活的代码"上。
2. **V-2**：是否把 `workflow` 加入 `EXOTIC_TOOLS`（默认 deny ⇒ 模型失去 workflow 编排能力）？还是保留它并在 UI 上明示风险？
3. **V-4**：shell 命中规则时的 access 语义怎么定？最小改动是跳过 `write` 档规则；是否还要给规则加 `shell` 覆盖位？
4. **V-3**：`defaultAccess !== 'allow'` 且无规则时，`shell: 'scan'` 是否改为 deny？
5. **V-5 / V-10**：自我保护是否从"子串匹配"升级为"拒绝所有 profile 变更类 action"；以及 fail-closed 是否需要收窄爆炸半径（非管辖工具在内部错误时放行）。
6. **V-1 文案**：`client/client.js:55,102` 与 `src/tool-fields.js:46` 现在承诺了一个不存在的"输出过滤"，建议在下一版直接删掉该措辞（这是对用户的错误安全承诺）。

---

# G. Lead 附注（报告之后补充，未改动上文任何结论）

## G1. V-9 是「被停用」的运行状态，不是安装缺陷

报告的观察本身准确：验证时 `dsh.profile.bundles` 里确实没有 `dsh-path-guard`，活 Host 查询也返回 0 条。
但时间线是：**安装当时是挂载成功的**——安装后立即用同一条
`cordis_inspect_query({provider:'host/Config', method:listConfigs, input:{name:'dsh-path-guard'}})`
查到过 `{id: "include:path-guard", patchId: "path-guard", status: "schema"}`，并取到完整投影 schema。
随后用户在 Web 前端把 bundle 停用（`set_bundle enabled:false`），该操作把包从 `dsh.profile.bundles`
移除但保留在 `dependencies` 里——这正是报告看到的形态。所以 V-9 的修法不是"加进 bundles"，
而是"**启用**"，且这一点仍未完成（需要重启 DSH 后启用，见 `docs/ACCEPTANCE.md`）。
报告里"本会话实际零防护"的结论在观察时点成立。

## G2. 已在本轮修复的条目

| 条目 | 处置 |
|---|---|
| V-1 | 实现了 shell 输出块扣留（`scan.js::redactTextBlocks` + post-execute 分支）；同时删掉三处"会过滤输出"的错误承诺，改为明确写出**不把路径写成连续字面量即可绕过**，并在配置页把「整体禁用」标为唯一真正堵住的档位 |
| V-2 | `workflow`、`ralph` 加入 `EXOTIC_TOOLS`（默认 `deny`，可用 `exoticTools: allow` 放行）；同进程 `subagent`/`subagent_fork` 不受影响 |
| V-3 | `shell: scan` 在**推不出任何 needle** 且 `defaultAccess != allow` 时改为拒绝 |
| V-4 | shell 扫描跳过 `access: 'write'` 的规则；拒绝文案说明 shell 无法逐路径判定 |
| V-5 | **改为**：`selfProtection` 开启时一律拒绝变更类 action，只保留 `list_*`。理由与报告一致——`target` 字符串不是"这次改动影响哪一行"的可靠身份 |
| V-6 | 惰性判据改为「没有任何非 `write` 档的用户规则」，selfRules 不再导致整块 block |
| V-7 | `rules` 存在但非数组 ⇒ 抛错 ⇒ 被拦截点捕获 ⇒ fail-closed，不再静默降级为"无规则" |
| V-8 | `glob`/`grep` 的 `fs.resolve` 失败改记 `warn`（这两种工具自身不经 `ctx.fs`，词法兜底是唯一一层） |
| V-10 | fail-closed 收窄到「本插件负责判定的调用」；`ask_user_question`/`todo_write` 等在本插件内部出错时照常放行 |

## G3. 已知未修（有意保留）

- **V-11（UNC 与 POSIX 键碰撞）/ V-12（POSIX `/` 不能作根规则）**：已写入 README 的「已知的规则边界」，未改
  归一化逻辑——为一个当前 profile（Windows）不触发的边界改路径规范化，风险大于收益。
- §E 列出的其余项：同意"不该在本插件层修"。

## G4. 新增回归测试

`tests/host.spec.js` 增加了 6 个针对性用例（workflow 归入不可拦、shell 输出扣留、
`defaultAccess != allow` 时 shell 拒绝、`write` 档规则不参与扫描、`rules` 形状漂移 fail-closed、
内部错误不波及其他工具）。全套 **91 pass / 0 fail**。
