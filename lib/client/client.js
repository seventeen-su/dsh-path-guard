"use strict";
/**
 * dsh-path-guard — Web client half.
 *
 * Why this file exists: DSH 0.1.7-rc.2 has NO generic auto-generated plugin
 * configuration page. The `settings` service does project a per-entry
 * `autoGenerate` flag (packages/settings/settings/src/index.ts:312,
 * packages/api/settings-controller/src/index.ts:51), but no client renderer
 * anywhere in the tree consumes it — every client-side occurrence of
 * `autoGenerate` lives in test fixtures. A plugin's configuration therefore
 * needs a client half of its own, exactly like the shipped companion packages
 * (`packages/client/ui-settings-agent-loop/src/client/index.ts`).
 *
 * This half registers the config page on the Plugins page (`plugins.row.config`
 * and `plugins.bundle.config`, see `apply` below) and binds it to the
 * `path-guard` settings namespace, which IS the row id in
 * `cordis.patch.yml` (packages/settings/settings/src/index.ts:315,382).
 *
 * Deliberate constraints:
 *   - compiled to `lib/client/client.js` by `tsc -p tsconfig.client.json` and
 *     loaded through `window.__ModuleLoader__.load` as a **classic script**
 *     (packages/client/modules/src/client/system.ts:15-29). `install_bundle`
 *     runs `pnpm add` only and never builds a package
 *     (packages/boot/plugin-manager/src/index.ts:461-559), so the built file has
 *     to sit in the repository. Keep this file free of `import`/`export`: the
 *     loader evaluates the output as a classic script, where ESM syntax does not
 *     parse.
 *   - only `react` is required, and it is a baseline external
 *     (packages/client/web/src/platform.ts:8-14) — no other Harness client
 *     package is imported, per the plugin authoring policy.
 *   - styling: every colour is a `--dsw-alias-*` theme token (so it follows the
 *     light/dark switch); geometry comes from the host's own variables where one
 *     exists (`--dsw-radius-*`, `--ds-font-family-code`, ui-theme/src/styles/base.css)
 *     and otherwise from the numbers the shipped pages use, each one cited at the
 *     property. No `font-family` is declared: this page inherits the host family
 *     (base.css:7-8). See the comment above `CONTROL`/`STYLE`.
 */
