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

/**
 * The client-module loader the shell publishes on `window` before any bundle
 * runs. Declared locally instead of imported: a plugin may not depend on a DSH
 * client package, and `tsconfig.client.json` sets `"types": []` so nothing may
 * be borrowed from `@types/node` either.
 */
interface PathGuardModuleLoader {
  /**
   * Register one client half.
   * @param spec - the module id and the factory the module system later calls.
   */
  load(spec: {
    readonly id: string
    readonly factory: (require: (id: string) => unknown) => unknown
  }): void
}

// Reached through one cast rather than a `declare global` augmentation: this
// file has to compile whether or not the compiler is told the package makes it
// an ES module, and a global augmentation is legal only inside a module. (The
// distinction matters for the build: under `"type": "module"` tsc appends
// `export {}` to the output, which the loader's classic script cannot parse —
// see the header note.)
;(window as unknown as { __ModuleLoader__: PathGuardModuleLoader }).__ModuleLoader__.load({
  id: 'dsh-path-guard',
  factory(require: (id: string) => unknown) {
    /**
     * Local structural mirrors of the host faces this half touches. Type-only,
     * so nothing here reaches the emitted classic script.
     *
     * Deliberate: a plugin may not import a DSH client package, and
     * `tsconfig.client.json` sets `"types": []`, so the globals and service
     * shapes are declared here instead of borrowed. Each mirror names the DSH
     * source it was read from and declares only the members this file uses.
     */

    /**
     * The slice of React this half uses. `react` is a baseline external the
     * module system always answers (packages/client/web/src/platform.ts:8-14);
     * anything else would be a package this plugin may not depend on.
     */
    interface ReactLike {
      /** Mirrors React.createElement (props are passed through untouched). */
      createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
      /** Mirrors React.useState. */
      useState<S>(initial: S): [S, (next: S) => void]
      /** Mirrors React.useSyncExternalStore. */
      useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T
    }

    /** One configured rule, as the `path-guard` settings namespace stores it. */
    interface Rule {
      path?: string | undefined
      access?: string | undefined
      note?: string | undefined
    }

    /** One one-click preset (a rule without a note). */
    interface Preset {
      readonly key: string
      readonly path: string
      readonly access: string
    }

    /** The page's transient status line. */
    interface Message {
      readonly kind: 'ok' | 'error'
      readonly text: string
    }

    /** The slice of a DOM change event the handlers read; a React synthetic event satisfies it. */
    interface ChangeEvent<T> {
      readonly target: T
    }

    /** A change event's target for text inputs and selects. */
    interface ValueTarget {
      readonly value: string
    }

    /** A change event's target for a checkbox. */
    interface CheckedTarget {
      readonly checked: boolean
    }

    /** One `<option>` of an enum field. */
    interface Option {
      readonly value: string
      readonly label: string
    }

    /** A thrown value that may carry a `message` (an Error, a DOMException, or anything else). */
    interface ErrorLike {
      readonly message?: unknown
    }

    /** Mirrors ConfigFormSnapshot<T> (packages/client/ui-settings/src/client/config-form-types.ts:8-34). */
    interface ConfigSnapshot<T> {
      readonly status: 'loading' | 'ready' | 'unavailable'
      readonly value: T | undefined
      readonly revision: number | undefined
      readonly writable: boolean
      readonly mode: 'host' | 'memory'
    }

    /** Mirrors the ConfigForm<T> members this half uses (config-form-types.ts:39-77). */
    interface ConfigForm<T> {
      getSnapshot(): ConfigSnapshot<T>
      subscribe(listener: () => void): () => void
      set(field: string, value: unknown): Promise<boolean>
    }

    /**
     * Mirrors the `configForms` service face
     * (ui-settings/src/client/config-form.ts:293 `get`, :317 `whileServed`).
     */
    interface ConfigFormsFace {
      get<T>(namespace: string): ConfigForm<T>
      whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
    }

    /**
     * Mirrors PluginConfigViewProps
     * (ui-plugin-manager/src/client/slot-contract.ts:23-28).
     */
    interface ConfigViewProps {
      readonly view: 'summary' | 'page'
    }

    /** Mirrors the registration options these two seats are given (ui-slots/src/index.ts:1157-1203). */
    interface SlotRegistration {
      readonly name: string
      readonly key: string
      readonly locale: string
    }

    /**
     * The `slots` service face this half uses. `inject` is the Cordis Context
     * method the shipped pages call the same way
     * (ui-settings-agent-loop/src/client/index.ts:47-48); `register` mirrors the
     * used shape of SlotCore.register (ui-slots/src/index.ts:1157-1203).
     */
    interface SlotsFace {
      inject(name: string, register: () => () => void): () => void
      register(options: SlotRegistration, component: (props: ConfigViewProps | undefined) => unknown): () => void
    }

    /** The `locale` service face: one dictionary per language, addressed by namespace. */
    interface LocaleFace {
      register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
      bind(namespace: string): (key: string) => string
    }

    /**
     * The directory-picker Remote, mirrored from the Host method it is generated
     * from (packages/api/workspace-controller/src/directory-picker.ts:49-62).
     */
    interface DirectoryPickerRemote {
      /**
       * Open the Host's chooser.
       * @param signal - caller lifetime; abort terminates the chooser.
       * @returns the chosen absolute path, or null when the operator cancels.
       */
      pick(signal: AbortSignal): Promise<string | null>
    }

    /** The context an `inject([...])` callback receives, reduced to the Remote this half asks for. */
    interface RemoteInjectContext {
      readonly remote: { readonly directoryPicker: DirectoryPickerRemote }
    }

    /** Local state of the optional "Browse…" affordance; it stays unavailable without the Remote. */
    interface Picker extends DirectoryPickerRemote {
      available: boolean
    }

    /**
     * The client plugin Context, reduced to what this half uses. Structural
     * mirror: `effect` and `inject` are Cordis Context methods, and the three
     * services are the faces above.
     */
    interface ClientContext {
      effect(callback: () => void | (() => void), label?: string): () => void
      inject(deps: readonly string[], callback: (ctx: RemoteInjectContext) => void | (() => void)): void
      readonly locale: LocaleFace
      readonly configForms: ConfigFormsFace
      readonly slots: SlotsFace
    }

    const React = require('react') as ReactLike
    const h = React.createElement

    /** Settings namespace == the plugin row id in the profile patch. */
    const NS = 'path-guard'

    /** Bundle package name, the other half of the plugin-list row key. */
    const PKG = 'dsh-path-guard'

    /** Locale key for this page. */
    const L10N = 'path-guard'

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
      presets: '常用位置（点一下即添加）',
      presetSsh: '~/.ssh → 仅文件名',
      presetAws: '~/.aws → 完全禁止',
      presetGnupg: '~/.gnupg → 完全禁止',
      presetDocker: '~/.docker → 完全禁止',
      rulesExemptHint: '想给受保护目录里的某个文件开例外？再加一条更具体的规则就行——例如「~/.ssh → 仅文件名」再加「~/.ssh/README.md → 只读」，就只有那一个文件可读。',
      browse: '浏览…',
      browseTitle: '把选中的目录填入这一行',
      help: '怎么用？看四个例子',
      helpHide: '收起说明',
      helpBody: [
        '① 完全禁止：规则路径填 ~/.ssh，档位选「完全禁止」。AI 连这个目录里有哪些文件名都看不到。',
        '② 只让看名字、不让读内容：档位选「半访问·仅文件名」。glob 仍能看到文件名，read / grep 会被拒。',
        '③ 可读但不可写：档位选「半访问·只读」。读得到，write / edit 会被拒。',
        '④ 豁免某个文件：再加一条更具体的规则。例如先给 ~/.ssh 设「仅文件名」，再加 ~/.ssh/README.md 设「只读」，就只有那一个文件能读。',
        '',
        '规则不区分先后：越具体的路径自动优先——先比命中目录的深度，再比字面量前缀长度，然后比通配符多少。',
        '路径写法：~ 是家目录；${workspace} 是当前会话的工作区；* 匹配一段，** 匹配任意层。',
        '改动即时生效，不需要重启。写操作只会改 profile 补丁里本插件那一条 config。',
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
    }

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
      presets: 'Common locations (click to add)',
      presetSsh: '~/.ssh → names only',
      presetAws: '~/.aws → blocked',
      presetGnupg: '~/.gnupg → blocked',
      presetDocker: '~/.docker → blocked',
      rulesExemptHint: 'Need one file inside a protected directory to stay readable? Add a second, more specific rule — e.g. "~/.ssh → names only" plus "~/.ssh/README.md → read only" makes exactly that one file readable.',
      browse: 'Browse…',
      browseTitle: 'Put the chosen directory into this row',
      help: 'How do I use this? Four examples',
      helpHide: 'Hide help',
      helpBody: [
        '1. Blocked: set the path to ~/.ssh and the level to "Blocked". The AI cannot even see which file names live there.',
        '2. Names only: pick "Half access · names only". glob still lists file names; read and grep are refused.',
        '3. Read only: pick "Half access · read only". Reads succeed; write and edit are refused.',
        '4. Exemption: add a second, more specific rule. Set ~/.ssh to "names only" and ~/.ssh/README.md to "read only" to make exactly that one file readable.',
        '',
        'Order does not matter: the more specific path wins automatically — first by how deep the matched directory is, then by literal prefix length, then by fewest wildcards.',
        'Path syntax: ~ is your home directory; ${workspace} is the current session workspace; * matches one segment, ** matches any depth.',
        'Changes apply immediately, no restart. A write only touches this plugin\'s own config entry in the profile patch.',
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
    }

    /** Access levels in ladder order, weakest first. */
    const LEVELS = ['none', 'list', 'read', 'write']

    /**
     * One-click rules for the locations people actually protect first. The
     * access level is the conservative-but-usable default for each: SSH keeps
     * names visible so the agent can still tell a key exists, everything else
     * is hidden outright.
     */
    const PRESETS = [
      { key: 'presetSsh', path: '~/.ssh', access: 'list' },
      { key: 'presetAws', path: '~/.aws', access: 'none' },
      { key: 'presetGnupg', path: '~/.gnupg', access: 'none' },
      { key: 'presetDocker', path: '~/.docker', access: 'none' },
    ]

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

    /** Control surface shared by the settings-form text input and enum select (SF:107-117). */
    const CONTROL = {
      boxSizing: 'border-box',
      height: '34px', // SF:108
      padding: '0 12px', // SF:109
      border: '0.5px solid var(--dsw-alias-border-l4, currentColor)', // SF:110
      borderRadius: 'var(--dsw-radius-md, 12px)', // SF:111, TH:18
      background: 'var(--dsw-alias-bg-layer-3, transparent)', // SF:112
      color: 'var(--dsw-alias-label-primary, inherit)', // SF:116
      fontFamily: 'inherit', // SF:113
      fontSize: '13px', // SF:114
      lineHeight: 1.5, // SF:115
    }

    /** The compact outlined action: Button `sm` size (BT:28-34) in its `outline` variant (BT:54-57). */
    const SM_BUTTON = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '28px', // BT:29
      padding: '0 10px', // BT:32
      border: '0.5px solid var(--dsw-alias-border-l3, currentColor)', // BT:55
      borderRadius: 'var(--dsw-radius-sm, 8px)', // BT:33, TH:17
      background: 'none', // BT:56 paints nothing on the outline variant (written `none` as PM:546 does)
      color: 'var(--dsw-alias-label-primary, inherit)', // BT:13
      fontFamily: 'inherit',
      fontSize: '12px', // BT:30
      lineHeight: '18px', // BT:31
    }

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
      checkboxLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer' }, // CB:1-9
      checkbox: { flex: '0 0 auto', width: '16px', height: '16px', margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' }, // CB:11-18
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, inherit)' }, // SF:140-145
      // MS:589-594: an enum picker holds a handful of short options and sizes to
      // them, so it does not read as a text field the user is expected to fill in.
      select: { ...CONTROL, alignSelf: 'flex-start', maxWidth: '100%' },
      input: { ...CONTROL, width: '100%' },
      // The rules table copies the host's own table (TR:99-159): 12px/18px text
      // (TT:244), a 30px header on the l2 hairline, body cells on l1.
      table: { width: '100%', borderCollapse: 'collapse', margin: '0 0 12px', color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-layer-1, transparent)', fontSize: '12px', lineHeight: '18px' },
      th: {
        boxSizing: 'border-box',
        height: '30px', // TR:132
        padding: '0 8px', // TR:133
        borderBottom: '0.5px solid var(--dsw-alias-border-l2, currentColor)', // TR:135
        color: 'var(--dsw-alias-label-tertiary, inherit)', // TR:136
        fontWeight: 500, // TR:139
        textAlign: 'left', // TR:140
      },
      // TR:151-159 keeps a 30px cell height too; the 34px controls in these cells
      // set their own, so only the 8px inset is copied.
      td: { boxSizing: 'border-box', padding: '4px 8px', verticalAlign: 'middle' },
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
      presets: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '0 0 10px' }, // PM:1070-1075 `.approvalList`; PS:78
      chip: { ...SM_BUTTON, borderRadius: '999px', padding: '0 12px' }, // PL:8 pill; BT:29-32 for the box
      helpToggle: { margin: '0 0 10px' }, // PS:78 `.cards { gap: 10px }`
      link: { // INV:383-391 `.jumpLink`
        border: 'none',
        padding: 0,
        background: 'none',
        color: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      help: { // PM:566-581 `.guide` + `.guideHint`; text metrics from SF:67-72
        margin: '6px 0 0',
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
      actions: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, // PM:544 `.guideToggle { gap: 4px }`
      footer: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }, // SG:16-21
    }

    /**
     * The states React inline styles cannot express: `::placeholder` (no inline
     * counterpart at all), the hover fill, disabled affordance, the pointer cursor,
     * and the hairline between two adjacent fields (SF:10-12, which needs a `+`
     * selector). Every rule is scoped to this page root's own attribute, so none of
     * them can reach host UI, and the sheet is injected once from `apply` so it
     * leaves with the plugin.
     *
     * `!important` appears only on the hover fills: a state must beat the element's
     * own inline background, which carries the base state. If this sheet were ever
     * missing, the page still renders exactly its inline styling and loses only the
     * hover fills.
     */
    const STATE_CSS = `
[data-path-guard] input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); } /* MS:601-603 */
[data-path-guard] button, [data-path-guard] select { cursor: pointer; } /* MS:593 */
[data-path-guard] button:disabled { opacity: 0.4; cursor: default; } /* BT:18-21 */
[data-path-guard] input:disabled, [data-path-guard] select:disabled { opacity: 0.6; cursor: default; } /* MS:605-608 */
[data-path-guard] button:not([data-pg-primary]):not([data-pg-link]):not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover) !important; } /* BT:45-47 */
[data-path-guard] button[data-pg-primary]:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)) !important; } /* BT:41-43 */
[data-path-guard] button[data-pg-link]:hover { color: var(--dsw-alias-label-primary); } /* PM:554-556 */
[data-path-guard] .dsh-path-guard-field + .dsh-path-guard-field { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 12px; } /* SF:10-12 */
`

    /** Class on each field wrapper, so STATE_CSS can separate two adjacent fields. */
    const FIELD_CLASS = 'dsh-path-guard-field'

    /** Id of the injected state stylesheet: one copy per document. */
    const STATE_STYLE_ID = 'dsh-path-guard-state-styles'

    /**
     * Put STATE_CSS in the page.
     * @returns {() => void} removal, for the plugin's own effect cleanup.
     */
    function installStateStyles() {
      if (typeof document === 'undefined' || document.getElementById(STATE_STYLE_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = STATE_STYLE_ID
      element.textContent = STATE_CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    /** Every root this section renders under, carrying the stylesheet's scope attribute. */
    const ROOT_ATTR = { 'data-path-guard': '' }

    /**
     * Build the settings section component around one bound config form.
     * @param ctx - the client plugin context.
     * @param t - locale lookup.
     * @param picker - the optional directory-picker affordance.
     * @returns the React component.
     */
    function createSection(ctx: ClientContext, t: (key: string) => string, picker: Picker) {
      const form = ctx.configForms.get<Record<string, unknown>>(NS)
      const subscribe = (listener: () => void) => form.subscribe(listener)
      const getSnapshot = () => form.getSnapshot()
      const label = (key: string) => t(key)

      function PathGuardSection() {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
        const [draft, setDraft] = React.useState<Rule[] | null>(null)
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState<Message | null>(null)
        const [helpOpen, setHelpOpen] = React.useState(false)

        if (snapshot.status === 'loading') {
          return h('section', { ...ROOT_ATTR, style: STYLE.root, 'aria-busy': true }, h('p', { style: STYLE.status }, label('statusLoading')))
        }
        if (snapshot.status === 'unavailable') {
          return h('section', { ...ROOT_ATTR, style: STYLE.root }, h('p', { style: STYLE.statusWarn }, label('statusUnavailable')))
        }

        const value: Record<string, unknown> = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
        const persisted: Rule[] = Array.isArray(value.rules) ? (value.rules as Rule[]) : []
        const rows = draft ?? persisted
        const writable = snapshot.writable !== false && snapshot.mode !== 'memory'

        const write = async (field: string, next: unknown, okKey: string) => {
          setBusy(true)
          setMessage(null)
          try {
            const ok = await form.set(field, next)
            setMessage(ok === false ? { kind: 'error', text: label('saveFailed') } : { kind: 'ok', text: label(okKey) })
          } catch (error) {
            setMessage({ kind: 'error', text: `${label('saveFailed')} ${String(error && (error as ErrorLike).message ? (error as ErrorLike).message : error)}` })
          } finally {
            setBusy(false)
          }
        }

        const updateRow = (index: number, patch: Partial<Rule>) => {
          const next = rows.map((row, at) => (at === index ? { ...row, ...patch } : row))
          setDraft(next)
        }

        const toggleRow = (index: number, key: string) => (event: ChangeEvent<ValueTarget>) => updateRow(index, { [key]: event.target.value })

        /** Append one rule to the draft, creating the draft if needed. */
        const appendRule = (rule: Rule) => setDraft([...rows, rule])

        /** Append one preset; a path already present is not duplicated. */
        const appendPreset = (preset: Preset) => {
          if (rows.some(row => row.path === preset.path)) return
          setDraft([...rows, { path: preset.path, access: preset.access, note: '' }])
        }

        /** Ask the Host's directory picker and put the result in one row. */
        const browseInto = (index: number) => async () => {
          if (!picker.available) return
          try {
            const chosen = await picker.pick(new AbortController().signal)
            if (typeof chosen === 'string' && chosen !== '') updateRow(index, { path: chosen })
          } catch (error) {
            setMessage({ kind: 'error', text: String(error && (error as ErrorLike).message ? (error as ErrorLike).message : error) })
          }
        }

        // One settings-form field: label over control over hint (SF:3-8).
        const scalar = (field: string, key: string, options: readonly Option[]) => h('div', { key: field, className: FIELD_CLASS, style: STYLE.field },
          h('label', { style: STYLE.fieldLabel, htmlFor: `pg-${field}` }, label(key)),
          h('select', {
            id: `pg-${field}`,
            style: STYLE.select,
            value: String(value[field]),
            disabled: busy || !writable,
            onChange: (event: ChangeEvent<ValueTarget>) => void write(field, event.target.value, 'saved'),
          }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
          h('p', { style: STYLE.hint }, label(`${key}Hint`)),
        )

        const checkbox = (field: string, key: string) => h('div', { key: field, className: FIELD_CLASS, style: STYLE.field },
          h('label', { style: STYLE.checkboxLabel },
            h('input', {
              type: 'checkbox',
              style: STYLE.checkbox,
              checked: value[field] !== false,
              disabled: busy || !writable,
              onChange: (event: ChangeEvent<CheckedTarget>) => void write(field, event.target.checked, 'saved'),
            }),
            label(key),
          ),
          h('p', { style: STYLE.hint }, label(`${key}Hint`)),
        )

        return h('section', { ...ROOT_ATTR, style: STYLE.root, 'aria-label': label('title') },
          h('h2', { style: STYLE.title }, label('title')),
          h('p', { style: STYLE.intro }, label('intro')),
          !writable ? h('p', { style: STYLE.notice }, label('statusReadonly')) : null,

          h('div', { style: STYLE.group },
            h('h3', { style: STYLE.groupTitle }, label('master')),
            checkbox('enabled', 'master'),
            scalar('defaultAccess', 'defaultAccess', [
              { value: 'allow', label: label('defaultAllow') },
              ...LEVELS.map(level => ({ value: level, label: label(`access${level[0]!.toUpperCase()}${level.slice(1)}`) })),
            ]),
          ),

          h('div', { style: STYLE.group },
            h('h3', { style: STYLE.groupTitle }, label('rules')),
            h('p', { style: STYLE.hint }, label('rulesHint')),
            h('p', { style: { ...STYLE.hint, margin: '0 0 6px' } }, label('presets')),
            h('div', { style: STYLE.presets }, PRESETS.map(preset => h('button', {
              key: preset.key,
              type: 'button',
              style: STYLE.chip,
              disabled: busy || !writable,
              onClick: () => appendPreset(preset),
            }, label(preset.key)))),
            h('div', { style: STYLE.helpToggle },
              h('button', {
                type: 'button',
                style: STYLE.link,
                'data-pg-link': '',
                onClick: () => setHelpOpen(!helpOpen),
              }, label(helpOpen ? 'helpHide' : 'help')),
              helpOpen
                ? h('pre', { style: STYLE.help }, label('helpBody'))
                : null,
            ),
            rows.length === 0
              ? h('p', { style: STYLE.hint }, label('empty'))
              : h('table', { style: STYLE.table },
                h('thead', null, h('tr', null,
                  h('th', { style: { ...STYLE.th, width: '34%' } }, label('colPath')),
                  h('th', { style: { ...STYLE.th, width: '38%' } }, label('colAccess')),
                  h('th', { style: STYLE.th }, label('colNote')),
                  h('th', { style: { ...STYLE.th, width: '112px' } }, label('colActions')),
                )),
                h('tbody', null, rows.map((row, index) => h('tr', { key: index },
                  h('td', { style: STYLE.td }, h('input', {
                    style: { ...STYLE.input, ...STYLE.mono },
                    value: row.path ?? '',
                    placeholder: label('pathPlaceholder'),
                    'aria-label': label('colPath'),
                    disabled: busy || !writable,
                    onChange: (event: ChangeEvent<ValueTarget>) => updateRow(index, { path: event.target.value }),
                  })),
                  h('td', { style: STYLE.td }, h('select', {
                    style: { ...STYLE.select, width: '100%' },
                    value: row.access ?? 'none',
                    'aria-label': label('colAccess'),
                    disabled: busy || !writable,
                    onChange: toggleRow(index, 'access'),
                  }, LEVELS.map(level => h('option', { key: level, value: level },
                    label(`access${level[0]!.toUpperCase()}${level.slice(1)}`))))),
                  h('td', { style: STYLE.td }, h('input', {
                    style: STYLE.input,
                    value: row.note ?? '',
                    'aria-label': label('colNote'),
                    disabled: busy || !writable,
                    onChange: (event: ChangeEvent<ValueTarget>) => updateRow(index, { note: event.target.value }),
                  })),
                  h('td', { style: STYLE.td }, h('div', { style: STYLE.actions },
                    picker.available
                      ? h('button', {
                        type: 'button',
                        style: STYLE.button,
                        title: label('browseTitle'),
                        disabled: busy || !writable,
                        onClick: browseInto(index),
                      }, label('browse'))
                      : null,
                    h('button', {
                      type: 'button',
                      style: STYLE.button,
                      disabled: busy || !writable,
                      onClick: () => setDraft(rows.filter((_row, at) => at !== index)),
                    }, label('remove')))),
                ))),
              ),
            h('p', { style: STYLE.hint }, label('rulesExemptHint')),
            h('div', { style: STYLE.footer },
              h('button', {
                type: 'button',
                style: STYLE.button,
                disabled: busy || !writable,
                onClick: () => appendRule({ path: '', access: 'none', note: '' }),
              }, label('addRule')),
              draft === null ? null : h('span', { style: STYLE.warn }, label('unsaved')),
              draft === null ? null : h('button', {
                type: 'button',
                style: STYLE.primary,
                'data-pg-primary': '',
                disabled: busy,
                onClick: async () => {
                  await write('rules', rows, 'saved')
                  setDraft(null)
                },
              }, label('save')),
              draft === null ? null : h('button', {
                type: 'button',
                style: STYLE.button,
                disabled: busy,
                onClick: () => setDraft(null),
              }, label('revert')),
            ),
          ),

          h('div', { style: STYLE.group },
            h('h3', { style: STYLE.groupTitle }, label('shell')),
            scalar('shell', 'shell', [
              { value: 'scan', label: label('shellScan') },
              { value: 'deny', label: label('shellDeny') },
              { value: 'off', label: label('shellOff') },
            ]),
          ),

          h('div', { style: STYLE.group },
            h('h3', { style: STYLE.groupTitle }, label('exotic')),
            scalar('exoticTools', 'exotic', [
              { value: 'deny', label: label('exoticDeny') },
              { value: 'allow', label: label('exoticAllow') },
            ]),
          ),

          h('div', { style: STYLE.group },
            checkbox('searchRedaction', 'searchRedaction'),
            checkbox('selfProtection', 'selfProtection'),
            scalar('notify', 'notify', [
              { value: 'focused', label: label('notifyFocused') },
              { value: 'always', label: label('notifyAlways') },
              { value: 'off', label: label('notifyOff') },
            ]),
          ),

          message === null ? null : h('p', { style: message.kind === 'ok' ? STYLE.ok : STYLE.error }, message.text),
          h('p', { style: { ...STYLE.hint, marginTop: '12px' } },
            `${label('revision')}: ${String(snapshot.revision ?? '-')}`),
        )
      }

      return PathGuardSection
    }

    return {
      name: 'path-guard-client',
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx: ClientContext) {
        ctx.effect(() => ctx.locale.register(L10N, { zh, en }), 'path-guard: locale')
        const t = ctx.locale.bind(L10N)

        // The hover, placeholder, disabled and field-separator rules React inline
        // styles cannot express (STATE_CSS above); it leaves with the plugin.
        ctx.effect(() => installStateStyles(), 'path-guard: state styles')

        // The Host's directory picker is an optional Remote: a deployment
        // without `@deepseek-ai/dsh-directory-picker-auto` simply gets no
        // "Browse…" button instead of a broken one.
        const picker: Picker = { available: false, pick: async () => null }
        ctx.inject(['remote', 'remote.directoryPicker'], pickerCtx => {
          picker.available = true
          picker.pick = signal => pickerCtx.remote.directoryPicker.pick(signal)
          return () => {
            picker.available = false
            picker.pick = async () => null
          }
        })

        const Section = createSection(ctx, t, picker)

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
            }, (props: ConfigViewProps | undefined) => (props?.view === 'summary' ? t('configSummary') : h(Section, null)))),

            ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: PKG,
              locale: L10N,
            }, (props: ConfigViewProps | undefined) => (props?.view === 'summary' ? null : h(Section, null)))),
          ]
          return () => { for (const dispose of disposers) dispose() }
        }), 'path-guard: plugin config pages')
      },
    }
  },
})
