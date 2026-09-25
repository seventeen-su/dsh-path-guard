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
      exoticHint: 'MCP 服务、run_code、外部子代理循环在独立进程里访问文件系统，插件层无法观察。',
      exoticDeny: '直接拒绝（默认）',
      exoticAllow: '放行（接受漏洞）',
      selfProtection: '自我保护',
      selfProtectionHint: '禁止 AI 改写本插件所在的 profile 组合文件，也禁止它用 plugin_manager 关闭本插件。',
      rules: '路径规则',
      rulesHint: '更具体的路径覆盖更宽泛的路径，所以「豁免」就是再加一条更具体的规则。',
      colPath: '路径',
      colAccess: '访问档位',
      colNote: '备注',
      colActions: '操作',
      addRule: '添加规则',
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
      exoticHint: 'MCP servers, run_code and foreign subagent loops touch the filesystem in their own process; a plugin cannot observe them.',
      exoticDeny: 'Deny (default)',
      exoticAllow: 'Allow (accept the hole)',
      selfProtection: 'Self-protection',
      selfProtectionHint: 'Stop the AI from rewriting this profile composition or disabling this plugin through plugin_manager.',
      rules: 'Path rules',
      rulesHint: 'A more specific path overrides a broader one, so an exemption is just a more specific rule.',
      colPath: 'Path',
      colAccess: 'Access',
      colNote: 'Note',
      colActions: 'Actions',
      addRule: 'Add rule',
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
    }

    /** Access levels in ladder order, weakest first. */
    const LEVELS = ['none', 'list', 'read', 'write']

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
      footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' },
    }

    /**
     * Build the settings section component around one bound config form.
     * @param {object} ctx - the client plugin context.
     * @param {(key: string) => string} t - locale lookup.
     * @returns {Function} the React component.
     */
    function createSection(ctx, t) {
      const form = ctx.configForms.get(NS)
      const subscribe = listener => form.subscribe(listener)
      const getSnapshot = () => form.getSnapshot()
      const label = key => t(key)

      function PathGuardSection() {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
        const [draft, setDraft] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState(null)

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
            rows.length === 0
              ? h('p', { style: STYLE.hint }, label('empty'))
              : h('table', { style: STYLE.table },
                h('thead', null, h('tr', null,
                  h('th', { style: { ...STYLE.th, width: '34%' } }, label('colPath')),
                  h('th', { style: { ...STYLE.th, width: '38%' } }, label('colAccess')),
                  h('th', { style: STYLE.th }, label('colNote')),
                  h('th', { style: { ...STYLE.th, width: '56px' } }, label('colActions')),
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
                  h('td', { style: STYLE.td }, h('button', {
                    type: 'button',
                    style: STYLE.button,
                    disabled: busy || !writable,
                    onClick: () => setDraft(rows.filter((_row, at) => at !== index)),
                  }, label('remove'))),
                ))),
              ),
            h('div', { style: STYLE.footer },
              h('button', {
                type: 'button',
                style: STYLE.button,
                disabled: busy || !writable,
                onClick: () => setDraft([...rows, { path: '', access: 'none', note: '' }]),
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
        const Section = createSection(ctx, t)

        // Register only while the Host actually serves the namespace, so a
        // profile without this bundle's row shows no trace of the page.
        ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: NS,
            order: 60,
            label: () => t('title'),
            locale: L10N,
          }, Section))), 'path-guard: settings page')
      },
    }
  },
})