// Reached through one cast rather than a `declare global` augmentation: this
// file has to compile whether or not the compiler is told the package makes it
// an ES module, and a global augmentation is legal only inside a module. (The
// distinction matters for the build: under `"type": "module"` tsc appends
// `export {}` to the output, which the loader's classic script cannot parse —
// see the header note.)
;
window.__ModuleLoader__.load({
    id: 'dsh-path-guard',
    factory(require) {
        /**
         * Local structural mirrors of the host faces this half touches. Type-only,
         * so nothing here reaches the emitted classic script.
         *
         * Deliberate: a plugin may not import a DSH client package, and
         * `tsconfig.client.json` sets `"types": []`, so the globals and service
         * shapes are declared here instead of borrowed. Each mirror names the DSH
         * source it was read from and declares only the members this file uses.
         */
        const React = require('react');
        const h = React.createElement;
        /** Settings namespace == the plugin row id in the profile patch. */
        const NS = 'path-guard';
        /** Bundle package name, the other half of the plugin-list row key. */
        const PKG = 'dsh-path-guard';
        /** Locale key for this page. */
        const L10N = 'path-guard';
        const zh = {
            title: '路径守卫',
            intro: '按路径限制 AI 的文件访问。即使 DSH 处于完全权限（danger-full-access），这里的规则依然生效。',
            statusLoading: '正在读取配置…',
            statusUnavailable: '当前 profile 没有挂载 settings 服务，无法编辑配置。',
            statusReadonly: '当前浏览器不是本机回环连接，配置只能保存在本页内存中，不会写回 profile。',
            master: '总开关',
            masterHint: '关闭后本插件不注册任何拦截。',
            defaultAccess: '未命中规则时的默认档位',
            defaultAccessHint: '默认不限制，只有你写下的规则才会起作用。',
            defaultAllow: '不限制（默认）',
            searchRedaction: '搜索结果脱敏',
            searchRedactionHint: '把 glob / grep 结果里落在受保护路径上的条目剔除。',
            shell: 'shell 工具（bash / pwsh）',
            shellHint: 'shell 命令是图灵完备的：插件只能扫描命令文本里是否出现受保护路径，并整段扣留提到它的输出。任何不把路径写成连续字面量的写法（$(echo ~)、Join-Path、通配符、或借用别的解释器拼出路径）都能绕过去。要高强度就用「整体禁用」。',
            shellScan: '扫描命令文本 + 扣留相关输出（默认，尽力而为）',
            shellDeny: '整体禁用 shell（唯一真正堵住的档位）',
            shellOff: '不处理（已知漏洞）',
            exotic: '无法拦截的工具',
            exoticHint: 'MCP 服务、run_code、外部子代理循环在独立进程里访问文件系统，插件层既看不到参数也看不到输出。workflow 不在此列——它和 shell 一样按脚本文本扫描（尽力而为）。',
            exoticDeny: '直接拒绝（默认）',
            exoticAllow: '放行（接受漏洞）',
            selfProtection: '自我保护',
            selfProtectionHint: '禁止 AI 改写本插件所在的 profile 组合文件。plugin_manager 里只有「指名本插件的动作」和「本地路径/git/tarball 来源的安装」会被拒；装注册表上的插件、开关别的插件都照常可用。',
            notify: '拦截时发桌面通知',
            notifyHint: '需要同 profile 装了 dsh-desktop-notify。没装就什么都不发生，装了之后改这里立即生效。',
            notifyFocused: '只在你不看那个会话时弹（默认）',
            notifyAlways: '任何情况都弹',
            notifyOff: '关闭',
            rules: '路径规则',
            rulesHint: '更具体的路径覆盖更宽泛的路径，所以「豁免」就是再加一条更具体的规则。',
            colPath: '路径',
            colAccess: '访问档位',
            colNote: '备注',
            colActions: '操作',
            addRule: '添加规则',
            rulesExemptHint: '想给受保护目录里的某个文件开例外？再加一条更具体的规则就行——例如「~/.ssh → 仅文件名」再加「~/.ssh/README.md → 只读」，就只有那一个文件可读。',
            browse: '浏览…',
            browseTitle: '把选中的目录填入这一行',
            // The rules reference is ALWAYS visible. A toggle hid the one thing this
            // page exists to explain, and what it hid was already the shortest complete
            // description of the matching semantics — so the page spent a click to show
            // less. Documenting the rules directly is the whole point.
            rulesDocTitle: '规则说明',
            rulesDoc: [
                '一条规则 = 路径模式 + 访问档位。模式匹配的是「该路径本身」以及「它的所有后代」。',
                '',
                '【档位】权限逐级累积，从宽到严：',
                '  完全允许        看得到名字、读得到内容、写得了',
                '  半访问·只读      能读内容，不能修改',
                '  半访问·仅文件名  只看得到目录结构与文件名，读不到内容，更不能写',
                '  完全禁止        连这个目录里有哪些文件都看不到',
                '',
                '【多条规则如何判定】与书写顺序无关，永远是最具体的那条生效，依次比较：',
                '  1. 命中的目录更深（越贴近该文件越具体）',
                '  2. 字面量前缀更长',
                '  3. 通配符更少',
                '  4. 仍并列时，后写的那条优先',
                '',
                '【豁免】豁免不是特殊语法，就是「再加一条更具体的规则」。先给 ~/.ssh 设「仅文件名」，',
                '再给 ~/.ssh/README.md 设「只读」，就只有这一个文件能读，其余照旧。',
                '',
                '【路径写法】',
                '  ~              家目录',
                '  ${workspace}   当前会话的工作区',
                '  *              匹配一段，不跨目录分隔符',
                '  **             匹配任意层',
                '  name:文件名    按文件名匹配，任意位置生效；例如 name:readme.md、name:*.md',
                '  绝对路径       例如 D:/secrets/**',
                '',
                '【生效方式】点保存后立即生效，不需要重启。写入只会改 profile 补丁里本插件那一条 config。',
                '【已知边界】shell 命令与脚本里的路径靠文本扫描，属于尽力而为；name: 规则不参与该扫描。',
            ].join('\n'),
            trust: '工具信任',
            unknownTools: '未建模工具的判定',
            unknownToolsHint: '对没有被本插件逐一建模的工具（MCP、记忆、第三方工具……），只在它报出的参数里找路径，命中规则才拒。',
            unknownToolsCheck: '只按规则判定它报出的路径（推荐）',
            unknownToolsDeny: '只要参数看起来像路径就拒绝（更严，会误伤）',
            trustedTools: '信任的工具',
            colMatch: '工具名 / 前缀',
            pickTool: '选择',
            noTrackedTools: '暂无已跟踪的工具',
            addTrust: '添加信任',
            trustPlaceholder: '例如 notes_search 或 notes_*',
            trustEmpty: '还没有信任任何工具。',
            // Always visible, like the rules reference: what a prefix wildcard buys and
            // what it costs IS the decision this group asks for.
            trustDocTitle: '信任是怎么生效的',
            trustDoc: [
                '【两种写法】match 填工具名或前缀通配：',
                '  notes_search 只信任这一个工具',
                '  notes_*      前缀通配：信任该插件的全部工具，包括它以后新增的',
                '  mcp__*       同理，按前缀批量信任某个 MCP 服务',
                '',
                '【代价】命中信任后，本插件对该工具的判定被整体跳过——路径规则、shell 扫描、结果脱敏都不再过问。',
                '所以只信任你了解用途的插件；拿不准就写具体工具名，别写通配。',
                '',
                '【不会生效】match 留空会被忽略，不匹配任何工具。',
                '【怎么填】直接手打工具名或前缀通配即可；输入时会按内容过滤出已跟踪到的工具，点输入框右侧的箭头可以展开完整列表挑一个。',
            ].join('\n'),
            remove: '删除',
            save: '保存',
            revert: '放弃修改',
            empty: '还没有任何规则。添加一条即可开始保护。',
            unsaved: '有未保存的修改',
            saved: '已保存',
            saveFailed: '保存被拒绝（可能是配置已被别处修改，请刷新后重试）',
            pathPlaceholder: '例如 ~/.ssh、D:/secrets/**，或按文件名豁免 name:readme.md',
            accessNone: '完全禁止（看不见、读不到、写不了）',
            accessList: '半访问·仅文件名（能看到目录结构与文件名，读不到内容）',
            accessRead: '半访问·只读（能读内容，不能修改）',
            accessWrite: '完全允许（读写）',
            required: '必填',
            revision: '修订号',
            configSummary: '按路径阻止 AI 访问；打开后在设置里添加规则',
        };
        const en = {
            title: 'Path Guard',
            intro: 'Restrict AI file access by path. These rules stay in force even when DSH runs with danger-full-access.',
            statusLoading: 'Reading configuration…',
            statusUnavailable: 'This profile does not mount the settings service; configuration cannot be edited.',
            statusReadonly: 'This browser is not a loopback connection, so edits stay in this page and are not written back to the profile.',
            master: 'Master switch',
            masterHint: 'When off, the plugin registers no interception at all.',
            defaultAccess: 'Default level for unmatched paths',
            defaultAccessHint: 'Unrestricted by default: only the rules you write take effect.',
            defaultAllow: 'Unrestricted (default)',
            searchRedaction: 'Search result redaction',
            searchRedactionHint: 'Drop glob / grep entries that fall under a protected path.',
            shell: 'Shell tools (bash / pwsh)',
            shellHint: 'A shell command is Turing-complete: the plugin can only scan its text for a protected path and withhold output blocks that mention one. Any spelling that never writes the path as one literal — $(echo ~), Join-Path, a wildcard, or another interpreter building it — gets through. Use "Deny shell entirely" for real confinement.',
            shellScan: 'Scan command text + withhold matching output (default, best effort)',
            shellDeny: 'Deny shell entirely (the only setting that really closes it)',
            shellOff: 'Do nothing (known hole)',
            exotic: 'Unfenceable tools',
            exoticHint: 'MCP servers, run_code and foreign subagent loops touch the filesystem in their own process; the plugin sees neither their arguments nor their output. workflow is NOT in this list — its script text is scanned like a shell command (best effort).',
            exoticDeny: 'Deny (default)',
            exoticAllow: 'Allow (accept the hole)',
            selfProtection: 'Self-protection',
            selfProtectionHint: 'Stops the AI from rewriting this profile composition. Under plugin_manager only actions naming this plugin, and installs from a local path / git / tarball, are refused; registry installs and toggling other plugins keep working.',
            notify: 'Desktop notification on refusal',
            notifyHint: 'Requires dsh-desktop-notify in the same profile. Without it nothing happens; with it, changes here apply immediately.',
            notifyFocused: 'Only when you are not watching that session (default)',
            notifyAlways: 'Always',
            notifyOff: 'Off',
            rules: 'Path rules',
            rulesHint: 'A more specific path overrides a broader one, so an exemption is just a more specific rule.',
            colPath: 'Path',
            colAccess: 'Access',
            colNote: 'Note',
            colActions: 'Actions',
            addRule: 'Add rule',
            rulesExemptHint: 'Need one file inside a protected directory to stay readable? Add a second, more specific rule — e.g. "~/.ssh → names only" plus "~/.ssh/README.md → read only" makes exactly that one file readable.',
            browse: 'Browse…',
            browseTitle: 'Put the chosen directory into this row',
            // Always visible, for the same reason as the zh copy: the reference IS the
            // page's content, so hiding it behind a click showed strictly less.
            rulesDocTitle: 'How the rules work',
            rulesDoc: [
                'A rule is a path pattern plus an access level. The pattern matches that path itself AND every descendant of it.',
                '',
                'Levels accumulate, widest to strictest:',
                '  Full access        names, contents and writes',
                '  Half · read only   contents readable, no writes',
                '  Half · names only  directory structure and file names visible; contents unreadable, writes refused',
                '  Blocked            not even the file names inside are visible',
                '',
                'Which of several rules wins does NOT depend on the order you wrote them in — the most specific one always applies, compared in this order:',
                '  1. the deeper matched directory (closer to the file wins)',
                '  2. the longer literal prefix',
                '  3. the fewer wildcards',
                '  4. still tied: the rule written later wins',
                '',
                'Exemptions are not special syntax — they are just a second, more specific rule.',
                'Set ~/.ssh to "names only", then ~/.ssh/README.md to "read only", and exactly that one file becomes readable.',
                '',
                'Path syntax:',
                '  ~              your home directory',
                '  ${workspace}   the current session workspace',
                '  *              one segment, not crossing a separator',
                '  **             any depth',
                '  name:<file>    match by file name anywhere; e.g. name:readme.md, name:*.md',
                '  absolute       e.g. D:/secrets/**',
                '',
                'A save applies immediately — no restart. A write only touches this plugin\'s own config entry in the profile patch.',
                'Known limit: paths inside shell commands and scripts are found by text scanning, which is best effort; name: rules do not take part in that scan.',
            ].join('\n'),
            trust: 'Tool trust',
            unknownTools: 'How unmodelled tools are judged',
            unknownToolsHint: 'For tools this plugin does not model one by one (MCP servers, memory, third-party tools), look only for paths among the arguments the tool reports, and refuse only when a rule matches one.',
            unknownToolsCheck: 'Judge only the paths it reports (recommended)',
            unknownToolsDeny: 'Refuse whenever an argument looks like a path (stricter, false positives)',
            trustedTools: 'Trusted tools',
            colMatch: 'Tool / prefix',
            pickTool: 'Choose',
            noTrackedTools: 'No tracked tools yet',
            addTrust: 'Trust a tool',
            trustPlaceholder: 'e.g. notes_search or notes_*',
            trustEmpty: 'No trusted tools yet.',
            trustDocTitle: 'How trust works',
            trustDoc: [
                'Two spellings — match takes a tool name or a prefix wildcard:',
                '  notes_search trust exactly this one tool',
                '  notes_*      prefix wildcard: trust every tool of that plugin, INCLUDING the ones it adds later',
                '  mcp__*       the same, to trust one MCP server by prefix',
                '',
                'The cost: a match skips every check this plugin makes for that tool — path rules, shell scanning and result redaction all stand aside.',
                'So trust only plugins whose purpose you understand; when in doubt, name one tool instead of a wildcard.',
                '',
                'Not a wildcard: an empty match is ignored and matches nothing.',
                'Filling it in: just type a tool name or a prefix wildcard — typing filters the tools this plugin has already tracked, and the arrow at the field\'s right edge opens the full list to pick from.',
            ].join('\n'),
            remove: 'Remove',
            save: 'Save',
            revert: 'Discard changes',
            empty: 'No rules yet. Add one to start protecting a path.',
            unsaved: 'Unsaved changes',
            saved: 'Saved',
            saveFailed: 'Save was refused (the configuration may have changed elsewhere; reload and retry)',
            pathPlaceholder: 'e.g. ~/.ssh, D:/secrets/**, or by file name: name:readme.md',
            accessNone: 'Blocked (invisible, unreadable, unwritable)',
            accessList: 'Half access · names only (structure and file names visible, contents not)',
            accessRead: 'Half access · read only (contents readable, not writable)',
            accessWrite: 'Unrestricted (read and write)',
            required: 'Required',
            revision: 'revision',
            configSummary: 'Block AI access by path; add rules in Settings',
        };
        /** Access levels in ladder order, weakest first. */
        const LEVELS = ['none', 'list', 'read', 'write'];
        /**
         * Visual language copied from the shipped plugin and settings pages: every
         * number below names the host file it was read from, so this page reads like
         * the host instead of like a plugin's own invention.
         *
         * Fonts: `Theme.listTokens` exposes colours only, so there is no font token to
         * ask the client service for — but the host shell already puts the standard
         * stack on `body` (`packages/client/web/src/base.css:11-24`, rendering
         * `--dsw-font-family` from ui-theme/src/styles/base.css:7-8) and re-applies
         * `font-family: inherit` to button/input/select/textarea because UA sheets pin
         * their own families (web/src/base.css:102-109). This page therefore declares
         * NO family of its own and inherits the host's. The one place that needs the
         * `inherit` written out is the help block: it is a `<pre>`, which the host's
         * control list does not cover and a UA sheet would render in monospace.
         * Code text uses `--ds-font-family-code` (TH:10-11): the stack the host's own
         * composite code tokens resolve to (TT:160) and what shipped pages put on code
         * (PM:652-654, INV:204).
         *
         * Sources below; paths relative to the DSH checkout.
         *   PM  packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css
         *   PS  packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.module.css
         *   SF  packages/client/ui-primitives/src/settings-form/fields.module.css
         *   SG  packages/client/ui-primitives/src/settings-form/SettingsForm.module.css
         *   BT  packages/client/ui-primitives/src/Button.module.css
         *   CB  packages/client/ui-primitives/src/Checkbox.module.css
         *   MS  packages/client/ui-settings-models/src/client/ModelsSection.module.css
         *   INV packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css
         *   TR  packages/client/ui-trajectory/src/client/TrajectoryTable.module.css
         *   PL  packages/client/ui-primitives/src/Pill.module.css
         *   TH  packages/client/ui-theme/src/styles/base.css
         *   TT  packages/client/ui-theme/src/styles/gradient-shadow-text.css
         *
         * Sizes: the host's own scale is `--dsw-font-*` (TT:188-271) — 20/28, 14/22,
         * 13/20, 12/18 — written here the way the host pages write it. Radii come from
         * the one scale in TH:16-21, never from a literal.
         */
        /**
         * The unified control surface: the SAME family as STYLE.menuTrigger — a filled,
         * borderless DSH surface, not the host's outlined settings field.
         *
         * Deliberately NOT copied from the host's own input
         * (ui-primitives/settings-form/fields.module.css:107-122), which pairs a 0.5px
         * `--dsw-alias-border-l4` stroke with `bg-layer-3` and marks focus by
         * recolouring that stroke blue. On the dark theme that stroke reads as a WHITE
         * border and the focus state as a BLUE one — exactly the two things the user
         * asked to remove. Geometry and fill come from the reference plugin's trigger
         * (`lib/client.js:1475-1483`): height 32px, `--dsw-radius-sm`, `0 8px` padding,
         * `--dsw-alias-bg-module-platform` fill, no border.
         *
         * Focus is NOT declared here: the host's global rule supplies only the ring's
         * colour and width and never its style (focus.css:10-13), so STATE_CSS writes
         * the whole `outline` shorthand for inputs and buttons alike.
         */
        const CONTROL = {
            boxSizing: 'border-box',
            height: '32px',
            padding: '0 8px',
            border: 'none',
            borderRadius: 'var(--dsw-radius-sm, 8px)',
            background: 'var(--dsw-alias-bg-module-platform)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
        };
        /**
         * Switch colours, copied verbatim from dsh-desktop-notify 1.7.0 (its `C`
         * table, `lib/client.js:1319-1335`, read by the `Switch` at :1363-1385).
         *
         * `trackOff` and `knobOff` are the ONE deliberate exception to this page's
         * token-only rule, and they are upstream's own values: the off track is a
         * neutral translucent grey that reads on either theme, and the off knob is
         * plain white so no theme can hide it. They are copied rather than
         * re-derived, so the two plugins' switches match. The on state uses tokens:
         * the brand track and `--dsw-alias-bg-base`, which is white in the light
         * theme and near-black in the dark one.
         */
        const SWITCH = {
            brand: 'var(--dsw-alias-brand-primary)',
            trackOff: 'rgba(128, 132, 140, 0.45)',
            knobOn: 'var(--dsw-alias-bg-base)',
            knobOff: '#FFFFFF',
        };
        /**
         * The compact action button in the FILLED standard style, not the host
         * library's `outline` variant: `ui-shortcuts/src/client/Reference.module.css:32-51`
         * is what the host's own reference bar uses — `border: none`, `background:
         * var(--dsw-alias-bg-module-platform)`, `color: var(--dsw-alias-label-primary)`,
         * `font: inherit` — and the user pointed at exactly that element as "the
         * standard control". What we had before was `ui-primitives/Button.module.css:54`
         * (the `outline` variant, `border: 0.5px solid var(--dsw-alias-border-l3)`),
         * which drew a hairline the user read as a stray border.
         *
         * Geometry follows the ROW, not the host's compact `sm` size: every other
         * control in a rule row (the text input, the combobox, the menu trigger) is
         * 32px tall at 13px/20px, so a 28px/12px button sat 4px short and read as a
         * mismatched row. Same 32px, 13px and `--dsw-radius-sm` as those controls;
         * only the horizontal padding stays tighter, since a button label is short.
         * The transparent inset shadow is the baseline the STATE_CSS hover/press
         * tints replace — one item in the shadow list in every state, so the 120ms
         * fade actually interpolates (none → shadow does not), and the opaque fill
         * stays INLINE so the control still paints without the sheet.
         */
        const SM_BUTTON = {
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            // A button label must stay on ONE line. Without these two the buttons shrank
            // in a narrow row and Chinese labels wrapped once per character, which reads
            // as vertical text: `flex: 0 0 auto` refuses the shrink, `white-space: nowrap`
            // refuses the wrap.
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            height: '32px', // SF:108, the same 32px the row's inputs use
            padding: '0 12px', // SF:109
            border: 'none', // RS:33
            borderRadius: 'var(--dsw-radius-sm, 8px)', // TH:17
            background: 'var(--dsw-alias-bg-module-platform)', // RS:34
            color: 'var(--dsw-alias-label-primary, inherit)', // RS:35
            fontFamily: 'inherit', // RS:36
            fontSize: '13px', // SF:114, the row's control size
            lineHeight: 1.5, // SF:115
            boxShadow: 'inset 0 0 0 999px transparent', // the tint baseline
            transition: 'box-shadow 120ms ease',
        };
        const STYLE = {
            // PM:3-16 `.page` already owns the page inset
            // (`padding: 0 clamp(24px, 4vw, 48px) 48px`) and the page scroll; this
            // section renders inside it, so it declares neither padding of its own nor a
            // second scroll container — the old `padding: 20px 24px` double-inset the
            // page and `height/overflow` nested a scroller inside PM's own.
            root: {
                color: 'var(--dsw-alias-label-primary, inherit)', // PM:15
                fontSize: '13px', // PM:78-79 `.status`; TT:230 --dsw-font-xs-13
                lineHeight: '20px', // TT:233
            },
            // Section head: title over lede, 4px apart — PM:53 `.pageIntro { margin: 4px 0 0 }`.
            // PS:103-107 is the settings section drawn over these same plugin cards, so
            // its title size sits below the host's own 20px/28px page title (PM:42-47)
            // without competing with it.
            title: { margin: '0 0 4px', fontSize: '15px', lineHeight: '22px', fontWeight: 600 },
            intro: { margin: '0 0 12px', color: 'var(--dsw-alias-label-secondary, inherit)' }, // PM:56; PS:6 rhythm
            status: { margin: 0, color: 'var(--dsw-alias-label-tertiary, inherit)' }, // PM:74-81 `.status`
            statusWarn: { margin: 0, color: 'var(--dsw-alias-state-warn-primary, inherit)' }, // PM:83-88 `.failure` tone
            notice: {
                margin: '0 0 12px', // PS:6
                padding: '8px 12px', // PM:1023 `.result`
                border: '0.5px solid var(--dsw-alias-border-l3, currentColor)', // PM:926 `.subject`
                borderRadius: 'var(--dsw-radius-md, 12px)', // PM:1024
                background: 'var(--dsw-alias-bg-layer-2, transparent)', // PM:722
                color: 'var(--dsw-alias-label-secondary, inherit)',
                fontSize: '12px', lineHeight: '18px', // TT:244 --dsw-font-xxs-12
            },
            // One card per topic: the hairline inset panel the plugins page itself uses
            // (PM:566-574 `.guide`, PM:920-929 `.subject`), not a heavy 1px frame.
            group: {
                margin: '0 0 12px', // PS:6
                padding: '12px 14px', // PM:1040 `.approval`; INV:134 `.cardContent`
                border: '0.5px solid var(--dsw-alias-border-l3, currentColor)', // PM:926
                borderRadius: 'var(--dsw-radius-lg, 16px)', // PM:572; TH:19
                background: 'var(--dsw-alias-bg-layer-1, transparent)', // PM:573
            },
            groupTitle: { margin: '0 0 8px', fontSize: '14px', lineHeight: '22px', fontWeight: 500 }, // PM:108-113; PM:99
            // A field is label / control / hint stacked (SF:3-8). The host's settings
            // forms never run a label column, so the old `minWidth: 190px` row is gone.
            // The hairline between two adjacent fields needs a `+` selector and lives in
            // STATE_CSS (SF:10-12).
            field: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '0 0 12px' }, // SF:6 gap, SF:7 padding
            fieldLabel: { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, inherit)' }, // SF:20-27
            // The elliptical switch replaces the native checkbox on all three boolean
            // settings. Geometry and the knob shadow are copied verbatim from
            // dsh-desktop-notify 1.7.0 (`lib/client.js:1363-1385`): a 38x22 pill track
            // with a 16px knob inset 3px. Only the state-dependent values (left,
            // background, cursor, opacity, transition) are applied at the render site,
            // exactly as upstream does.
            switchTrack: {
                flex: '0 0 auto',
                width: '38px',
                height: '22px',
                padding: 0,
                border: 'none',
                borderRadius: '999px',
                position: 'relative',
                transition: 'background .15s ease',
            },
            switchKnob: {
                position: 'absolute',
                top: '3px',
                width: '16px',
                height: '16px',
                borderRadius: '999px',
                boxShadow: '0 1px 2px rgba(0,0,0,.35)', // upstream lib/client.js:1381
                transition: 'left .15s ease',
            },
            // The switch keeps its name to the RIGHT, exactly where the native checkbox
            // kept it, so the control swap does not move any text.
            switchRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary, inherit)' },
            hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, inherit)' }, // SF:140-145
            // The DSH menu-style select, copied verbatim from dsh-desktop-notify 1.7.0
            // (`lib/client.js:1467-1521`) because the native `<select>` paints its option
            // list and its selected state with the OS, which is by definition NOT the
            // host's own control style. Four keys, one per piece of the control; the
            // state-dependent values (width, background, cursor) are applied at the
            // render site, exactly as upstream does.
            menuAnchor: { position: 'relative', flex: '0 0 auto' },
            menuTrigger: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
                height: '32px',
                padding: '0 8px',
                fontFamily: 'inherit',
                fontSize: '13px',
                lineHeight: '20px',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-label-primary, inherit)',
                border: 'none',
                borderRadius: 'var(--dsw-radius-sm, 8px)',
                // The opaque base stays INLINE (a missing sheet must still paint the
                // control); hover/open/press are an inset-shadow TINT layered over it
                // by STATE_CSS. A bare `background: var(--dsw-alias-interactive-bg-*)`
                // swap — what the reference does — REPLACES the base, so the 6-8%
                // translucent tint blends with the CARD behind instead of the trigger:
                // on light rgb(245,246,247) the shift is ≈1% (invisible), on dark the
                // "hover" is DARKER than the base and the press tint lands back on the
                // base colour itself. The overlay darkens/lightens the base itself by
                // 11-28 RGB units on both themes. The transparent base shadow keeps the
                // shadow list one item long in every state so the 120ms fade can
                // actually interpolate (none → shadow does not).
                background: 'var(--dsw-alias-bg-module-platform)',
                boxShadow: 'inset 0 0 0 999px transparent',
                transition: 'background 120ms ease, box-shadow 120ms ease',
            },
            // `top` is fixed; `left`/`right` and the width are decided per opening from
            // the anchor's geometry (see MenuControl.measure), so they are NOT declared
            // here — the reference can hardcode `right: 0` because its anchor sits at the
            // right edge of a wide card, ours can sit in a narrow left-hand column.
            menuSurface: {
                position: 'absolute',
                zIndex: 100,
                top: 'calc(100% + 4px)',
                boxSizing: 'border-box',
                padding: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                // The host's menu material: a translucent surface that needs the blur below
                // to read as floating.
                background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-1))',
                color: 'var(--dsw-alias-label-primary, inherit)',
                border: 0,
                backdropFilter: 'blur(20px) saturate(1.4)',
                WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
                borderRadius: 'var(--dsw-radius-sm, 8px)',
                // The host paints its elevation stroke through this variable rather than a
                // border; a menu rebinds it to the faintest hairline.
                '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
                boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35))',
                animation: 'dsh-path-guard-menu-in 130ms cubic-bezier(.2,.8,.2,1)',
            },
            menuItem: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                // `width: 100%` plus padding only fits inside the menu when the box is
                // border-box. Without it every row is 16px wider than the surface, and
                // because a scroll container's cross axis cannot stay `visible`
                // (`overflow-y: auto` forces the used `overflow-x` to `auto`), that
                // overflow showed up as a HORIZONTAL scrollbar in the tool picker.
                boxSizing: 'border-box',
                width: '100%',
                minWidth: 0,
                minHeight: '34px',
                padding: '6px 8px',
                border: 'none',
                borderRadius: 'var(--dsw-radius-sm, 8px)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '13px',
                lineHeight: '20px',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-label-primary, inherit)',
                background: 'none',
            },
            // The tool-match combobox: ONE control that is both the free-form input
            // and the tracked-tools picker. The WRAPPER carries the field's chrome
            // (CONTROL's border, radius and fill) so the pair reads as a single
            // control; the input inside is chromeless, and the chevron button at the
            // right edge opens the same menu surface the enum selects use. The focus
            // ring is painted on the wrapper from React focus state (inline, so it
            // does not depend on the sheet), never on the inner input.
            comboWrap: {
                ...CONTROL,
                display: 'flex',
                alignItems: 'center',
                padding: 0,
                position: 'relative',
                width: '100%',
            },
            comboInput: {
                flex: '1 1 auto',
                minWidth: 0,
                height: '100%',
                border: 'none',
                background: 'none',
                // Left inset matches the trigger's own padding so every control's text
                // starts on the same x; the right side leaves room for the toggle.
                padding: '0 4px 0 8px',
                fontFamily: 'inherit',
                fontSize: '13px',
                lineHeight: 1.5,
                color: 'inherit',
                outline: 'none', // focus paints nothing here; see STATE_CSS on why it must be explicit
            },
            comboToggle: {
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                alignSelf: 'stretch',
                width: '28px',
                padding: 0,
                border: 'none',
                background: 'none',
                color: 'var(--dsw-alias-label-tertiary, inherit)',
                // Stay inside the wrapper's rounded corner on the trailing edge.
                borderRadius: '0 var(--dsw-radius-sm, 8px) var(--dsw-radius-sm, 8px) 0',
            },
            input: { ...CONTROL, width: '100%' },
            /**
             * D2 — the rule/trust lists are FLEX rows, not `<table>`s.
             *
             * The table's fixed percentage columns (34%/38%/auto/1%) could only be
             * relaxed by a `@media` query, and a media query measures the VIEWPORT while
             * the user's damage came from the CONTAINER being squeezed (the panel and
             * sidebar change the content column's width without touching the viewport).
             * A flex row wraps on its own container's width, whichever way that width
             * changed, so no breakpoint is involved at all.
             *
             * `min-width: 0` on every field is what makes wrapping work at all: a flex
             * item's default `min-width: auto` refuses to shrink below its content, so
             * the row would overflow instead of wrapping. With it, each field takes a
             * 160px basis, grows to share the row, and drops to the next line when the
             * container cannot afford another 160px — a text input is therefore never
             * squeezed narrower than the field it sits in (the "input crushed into a
             * diamond" report was a rounded control compressed below its own width).
             *
             * Each field carries its own label above it instead of a header row: once the
             * row can wrap, a single header cannot stay aligned with the columns it
             * names, and repeating the label is also the honest thing for a screen
             * reader at any width.
             */
            list: {
                display: 'flex',
                flexDirection: 'column',
                margin: '0 0 12px',
                background: 'var(--dsw-alias-bg-layer-1, transparent)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                fontSize: '12px',
                lineHeight: '18px',
            },
            row: {
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
                alignItems: 'flex-end',
                padding: '8px',
                borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
            },
            /** The last row drops the separator, so the list ends on its own edge. */
            rowLast: { borderBottom: 0 },
            /** One field: its label over its control. `flex: 1 1 160px` + `min-width: 0`. */
            rowField: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 160px', minWidth: 0 },
            rowLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
            /** The action group: it keeps its own size and wraps as a unit. */
            rowActions: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto', minWidth: 0 },
            button: SM_BUTTON,
            // BT:36-39: the primary variant fills with the brand tone and writes its
            // label in the foreground tone. Same painted pair as before, token-only.
            primary: {
                ...SM_BUTTON,
                border: 'none',
                background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
                color: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-3))',
            },
            error: { margin: '0 0 12px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary, inherit)' }, // SG:23-30
            ok: { margin: '0 0 12px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-success-primary, inherit)' }, // SG:23-30
            warn: { color: 'var(--dsw-alias-state-warn-primary, inherit)' },
            // Code text keeps the host's code stack instead of an invented macOS one
            // (TH:10-11). Deliberately no literal tail: if the theme variable were ever
            // absent the declaration drops and the text inherits the host family — the
            // same result the host's own `font: inherit` rules give.
            mono: { fontFamily: 'var(--ds-font-family-code)' },
            // The two action buttons are the only inline-flex controls left; the pill
            // chip style went with the one-click presets.
            doc: {
                margin: '6px 0 12px',
                padding: '8px 14px',
                border: '0.5px solid var(--dsw-alias-border-l4, currentColor)',
                borderRadius: 'var(--dsw-radius-lg, 16px)',
                background: 'var(--dsw-alias-bg-layer-1, transparent)',
                color: 'var(--dsw-alias-label-secondary, inherit)',
                fontSize: '12px',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
            },
            docTitle: { margin: '0 0 6px', fontSize: '13px', fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, inherit)' },
            // The action cell must never wrap: two buttons on one line is the whole
            // point, so the container refuses to wrap and the COLUMN is sized to its
            // content instead (see the `1%` width at the render site).
            actions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap' },
            footer: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }, // SG:16-21
        };
        /**
         * The states React inline styles cannot express: `::placeholder` (no inline
         * counterpart at all), the hover/press fills, the focus ring on buttons,
         * disabled affordance, the pointer cursor, and the hairline between two
         * adjacent fields (SF:10-12, which needs a `+` selector). Every rule is
         * scoped to this page root's own attribute, so none of them can reach host
         * UI, and the sheet is installed synchronously from `apply` (the way the
         * reference installs its own at lib/client.js:1604) so it is never late.
         *
         * Focus: the host's global `:focus-visible` rule (focus.css:10-13) paints
         * the DeepSeek-blue `--dsw-alias-state-business-primary` ring. This page
         * re-paints every control's ring in the NEUTRAL brand tone
         * (design-platform.css:192/310) exactly like the reference does for its own
         * buttons (lib/client.js:1179); a menu item substitutes a fill, and text
         * inputs pin just the colour inline (see CONTROL) so they never show blue
         * even if this sheet were missing. The host's pointer-modality suppression
         * (focus.css:18-20) still wins over the button rule, so mouse users see no
         * ring on buttons and keyboard users see the neutral one.
         *
         * Trigger states LAYER the tint over the opaque module base as an inset
         * shadow instead of swapping `background` (see STYLE.menuTrigger for why a
         * swap is invisible). Menu items sit on the translucent menu surface, where
         * the plain tint fill is the host's own idiom (lib/client.js:1180-1182).
         */
        const STATE_CSS = `
[data-path-guard] input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); } /* MS:601-603 */
[data-path-guard] button { cursor: pointer; } /* MS:593 */
[data-path-guard] button:disabled { opacity: 0.4; cursor: default; } /* BT:18-21 */
[data-path-guard] input:disabled { opacity: 0.6; cursor: default; } /* MS:605-608 */
[data-path-guard] button:not([data-pg-primary]):not([data-pg-switch]):not([data-pg-menu]):not([data-pg-combo-toggle]):not(:disabled):hover { box-shadow: inset 0 0 0 999px var(--dsw-alias-interactive-bg-hover); } /* D3: the tint is LAYERED over the opaque module fill; swapping the background property shifts a light-theme button by ~1% and is invisible */
[data-path-guard] button:not([data-pg-primary]):not([data-pg-switch]):not([data-pg-menu]):not([data-pg-combo-toggle]):not(:disabled):active { box-shadow: inset 0 0 0 999px var(--dsw-alias-interactive-bg-active); } /* design-platform.css:209/327 */
[data-path-guard] button[data-pg-primary]:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)) !important; } /* BT:41-43 */
[data-path-guard] .dsh-path-guard-field + .dsh-path-guard-field { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 12px; } /* SF:10-12 */
[data-path-guard] button:focus-visible { outline: none; } /* D1: NO ring on our controls. The declaration is written EXPLICITLY: deleting the rule instead would let the host's global blue :focus-visible ring (focus.css:10-13, --dsw-alias-state-business-primary) show through, and the user rejected that blue ring earlier. Focus feedback stays on the fill (hover/press tint below). */
[data-path-guard] input:focus-visible { outline: none; } /* D1: same — a 2px grey ring reads as a white border on the dark theme; the field's fill is the control's whole affordance. */
[data-path-guard] button[data-pg-menu]:not(:disabled):hover, [data-path-guard] button[data-pg-menu][data-pg-open]:not(:disabled) { box-shadow: inset 0 0 0 999px var(--dsw-alias-interactive-bg-hover); } /* tint OVER the inline base */
[data-path-guard] button[data-pg-menu]:not(:disabled):active { box-shadow: inset 0 0 0 999px var(--dsw-alias-interactive-bg-active); } /* design-platform.css:209/327 */
[data-path-guard] [role="menuitem"], [data-path-guard] [role="option"] { transition: background 120ms ease; } /* upstream lib/client.js:1181 */
[data-path-guard] [role="menuitem"]:hover:not(:disabled), [data-path-guard] [role="option"]:hover, [data-path-guard] [role="option"][data-pg-active] { background: var(--dsw-alias-interactive-bg-hover) !important; } /* upstream lib/client.js:1180; !important beats the inline base */
[data-path-guard] [role="menuitem"]:active:not(:disabled), [data-path-guard] [role="option"]:active { background: var(--dsw-alias-interactive-bg-active) !important; } /* design-platform.css:209/327 */
[data-path-guard] [role="menuitem"]:focus-visible { background: var(--dsw-alias-interactive-bg-hover) !important; outline: none; } /* upstream lib/client.js:1182 — the fill IS the focus indicator */
@keyframes dsh-path-guard-menu-in { from { opacity: 0; transform: translateY(-2px) scale(.98); } to { opacity: 1; transform: none; } } /* upstream lib/client.js:1183 */
`;
        /** Class on each field wrapper, so STATE_CSS can separate two adjacent fields. */
        const FIELD_CLASS = 'dsh-path-guard-field';
        /** Id of the injected state stylesheet: one copy per document. */
        const STATE_STYLE_ID = 'dsh-path-guard-state-styles';
        /**
         * Put STATE_CSS in the page. Called synchronously from `apply` — the way the
         * reference installs its own sheet (lib/client.js:1602-1604) — so the rules
         * never depend on effect scheduling; `uninstallStateStyles` is registered as
         * the plugin's effect cleanup. The `data-plugin` attribute is the platform's
         * ownership marker: on client-code replacement the modules runtime sweeps
         * `style[data-plugin]` (client/modules/src/client/entry-lifecycle.ts:23-27),
         * so carrying it lets the next revision re-install fresh content instead of
         * keeping a stale sheet the id guard would otherwise preserve.
         */
        function installStateStyles() {
            if (typeof document === 'undefined' || document.getElementById(STATE_STYLE_ID) !== null)
                return;
            const element = document.createElement('style');
            element.id = STATE_STYLE_ID;
            element.setAttribute('data-plugin', PKG);
            element.textContent = STATE_CSS;
            document.head.appendChild(element);
        }
        /** Remove the sheet; safe to call when it was never installed or already swept. */
        function uninstallStateStyles() {
            if (typeof document === 'undefined')
                return;
            const element = document.getElementById(STATE_STYLE_ID);
            if (element !== null)
                element.remove();
        }
        /** Every root this section renders under, carrying the stylesheet's scope attribute. */
        const ROOT_ATTR = { 'data-path-guard': '' };
        /** Document-relative route the Host answers the tracked tool names on. */
        const TOOLS_PATH = 'path-guard/tools';
        /** Popup-menu geometry, copied from dsh-desktop-notify (`lib/client.js:1490`):
         *  a 238px floor, a 340px ceiling, and an 8px gap kept to the viewport edge.
         *  The floor yields to a viewport narrower than it — `MENU_ABSOLUTE_MIN_WIDTH`
         *  is the smallest surface still worth showing, so the menu never overflows. */
        const MENU_MIN_WIDTH = 238;
        const MENU_MAX_WIDTH = 340;
        const MENU_ABSOLUTE_MIN_WIDTH = 160;
        const MENU_EDGE_GAP = 8;
        /**
         * Choose the edge a popup hangs from and the width that edge can afford.
         *
         * POSITION DECIDES FIRST (user: "the list is on the right, it should
         * right-align"): an anchor whose CENTRE sits in the right half of the viewport
         * right-aligns, so the surface grows leftward from the anchor's right edge and
         * closes the gap to the window edge; anything left of centre left-aligns. The
         * viewport half is the right ruler here rather than the content column: the
         * surface is clipped by the WINDOW, and the content column's own right edge
         * moves with the sidebar and the panel width, so a column-relative test would
         * flip on window resizes that changed nothing about visibility.
         *
         * The overflow checks still run afterwards, so the rule can never push the
         * surface out of the window: a right-hanging surface is only allowed while
         * `rect.right - width` stays inside the LEFT edge (that is also what keeps it
         * clear of the sidebar), and a left-hanging one while it stays inside the
         * RIGHT edge. When neither side fits at full width the preferred side keeps
         * the surface and the width shrinks to the room available there.
         * @param anchor - the positioned wrapper, or null before first layout.
         * @returns the side to hang from and the pixel width.
         */
        function measureMenu(anchor) {
            const viewport = window.innerWidth;
            // Clamp to the viewport first: a menu wider than the window would
            // overflow whichever edge it hangs from.
            const width = Math.max(MENU_ABSOLUTE_MIN_WIDTH, Math.min(MENU_MAX_WIDTH, viewport - 2 * MENU_EDGE_GAP));
            if (anchor === null)
                return { side: 'left', width };
            const rect = anchor.getBoundingClientRect();
            const preferRight = rect.left + (rect.right - rect.left) / 2 > viewport / 2;
            if (preferRight && rect.right - width >= MENU_EDGE_GAP)
                return { side: 'right', width };
            if (!preferRight && rect.left + width + MENU_EDGE_GAP <= viewport)
                return { side: 'left', width };
            // The preferred side cannot take a full-width surface: use the other one if
            // it can, otherwise stay put and shrink to the room that side has.
            if (!preferRight && rect.right - width >= MENU_EDGE_GAP)
                return { side: 'right', width };
            if (preferRight && rect.left + width + MENU_EDGE_GAP <= viewport)
                return { side: 'left', width };
            return preferRight
                ? { side: 'right', width: Math.max(MENU_ABSOLUTE_MIN_WIDTH, Math.min(width, rect.right - MENU_EDGE_GAP)) }
                : { side: 'left', width: Math.max(MENU_ABSOLUTE_MIN_WIDTH, Math.min(width, viewport - MENU_EDGE_GAP - rect.left)) };
        }
        /** Monotonic id source for combobox listbox ids (`useId` is not mirrored in ReactLike). */
        let comboSeq = 0;
        /** How long after the Host's "unmodelled tool" notice a panel switch is treated
         *  as that notice's click rather than a user action. */
        const CORRECTION_WINDOW_MS = 20000;
        /** At most one Host read per second for the correction, however many window
         *  events one activation emits. */
        const EVALUATION_THROTTLE_MS = 1000;
        /** The panel id whose activation triggers the landing correction. */
        const PLUGINS_PANEL_ID = 'plugins';
        /**
         * Read `lastUnmodelledAt` (epoch ms of the Host's last "unmodelled tool" notice)
         * out of an unknown body.
         * @param body - the parsed response, whatever shape it turned out to have.
         * @returns the timestamp, or null when the Host never sent that notice.
         */
        function readUnmodelledAt(body) {
            if (body === null || typeof body !== 'object')
                return null;
            const at = body.lastUnmodelledAt;
            return typeof at === 'number' && Number.isFinite(at) ? at : null;
        }
        /** Stable empty snapshot: `useSyncExternalStore` compares snapshots by reference. */
        const NO_TOOLS = [];
        /**
         * The snapshot shown while no config form can be resolved yet (C5). A frozen
         * constant, not a fresh object: `useSyncExternalStore` compares by reference and
         * would loop on a new snapshot per call. `loading` is the honest status — the
         * page has not read anything yet — and it makes the section render its
         * "reading configuration…" line instead of dereferencing a null form.
         */
        const READING_SNAPSHOT = Object.freeze({
            status: 'loading',
            value: undefined,
            revision: undefined,
            writable: false,
            mode: 'host',
        });
        /**
         * Read `{ tools: string[] }` out of an unknown body.
         * @param body - the parsed response, whatever shape it turned out to have.
         * @returns the tool names, or an empty list for every other shape.
         */
        function readToolList(body) {
            if (body === null || typeof body !== 'object')
                return [];
            const tools = body.tools;
            if (!Array.isArray(tools))
                return [];
            return tools.filter((name) => typeof name === 'string' && name !== '');
        }
        /**
         * The tracked tool names, fetched once through the Host's document-relative
         * route and published to React through `useSyncExternalStore`.
         *
         * This is a convenience layer and nothing more: a refused request, a body that
         * is not JSON, an unexpected shape and an empty list all leave the suggestion
         * list absent while the free-form input keeps working. Nothing here may throw
         * into the page.
         * @returns the store the section subscribes to.
         */
        function createToolsStore() {
            const listeners = new Set();
            let snapshot = NO_TOOLS;
            let started = false;
            return {
                subscribe(listener) {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                getSnapshot: () => snapshot,
                load() {
                    if (started)
                        return () => { };
                    started = true;
                    void (async () => {
                        try {
                            const url = new URL(TOOLS_PATH, document.baseURI).toString();
                            const response = await fetch(url, { headers: { accept: 'application/json' } });
                            if (!response.ok)
                                return;
                            const names = readToolList(await response.json());
                            if (names.length === 0)
                                return;
                            snapshot = names;
                            for (const listener of listeners)
                                listener();
                        }
                        catch {
                            // Convenience, not a dependency: the input stays free-form.
                        }
                    })();
                    return () => { listeners.clear(); };
                },
            };
        }
        /**
         * Build the settings section component around one bound config form.
         * @param ctx - the client plugin context.
         * @param t - locale lookup.
         * @param picker - the optional directory-picker affordance.
         * @param toolsStore - the optional tracked-tool suggestions.
         * @returns the React component.
         */
        function createSection(ctx, t, picker, toolsStore) {
            const label = (key) => t(key);
            /**
             * Find the namespace's form RIGHT NOW. Never cached: the service may arrive
             * after this half (the first open of the plugins page resolves it late) and
             * the Form instance is replaced on a plugin hot reload, after which the old
             * subscription is dead and the page silently reads nothing.
             * @returns the form, or null when the service cannot answer.
             */
            const resolveForm = () => {
                try {
                    const service = ctx.configForms;
                    return service !== null && service !== undefined && typeof service.get === 'function'
                        ? service.get(NS)
                        : null;
                }
                catch {
                    return null;
                }
            };
            /**
             * C5 — the reference's `useConfigForm()` (`lib/client.js:1210-1256`, its
             * commit 169818d): **cache how to FIND the form, never the form itself**.
             * Resolved on every render and re-resolved when the service arrives, so a
             * replaced instance is picked up instead of leaving the page bound to a dead
             * one.
             *
             * One deliberate difference from the reference: it keeps its previous Form
             * when the identity key (`namespace || id || name`, lib/client.js:1224-1232)
             * matches, which is right for a wrapper that merely re-reports the same
             * entry — but a hot-reloaded Form for the SAME namespace has that same key,
             * so keeping the old one is exactly the "configuration reads nothing"
             * defect. Here the resolved instance always wins (`previous === next ?
             * previous : next`); the rebind only runs on mount and on the service's
             * arrival (never per render), so adopting it cannot thrash.
             * @returns the current form, or null while none can be resolved.
             */
            function useConfigForm() {
                // The initial value is resolved eagerly (a namespace lookup, not a query):
                // ReactLike mirrors `useState` without the lazy-initializer overload, and a
                // lookup per render is what the reference does anyway.
                const [form, setForm] = React.useState(resolveForm());
                React.useEffect(() => {
                    let disposed = false;
                    const rebind = () => {
                        if (disposed)
                            return;
                        const next = resolveForm();
                        setForm(previous => (previous === next ? previous : next));
                    };
                    rebind();
                    // The service itself can arrive later; this fires once, it is not a poll.
                    try {
                        ctx.inject(['configForms'], () => { rebind(); });
                    }
                    catch { /* already injected */ }
                    return () => { disposed = true; };
                }, []);
                return form;
            }
            // ---- C1: component identity ----
            // These two live at createSection scope, NOT inside PathGuardSection's body.
            // A component function defined in a render body is a NEW element type on
            // every render, so React unmounts and remounts the whole subtree: typing one
            // character updates the draft, the section re-renders, and the input the user
            // is typing in is replaced (the caret is lost). Hoisting them here keeps the
            // type — and therefore the DOM node and its focus — stable across renders.
            /**
             * The select chevron, in the host's own shape: `ModelSelect.module.css:78-86`
             * and `PermissionSelect.module.css:79-86` (two independent select controls)
             * both write the same three declarations — `display: inline-flex`,
             * `flex: 0 0 auto`, `color: var(--dsw-alias-label-caption)` — plus a
             * 120ms transform and a 180° turn while open. Setting the colour here, on
             * the wrapper, is what keeps every chevron on the page identical: before,
             * the trigger's inherited `label-primary` and the combobox toggle's
             * `label-tertiary` produced two different greys, and neither rotated.
             * `inline-flex` rather than `inline` matters for the same reason the host
             * notes: an inline seat reserves baseline descent under the glyph and
             * floats it off-centre in a flex row.
             */
            const menuChevron = (open) => h('span', {
                style: {
                    display: 'inline-flex',
                    flex: '0 0 auto',
                    color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))',
                    transition: 'transform 120ms ease',
                    transform: open ? 'rotate(180deg)' : 'none',
                },
            }, h('svg', {
                width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
                stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true',
            }, h('path', { d: 'M4 6l4 4 4-4' }))); // upstream lib/client.js:1484
            const menuCheck = () => h('svg', {
                width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
                stroke: 'currentColor', strokeWidth: 1, 'aria-hidden': 'true',
                style: { flex: '0 0 auto' },
            }, h('path', { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4' })); // upstream lib/client.js:1432-1437
            /**
             * The DSH menu-style select: a trigger button that expands a `role="menu"`
             * of `role="menuitem"` buttons, the current one ticked. Copied from
             * dsh-desktop-notify 1.7.0 (`lib/client.js:1444-1521`), which is what "the
             * standard control" means here — the native `<select>` this replaces paints
             * its list and its selection with the OS.
             *
             * A component of its own, not a builder: each instance owns open/hover state
             * and two effects, and the rules table renders one per row, so the hooks may
             * not live in the caller's render.
             * @param props - value, options, disabled, width, accessible name, change handler.
             * @returns the control.
             */
            function MenuControl(props) {
                const [open, setOpen] = React.useState(false);
                const [placement, setPlacement] = React.useState({ side: 'left', width: MENU_MIN_WIDTH });
                const anchor = React.useRef(null);
                const trigger = React.useRef(null);
                // Hover and press are painted by STATE_CSS (an inset-shadow tint over
                // the inline base, see STYLE.menuTrigger), so the only states left
                // here are `open` — rendered as the `data-pg-open` attribute the sheet
                // reads — and the measured placement.
                // Outside click closes; Esc closes AND returns focus to the trigger, so
                // keyboard users are not dropped on the body when the menu unmounts.
                React.useEffect(() => {
                    if (!open)
                        return undefined;
                    const onPointerDown = (event) => {
                        if (anchor.current !== null && anchor.current.contains(event.target))
                            return;
                        setOpen(false);
                    };
                    const onKeyDown = (event) => {
                        if (event.key !== 'Escape')
                            return;
                        setOpen(false);
                        if (trigger.current !== null)
                            trigger.current.focus();
                    };
                    // A menu the viewport moved out from under is more wrong than a closed
                    // one: closing is simpler than re-measuring and cannot end up misaligned.
                    const onReflow = () => setOpen(false);
                    document.addEventListener('mousedown', onPointerDown);
                    document.addEventListener('keydown', onKeyDown);
                    window.addEventListener('resize', onReflow);
                    window.addEventListener('scroll', onReflow, true);
                    return () => {
                        document.removeEventListener('mousedown', onPointerDown);
                        document.removeEventListener('keydown', onKeyDown);
                        window.removeEventListener('resize', onReflow);
                        window.removeEventListener('scroll', onReflow, true);
                    };
                }, [open]);
                const selected = props.value === undefined
                    ? undefined
                    : props.options.find(option => option.value === props.value);
                const surfaceStyle = {
                    ...STYLE.menuSurface,
                    width: `${placement.width}px`,
                    maxWidth: `${placement.width}px`,
                    ...(placement.side === 'right' ? { right: 0 } : { left: 0 }),
                };
                return h('div', { ref: anchor, style: { ...STYLE.menuAnchor, width: props.width } }, h('button', {
                    ...(props.id === undefined ? {} : { id: props.id }),
                    ...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel }),
                    type: 'button',
                    disabled: props.disabled,
                    'aria-haspopup': 'menu',
                    'aria-expanded': open ? 'true' : 'false',
                    'data-pg-menu': props.value,
                    ...(open ? { 'data-pg-open': '' } : {}),
                    ref: trigger,
                    onClick: () => {
                        if (props.disabled)
                            return;
                        if (!open)
                            setPlacement(measureMenu(anchor.current));
                        setOpen(!open);
                    },
                    style: {
                        ...STYLE.menuTrigger,
                        // `auto` lets a short trigger hug its own label; every other
                        // caller fills its anchor.
                        width: props.width === 'auto' ? 'auto' : '100%',
                        cursor: props.disabled ? 'not-allowed' : 'pointer',
                    },
                }, h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' } }, props.triggerLabel), menuChevron(open)), open ? h('div', { role: 'menu', style: surfaceStyle }, props.options.length === 0
                    ? h('button', {
                        type: 'button',
                        role: 'menuitem',
                        'aria-disabled': 'true',
                        disabled: true,
                        style: { ...STYLE.menuItem, cursor: 'default' },
                    }, h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.emptyLabel))
                    : props.options.map(option => h('button', {
                        key: option.value,
                        type: 'button',
                        role: 'menuitem',
                        'data-pg-menu-value': option.value,
                        onClick: () => {
                            setOpen(false);
                            if (trigger.current !== null)
                                trigger.current.focus();
                            props.onPick(option.value);
                        },
                        style: STYLE.menuItem,
                    }, h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.label), selected !== undefined && option.value === selected.value ? menuCheck() : null))) : null);
            }
            /**
             * The tool-match combobox: ONE control that is both the free-form input
             * and the tracked-tools picker (it replaces the old input + separate
             * "choose" button pair). The wrapper carries CONTROL's chrome so the
             * pair reads as a single field; the chevron opens the same menu surface
             * the enum selects drop, listing the tools the Host has actually seen.
             *
             * Behaviour: typing filters (substring, case-insensitive); the chevron
             * or ArrowDown opens the FULL list; ArrowUp/ArrowDown move the active
             * row; Enter picks it (or the only remaining row); Esc closes; picking
             * writes the row through the same `onChange` typing uses. Options are
             * activated on mousedown with the default prevented, so the input keeps
             * focus and keyboard flow is never interrupted.
             * @param props - value, tools, labels, disabled, change handler.
             * @returns the control.
             */
            function ToolMatchField(props) {
                const [open, setOpen] = React.useState(false);
                // `filtering` distinguishes "opened by typing" (filter the list) from
                // "opened by the chevron or ArrowDown" (show everything, so a field
                // whose value already matches one tool can still be re-picked).
                const [filtering, setFiltering] = React.useState(false);
                const [active, setActive] = React.useState(-1);
                const [placement, setPlacement] = React.useState({ side: 'left', width: MENU_MIN_WIDTH });
                const anchor = React.useRef(null);
                const input = React.useRef(null);
                const idRef = React.useRef('');
                if (idRef.current === '')
                    idRef.current = `pg-combo-${++comboSeq}`;
                const needle = props.value.trim().toLowerCase();
                const shown = !filtering || needle === '' ? props.tools : props.tools.filter(name => name.toLowerCase().includes(needle));
                const openMenu = (filter) => {
                    setPlacement(measureMenu(anchor.current));
                    setFiltering(filter);
                    setActive(-1);
                    setOpen(true);
                };
                const close = () => { setOpen(false); setActive(-1); };
                const pick = (name) => {
                    props.onChange(name);
                    close();
                    if (input.current !== null)
                        input.current.focus();
                };
                // Outside click closes; a viewport reflow closes (same policy as
                // MenuControl: a misaligned menu is worse than a closed one).
                React.useEffect(() => {
                    if (!open)
                        return undefined;
                    const onPointerDown = (event) => {
                        if (anchor.current !== null && anchor.current.contains(event.target))
                            return;
                        close();
                    };
                    const onReflow = () => close();
                    document.addEventListener('mousedown', onPointerDown);
                    window.addEventListener('resize', onReflow);
                    window.addEventListener('scroll', onReflow, true);
                    return () => {
                        document.removeEventListener('mousedown', onPointerDown);
                        window.removeEventListener('resize', onReflow);
                        window.removeEventListener('scroll', onReflow, true);
                    };
                }, [open]);
                // Keep the keyboard-active row visible inside the scrolling surface.
                React.useEffect(() => {
                    if (!open || active < 0 || anchor.current === null)
                        return;
                    const row = anchor.current.querySelector(`[data-pg-index="${active}"]`);
                    if (row !== null)
                        row.scrollIntoView({ block: 'nearest' });
                }, [active, open]);
                const onKeyDown = (event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        if (!open) {
                            openMenu(false);
                            return;
                        }
                        if (shown.length > 0)
                            setActive(active >= 0 ? (active + 1) % shown.length : 0);
                    }
                    else if (event.key === 'ArrowUp') {
                        if (!open)
                            return;
                        event.preventDefault();
                        if (shown.length > 0)
                            setActive(active > 0 ? active - 1 : shown.length - 1);
                    }
                    else if (event.key === 'Enter') {
                        if (!open)
                            return;
                        event.preventDefault();
                        const target = active >= 0 ? shown[active] : (shown.length === 1 ? shown[0] : undefined);
                        if (target !== undefined)
                            pick(target);
                    }
                    else if (event.key === 'Escape') {
                        if (open)
                            close();
                    }
                };
                return h('div', {
                    ref: anchor,
                    'data-pg-combo': '',
                    // Focus leaving the whole control closes the list. React's onBlur
                    // bubbles (focusout), so one handler on the wrapper sees the input and
                    // the toggle alike; a relatedTarget still inside keeps it open, which
                    // is what lets a click move between the two without a flicker.
                    onBlur: (event) => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                            close();
                    },
                    style: {
                        ...STYLE.comboWrap,
                        // D1: `outline: none` written EXPLICITLY, never merely omitted — the
                        // host's global :focus-visible rule (focus.css:10-13) would otherwise
                        // paint its blue ring on the focused input inside this wrapper.
                        outline: 'none',
                        opacity: props.disabled ? 0.6 : 1,
                    },
                }, h('input', {
                    ref: input,
                    role: 'combobox',
                    'aria-expanded': open ? 'true' : 'false',
                    'aria-controls': idRef.current,
                    'aria-autocomplete': 'list',
                    ...(open && active >= 0 ? { 'aria-activedescendant': `${idRef.current}-${active}` } : {}),
                    'aria-label': props.ariaLabel,
                    value: props.value,
                    placeholder: props.placeholder,
                    disabled: props.disabled,
                    style: { ...STYLE.comboInput, ...STYLE.mono },
                    // Clicking or tabbing into the field opens the full list straight
                    // away, which is what the field is for; typing then filters it.
                    onFocus: () => {
                        if (!props.disabled && !open)
                            openMenu(false);
                    },
                    onChange: (event) => {
                        props.onChange(event.target.value);
                        if (props.tools.length > 0) {
                            if (open)
                                setFiltering(true);
                            else
                                openMenu(true);
                        }
                    },
                    onKeyDown,
                }), h('button', {
                    type: 'button',
                    tabIndex: -1,
                    'data-pg-combo-toggle': '',
                    'aria-label': props.toggleLabel,
                    disabled: props.disabled,
                    // mousedown, not click: preventing the default keeps the input's
                    // focus, so toggling never drops the user's caret.
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => {
                        if (props.disabled)
                            return;
                        if (open)
                            close();
                        else {
                            openMenu(false);
                            if (input.current !== null)
                                input.current.focus();
                        }
                    },
                    style: { ...STYLE.comboToggle, cursor: props.disabled ? 'not-allowed' : 'pointer' },
                }, menuChevron(open)), open ? h('div', {
                    role: 'listbox',
                    id: idRef.current,
                    style: {
                        ...STYLE.menuSurface,
                        width: `${placement.width}px`,
                        maxWidth: `${placement.width}px`,
                        ...(placement.side === 'right' ? { right: 0 } : { left: 0 }),
                        maxHeight: '260px',
                        // Vertical scrolling only. Names are truncated by the option's own
                        // ellipsis, so nothing here may widen sideways; leaving the cross
                        // axis unset is what turned the tool picker's overflow into a
                        // horizontal scrollbar.
                        overflowY: 'auto',
                        overflowX: 'hidden',
                    },
                }, shown.length === 0
                    ? h('div', {
                        role: 'option',
                        'aria-selected': 'false',
                        'aria-disabled': 'true',
                        style: { ...STYLE.menuItem, cursor: 'default', color: 'var(--dsw-alias-label-tertiary, inherit)' },
                    }, props.emptyLabel)
                    : shown.map((name, at) => h('div', {
                        key: name,
                        role: 'option',
                        id: `${idRef.current}-${at}`,
                        'aria-selected': name === props.value ? 'true' : 'false',
                        'data-pg-index': String(at),
                        ...(at === active ? { 'data-pg-active': '' } : {}),
                        onMouseDown: (event) => { event.preventDefault(); pick(name); },
                        style: STYLE.menuItem,
                    }, h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name), name === props.value ? menuCheck() : null))) : null);
            }
            function PathGuardSection() {
                const form = useConfigForm();
                // A null form means "not resolvable yet": subscribe to nothing and show the
                // reading state, rather than crashing on a form the service has not built.
                const subscribeToForm = (listener) => (form === null ? () => { } : form.subscribe(listener));
                const readForm = () => (form === null ? READING_SNAPSHOT : form.getSnapshot());
                const snapshot = React.useSyncExternalStore(subscribeToForm, readForm);
                const tools = React.useSyncExternalStore(toolsStore.subscribe, toolsStore.getSnapshot);
                const [draft, setDraft] = React.useState(null);
                const [trustDraft, setTrustDraft] = React.useState(null);
                const [busy, setBusy] = React.useState(false);
                const [message, setMessage] = React.useState(null);
                if (snapshot.status === 'loading') {
                    return h('section', { ...ROOT_ATTR, style: STYLE.root, 'aria-busy': true }, h('p', { style: STYLE.status }, label('statusLoading')));
                }
                if (snapshot.status === 'unavailable') {
                    return h('section', { ...ROOT_ATTR, style: STYLE.root }, h('p', { style: STYLE.statusWarn }, label('statusUnavailable')));
                }
                const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {};
                const persisted = Array.isArray(value.rules) ? value.rules : [];
                const rows = draft ?? persisted;
                const writable = snapshot.writable !== false && snapshot.mode !== 'memory';
                const write = async (field, next, okKey) => {
                    // Resolve at WRITE time: the instance this render closed over may already
                    // have been replaced by a hot reload, and a write must never land on a
                    // dead form (nor silently vanish if the service is momentarily absent).
                    const target = resolveForm() ?? form;
                    if (target === null) {
                        setMessage({ kind: 'error', text: label('saveFailed') });
                        return;
                    }
                    setBusy(true);
                    setMessage(null);
                    try {
                        const ok = await target.set(field, next);
                        setMessage(ok === false ? { kind: 'error', text: label('saveFailed') } : { kind: 'ok', text: label(okKey) });
                    }
                    catch (error) {
                        setMessage({ kind: 'error', text: `${label('saveFailed')} ${String(error && error.message ? error.message : error)}` });
                    }
                    finally {
                        setBusy(false);
                    }
                };
                const updateRow = (index, patch) => {
                    const next = rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
                    setDraft(next);
                };
                /** Append one rule to the draft, creating the draft if needed. */
                const appendRule = (rule) => setDraft([...rows, rule]);
                // The trust list reuses the rules list's draft pattern verbatim — same
                // useState, same save/abandon pair, its own copy so the two lists are
                // edited and written independently (the Host stores them in two fields).
                const persistedTrust = Array.isArray(value.trustedTools) ? value.trustedTools : [];
                const trustRows = trustDraft ?? persistedTrust;
                const updateTrust = (index, patch) => {
                    const next = trustRows.map((row, at) => (at === index ? { ...row, ...patch } : row));
                    setTrustDraft(next);
                };
                /** Append one trusted tool to the draft, creating the draft if needed. */
                const appendTrust = (trust) => setTrustDraft([...trustRows, trust]);
                /** Ask the Host's directory picker and put the result in one row. */
                const browseInto = (index) => async () => {
                    if (!picker.available)
                        return;
                    try {
                        const chosen = await picker.pick(new AbortController().signal);
                        if (typeof chosen === 'string' && chosen !== '')
                            updateRow(index, { path: chosen });
                    }
                    catch (error) {
                        setMessage({ kind: 'error', text: String(error && error.message ? error.message : error) });
                    }
                };
                /** The visible label of one option, for a trigger that prints the current value. */
                const optionLabel = (options, value) => {
                    const found = options.find(option => option.value === value);
                    return found === undefined ? '' : found.label;
                };
                // One settings-form field: label over control over hint (SF:3-8). Every
                // field prints its own visible label; nothing suppresses it any more, so the
                // control's accessible name comes from that label via `htmlFor`/`id`.
                const scalar = (field, key, options) => h('div', { key: field, className: FIELD_CLASS, style: STYLE.field }, h('label', { style: STYLE.fieldLabel, htmlFor: `pg-${field}` }, label(key)), h(MenuControl, {
                    id: `pg-${field}`,
                    triggerLabel: optionLabel(options, String(value[field])),
                    value: String(value[field]),
                    options,
                    disabled: busy || !writable,
                    width: '186px', // upstream lib/client.js:1476
                    emptyLabel: label('noTrackedTools'),
                    onPick: (next) => void write(field, next, 'saved'),
                }), h('p', { style: STYLE.hint }, label(`${key}Hint`)));
                // The elliptical switch replaces the native checkbox on every boolean
                // setting. Same write path, same busy/disabled behaviour, same accessible
                // name; only the control and its state-dependent paint differ, and both
                // come from dsh-desktop-notify (see SWITCH / STYLE.switchTrack).
                const switchControl = (field, key) => {
                    const on = value[field] !== false;
                    const locked = busy || !writable;
                    return h('div', { key: field, className: FIELD_CLASS, style: STYLE.field }, h('div', { style: STYLE.switchRow }, h('button', {
                        type: 'button',
                        role: 'switch',
                        'aria-checked': on ? 'true' : 'false',
                        'aria-label': label(key),
                        'data-pg-switch': field,
                        disabled: locked,
                        onClick: () => void write(field, !on, 'saved'),
                        style: {
                            ...STYLE.switchTrack,
                            cursor: locked ? 'not-allowed' : 'pointer',
                            opacity: locked ? 0.55 : 1,
                            background: on ? SWITCH.brand : SWITCH.trackOff,
                        },
                    }, h('span', {
                        style: {
                            ...STYLE.switchKnob,
                            left: on ? '19px' : '3px',
                            background: on ? SWITCH.knobOn : SWITCH.knobOff,
                        },
                    })), label(key)), h('p', { style: STYLE.hint }, label(`${key}Hint`)));
                };
                return h('section', { ...ROOT_ATTR, style: STYLE.root, 'aria-label': label('title') }, h('h2', { style: STYLE.title }, label('title')), h('p', { style: STYLE.intro }, label('intro')), !writable ? h('p', { style: STYLE.notice }, label('statusReadonly')) : null, 
                // Box 1 has no heading: every control in it names itself to its right
                // (the checkbox label, the field label), so a heading would only repeat
                // the first control's own text — the duplicate-title bug fixed earlier.
                h('div', { style: STYLE.group }, switchControl('enabled', 'master'), switchControl('selfProtection', 'selfProtection'), scalar('defaultAccess', 'defaultAccess', [
                    { value: 'allow', label: label('defaultAllow') },
                    ...LEVELS.map(level => ({ value: level, label: label(`access${level[0].toUpperCase()}${level.slice(1)}`) })),
                ])), h('div', { style: STYLE.group }, h('h3', { style: STYLE.groupTitle }, label('rules')), h('p', { style: STYLE.hint }, label('rulesHint')), 
                // Always visible: this reference documents the matching semantics the
                // page configures, so a toggle would only hide the page's own content.
                h('div', { style: STYLE.doc }, h('h4', { style: STYLE.docTitle }, label('rulesDocTitle')), h('pre', { style: { margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' } }, label('rulesDoc'))), rows.length === 0
                    ? h('p', { style: STYLE.hint }, label('empty'))
                    : h('div', { style: STYLE.list, role: 'list' }, rows.map((row, index) => h('div', {
                        key: index,
                        role: 'listitem',
                        style: index === rows.length - 1 ? { ...STYLE.row, ...STYLE.rowLast } : STYLE.row,
                    }, h('div', { style: STYLE.rowField }, h('span', { style: STYLE.rowLabel }, label('colPath')), h('input', {
                        style: { ...STYLE.input, ...STYLE.mono },
                        value: row.path ?? '',
                        placeholder: label('pathPlaceholder'),
                        'aria-label': label('colPath'),
                        disabled: busy || !writable,
                        onChange: (event) => updateRow(index, { path: event.target.value }),
                    })), h('div', { style: STYLE.rowField }, h('span', { style: STYLE.rowLabel }, label('colAccess')), h(MenuControl, {
                        // The trigger fills its field; the menu aligns against it.
                        width: '100%',
                        value: row.access ?? 'none',
                        triggerLabel: optionLabel(LEVELS.map(level => ({ value: level, label: label(`access${level[0].toUpperCase()}${level.slice(1)}`) })), row.access ?? 'none'),
                        options: LEVELS.map(level => ({ value: level, label: label(`access${level[0].toUpperCase()}${level.slice(1)}`) })),
                        ariaLabel: label('colAccess'),
                        disabled: busy || !writable,
                        emptyLabel: label('noTrackedTools'),
                        onPick: (next) => updateRow(index, { access: next }),
                    })), h('div', { style: STYLE.rowField }, h('span', { style: STYLE.rowLabel }, label('colNote')), h('input', {
                        style: STYLE.input,
                        value: row.note ?? '',
                        'aria-label': label('colNote'),
                        disabled: busy || !writable,
                        onChange: (event) => updateRow(index, { note: event.target.value }),
                    })), h('div', { style: STYLE.rowActions }, h('span', { style: STYLE.rowLabel }, label('colActions')), h('div', { style: STYLE.actions }, picker.available
                        ? h('button', {
                            type: 'button',
                            style: STYLE.button,
                            title: label('browseTitle'),
                            disabled: busy || !writable,
                            onClick: browseInto(index),
                        }, label('browse'))
                        : null, h('button', {
                        type: 'button',
                        style: STYLE.button,
                        disabled: busy || !writable,
                        onClick: () => setDraft(rows.filter((_row, at) => at !== index)),
                    }, label('remove'))))))), h('p', { style: STYLE.hint }, label('rulesExemptHint')), h('div', { style: STYLE.footer }, h('button', {
                    type: 'button',
                    style: STYLE.button,
                    disabled: busy || !writable,
                    onClick: () => appendRule({ path: '', access: 'none', note: '' }),
                }, label('addRule')), draft === null ? null : h('span', { style: STYLE.warn }, label('unsaved')), draft === null ? null : h('button', {
                    type: 'button',
                    style: STYLE.primary,
                    'data-pg-primary': '',
                    disabled: busy,
                    onClick: async () => {
                        await write('rules', rows, 'saved');
                        setDraft(null);
                    },
                }, label('save')), draft === null ? null : h('button', {
                    type: 'button',
                    style: STYLE.button,
                    disabled: busy,
                    onClick: () => setDraft(null),
                }, label('revert')))), h('div', { style: STYLE.group }, h('h3', { style: STYLE.groupTitle }, label('trust')), 
                // No `namedBy`: the heading above names the topic, not this control,
                // so the select keeps its own visible label.
                scalar('unknownTools', 'unknownTools', [
                    { value: 'check', label: label('unknownToolsCheck') },
                    { value: 'deny', label: label('unknownToolsDeny') },
                ]), 
                // Always visible, like the rules reference: what a prefix wildcard
                // buys and what it costs is the decision this group asks for.
                h('div', { style: STYLE.doc }, h('h4', { style: STYLE.docTitle }, label('trustDocTitle')), h('pre', { style: { margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' } }, label('trustDoc'))), trustRows.length === 0
                    ? h('p', { style: STYLE.hint }, label('trustEmpty'))
                    : h('div', { style: STYLE.list, role: 'list', 'aria-label': label('trustedTools') }, trustRows.map((row, index) => h('div', {
                        key: index,
                        role: 'listitem',
                        style: index === trustRows.length - 1 ? { ...STYLE.row, ...STYLE.rowLast } : STYLE.row,
                    }, 
                    // ONE control: free typing filters the tracked tools inline, the
                    // chevron opens the full list. The list is a convenience, so an
                    // empty or unavailable route leaves the field exactly as
                    // editable as a bare input and only the popup says so.
                    h('div', { style: STYLE.rowField }, h('span', { style: STYLE.rowLabel }, label('colMatch')), h(ToolMatchField, {
                        value: row.match ?? '',
                        tools,
                        disabled: busy || !writable,
                        ariaLabel: label('colMatch'),
                        placeholder: label('trustPlaceholder'),
                        toggleLabel: label('pickTool'),
                        emptyLabel: label('noTrackedTools'),
                        onChange: (next) => updateTrust(index, { match: next }),
                    })), h('div', { style: STYLE.rowField }, h('span', { style: STYLE.rowLabel }, label('colNote')), h('input', {
                        style: STYLE.input,
                        value: row.note ?? '',
                        'aria-label': label('colNote'),
                        disabled: busy || !writable,
                        onChange: (event) => updateTrust(index, { note: event.target.value }),
                    })), h('div', { style: STYLE.rowActions }, h('span', { style: STYLE.rowLabel }, label('colActions')), h('div', { style: STYLE.actions }, h('button', {
                        type: 'button',
                        style: STYLE.button,
                        disabled: busy || !writable,
                        onClick: () => setTrustDraft(trustRows.filter((_row, at) => at !== index)),
                    }, label('remove'))))))), h('div', { style: STYLE.footer }, h('button', {
                    type: 'button',
                    style: STYLE.button,
                    disabled: busy || !writable,
                    onClick: () => appendTrust({ match: '', note: '' }),
                }, label('addTrust')), trustDraft === null ? null : h('span', { style: STYLE.warn }, label('unsaved')), trustDraft === null ? null : h('button', {
                    type: 'button',
                    style: STYLE.primary,
                    'data-pg-primary': '',
                    disabled: busy,
                    onClick: async () => {
                        await write('trustedTools', trustRows, 'saved');
                        setTrustDraft(null);
                    },
                }, label('save')), trustDraft === null ? null : h('button', {
                    type: 'button',
                    style: STYLE.button,
                    disabled: busy,
                    onClick: () => setTrustDraft(null),
                }, label('revert')))), 
                // ONE frame holding three sub-sections, drawn with the SAME style as
                // every other box. An earlier version gave it its own weaker border and
                // a different surface token to signal the nesting; in the running UI that
                // just read as a box whose colour did not match the others, so the frame
                // is deliberately uniform now. The grouping is carried by what is
                // actually informative: each sub-section names itself through its own
                // visible label (the builders render label + control + hint), and the
                // injected stylesheet's `.dsh-path-guard-field + .dsh-path-guard-field`
                // hairline (STATE_CSS, copied from SF:10-12) separates two of them.
                h('div', { style: STYLE.group }, scalar('shell', 'shell', [
                    { value: 'scan', label: label('shellScan') },
                    { value: 'deny', label: label('shellDeny') },
                    { value: 'off', label: label('shellOff') },
                ]), scalar('exoticTools', 'exotic', [
                    { value: 'deny', label: label('exoticDeny') },
                    { value: 'allow', label: label('exoticAllow') },
                ]), switchControl('searchRedaction', 'searchRedaction')), 
                // Its own frame, named by the field's own visible label.
                h('div', { style: STYLE.group }, scalar('notify', 'notify', [
                    { value: 'focused', label: label('notifyFocused') },
                    { value: 'always', label: label('notifyAlways') },
                    { value: 'off', label: label('notifyOff') },
                ])), message === null ? null : h('p', { style: message.kind === 'ok' ? STYLE.ok : STYLE.error }, message.text), h('p', { style: { ...STYLE.hint, marginTop: '12px' } }, `${label('revision')}: ${String(snapshot.revision ?? '-')}`));
            }
            return PathGuardSection;
        }
        return {
            name: 'path-guard-client',
            inject: ['slots', 'locale', 'configForms'],
            apply(ctx) {
                ctx.effect(() => ctx.locale.register(L10N, { zh, en }), 'path-guard: locale');
                const t = ctx.locale.bind(L10N);
                // Installed SYNCHRONOUSLY, the way the reference installs its own sheet
                // (lib/client.js:1602-1604): the rules must be live before the page's
                // first paint, not whenever an effect scheduler runs. The effect carries
                // only the removal, so the sheet still leaves with the plugin.
                installStateStyles();
                ctx.effect(() => uninstallStateStyles, 'path-guard: state styles');
                // The Host's directory picker is an optional Remote: a deployment
                // without `@deepseek-ai/dsh-directory-picker-auto` simply gets no
                // "Browse…" button instead of a broken one.
                const picker = { available: false, pick: async () => null };
                ctx.inject(['remote', 'remote.directoryPicker'], pickerCtx => {
                    // Every injected member is optional in this half's mirror, so the guard is
                    // real rather than decorative: no Remote means no "Browse…" button.
                    const remote = pickerCtx.remote;
                    if (remote === undefined)
                        return undefined;
                    picker.available = true;
                    picker.pick = signal => remote.directoryPicker.pick(signal);
                    return () => {
                        picker.available = false;
                        picker.pick = async () => null;
                    };
                });
                // The tracked tool names are a convenience for the trust editor: fetched
                // once here (never per render), published to the component through the
                // store, and dropped with the plugin.
                const toolsStore = createToolsStore();
                ctx.effect(() => toolsStore.load(), 'path-guard: tracked tools');
                // ---- Landing correction for the "unmodelled tool" notification ----
                //
                // The notice's click is handled by the OTHER plugin (dsh-desktop-notify),
                // whose `page:plugins` branch calls `openBundle('dsh-desktop-notify')` with
                // its own name HARDCODED, while the wire protocol's page whitelist carries
                // only the two bare values ('settings-plugins', 'plugins') and no
                // bundle-qualified form. So the click can only ever land on that plugin's
                // package page — upstream behaviour we cannot change from here.
                //
                // What we CAN do is finish the journey: once the plugins panel is the active
                // one right after that notice, open THIS bundle's page instead.
                //
                // TWO triggers, because one click produces different signals depending on
                // where the user already was:
                //   - the plugin manager changed the active panel (the user was elsewhere)
                //     → `layout.panelInfo` emits;
                //   - the panel was ALREADY the active one (the user sat on the plugins list,
                //     or on our own page, when the notice arrived) → nothing changes the
                //     panel, so panelInfo stays silent. Clicking a desktop notification
                //     brings the window to the front (the upstream Windows forwarder calls
                //     AppActivate, the page calls focus()), so `focus` and
                //     `visibilitychange → visible` carry that case.
                // Both triggers run the SAME evaluation, and both require the plugins panel
                // to be active: that keeps them complementary (panel change vs. no panel
                // change) and stops a plain alt-tab onto some other panel from being
                // redirected. The correction itself is asynchronous, so it lands after the
                // reference plugin's synchronous navigation and wins the race.
                //
                // The 20s window is the safety mechanism: the correction only fires just
                // after the notice was actually sent. Everything is best effort — a missing
                // service, a refused request or an unexpected body silently does nothing.
                //
                // Delete this block wholesale if upstream ever accepts a bundle-qualified
                // page target, or if the notice learns to name its own destination.
                ctx.inject(['layout', 'pluginNavigation'], scope => {
                    const layout = scope.layout;
                    const navigation = scope.pluginNavigation;
                    if (layout === undefined || navigation === undefined)
                        return undefined;
                    /** The `lastUnmodelledAt` already acted on, so the two or three signals one
                     *  click produces correct once — while a NEWER notice (a new timestamp)
                     *  may still correct again. */
                    let correctedAt = null;
                    let lastEvaluatedAt = 0;
                    let inFlight = false;
                    /** Ask the Host once and correct only a still-fresh notice. */
                    const evaluate = () => {
                        if (inFlight)
                            return;
                        const now = Date.now();
                        // Focus storms are real (a window manager can emit focus several times
                        // for one activation), and the Host read is the expensive part, so at
                        // most one evaluation per second.
                        if (now - lastEvaluatedAt < EVALUATION_THROTTLE_MS)
                            return;
                        lastEvaluatedAt = now;
                        inFlight = true;
                        void (async () => {
                            try {
                                const url = new URL(TOOLS_PATH, document.baseURI).toString();
                                const response = await fetch(url, { headers: { accept: 'application/json' } });
                                if (!response.ok)
                                    return;
                                const at = readUnmodelledAt(await response.json());
                                if (at === null || Date.now() - at > CORRECTION_WINDOW_MS)
                                    return;
                                if (correctedAt === at)
                                    return;
                                correctedAt = at;
                                navigation.openBundle(PKG);
                            }
                            catch {
                                // Best effort: never disturb the panel the user just opened.
                            }
                            finally {
                                inFlight = false;
                            }
                        })();
                    };
                    /** The one gate every trigger shares: only the plugins panel is corrected. */
                    const evaluateOnPluginsPanel = () => {
                        if (layout.panelInfo.getSnapshot().activePanelId !== PLUGINS_PANEL_ID)
                            return;
                        evaluate();
                    };
                    const onVisibility = () => {
                        if (document.visibilityState !== 'visible')
                            return;
                        evaluateOnPluginsPanel();
                    };
                    // Every listener is registered on the plugin's own cleanup path, so none
                    // of them can outlive this half. The disposer is also handed back to the
                    // injection, and removing a listener twice is a no-op.
                    // No evaluation at mount time: a page load is a user action of its own
                    // (the notice's click navigates in-app and never reloads), and acting on
                    // a refresh that happens to fall inside the window would move someone who
                    // is browsing the plugins list. The triggers above cover the click.
                    return ctx.effect(() => {
                        const off = layout.panelInfo.subscribe(evaluateOnPluginsPanel);
                        window.addEventListener('focus', evaluateOnPluginsPanel);
                        document.addEventListener('visibilitychange', onVisibility);
                        return () => {
                            off();
                            window.removeEventListener('focus', evaluateOnPluginsPanel);
                            document.removeEventListener('visibilitychange', onVisibility);
                        };
                    }, 'path-guard: landing correction');
                });
                const Section = createSection(ctx, t, picker, toolsStore);
                // Register only while the Host actually serves the namespace, so a
                // profile without this bundle's row shows no trace of the page.
                //
                // A plugin's OWN configuration belongs on the Plugins page, not in the
                // Settings navigation. Verified against every shipped client package:
                // `settings.section` is registered only by deployment-level sections
                // (general, models, account, agent-presets), while a plugin's own config
                // page registers into `plugins.item` (agent-loop, shell, web-search,
                // subagent). NO shipped package registers both, so a second nav entry
                // would be off-standard rather than helpful.
                //
                // For a third-party BUNDLE the plugins-page seats are these two:
                //   - `plugins.row.config`    → the configure control on this bundle's
                //                               row, keyed `<package name>#<row id>`
                //   - `plugins.bundle.config` → the bundle card's own page, keyed by the
                //                               bundle package name
                ctx.effect(() => ctx.configForms.whileServed([NS], () => {
                    const disposers = [
                        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
                            name: 'plugins.row.config',
                            key: `${PKG}#${NS}`,
                            locale: L10N,
                        }, (props) => (props?.view === 'summary' ? t('configSummary') : h(Section, null)))),
                        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
                            name: 'plugins.bundle.config',
                            key: PKG,
                            locale: L10N,
                        }, (props) => (props?.view === 'summary' ? null : h(Section, null)))),
                    ];
                    return () => { for (const dispose of disposers)
                        dispose(); };
                }), 'path-guard: plugin config pages');
            },
        };
    },
});
