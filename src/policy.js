/**
 * dsh-path-guard — L0 纯策略引擎。
 *
 * 本模块是零依赖、无副作用的纯函数层：不读文件、不读环境变量、不依赖 Cordis。
 * 它只做一件事：把「路径模式 → 访问档位」的规则集合编译成可复用的匹配器，
 * 并对给定的绝对路径判定最具体的一条规则。
 *
 * 访问档位是累积的能力阶梯：
 *
 * | access | 列目录/看结构 | 读内容 | 写 |
 * |--------|--------------|--------|----|
 * | none   | ✗            | ✗      | ✗  |
 * | list   | ✓            | ✗      | ✗  |
 * | read   | ✓            | ✓      | ✗  |
 * | write  | ✓            | ✓      | ✓  |
 */

/**
 * 访问档位，从最严到最宽，顺序即能力包含关系。
 * @type {readonly ['none', 'list', 'read', 'write']}
 */
export const ACCESS_LEVELS = Object.freeze(['none', 'list', 'read', 'write']);

/** glob 通配符字符。 */
const WILDCARDS = '*?';

/** 只能在 match 期展开的 workspace 占位符。 */
const WORKSPACE_TOKEN = '${workspace}';

// ---------------------------------------------------------------------------
// 路径归一化（纯词法，跨平台，不触碰文件系统）
// ---------------------------------------------------------------------------

/**
 * 把 `\` 与 `/` 统一成 `/`，并折叠连续分隔符。
 * @param {string} value
 * @returns {string}
 */
function unifySlashes(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * 词法解析根前缀：`C:/`、`/` 或 ``（无根）。
 * @param {string} unified 已统一分隔符的路径
 * @returns {string}
 */
function rootPrefixOf(unified) {
  const drive = /^([A-Za-z]:)\//.exec(unified);
  if (drive) {
    return `${drive[1]}/`;
  }
  return unified.startsWith('/') ? '/' : '';
}

/**
 * 跨平台 dirname（不依赖 `node:path`，避免宿主平台影响结果）。
 * 根（`/`、`C:/`）的 dirname 是它自己。
 * @param {string} p 已归一化的路径
 * @returns {string}
 */
function dirnameOf(p) {
  if (p === '' || p === '/') {
    return p;
  }
  if (/^[A-Za-z]:\/$/.test(p)) {
    return p;
  }
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) {
    return '';
  }
  if (cut === 0) {
    return '/';
  }
  const head = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
}

/**
 * 归一化路径：统一分隔符、去掉 `.` 段、折叠多余分隔符、解析 `..`（不越过根）。
 * 不改变大小写；大小写折叠由调用方按 windows 标志决定。
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  const unified = unifySlashes(value);
  const prefix = rootPrefixOf(unified);
  /** @type {string[]} */
  const segments = [];
  for (const segment of unified.slice(prefix.length).split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // 已在根时吞掉 `..`，保证不越过根。
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return prefix + segments.join('/');
}

/**
 * 按 windows 标志折叠大小写。
 * @param {string} p
 * @param {boolean} windows
 * @returns {string}
 */
function foldCase(p, windows) {
  return windows ? p.toLowerCase() : p;
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/**
 * 单个字符的正则转义。
 * @param {string} ch
 * @returns {string}
 */
function escapeRegexChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * 把已归一化（分隔符全是 `/`）的 glob 模式编译成锚定正则。
 *
 * - `*`  匹配除 `/` 外的任意字符（0 个或多个）
 * - `**` 匹配任意字符（含 `/`）；`p/**` 额外允许匹配 `p` 自身
 * - `?`  匹配单个非 `/` 字符
 * - 其余字符字面量匹配
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; ) {
    const ch = glob[i];
    if (ch !== '*') {
      out += ch === '?' ? '[^/]' : escapeRegexChar(ch);
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < glob.length && glob[i + run] === '*') {
      run += 1;
    }
    i += run;

    if (run === 1) {
      // 单个 `*`：不跨分隔符。
      out += '[^/]*';
      continue;
    }

    // run >= 2 视为 globstar，并做「分隔符可选」处理，使
    // `a/**` 同时匹配 `a` 与 `a/x/y`，`a/**/b` 同时匹配 `a/b` 与 `a/x/b`。
    const nextSlash = glob[i] === '/';
    if (out === '') {
      if (nextSlash) {
        i += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
      continue;
    }
    if (out.endsWith('/')) {
      out = out.slice(0, -1);
      if (nextSlash) {
        i += 1;
        out += '(?:/.*)?/';
      } else {
        out += '(?:/.*)?';
      }
      continue;
    }
    if (nextSlash) {
      i += 1;
      out += '(?:/.*)?/';
      continue;
    }
    out += '.*';
  }
  return new RegExp(`^${out}$`);
}

