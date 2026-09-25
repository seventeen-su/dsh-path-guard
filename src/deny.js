/**
 * Denial text.
 *
 * Whatever this module returns reaches the model verbatim: `tools/pre-execute`
 * denials are rendered as `Error: <reason>`
 * (packages/core/tools/src/index.ts:1526), and `ctx.tools.guard()` reasons take
 * the same path. The wording is therefore part of the product, not debug output.
 *
 * Per the user's decision the refusal is EXPLICIT: it says the user blocked
 * this path, names the rule, forbids bypass attempts, and points at the legal
 * route (ask the user to change the rule).
 *
 * @module dsh-path-guard/deny
 */

/** Human wording for each access level, used inside the denial text. */
const ACCESS_TEXT = {
  none: '完全禁止（不可见、不可读、不可写）',
  list: '仅允许查看文件名与目录结构，不允许读取内容',
  read: '允许读取，不允许写入或修改',
  write: '允许读取与写入',
}

/** The closing guidance shared by every denial. */
const NO_BYPASS = [
  '不要尝试绕过这个限制。以下做法都会同样被拒绝，并且会被记录：',
  '换用别的工具或别的参数名；改用相对路径、`..`、符号链接、短路径(8.3)或大小写变体；',
  '先把文件编码、压缩、分片或改名再读；通过 shell 命令、脚本或程序间接读取。',
  '',
  '如果任务确实需要访问这个路径，请向用户说明用途，请他在「设置 → 路径守卫」中调整规则。',
].join('\n')

/**
 * The refusal for a path-level policy violation.
 * @param {{toolName: string, shownPath: string, access: string, required: string,
 *          ruleId?: string, rulePath?: string}} input - the decision facts.
 * @returns {string} the model-facing reason.
 */
export function denialText({ toolName, shownPath, access, required, ruleId, rulePath }) {
  // `ruleId` is either a user-supplied id or the policy engine's synthesized
  // `#<index>` for an anonymous rule; only add a marker when it needs one.
  const id = ruleId === undefined || ruleId === ''
    ? ''
    : ` (${ruleId.startsWith('#') ? ruleId : `#${ruleId}`})`
  const rule = rulePath === undefined
    ? `默认档位 defaultAccess = ${access}`
    : `${rulePath}${id} → access: ${access}`
  return [
    '访问被拒绝：该路径由用户通过 dsh-path-guard 明确设置了访问限制。这不是系统错误，也不是权限不足。',
    '',
    `- 工具：${toolName}`,
    `- 路径：${shownPath}`,
    `- 生效规则：${rule}`,
    `- 该规则允许：${ACCESS_TEXT[access] ?? access}`,
    `- 本次调用需要：${required}`,
    '',
    NO_BYPASS,
  ].join('\n')
}

/**
 * The refusal for an opaque-program call (shell command or workflow script)
 * whose text references a protected path.
 * @param {{toolName: string, needle: string, rulePath?: string, access: string,
 *          kind?: 'shell'|'script'}} input - the match facts.
 * @returns {string} the model-facing reason.
 */
export function shellDenialText({ toolName, needle, rulePath, access, kind = 'shell' }) {
  const script = kind === 'script'
  return [
    `访问被拒绝：这${script ? '段脚本' : '条命令'}引用了用户通过 dsh-path-guard 保护的路径。这不是系统错误。`,
    '',
    `- 工具：${toolName}`,
    `- ${script ? '脚本' : '命令'}中出现：${needle}`,
    `- 命中规则：${rulePath ?? '(默认档位)'} → access: ${access}`,
    '',
    script
      ? 'workflow 脚本在独立上下文里运行，插件无法逐路径约束它，因此只做文本扫描；被扫描到的引用一律拒绝。'
      : 'shell 命令无法被可靠地逐路径约束，因此这里只做文本扫描，但被扫描到的引用一律拒绝。',
    '',
    NO_BYPASS,
  ].join('\n')
}

/**
 * The refusal for a surface the plugin cannot fence at all.
 * @param {{toolName: string}} input - the tool identity.
 * @returns {string} the model-facing reason.
 */
export function exoticDenialText({ toolName }) {
  return [
    `访问被拒绝：工具 \`${toolName}\` 可以绕过 dsh-path-guard 的路径限制，因此已被用户的配置禁用。`,
    '',
    '这类工具（MCP 服务、run_code、外部子代理循环）在独立进程或外部工具循环里访问文件系统，',
    '插件层无法观察也无法拦截其中的文件操作。',
    '',
    '如果确实需要它，请向用户说明用途，请他在「设置 → 路径守卫」中把 exoticTools 改成 allow。',
  ].join('\n')
}

/**
 * The refusal for a `plugin_manager` action that would change the profile
 * composition while self-protection is on.
 * @param {{action: string, target: string}} input - the attempted action.
 * @returns {string} the model-facing reason.
 */
export function selfDenialText({ action, target }) {
  return [
    '访问被拒绝：自我保护开启时，不允许修改 profile 的插件组合。',
    '',
    `- action：${action}`,
    `- target：${target}`,
    '',
    '原因是这类动作可能直接或间接停用 dsh-path-guard。`plugin_manager` 的参数里没有任何东西',
    '能可靠地证明「这次改动不会影响防护插件」——例如把本插件复制到别的路径再安装，target 字符串里',
    '不会出现它的名字，但副本会用同一个 row id 覆盖掉防护行。因此这里采取保守规则：',
    '**自我保护开启时，plugin_manager 只读**。',
    '',
    '读取类动作（list_plugins / list_bundles / list_version_exemptions）不受限制，仍然可用。',
    '如果确实需要让 AI 管理插件，请向用户说明用途，请他在「设置 → 路径守卫」里关闭自我保',
    '护；也可以由用户自己在前端操作。',
  ].join('\n')
}

/**
 * The refusal used when the plugin's own code failed.
 *
 * An exception thrown from `ctx.tools.guard()` or `tools/pre-execute` becomes a
 * tool failure, so an internal bug would otherwise take the whole tool surface
 * down with a stack trace the model cannot act on — or, if swallowed, silently
 * remove the protection the user asked for. Neither is acceptable for a
 * security control, so the plugin fails CLOSED and says exactly what happened.
 * @param {string} where - the extension point that failed.
 * @returns {string} the model-facing reason.
 */
export function internalErrorText(where) {
  return [
    `访问被拒绝：dsh-path-guard 在 ${where} 内部出错，无法判定这次调用是否安全。`,
    '',
    '这是本插件的缺陷，不是你的调用有问题。作为安全控件，它在无法判定时选择拒绝而不是放行（fail-closed）。',
    '',
    '请把这条信息告诉用户：他可以在「设置 → 路径守卫」里关闭本插件，或查看 DSH 日志中 path-guard 的 error 行。',
  ].join('\n')
}

/**
 * The refusal used when a search result had to be withheld because redaction
 * could not be applied safely (fail-closed).
 * @param {string} toolName - `glob` or `grep`.
 * @returns {string} the model-facing reason.
 */
export function redactionBlockedText(toolName) {
  return [
    `\`${toolName}\` 的结果已被整体扣留：dsh-path-guard 无法安全地确认其中是否包含受保护路径的内容。`,
    '',
    '这是刻意的失败关闭（fail-closed）行为——宁可少给结果，也不泄露受保护内容。',
    '请改用范围更明确、不含受保护路径的搜索（例如把 path 指向一个具体目录），或请用户调整规则。',
  ].join('\n')
}
