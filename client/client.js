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
 * This half registers one Settings page under `settings.section` and binds it
 * to the `path-guard` settings namespace, which IS the row id in
 * `cordis.patch.yml` (packages/settings/settings/src/index.ts:315,382).
 *
 * Deliberate constraints:
 *   - plain JS, hand-written, loaded through `window.__ModuleLoader__.load`;
 *     `install_bundle` runs `pnpm add` only and never builds a package
 *     (packages/boot/plugin-manager/src/index.ts:461-559), so shipping a
 *     pre-built `client.js` is the only thing that works for a third-party
 *     bundle.
 *   - only `react` is required, and it is a baseline external
 *     (packages/client/web/src/platform.ts:8-14) — no other Harness client
 *     package is imported, per the plugin authoring policy.
 *   - styling uses only `--dsw-alias-*` theme tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-path-guard',
  factory(require) {
    const React = require('react')
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
      pathPlaceholder: '例如 ~/.ssh 或 D:/secrets/**',
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
      pathPlaceholder: 'e.g. ~/.ssh or D:/secrets/**',
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

    const STYLE = {
      root: {
        padding: '20px 24px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        lineHeight: 1.6,
        overflowY: 'auto',
        height: '100%',
      },
      title: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 },
      intro: { margin: '0 0 16px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      notice: {
        margin: '0 0 16px',
        padding: '8px 12px',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      group: {
        margin: '0 0 18px',
        padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      groupTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px' },
      rowLabel: { minWidth: '190px', color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { margin: '2px 0 10px', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px' },
      select: {
        padding: '4px 6px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l2, currentColor)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '12px',
      },
      input: {
        width: '100%',
        padding: '4px 6px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l2, currentColor)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '12px',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: {
        textAlign: 'left',
        padding: '4px 6px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        borderBottom: '1px solid var(--dsw-alias-border-l1, currentColor)',
      },
      td: { padding: '4px 6px', verticalAlign: 'middle' },
      button: {
        padding: '4px 10px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l2, currentColor)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      primary: {
        padding: '4px 12px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-brand-primary, currentColor)',
        background: 'var(--dsw-alias-brand-primary, transparent)',
        color: 'var(--dsw-alias-bg-base, #fff)',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, inherit)' },
      ok: { color: 'var(--dsw-alias-state-success-primary, inherit)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary, inherit)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      presets: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '0 0 10px' },
      chip: {
        padding: '3px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, currentColor)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        fontSize: '11px',
        fontFamily: 'inherit',
      },
      link: {
        padding: 0,
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-brand-primary, currentColor)',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'inherit',
        textDecoration: 'underline',
      },
      help: {
        margin: '6px 0 0',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        whiteSpace: 'pre-wrap',
        fontFamily: 'inherit',
        lineHeight: 1.7,
      },
      actions: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' },
    }

    /**
     * Build the settings section component around one bound config form.
     * @param {object} ctx - the client plugin context.
     * @param {(key: string) => string} t - locale lookup.
     * @returns {Function} the React component.
     */
    function createSection(ctx, t, picker) {
      const form = ctx.configForms.get(NS)
      const subscribe = listener => form.subscribe(listener)
      const getSnapshot = () => form.getSnapshot()
      const label = key => t(key)

      function PathGuardSection() {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
        const [draft, setDraft] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState(null)
        const [helpOpen, setHelpOpen] = React.useState(false)

        if (snapshot.status === 'loading') {
          return h('section', { style: STYLE.root, 'aria-busy': true }, h('p', null, label('statusLoading')))
        }
        if (snapshot.status === 'unavailable') {
          return h('section', { style: STYLE.root }, h('p', { style: STYLE.warn }, label('statusUnavailable')))
        }

        const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
        const persisted = Array.isArray(value.rules) ? value.rules : []
        const rows = draft ?? persisted
        const writable = snapshot.writable !== false && snapshot.mode !== 'memory'

        const write = async (field, next, okKey) => {
          setBusy(true)
          setMessage(null)
          try {
            const ok = await form.set(field, next)
            setMessage(ok === false ? { kind: 'error', text: label('saveFailed') } : { kind: 'ok', text: label(okKey) })
          } catch (error) {
            setMessage({ kind: 'error', text: `${label('saveFailed')} ${String(error && error.message ? error.message : error)}` })
          } finally {
            setBusy(false)
          }
        }

        const updateRow = (index, patch) => {
          const next = rows.map((row, at) => (at === index ? { ...row, ...patch } : row))
          setDraft(next)
        }

        const toggleRow = (index, key) => event => updateRow(index, { [key]: event.target.value })

        /** Append one rule to the draft, creating the draft if needed. */
        const appendRule = rule => setDraft([...rows, rule])

        /** Append one preset; a path already present is not duplicated. */
        const appendPreset = preset => {
          if (rows.some(row => row.path === preset.path)) return
          setDraft([...rows, { path: preset.path, access: preset.access, note: '' }])
        }

        /** Ask the Host's directory picker and put the result in one row. */
        const browseInto = index => async () => {
          if (!picker.available) return
          try {
            const chosen = await picker.pick(new AbortController().signal)
            if (typeof chosen === 'string' && chosen !== '') updateRow(index, { path: chosen })
          } catch (error) {
            setMessage({ kind: 'error', text: String(error && error.message ? error.message : error) })
          }
        }

        const scalar = (field, key, options) => h('div', { key: field },
          h('div', { style: STYLE.row },
            h('label', { style: STYLE.rowLabel, htmlFor: `pg-${field}` }, label(key)),
            h('select', {
              id: `pg-${field}`,
              style: STYLE.select,
              value: String(value[field]),
              disabled: busy || !writable,
              onChange: event => void write(field, event.target.value, 'saved'),
            }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
          ),
          h('p', { style: STYLE.hint }, label(`${key}Hint`)),
        )

        const checkbox = (field, key) => h('div', { key: field },
          h('div', { style: STYLE.row },
            h('label', { style: { ...STYLE.rowLabel, display: 'flex', alignItems: 'center', gap: '6px' } },
              h('input', {
                type: 'checkbox',
                checked: value[field] !== false,
                disabled: busy || !writable,
                onChange: event => void write(field, event.target.checked, 'saved'),
              }),
              label(key),
            ),
          ),
          h('p', { style: STYLE.hint }, label(`${key}Hint`)),
        )

        return h('section', { style: STYLE.root, 'aria-label': label('title') },
          h('h2', { style: STYLE.title }, label('title')),
          h('p', { style: STYLE.intro }, label('intro')),
          !writable ? h('p', { style: STYLE.notice }, label('statusReadonly')) : null,

          h('div', { style: STYLE.group },
            h('h3', { style: STYLE.groupTitle }, label('master')),
            checkbox('enabled', 'master'),
            scalar('defaultAccess', 'defaultAccess', [
              { value: 'allow', label: label('defaultAllow') },
              ...LEVELS.map(level => ({ value: level, label: label(`access${level[0].toUpperCase()}${level.slice(1)}`) })),
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
            h('div', { style: { margin: '0 0 10px' } },
              h('button', {
                type: 'button',
                style: STYLE.link,
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
                    onChange: event => updateRow(index, { path: event.target.value }),
                  })),
                  h('td', { style: STYLE.td }, h('select', {
                    style: { ...STYLE.select, width: '100%' },
                    value: row.access ?? 'none',
                    'aria-label': label('colAccess'),
                    disabled: busy || !writable,
                    onChange: toggleRow(index, 'access'),
                  }, LEVELS.map(level => h('option', { key: level, value: level },
                    label(`access${level[0].toUpperCase()}${level.slice(1)}`))))),
                  h('td', { style: STYLE.td }, h('input', {
                    style: STYLE.input,
                    value: row.note ?? '',
                    'aria-label': label('colNote'),
                    disabled: busy || !writable,
                    onChange: event => updateRow(index, { note: event.target.value }),
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
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(L10N, { zh, en }), 'path-guard: locale')
        const t = ctx.locale.bind(L10N)

        // The Host's directory picker is an optional Remote: a deployment
        // without `@deepseek-ai/dsh-directory-picker-auto` simply gets no
        // "Browse…" button instead of a broken one.
        const picker = { available: false, pick: async () => null }
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
        // The same editor is registered in THREE places, because users look for
        // it in different ones and a missing page reads as "the plugin has no
        // settings at all":
        //   - `settings.section`      → its own nav entry in the Settings dialog
        //   - `plugins.row.config`    → the configure control on this bundle's
        //                               row in the Plugins page, keyed
        //                               `<package name>#<row id>`
        //   - `plugins.bundle.config` → the bundle card's own page, keyed by the
        //                               bundle package name
        ctx.effect(() => ctx.configForms.whileServed([NS], () => {
          const disposers = [
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: NS,
              order: 60,
              label: () => t('title'),
              locale: L10N,
            }, Section)),

            ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key: `${PKG}#${NS}`,
              locale: L10N,
            }, props => (props?.view === 'summary' ? t('configSummary') : h(Section, null)))),

            ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: PKG,
              locale: L10N,
            }, props => (props?.view === 'summary' ? null : h(Section, null)))),
          ]
          return () => { for (const dispose of disposers) dispose() }
        }), 'path-guard: settings pages')
      },
    }
  },
})