/**
 * 模式中通配符出现次数（`*`、`**`、`?` 每个字符各计 1）。
 * @param {string} pattern
 * @returns {number}
 */
function countWildcards(pattern) {
  let count = 0;
  for (const ch of pattern) {
    if (WILDCARDS.includes(ch)) {
      count += 1;
    }
  }
  return count;
}

/**
 * 第一个通配符之前的字面量字符数（无通配符时为整串长度）。
 * @param {string} pattern
 * @returns {number}
 */
function literalPrefixLength(pattern) {
  const firstWildcard = [...pattern].findIndex((ch) => WILDCARDS.includes(ch));
  return firstWildcard < 0 ? pattern.length : firstWildcard;
}

/**
 * 解析模式：把 `${workspace}` 之前的部分与之后的后缀分开。
 * `${workspace}` 出现多次时，只有第一次之前的部分能在 compile 期确定。
 *
 * 不含 `${workspace}` 时整体作为 `prefix` 返回（通配符保持原样，由 expandPath 直通）。
 *
 * @param {string} pattern 原始模板
 * @returns {{prefix: string, suffix: string}}
 */
function parsePattern(pattern) {
  const tokenAt = pattern.indexOf(WORKSPACE_TOKEN);
  if (tokenAt < 0) {
    return { prefix: pattern, suffix: '' };
  }
  const firstWildcard = [...pattern].findIndex((ch) => WILDCARDS.includes(ch));
  const cut = firstWildcard < 0 ? tokenAt : Math.min(firstWildcard, tokenAt);
  return {
    prefix: pattern.slice(0, cut),
    suffix: pattern.slice(cut + WORKSPACE_TOKEN.length),
  };
}

/**
 * 从**归一化后的有效模式**计算具体性指标。
 *
 * 指标必须取自归一化结果而不是原始模板：否则 `D:/dup/` 与 `D:/dup` 归一化后
 * 明明是同一个模式，却会因为原始模板长度不同而得到不同的具体性，破坏
 * 「下标降序（last-wins）」这个最终裁决键。
 *
 * `${workspace}` 视为一个通配符位置（字面量前缀到此为止），但它本身
 * 不计入通配符数量——它是展开点，不是通配符。
 *
 * @param {string} normalized 归一化后的模式（可能仍含 `${workspace}`）
 * @param {boolean} needsWorkspace
 * @returns {{prefixLength: number, wildcards: number}}
 */
function patternMetrics(normalized, needsWorkspace) {
  if (!needsWorkspace) {
    return { prefixLength: literalPrefixLength(normalized), wildcards: countWildcards(normalized) };
  }
  return {
    prefixLength: literalPrefixLength(normalized.split(WORKSPACE_TOKEN).join('*')),
    wildcards: countWildcards(normalized.split(WORKSPACE_TOKEN).join('')),
  };
}

// ---------------------------------------------------------------------------
// expandPath
// ---------------------------------------------------------------------------

/**
 * 词法展开路径模板并归一化。纯函数：不读环境变量、不访问文件系统。
 *
 * - `~` 或 `~/...` → `ctx.home`；home 缺省时保留原样（不猜、不抛错）
 * - `${workspace}` → `ctx.workspace`；workspace 缺省时保留占位符
 * - 绝对路径（`/x`、`D:/x`、`D:\x`）→ 原样（仅归一化）
 * - 其它（相对路径）→ 挂在 `ctx.workspace` 下；workspace 缺省时原样归一化返回
 *
 * 返回值仍可能包含未展开的 `~` / `${workspace}`，这是刻意的：
 * 调用方据此判断该模板此刻是否可用。
 *
 * @param {string} template 规则里的路径模板
 * @param {{home?: string, workspace?: string}} [ctx] 展开上下文
 * @returns {string} 归一化后的路径
 */
export function expandPath(template, ctx) {
  const home = ctx && typeof ctx.home === 'string' && ctx.home !== '' ? ctx.home : undefined;
  const workspace =
    ctx && typeof ctx.workspace === 'string' && ctx.workspace !== '' ? ctx.workspace : undefined;
  let value = template == null ? '' : String(template);

  // `~` 只在路径开头（或独立出现）时才是 home 简写。
  if (home !== undefined && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) {
    value = home + value.slice(1);
  }
  if (workspace !== undefined) {
    value = value.split(WORKSPACE_TOKEN).join(workspace);
  }
  if (value === '') {
    return '';
  }

  const unified = unifySlashes(value);
  if (rootPrefixOf(unified) === '') {
    if (workspace === undefined) {
      return normalize(unified);
    }
    return normalize(`${unifySlashes(workspace)}/${unified}`);
  }
  return normalize(unified);
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

/**
 * 编译规则表。非法规则不抛出，收集进 `invalid` 并跳过：
 * 空/空白 path、access 不在 ACCESS_LEVELS 内、展开后无法构成可用模式。
 *
 * 归一化去重：展开后模式 + access + workspace 后缀完全相同的规则只保留最后一条
 * （不影响语义，只是省内存）。
 *
 * @param {{rules?: Array<{id?: string, path?: string, access?: string, note?: string}>, home?: string, windows?: boolean}} [input]
 * @returns {{
 *   rules: CompiledRule[],
 *   isEmpty: boolean,
 *   invalid: Array<{index: number, path: string, reason: string}>
 * }}
 */
export function compile(input) {
  const source = input && typeof input === 'object' ? input : {};
  const rawRules = Array.isArray(source.rules) ? source.rules : [];
  const home = typeof source.home === 'string' && source.home !== '' ? source.home : undefined;
  const windows = source.windows === true;

  /** @type {CompiledRule[]} */
  const compiledRules = [];
  /** @type {Array<{index: number, path: string, reason: string}>} */
  const invalid = [];
  /** @type {Map<string, number>} */
  const dedupe = new Map();

  for (let index = 0; index < rawRules.length; index += 1) {
    const raw = rawRules[index];
    if (raw == null || typeof raw !== 'object') {
      invalid.push({ index, path: '', reason: 'rule is not an object' });
      continue;
    }
    const rawPath = typeof raw.path === 'string' ? raw.path : '';
    if (rawPath.trim() === '') {
      invalid.push({ index, path: rawPath, reason: 'path is empty' });
      continue;
    }
    const access = typeof raw.access === 'string' ? raw.access : '';
    if (!ACCESS_LEVELS.includes(access)) {
      invalid.push({ index, path: rawPath, reason: `unknown access level: ${access}` });
      continue;
    }

    const parsed = parsePattern(rawPath);

    // compile 期只能展开 `${workspace}` 之前的部分；`~`（在有 home 时）可以立即展开。
    const head = expandPath(parsed.prefix, { home });
    const absoluteHead =
      head === '' || head.startsWith('/') || /^[A-Za-z]:\//.test(head) || head.startsWith('~');

    // 相对路径按规格「视为相对于 workspace」：用 `${workspace}/` 前缀改写，
    // 于是它与显式 `${workspace}` 规则走同一条 match 期展开路径。
    // workspace 缺省时该规则自然不生效，不需要在 compile 期拒绝。
    const needsWorkspace = rawPath.includes(WORKSPACE_TOKEN) || !absoluteHead;
    const suffix = unifySlashes(parsed.suffix);
    let patternWithToken;
    if (!needsWorkspace) {
      patternWithToken = head;
    } else if (absoluteHead) {
      // `D:/x/${workspace}/y`：前缀在 compile 期已确定。
      patternWithToken = `${head}${WORKSPACE_TOKEN}${suffix}`;
    } else {
      // `src/**`：整体挂在 workspace 下。
      patternWithToken = `${WORKSPACE_TOKEN}/${head}${suffix}`;
    }

    const normalized = foldCase(normalize(patternWithToken), windows);
    if (normalized === '' || normalized === '/') {
      invalid.push({ index, path: rawPath, reason: 'path does not resolve to a usable pattern' });
      continue;
    }
    const metrics = patternMetrics(normalized, needsWorkspace);

    /** @type {CompiledRule} */
    const rule = {
      index,
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `#${index}`,
      pattern: rawPath,
      access,
      note: typeof raw.note === 'string' ? raw.note : undefined,
      normalized,
      prefixLength: metrics.prefixLength,
      wildcards: metrics.wildcards,
      needsWorkspace,
      windows,
    };

    // 去重键必须带 needsWorkspace：`~/.ssh` 与 `${workspace}/.ssh` 在缺 home 时
    // 归一化结果可能相同，但可用性完全不同，绝不能合并。
    const key = `${rule.normalized}\u0000${access}\u0000${needsWorkspace ? 'w' : 's'}`;
    const previous = dedupe.get(key);
    if (previous === undefined) {
      dedupe.set(key, compiledRules.length);
      compiledRules.push(rule);
    } else {
      compiledRules[previous] = rule; // 保留最后一条
    }
  }

  return { rules: compiledRules, isEmpty: compiledRules.length === 0, invalid };
}

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

/**
 * 判定绝对路径命中的最优规则。
 *
 * 算法：
 * 1. 生成 P 的祖先链：P, dirname(P), dirname(dirname(P)), … 直到根；
 * 2. 对每条规则，若它匹配祖先链中任意一项则命中，记录**最深的**那个匹配祖先；
 * 3. 在命中规则中选最具体的一条，排序键依次为
 *    命中祖先长度降序 → 字面量前缀长度降序 → 通配符数量升序 → 下标降序（last-wins）。
 *
 * 无规则命中时返回 `undefined`，由调用方套用 defaultAccess。
 *
 * @param {CompiledRule[]} compiled `compile()` 的产物
 * @param {string} absolutePath 待判定的绝对路径
 * @param {{workspace?: string}} [opts] 仅在此处可用 workspace 展开 `${workspace}` 规则
 * @returns {{access: string, ruleId: string, pattern: string} | undefined}
 */
export function match(compiled, absolutePath, opts) {
  if (!Array.isArray(compiled) || compiled.length === 0) {
    return undefined;
  }
  if (typeof absolutePath !== 'string' || absolutePath.trim() === '') {
    return undefined;
  }
  const workspace =
    opts && typeof opts.workspace === 'string' && opts.workspace !== '' ? opts.workspace : undefined;

  /** @type {Array<{rule: CompiledRule, ancestorLength: number}>} */
  const hits = [];

  for (const rule of compiled) {
    if (rule == null || typeof rule !== 'object') {
      continue;
    }

    let regex;
    if (rule.needsWorkspace) {
      // workspace 缺省 → 该条规则不生效（绝不当成空字符串去匹配）。
      if (workspace === undefined) {
        continue;
      }
      const expanded = spliceWorkspace(rule.normalized, workspace);
      regex = globToRegExp(foldCase(normalize(expanded), rule.windows));
    } else {
      regex = globToRegExp(rule.normalized);
    }

    const candidate = foldCase(normalizeString(absolutePath), rule.windows);

    let ancestor = candidate;
    for (;;) {
      if (regex.test(ancestor)) {
        hits.push({ rule, ancestorLength: ancestor.length });
        break;
      }
      const parent = dirnameOf(ancestor);
      if (parent === ancestor || parent === '') {
        break;
      }
      ancestor = parent;
    }
  }

  if (hits.length === 0) {
    return undefined;
  }

  let best = hits[0];
  for (let i = 1; i < hits.length; i += 1) {
    if (compareHits(hits[i], best) < 0) {
      best = hits[i];
    }
  }
  return { access: best.rule.access, ruleId: best.rule.id, pattern: best.rule.pattern };
}

/**
 * 归一化待判定路径（去尾分隔符，避免 `D:/x/` 产生多余祖先）。
 * @param {string} value
 * @returns {string}
 */
function normalizeString(value) {
  const stripped = String(value).replace(/[\\/]+$/, '');
  return stripped === '' ? '/' : normalize(stripped);
}

/**
 * 在 match 期把 `${workspace}` 拼接进模式。
 *
 * 关键：`${workspace}` 在模式里是一个**路径分量**，不是纯文本。
 * `D:/proj/${workspace}/src` 在 workspace=`w1` 时必须展开成 `D:/proj/w1/src`，
 * 而不是 `D:/projw1/src`。所以按分量拼接并吸收两侧多余的分隔符。
 *
 * @param {string} normalized compile 期归一化后仍含 `${workspace}` 的模式
 * @param {string} workspace
 * @returns {string} 已归一化的完整模式
 */
function spliceWorkspace(normalized, workspace) {
  const value = normalize(String(workspace).replace(/\\/g, '/').replace(/\/+$/, ''));
  const parts = normalized.split(WORKSPACE_TOKEN);
  if (parts.length === 1) {
    return normalized;
  }
  const [head, ...tail] = parts;
  const left = head.replace(/\/+$/, '');
  const right = tail.join(WORKSPACE_TOKEN).replace(/^\/+/, '');
  let joined;
  if (left === '') {
    joined = right === '' ? value : `${value}/${right}`;
  } else if (right === '') {
    joined = `${left}/${value}`;
  } else {
    joined = `${left}/${value}/${right}`;
  }
  return normalize(joined);
}

/**
 * 具体性比较：返回值 < 0 表示 a 比 b 更具体（a 应胜出）。
 * @param {{rule: CompiledRule, ancestorLength: number}} a
 * @param {{rule: CompiledRule, ancestorLength: number}} b
 * @returns {number}
 */
function compareHits(a, b) {
  if (a.ancestorLength !== b.ancestorLength) {
    return b.ancestorLength - a.ancestorLength;
  }
  if (a.rule.prefixLength !== b.rule.prefixLength) {
    return b.rule.prefixLength - a.rule.prefixLength;
  }
  if (a.rule.wildcards !== b.rule.wildcards) {
    return a.rule.wildcards - b.rule.wildcards;
  }
  if (a.rule.index !== b.rule.index) {
    return b.rule.index - a.rule.index;
  }
  // 兜底：保证同一输入在任何引擎版本下结果一致。
  if (a.rule.normalized.length !== b.rule.normalized.length) {
    return b.rule.normalized.length - a.rule.normalized.length;
  }
  if (a.rule.normalized === b.rule.normalized) {
    return 0;
  }
  return a.rule.normalized < b.rule.normalized ? -1 : 1;
}

// ---------------------------------------------------------------------------
// capabilities / contains
// ---------------------------------------------------------------------------

/**
 * 把访问档位映射成能力位。未知档位一律按最严（全 false）处理。
 * @param {string} access
 * @returns {{list: boolean, read: boolean, write: boolean}}
 */
export function capabilities(access) {
  switch (access) {
    case 'list':
      return { list: true, read: false, write: false };
    case 'read':
      return { list: true, read: true, write: false };
    case 'write':
      return { list: true, read: true, write: true };
    default:
      return { list: false, read: false, write: false };
  }
}

/**
 * 词法判定 `root` 是否为 `candidate` 的祖先或本身。
 * 用于无法（或不应）做文件系统 resolve 时的兜底判断。
 *
 * @param {string} root
 * @param {string} candidate
 * @param {boolean} [windows] true 时按 Windows 语义折叠大小写
 * @returns {boolean}
 */
export function contains(root, candidate, windows) {
  const fold = windows === true;
  const r = foldCase(normalizeString(String(root ?? '')), fold);
  const c = foldCase(normalizeString(String(candidate ?? '')), fold);
  if (r === '' || r === '/') {
    return false;
  }
  if (r === c) {
    return true;
  }

  const rootPrefix = rootPrefixOf(r);
  const candidatePrefix = rootPrefixOf(c);
  if (rootPrefix === '/') {
    return candidatePrefix === '/' && c.startsWith(r.endsWith('/') ? r : `${r}/`);
  }
  if (/^[A-Za-z]:\/$/.test(rootPrefix)) {
    return candidatePrefix === rootPrefix && c.startsWith(r.endsWith('/') ? r : `${r}/`);
  }
  return c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * @typedef {object} CompiledRule
 * @property {number} index 规则在原始数组中的下标
 * @property {string} id 规则 id（缺省为 `#<index>`）
 * @property {string} pattern 原始路径模板（用于回报给调用方）
 * @property {string} access 访问档位
 * @property {string | undefined} note 备注
 * @property {string} normalized compile 期归一化后的模式，可能仍含 `${workspace}`
 * @property {number} prefixLength 字面量前缀长度（第一个通配符之前）
 * @property {number} wildcards 通配符数量
 * @property {boolean} needsWorkspace 是否必须在 match 期用 workspace 展开
 * @property {boolean} windows 该规则是否按 Windows 大小写不敏感语义比较
 */
