/**
 * dsh-path-guard — L0 纯策略引擎。
 *
 * 本模块是零依赖、无副作用的纯函数层：不读文件、不读环境变量、不依赖 Cordis。
 * 它只做两件事：把「路径模式 → 访问档位」的规则集合编译成可复用的匹配器，
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
 *
 * ## 1. 路径身份模型（docs/ARCHITECTURE.md §3.3）
 *
 * 每条路径先被解析成一个**身份键**：`(namespace, key)`。namespace 的取值见
 * `NAMESPACES`，`key` 是归一化后的字符串（分隔符统一 `/`）。规则与候选路径都
 * 先转成身份键再比较，所以「同一资源的不同拼写」才会相等，而「不同资源的相同
 * 后缀」绝不会碰撞。
 *
 * **平台无关**：模型由字符串自身的语法决定，不依赖宿主平台。`\\srv\share\x` 与
 * `//srv/share/x` 在 Windows 和 Linux 上都是同一个 UNC 身份；`/srv/share/x`
 * 永远是 POSIX 身份，与前者不相等（这正是旧实现把 UNC 折成 `/srv/share/x`
 * 之后与 POSIX 路径碰撞的那个 bug）。
 *
 * 归一化规则（每条都对应 Windows 上可复现的行为；证据来自 `GetFullPathNameW`
 * 与 `/` 的 .NET `Path.GetFullPath`，两者是同一套 Win32 词法规则）：
 *
 * | 输入 | 身份键 | 依据 |
 * |------|--------|------|
 * | `C:\x`            | `C:/x`            | 盘符绝对路径 |
 * | `\\srv\share\x`   | `//srv/share/x`   | UNC（DOS 设备路径） |
 * | `//srv/share/x`   | `//srv/share/x`   | 同一身份的另一种拼写 |
 * | `\\?\C:\x`        | `C:/x`            | 扩展长度前缀剥离后指向同一对象 |
 * | `\\?\UNC\srv\share\x` | `//srv/share/x` | 同上 |
 * | `\\?\Volume{g}\x` | `//?/Volume{g}/x` | 卷 GUID 无法词法映射到盘符，保留独立命名空间 |
 * | `\\.\C:\x`        | `//./C:/x`        | 设备命名空间，绝不与普通路径混同 |
 * | `C:\x.` / `C:\x ` | `C:/x`            | 末段尾部点/空格被 Win32 词法层剥掉 |
 * | `C:\x.\y`         | `C:/x/y`          | 中间段只剥尾部点（空格保留，见下） |
 * | `C:\x .\y`        | `C:/x /y`         | 中间段的尾部空格**不**剥 |
 * | `C:\f.txt:s`      | `C:/f.txt`        | ADS：流名属于同一资源（决定见下） |
 * | `/x.`             | `/x.`             | POSIX 文件名可以以点/空格结尾，不折叠 |
 * | `/f.txt:s`        | `/f.txt:s`        | POSIX 上 `:` 是普通文件名字符，不折叠 |
 *
 * ### 无法在纯字符串层解决的问题（刻意不假装能处理）
 *
 * 下面这些做不到，也**不应该**由本层做；它们由 `ctx.fs.resolve()` 的规范化
 * pass（`packages/fs/fs-local/src/fsio.ts` 的 `localDisplayPath` + `realpath`）
 * 负责。本层只保证「不因为不知道而放宽」：词法上不可判定的输入一律 fail-safe。
 *
 * - **8.3 短名 / 长名别名**（`C:\PROGRA~1\x` 与 `C:\Program Files\x`）：纯词法层
 *   无法展开，实测 `fs.realpathSync('C:\\Users\\SUSEVE~1')` 连大小写都不改写，
 *   所以只有文件系统身份（dev+ino 或 realpath）能识别。DSH 自己在
 *   `packages/fs/fs-sandbox/src/containment.ts:46-76` 就是用
 *   「词法快路径 + `stat` 的 dev/ino 兜底」处理这类别名的。
 * - **junction / symlink / mount point**：同上，必须 realpath。
 * - **ADS 的真实身份**：本层把流名折叠进宿主文件（见下），但 `realpath` 会把
 *   `f.txt:s` 原样带回（实测），所以最终身份以 canonical target 为准。
 * - **`C:foo`（驱动器相对）**：需要「该盘符的当前目录」，本层没有这个上下文，
 *   因此判为**不可判定**并 fail-safe（见 `resolveIdentity` 的 JSDoc）。
 * - **`\\?\` 前缀禁用 Win32 归一化的语义**：`\\?\C:\x.` 在 NT 层是另一个名字，
 *   但本层为了满足「`\\?\C:\x` 与 `C:\x` 同一身份」会把它一并折叠到 `C:/x`。
 *   这是**刻意的过度折叠**，方向是 fail-safe（deny 规则覆盖更多拼写）；
 *   真实身份仍由 canonical target 决定。
 *
 * ### 两个语义决定
 *
 * **`C:foo` → 不可判定 + fail-safe。** `C:foo` 是「C 盘当前目录下的 foo」，
 * 与 `C:\foo`、与相对路径都不是一回事。实测：`process.chdir('C:\\Windows')`
 * 之后 `fs.existsSync('C:System32')` 为 true（走的是每个盘符各自的当前目录），
 * 而 `path.win32.resolve('C:foo')` 在 cwd 位于 D: 时返回 `C:\foo` —— Node
 * 只能**猜**盘符根。也就是说「策略层看到的路径」和「OS 实际打开的文件」可能
 * 不是同一个，这正是 check-then-use 的来源。本层不复制这个猜测：
 * `compile()` 把这类规则收进 `invalid`，`match()` 对这类候选路径直接返回
 * fail-safe 的拒绝决定（`access: 'none'`，`ruleId: UNDECIDABLE_RULE_ID`）。
 *
 * **ADS（`f.txt:stream`）→ 同一资源。** 流物理上存在于同一个文件里，共享
 * 同一份 ACL、同一个目录项、同一套 rename/delete 生命周期。若把它当成另一个
 * 资源，规则写 `C:/secrets/token.txt` 时模型只需读 `C:/secrets/token.txt:$DATA`
 * 就能绕过——这是教科书式的 capability 旁路。所以本层在**比较时**把最后一个
 * 路径分量里第一个 `:` 之后的流名去掉，让流继承宿主文件的档位（对 deny 规则
 * 是收紧，对 allow 规则是「同一文件内的数据流」这一既有授权范围的延伸）。
 * 注意：(a) 只作用于 Windows 命名空间，POSIX 上 `:` 是普通字符；
 * (b) 只作用于最后一个分量（`C:/a:b/c` 里非末段的 `:` 不被折叠，保持独立身份）；
 * (c) 回传给调用方的 `pattern` 永远是用户写的原文，不做改写。
 *
 * ### 大小写折叠
 *
 * `windows` 标志**只**控制比较时是否把身份键统一小写（`foldCase`）。它不改写
 * 用户可见的路径：`CompiledRule.pattern`、`match()` 返回的 `pattern`、
 * `expandPath()` 的返回值都保留原始大小写。判定结果里报告的路径应当是调用方
 * 自己能 `fs.resolve()` 的那个拼写，而不是被策略层改写过的拼写。
 *
 * 另一处刻意的过度近似：POSIX 上 `\` 是合法文件名字符（DSH 自己也有测试
 * `packages/fs/tool-fs-search/tests/tools.spec.ts:719` 记录了这一点），但为了
 * 兼容跨平台配置，本层在**所有**命名空间里都把 `\` 当作分隔符折叠。后果是
 * POSIX 上名为 `a\b` 的文件会被 `/a/b` 的**允许**规则误覆盖（deny 规则则是
 * 误收紧，方向安全）。这是既有语义，本次不做改变，只在此记录。
 *
 * ## 2. 预编译匹配器（docs/ARCHITECTURE.md §3.4）
 *
 * `compile()` 一次性为每条规则构建：身份键、具体性指标（`prefixLength` /
 * `wildcards`）、以及**已编译的匹配物**——
 * - 不含 `${workspace}` 且无通配符：`literal`（一次 `startsWith` 判定，不建 regex）；
 * - 不含 `${workspace}` 但有通配符：`regex`（compile 期构建一次，绝不在 match 期重建）；
 * - 含 `${workspace}`：match 期按 workspace 展开，结果按 workspace 缓存
 *   （`WORKSPACE_CACHE`，同一条规则同一个 workspace 只编译一次）。
 *
 * `match()` 因此只做查表 + 匹配：候选路径的身份键与祖先链每次调用只算一次
 * （按 `windows` 标志做至多两个变体），规则循环里没有字符串归一化、没有
 * `RegExp` 构造。判定结果与旧的「每条规则 × 每个祖先重建 regex」实现逐项一致
 * （见 `tests/policy.spec.js` 的 200 规则 × 1000 路径对照测试）。
 *
 * ## 3. 按文件名匹配的规则（`name:`）
 *
 * 路径规则表达「某个位置及其后代」，`name:` 规则表达「**任何位置**下叫这个名字的
 * 资源」。语法是规则 `path` 以 `name:` 开头，其余部分是**单个路径分量**的模式：
 *
 * ```yaml
 * rules:
 *   - path: D:/secrets        # 目录整体禁止
 *     access: none
 *   - path: name:readme.md    # 但任何位置下的 readme.md 可读（含上面那个目录里）
 *     access: read
 * ```
 *
 * 语义边界（每条都有测试）：
 * - **只匹配候选资源自身，不匹配它的祖先**：`name:readme.md` 不会因为某个*目录*
 *   叫 `readme.md` 就把整棵子树放行。本层是纯词法的、分不出文件与目录，所以更
 *   不能靠名字去猜子树。
 * - **跨命名空间生效**：POSIX、盘符、UNC、设备路径下同名的资源都命中——这正是
 *   「任何位置」的含义。
 * - **模式是单分量 glob**：`name:*.md`、`name:README?` 可用；出现 `/`、`\`
 *   则判为非法（那是路径规则的事）；`.` / `..` / 全空白也非法。
 * - **模式内不做展开**：`~` 与 `${workspace}` 在名称模式里是普通文件名字符。
 * - **大小写**：与路径规则共用同一套比较期折叠（`foldCase`）。`windows: true`
 *   （Windows 宿主）时 `readme.md` / `Readme.MD` / `README.md` 等价；POSIX 宿主
 *   上保持大小写敏感——在大小写敏感的盘上它们是**不同文件**，折叠等于放行另一个
 *   文件。这是「大小写智能匹配」的边界，不是遗漏（见测试 19c）。
 *
 * ### `name:` 规则在具体性排序里怎么参与
 *
 * `match()` 的四个裁决键对两类规则是统一的，只是取值来源不同：
 *
 * | 键 | 路径规则 | `name:` 规则 |
 * |----|----------|--------------|
 * | 1 命中深度（越长越具体） | 命中的那个祖先的长度 | **候选路径自身的长度** |
 * | 2 字面量前缀长度（越长越具体） | 路径模式第一个通配符之前 | 名称模式第一个通配符之前 |
 * | 3 通配符数量（越少越具体） | 路径模式 | 名称模式 |
 * | 4 规则下标（越大越优先） | 同左 | 同左 |
 *
 * 第 1 键是关键：名称规则约束的是「就是这个资源」，而不是「某个祖先之下」，所以
 * 命中深度记为候选自身。由此得到三条可预期的性质（测试 20/20b/20c）：
 *
 * 1. **名称规则胜过任何只命中祖先的路径规则**——父目录整体 `none` 也能被逐名豁免，
 *    这就是用户要的主用例。
 * 2. **与候选完全同路径的规则仍然最具体**：`D:/secrets/readme.md → none` 与
 *    `name:readme.md → read` 在第 1 键打平，前者靠第 2 键（字面量前缀是整个路径，
 *    必然长于 basename）胜出。
 * 3. **名称模式内部的 specificity 照常生效**：`name:readme.md`（前缀 9、通配符 0）
 *    胜过 `name:*.md`（前缀 0、通配符 1），靠的是第 2/3 键。
 *
 * 名称规则是**全局**的：它在所有目录生效，包括被更严规则覆盖的目录。若不希望某个
 * 目录被豁免，用一条与该候选同路径的规则压过它（性质 2）。
 *
 * > 给配置页/文档的措辞：**「按文件名豁免（任何位置）：填写 `name:文件名`，
 * > 例如 `name:readme.md`；支持 `*`、`?` 通配符，不要写路径。大小写按当前平台的
 * > 比较语义处理（Windows 下不区分）。」**
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

/**
 * 文件名规则的显式前缀：`name:readme.md` = 「任何位置下名为 readme.md 的资源」。
 * 只有出现在模式**开头**时才是名称规则；它是保留前缀，因此不存在「文件名恰好
 * 叫 `name:...`」的路径规则写法（那种写法过去只会匹配到一个字面量文件名，
 * 实际配置里不可能出现）。
 */
const NAME_PREFIX = 'name:';

/** CompiledRule.kind 的取值。 */
const RULE_KIND = Object.freeze({ PATH: 'path', NAME: 'name' });

/**
 * 不可判定路径的 fail-safe 决定所用的伪规则 id。
 * 调用方只会看到 `access: 'none'`，不会看到任何用户规则被误用。
 */
const UNDECIDABLE_RULE_ID = '<undecidable>';

/**
 * 路径身份的命名空间标签。
 * @type {Readonly<{POSIX: 'posix', DRIVE: 'drive', UNC: 'unc', DEVICE: 'device', EXTENDED: 'extended'}>}
 */
const NAMESPACES = Object.freeze({
  POSIX: 'posix',
  DRIVE: 'drive',
  UNC: 'unc',
  DEVICE: 'device',
  EXTENDED: 'extended',
});

// ---------------------------------------------------------------------------
// 路径身份：解析与归一化
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PathIdentity
 * @property {true} ok 恒为 true（不可判定用 `{ok: false, reason}` 表达）
 * @property {'posix'|'drive'|'unc'|'device'|'extended'} namespace 命名空间
 * @property {string} key 归一化后的身份键（分隔符统一为 `/`）
 * @property {boolean} relative 是否为无根相对路径（只有 posix 命名空间可能为 true）
 */

/**
 * @typedef {object} UndecidablePath
 * @property {false} ok
 * @property {string} reason 面向用户的、可操作的原因（会进 `compile().invalid`）
 */

/**
 * 只折叠分隔符，用于拼接 suffix 这类局部文本。
 * **不要**用它处理完整路径：它会把 UNC 的前导 `//` 折成 `/`。
 * @param {string} value
 * @returns {string}
 */
function unifySlashes(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * 去掉 ADS 流名：末段里第一个 `:` 之后的部分属于流，不属于资源身份。
 * @param {string} segment
 * @returns {string}
 */
function stripStream(segment) {
  const at = segment.indexOf(':');
  return at < 0 ? segment : segment.slice(0, at);
}

/**
 * Windows 词法归一化：处理 `.` / `..`、末段尾部点/空格、ADS。
 *
 * 证据（`GetFullPathNameW`，经 .NET `Path.GetFullPath` 实测）：
 * - `x.\y.txt`   → `x\y.txt`   中间段剥尾部**点**
 * - `x .\y.txt`  → `x \y.txt`  中间段的尾部**空格保留**
 * - `x. .\y`     → `x. \y`     中间段只剥点，剥到空格为止
 * - `x\y.txt. `  → `x\y.txt`   末段点与空格都剥
 * - `x. .`       → `x`         末段把尾部「点/空格」连续段一起剥掉
 * - `...\y`      → `...\y`     中间的全点段不折叠（剥空则保留原样）
 * - `...`        → 父目录       末段剥空则整个分量消失
 *
 * @param {string} rest 已经去掉命名空间前缀的路径文本
 * @param {{final: boolean, ads: boolean}} opts `final` 为 false 时表示这是完整模式的
 *   前缀（后面还跟着 `${workspace}` 或通配符），此时**不**套用末段规则
 * @returns {string[]} 归一化后的分量（相对该命名空间的根）
 */
function windowsParts(rest, opts) {
  const components = String(rest).split(/[\\/]+/u).filter((segment) => segment !== '');
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < components.length; i += 1) {
    const isLast = opts.final === true && i === components.length - 1;
    let segment = components[i];
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      // 已在根时吞掉 `..`，不越过命名空间根。
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      }
      continue;
    }
    if (isLast && opts.ads === true) {
      segment = stripStream(segment);
    }
    const trimmed = isLast ? segment.replace(/[. ]+$/u, '') : segment.replace(/\.+$/u, '');
    if (trimmed === '') {
      // 中间段剥空（例如 `...`）→ 保留原样；末段剥空 → 该分量消失。
      if (!isLast) {
        out.push(segment);
      }
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * POSIX 归一化：`\` 也当分隔符（刻意的跨平台近似，见模块头），去 `.`、折叠分隔符、
 * 解析 `..`（不越过根）。不剥尾部点/空格：POSIX 文件名可以以它们结尾。
 * @param {string} raw
 * @returns {{key: string, relative: boolean}}
 */
function posixIdentity(raw) {
  const folded = String(raw).replace(/\\/gu, '/');
  const rooted = folded.startsWith('/');
  /** @type {string[]} */
  const parts = [];
  for (const segment of folded.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      }
      continue;
    }
    parts.push(segment);
  }
  return { key: `${rooted ? '/' : ''}${parts.join('/')}`, relative: !rooted };
}

/**
 * 组 UNC 身份键。server 与 share 必须都存在，否则不可判定。
 * @param {string[]} components server 起的原始分量
 * @param {string} raw 原始输入（用于报错信息）
 * @param {boolean} isFinal 该路径是否为完整路径（末段规则是否生效）
 * @returns {PathIdentity | UndecidablePath}
 */
function uncIdentity(components, raw, isFinal) {
  const parts = windowsParts(components.join('/'), { final: isFinal, ads: true });
  if (parts.length < 2) {
    return {
      ok: false,
      reason: `incomplete UNC path "${raw}": a share name after the server is required`
        + ' (a UNC path names both a server and a share); refusing to guess',
    };
  }
  return { ok: true, namespace: NAMESPACES.UNC, key: `//${parts.join('/')}`, relative: false };
}

/**
 * 解析 `\\...` 与 `//...` 开头的输入：UNC、扩展长度前缀、设备命名空间。
 * @param {string} raw
 * @param {boolean} isFinal
 * @returns {PathIdentity | UndecidablePath}
 */
function resolveNamespaced(raw, isFinal) {
  const components = raw.slice(2).split(/[\\/]+/u).filter((segment) => segment !== '');
  if (components.length === 0) {
    return { ok: false, reason: `"${raw}" names no target: refusing to guess` };
  }
  const first = components[0];
  if (first !== '?' && first !== '.') {
    return uncIdentity(components, raw, isFinal);
  }

  const tail = components.slice(1);
  if (first === '.') {
    // `\\.\` 是设备命名空间（`\\.\C:`、`\\.\PhysicalDrive0`）：Win32 词法规则
    // 不适用，因此分量**原样保留**（不折叠 `..`、不剥点/空格、不折叠 ADS），
    // 只保证它与任何普通路径都不相等。
    if (tail.length === 0) {
      return { ok: false, reason: `"${raw}" names no device: refusing to guess` };
    }
    return { ok: true, namespace: NAMESPACES.DEVICE, key: `//./${tail.join('/')}`, relative: false };
  }

  // `\\?\` 扩展长度前缀。
  if (tail.length === 0) {
    return { ok: false, reason: `"${raw}" names no target: refusing to guess` };
  }
  if (tail[0].toLowerCase() === 'unc') {
    return uncIdentity(tail.slice(1), raw, isFinal);
  }
  if (/^[A-Za-z]:$/u.test(tail[0])) {
    // `\\?\C:\x` 与 `C:\x` 是同一资源。
    const letter = tail[0][0];
    const parts = windowsParts(tail.slice(1).join('/'), { final: true, ads: true });
    return { ok: true, namespace: NAMESPACES.DRIVE, key: `${letter}:/${parts.join('/')}`, relative: false };
  }
  // `\\?\Volume{g}\x` 这类不透明目标：保留独立命名空间，绝不与盘符或 UNC 混同。
  return {
    ok: true,
    namespace: NAMESPACES.EXTENDED,
    key: `//?/${tail.join('/')}`,
    relative: false,
  };
}

/**
 * 解析盘符输入。驱动器相对（`C:foo`、`C:`）不可判定。
 * @param {string} raw
 * @param {boolean} isFinal
 * @returns {PathIdentity | UndecidablePath}
 */
function resolveDrive(raw, isFinal) {
  const after = raw.charAt(2);
  if (after !== '\\' && after !== '/') {
    return {
      ok: false,
      reason: `drive-relative path "${raw}" is not decidable without the per-drive current`
        + ' directory (Win32 resolves it against the current directory of that drive, which'
        + ' this layer has no context for); refusing to guess',
    };
  }
  const parts = windowsParts(raw.slice(2), { final: isFinal, ads: true });
  return {
    ok: true,
    namespace: NAMESPACES.DRIVE,
    key: `${raw[0]}:/${parts.join('/')}`,
    relative: false,
  };
}

/**
 * 把任意输入字符串解析成路径身份。**这是本模块唯一的归一化入口。**
 *
 * 不可判定（fail-safe，绝不猜）的情形：
 * - 空串；
 * - 驱动器相对：`C:foo`、`C:`、以及形如 `a:b` 的单字母冒号前缀（在 Windows 上
 *   它同样是 A 盘的相对路径；POSIX 上 `a:b` 是普通文件名，需要写成 `./a:b`
 *   才能表达——歧义必须由调用方消解，不能由策略层替它选一个）；
 * - 缺 share 的 UNC：`\\server`、`\\server\`；
 * - 只有命名空间标记的输入：`\\`、`\\?\`、`\\.\`。
 *
 * @param {unknown} input
 * @param {{final?: boolean}} [opts] `final: false` 表示输入是完整模式的前缀
 * @returns {PathIdentity | UndecidablePath}
 */
function resolveIdentity(input, opts) {
  const raw = input === null || input === undefined ? '' : String(input);
  const isFinal = !(opts && opts.final === false);
  if (raw === '') {
    return { ok: false, reason: 'path is empty' };
  }
  const lead = raw.slice(0, 2);
  if (lead === '\\\\' || lead === '//') {
    return resolveNamespaced(raw, isFinal);
  }
  if (/^[A-Za-z]:/u.test(raw)) {
    return resolveDrive(raw, isFinal);
  }
  const posix = posixIdentity(raw);
  return { ok: true, namespace: NAMESPACES.POSIX, key: posix.key, relative: posix.relative };
}

/**
 * 拆出身份键的结构：命名空间前缀、分量、以及 dirname 不允许越过的「根深度」。
 * @param {string} key
 * @returns {{prefix: string, parts: string[], floor: number}}
 */
function splitKey(key) {
  if (key.startsWith('//')) {
    // UNC 的根是 `//server/share`；`//./`、`//?/` 的根是标记 + 第一个分量。
    return { prefix: '//', parts: key.slice(2).split('/').filter((s) => s !== ''), floor: 2 };
  }
  const drive = /^([A-Za-z]:)\//u.exec(key);
  if (drive !== null) {
    return {
      prefix: `${drive[1]}/`,
      parts: key.slice(3).split('/').filter((s) => s !== ''),
      floor: 0,
    };
  }
  if (key.startsWith('/')) {
    return { prefix: '/', parts: key.slice(1).split('/').filter((s) => s !== ''), floor: 0 };
  }
  return { prefix: '', parts: key.split('/').filter((s) => s !== ''), floor: 0 };
}

/**
 * 跨平台 dirname（不依赖 `node:path`，避免宿主平台影响结果）。
 * 根（`/`、`C:/`、`//srv/share`）的 dirname 是它自己。
 * @param {string} key 已归一化的身份键
 * @returns {string}
 */
function dirnameOf(key) {
  const { prefix, parts, floor } = splitKey(key);
  if (parts.length <= floor) {
    return key;
  }
  return `${prefix}${parts.slice(0, -1).join('/')}`;
}

/**
 * 身份键的祖先链：自身、父、祖父……直到命名空间根（含）。
 * @param {string} key
 * @returns {string[]} 由深到浅
 */
function ancestorChain(key) {
  const chain = [key];
  for (;;) {
    const parent = dirnameOf(chain[chain.length - 1]);
    if (parent === chain[chain.length - 1] || parent === '') {
      return chain;
    }
    chain.push(parent);
  }
}

/**
 * 身份键的最后一个分量（basename）：`name:` 规则就是拿它做匹配的。
 * 命名空间根（`/`、`C:/`）没有 basename，返回 `''`。
 * @param {string} key 已归一化的身份键
 * @returns {string}
 */
function basenameOf(key) {
  const cut = key.lastIndexOf('/');
  return cut < 0 ? key : key.slice(cut + 1);
}

/**
 * `path` 是否等于 `root` 或位于 `root` 之下（分量边界处比较，不接受前缀字符串匹配）。
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function isUnderOrEqual(path, root) {
  if (path === root) {
    return true;
  }
  return path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * 按 windows 标志折叠大小写。
 * 只用于**比较**；`displayPath` / `pattern` 一律保留原始拼写。
 * @param {string} p
 * @param {unknown} windows
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
 * `~` 简写的**纯文本**展开（不做归一化）。只在路径开头（或独立出现）时生效。
 * @param {string} value
 * @param {string | undefined} home
 * @returns {string}
 */
function expandHomeText(value, home) {
  if (home !== undefined && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) {
    return home + value.slice(1);
  }
  return value;
}

/**
 * 展开模板并归一化成身份键。
 *
 * @param {string} template
 * @param {{home?: string, workspace?: string, final?: boolean}} [ctx] `final: false`
 *   表示这是完整模式的前缀（compile 内部使用），此时不套用末段归一化规则
 * @returns {{ok: true, key: string} | {ok: false, reason: string, raw: string}}
 */
function expandTemplate(template, ctx) {
  const home = ctx && typeof ctx.home === 'string' && ctx.home !== '' ? ctx.home : undefined;
  const workspace =
    ctx && typeof ctx.workspace === 'string' && ctx.workspace !== '' ? ctx.workspace : undefined;
  const isFinal = !(ctx && ctx.final === false);
  let value = template == null ? '' : String(template);

  value = expandHomeText(value, home);
  if (workspace !== undefined) {
    value = value.split(WORKSPACE_TOKEN).join(workspace);
  }
  if (value === '') {
    return { ok: true, key: '' };
  }

  const identity = resolveIdentity(value, { final: isFinal });
  if (!identity.ok) {
    // 不可判定：不猜。原样回传（与「缺 home 的 `~`」「缺 workspace 的占位符」同一约定），
    // 调用方据此判断此刻不可用。
    return { ok: false, reason: identity.reason, raw: value };
  }
  if (identity.relative) {
    if (workspace === undefined) {
      return { ok: true, key: identity.key };
    }
    // 相对路径挂在 workspace 下。拼接后重新解析，避免先归一化 workspace 丢失
    // 它自己的命名空间（UNC / 盘符）。
    const joined = resolveIdentity(`${String(workspace)}/${value}`, { final: isFinal });
    return joined.ok ? { ok: true, key: joined.key } : { ok: true, key: identity.key };
  }
  return { ok: true, key: identity.key };
}

/**
 * 词法展开路径模板并归一化。纯函数：不读环境变量、不访问文件系统。
 *
 * - `~` 或 `~/...` → `ctx.home`；home 缺省时保留原样（不猜、不抛错）
 * - `${workspace}` → `ctx.workspace`；workspace 缺省时保留占位符
 * - 绝对路径（`/x`、`D:/x`、`D:\x`、`\\srv\share\x`）→ 归一化成身份键
 * - 其它（相对路径）→ 挂在 `ctx.workspace` 下；workspace 缺省时原样归一化返回
 * - 不可判定（`C:foo`、缺 share 的 UNC）→ **原样回传**，绝不替调用方猜一个绝对路径
 *
 * 返回值仍可能包含未展开的 `~` / `${workspace}` / 不可判定的原文，这是刻意的：
 * 调用方据此判断该模板此刻是否可用。
 *
 * 大小写**不**被改写（`windows` 标志只影响匹配时的比较，见模块头）。
 *
 * @param {string} template 规则里的路径模板
 * @param {{home?: string, workspace?: string}} [ctx] 展开上下文
 * @returns {string} 归一化后的路径
 */
export function expandPath(template, ctx) {
  const expanded = expandTemplate(template, ctx);
  return expanded.ok ? expanded.key : expanded.raw;
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

/**
 * 校验名称模式（`name:` 之后的部分），返回拒绝原因或 undefined。
 *
 * 名称模式必须是一个**路径分量**的模式：不允许分隔符（那是路径规则），也不允许
 * `.` / `..`（它们不是文件名）。空白不做 trim：文件名可以以空格结尾（POSIX），
 * 只拒绝「全是空白」。
 * @param {string} namePattern
 * @returns {string | undefined}
 */
function nameRuleProblem(namePattern) {
  if (namePattern.trim() === '') {
    return 'name rule has an empty file name: write name:<file name>';
  }
  if (/[\\/]/u.test(namePattern)) {
    return `name rule "${namePattern}" must be a single path component (no separators);`
      + ' use a path pattern for anything with directories';
  }
  if (namePattern === '.' || namePattern === '..') {
    return `name rule "${namePattern}" is not a file name`;
  }
  return undefined;
}

/**
 * 编译规则表。非法规则不抛出，收集进 `invalid` 并跳过：
 * 空/空白 path、access 不在 ACCESS_LEVELS 内、展开后无法构成可用模式、
 * **不可判定**的路径（驱动器相对 `C:foo`、缺 share 的 UNC）、以及非法的
 * `name:` 名称模式（空名、含分隔符、`.`/`..`）——
 * 前者宁可报错也不猜一个可能指向别处的身份，后者宁可报错也不静默变成一条
 * 匹配不到任何东西的死规则。
 *
 * `path` 以 `name:` 开头的是**文件名规则**（任何位置下叫这个名字的资源，
 * 见模块头 §3）；其余是路径规则。
 *
 * 归一化去重：规则类型 + 展开后模式 + access + workspace 后缀完全相同的规则只
 * 保留最后一条（不影响语义，只是省内存）。
 *
 * 每条产出的规则都带**预编译**匹配物（`literal` 或 `regex`），match 期不再构造 regex。
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

  /**
   * 写入编译结果：同一个去重键只保留最后一条（last-wins，与具体性排序的第 4 键一致）。
   * @param {CompiledRule} rule 已编译规则
   * @param {string} key 去重键（含规则类型）
   * @returns {void}
   */
  const emit = (rule, key) => {
    const previous = dedupe.get(key);
    if (previous === undefined) {
      dedupe.set(key, compiledRules.length);
      compiledRules.push(rule);
    } else {
      compiledRules[previous] = rule; // 保留最后一条
    }
  };

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

    const ruleId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `#${index}`;
    const note = typeof raw.note === 'string' ? raw.note : undefined;

    if (rawPath.startsWith(NAME_PREFIX)) {
      // ---- 文件名规则：任何位置下叫这个名字的资源（模块头 §3）----
      const problem = nameRuleProblem(rawPath.slice(NAME_PREFIX.length));
      if (problem !== undefined) {
        invalid.push({ index, path: rawPath, reason: problem });
        continue;
      }
      // 名称模式与路径模式用同一套指标（字面量前缀长度 + 通配符数），这样它就能
      // 直接参与既有排序键的第 2/3 位；第 1 位（命中深度）在 match 期取候选长度。
      const namePattern = foldCase(rawPath.slice(NAME_PREFIX.length), windows);
      const nameMetrics = patternMetrics(namePattern, false);
      /** @type {CompiledRule} */
      const nameRule = {
        index,
        id: ruleId,
        pattern: rawPath,
        access,
        note,
        kind: RULE_KIND.NAME,
        namePattern,
        // 对名称规则，`normalized` 就是折叠后的名称模式：去重键、日志与
        // compareHits 的兜底比较都用它。
        normalized: namePattern,
        prefixLength: nameMetrics.prefixLength,
        wildcards: nameMetrics.wildcards,
        needsWorkspace: false,
        windows,
        literal: nameMetrics.wildcards === 0 ? namePattern : null,
        regex: nameMetrics.wildcards > 0 ? globToRegExp(namePattern) : null,
      };
      emit(nameRule, `${RULE_KIND.NAME}\u0000${namePattern}\u0000${access}`);
      continue;
    }

    const parsed = parsePattern(rawPath);
    const hasToken = rawPath.includes(WORKSPACE_TOKEN);

    // compile 期只能展开 `${workspace}` 之前的部分；`~`（在有 home 时）可以立即展开。
    // 前缀后面还跟着东西时（`suffix`/token），它自己不是末段，因此 `final: false`：
    // 否则 `C:/x.*/y` 这种「点紧挨通配符」的模式会把前缀末段的点误当成路径末段剥掉。
    const head = expandTemplate(parsed.prefix, { home, final: !hasToken });
    if (!head.ok) {
      invalid.push({ index, path: rawPath, reason: head.reason });
      continue;
    }
    const headKey = head.key;
    const absoluteHead =
      headKey === '' || headKey.startsWith('/') || /^[A-Za-z]:\//.test(headKey) || headKey.startsWith('~');

    // 相对路径按规格「视为相对于 workspace」：用 `${workspace}/` 前缀改写，
    // 于是它与显式 `${workspace}` 规则走同一条 match 期展开路径。
    // workspace 缺省时该规则自然不生效，不需要在 compile 期拒绝。
    const needsWorkspace = hasToken || !absoluteHead;
    const suffix = unifySlashes(parsed.suffix);
    let patternWithToken;
    if (!needsWorkspace) {
      // 无占位符：整条模板（`prefix` + `suffix`）一次性归一化，末段规则照常生效。
      patternWithToken = expandHomeText(parsed.prefix, home) + parsed.suffix;
    } else if (absoluteHead) {
      // `D:/x/${workspace}/y`：前缀在 compile 期已确定。
      patternWithToken = `${headKey}${WORKSPACE_TOKEN}${suffix}`;
    } else {
      // `src/**`：整体挂在 workspace 下。
      patternWithToken = `${WORKSPACE_TOKEN}/${headKey}${suffix}`;
    }

    const identity = resolveIdentity(patternWithToken);
    if (!identity.ok) {
      invalid.push({ index, path: rawPath, reason: identity.reason });
      continue;
    }
    const normalized = foldCase(identity.key, windows);
    if (normalized === '' || normalized === '/') {
      invalid.push({ index, path: rawPath, reason: 'path does not resolve to a usable pattern' });
      continue;
    }
    const metrics = patternMetrics(normalized, needsWorkspace);

    /** @type {CompiledRule} */
    const rule = {
      index,
      id: ruleId,
      pattern: rawPath,
      access,
      note,
      kind: RULE_KIND.PATH,
      namePattern: null,
      normalized,
      prefixLength: metrics.prefixLength,
      wildcards: metrics.wildcards,
      needsWorkspace,
      windows,
      // 预编译匹配物：二者至多一个非空。`${workspace}` 规则的 regex 在 match 期
      // 按 workspace 构建并缓存（见 WORKSPACE_CACHE）。
      literal: !needsWorkspace && metrics.wildcards === 0 ? normalized : null,
      regex: !needsWorkspace && metrics.wildcards > 0 ? globToRegExp(normalized) : null,
    };

    // 去重键必须带 needsWorkspace：`~/.ssh` 与 `${workspace}/.ssh` 在缺 home 时
    // 归一化结果可能相同，但可用性完全不同，绝不能合并。规则类型同样要带：
    // 名称规则 `name:x` 与路径规则不可能共享模式，但带上更不容易出错。
    emit(
      rule,
      `${RULE_KIND.PATH}\u0000${rule.normalized}\u0000${access}\u0000${needsWorkspace ? 'w' : 's'}`,
    );
  }

  return { rules: compiledRules, isEmpty: compiledRules.length === 0, invalid };
}

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

/**
 * `${workspace}` 展开结果的缓存：规则数组 → (workspace → 每条规则的已编译 regex)。
 *
 * 规则数组是 `compile()` 每次重新编译时新建的，用 WeakMap 做键可以让旧数组
 * 连同缓存一起被回收。每个数组内按插入顺序保留有限个 workspace（LRU 式的
 * 「淘汰最早的一个」），避免长会话里不断切换 workspace 造成无界增长。
 *
 * @type {WeakMap<object, Map<string, Array<RegExp | null>>>}
 */
const WORKSPACE_CACHE = new WeakMap();

/** 每个规则数组最多缓存多少个 workspace 的展开结果。 */
const WORKSPACE_CACHE_LIMIT = 64;

/**
 * 在 match 期把 `${workspace}` 拼接进模式，并归一化成身份键。
 *
 * 关键：`${workspace}` 在模式里是一个**路径分量**，不是纯文本。
 * `D:/proj/${workspace}/src` 在 workspace=`w1` 时必须展开成 `D:/proj/w1/src`，
 * 而不是 `D:/projw1/src`。所以按分量拼接并吸收两侧多余的分隔符。
 *
 * @param {string} normalized compile 期归一化后仍含 `${workspace}` 的模式
 * @param {string} workspace
 * @returns {string | undefined} 归一化后的完整模式；workspace 不可判定时为 undefined
 */
function spliceWorkspace(normalized, workspace) {
  const parts = normalized.split(WORKSPACE_TOKEN);
  if (parts.length === 1) {
    return normalized;
  }
  const [head, ...tail] = parts;
  const left = head.replace(/\/+$/u, '');
  const right = tail.join(WORKSPACE_TOKEN).replace(/^\/+/u, '');
  const value = String(workspace);
  let joined;
  if (left === '') {
    joined = right === '' ? value : `${value}/${right}`;
  } else if (right === '') {
    joined = `${left}/${value}`;
  } else {
    joined = `${left}/${value}/${right}`;
  }
  // 不先归一化 workspace：它自己可能带命名空间前缀（UNC / 盘符）。
  const identity = resolveIdentity(joined);
  return identity.ok ? identity.key : undefined;
}

/**
 * 为某个 workspace 构建（并缓存）每条规则展开后的 regex。
 * @param {Array<object>} rules
 * @param {string} workspace
 * @returns {Array<RegExp | null>} 与 rules 同下标；不适用/不可展开的规则为 null
 */
function workspaceStore(rules, workspace) {
  let perWorkspace = WORKSPACE_CACHE.get(rules);
  if (perWorkspace === undefined) {
    perWorkspace = new Map();
    WORKSPACE_CACHE.set(rules, perWorkspace);
  }
  let store = perWorkspace.get(workspace);
  if (store === undefined) {
    store = new Array(rules.length).fill(null);
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule == null || typeof rule !== 'object' || rule.needsWorkspace !== true) {
        continue;
      }
      const spliced = spliceWorkspace(String(rule.normalized), workspace);
      store[i] = spliced === undefined ? null : globToRegExp(foldCase(spliced, rule.windows));
    }
    // 有界缓存：淘汰最早插入的那个 workspace。
    if (perWorkspace.size >= WORKSPACE_CACHE_LIMIT) {
      const oldest = perWorkspace.keys().next();
      if (oldest.done !== true) {
        perWorkspace.delete(oldest.value);
      }
    }
    perWorkspace.set(workspace, store);
  }
  return store;
}

/**
 * 归一化候选路径。空串/纯分隔符按根 `/` 处理（保持既有语义）。
 * @param {unknown} value
 * @returns {PathIdentity | UndecidablePath}
 */
function candidateIdentity(value) {
  const text = String(value);
  if (text.replace(/[\\/]+$/u, '') === '') {
    return { ok: true, namespace: NAMESPACES.POSIX, key: '/', relative: false };
  }
  return resolveIdentity(text);
}

/**
 * 判定绝对路径命中的最优规则。
 *
 * 算法：
 * 1. 把候选路径归一化成身份键；**不可判定**（`C:foo`、缺 share 的 UNC）时返回
 *    fail-safe 的拒绝决定：`access: 'none'`、`ruleId: '<undecidable>'`、
 *    `pattern` 为调用方给的那个原始拼写（没有任何用户规则参与，所以三者都不会
 *    指向某条真实规则）——这类拼写在 Windows 上指向哪个对象取决于盘符当前目录，
 *    词法层无法知道，放行就等于把判定权交给一个猜测；
 * 2. 生成候选的身份键、祖先链与 basename（每次调用只算一次；
 *    按 `windows` 标志至多两个变体）；
 * 3. 对每条规则：
 *    - `name:` 规则：只把 basename 与名称模式比较（字面量相等或名称 regex），
 *      命中深度记为候选自身；
 *    - 路径 `literal` 规则：对候选键做一次分量边界的 `startsWith`（命中的祖先只
 *      可能是字面量自身，无需遍历祖先链、无需 regex）；
 *    - 路径通配符规则：用 compile 期（或按 workspace 缓存的）regex 在祖先链上
 *      由深到浅测试；
 * 4. 在命中规则中选最具体的一条，排序键依次为
 *    命中深度降序（路径规则=命中的祖先长度，`name:` 规则=候选长度）→
 *    字面量前缀长度降序 → 通配符数量升序 → 下标降序（last-wins）。
 *
 * 无规则命中时返回 `undefined`，由调用方套用 defaultAccess。
 *
 * @param {CompiledRule[]} compiled `compile()` 的产物
 * @param {string} absolutePath 待判定的绝对路径
 * @param {{workspace?: string}} [opts] 仅在此处可用 workspace 展开 `${workspace}` 规则
 * @returns {{access: string, ruleId: string, pattern: string} | undefined}
 */
export function match(compiled, absolutePath, opts) {
  if (!Array.isArray(compiled)) {
    return undefined;
  }
  if (typeof absolutePath !== 'string' || absolutePath.trim() === '') {
    return undefined;
  }

  const candidate = candidateIdentity(absolutePath);
  if (!candidate.ok) {
    return { access: 'none', ruleId: UNDECIDABLE_RULE_ID, pattern: absolutePath };
  }
  if (compiled.length === 0) {
    return undefined;
  }

  const workspace =
    opts && typeof opts.workspace === 'string' && opts.workspace !== '' ? opts.workspace : undefined;
  const workspaceRegexes = workspace === undefined ? undefined : workspaceStore(compiled, workspace);

  /** @type {Map<boolean, {key: string, ancestors: string[], base: string}>} */
  const variants = new Map();
  let lastFlag;
  /** @type {{key: string, ancestors: string[], base: string} | undefined} */
  let lastVariant;
  /**
   * 取某个大小写折叠标志下的候选键、祖先链与 basename（每次 match 只算一次）。
   * @param {boolean} windows
   * @returns {{key: string, ancestors: string[], base: string}}
   */
  const variantOf = (windows) => {
    if (lastVariant !== undefined && lastFlag === windows) {
      return lastVariant;
    }
    let variant = variants.get(windows);
    if (variant === undefined) {
      const key = foldCase(candidate.key, windows);
      variant = { key, ancestors: ancestorChain(key), base: basenameOf(key) };
      variants.set(windows, variant);
    }
    lastFlag = windows;
    lastVariant = variant;
    return variant;
  };

  /** @type {{rule: CompiledRule, ancestorLength: number} | undefined} */
  let best;

  for (let i = 0; i < compiled.length; i += 1) {
    const rule = compiled[i];
    if (rule == null || typeof rule !== 'object') {
      continue;
    }
    const windows = rule.windows === true;
    let ancestorLength = -1;

    if (rule.kind === RULE_KIND.NAME) {
      // 文件名规则：只测候选自身的 basename，不看祖先（见模块头 §3）。
      // 命中深度记为**候选自身**：它约束的是「就是这个资源」，胜过任何只命中
      // 祖先的路径规则；与候选完全同路径的路径规则则靠第 2 键取胜。
      const variant = variantOf(windows);
      if (variant.base !== '') {
        if (typeof rule.literal === 'string') {
          if (variant.base === rule.literal) {
            ancestorLength = variant.key.length;
          }
        } else {
          const regex =
            rule.regex instanceof RegExp
              ? rule.regex
              : globToRegExp(String(rule.namePattern ?? rule.normalized));
          if (regex.test(variant.base)) {
            ancestorLength = variant.key.length;
          }
        }
      }
    } else if (rule.needsWorkspace === true) {
      // workspace 缺省 → 该条规则不生效（绝不当成空字符串去匹配）。
      const regex = workspaceRegexes === undefined ? null : workspaceRegexes[i];
      if (regex == null) {
        continue;
      }
      for (const ancestor of variantOf(windows).ancestors) {
        if (regex.test(ancestor)) {
          ancestorLength = ancestor.length;
          break;
        }
      }
    } else if (typeof rule.literal === 'string') {
      // 无通配符：命中的祖先只可能是字面量自身，无需遍历祖先链、无需 regex。
      const variant = variantOf(windows);
      if (isUnderOrEqual(variant.key, rule.literal)) {
        ancestorLength = rule.literal.length;
      }
    } else {
      const regex = rule.regex instanceof RegExp ? rule.regex : globToRegExp(String(rule.normalized));
      for (const ancestor of variantOf(windows).ancestors) {
        if (regex.test(ancestor)) {
          ancestorLength = ancestor.length;
          break;
        }
      }
    }

    if (ancestorLength < 0) {
      continue;
    }
    const hit = { rule, ancestorLength };
    if (best === undefined || compareHits(hit, best) < 0) {
      best = hit;
    }
  }

  if (best === undefined) {
    return undefined;
  }
  return { access: best.rule.access, ruleId: best.rule.id, pattern: best.rule.pattern };
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
 * 两侧各自归一化成**身份键**后再按分量边界比较，因此 UNC（`//srv/share/x`）
 * 与同后缀的 POSIX 路径（`/srv/share/x`）不互相包含；两侧任一不可判定
 * （`C:foo`、缺 share 的 UNC）时返回 false——无法建立包含关系就不声称包含。
 *
 * @param {string} root
 * @param {string} candidate
 * @param {boolean} [windows] true 时按 Windows 语义折叠大小写
 * @returns {boolean}
 */
export function contains(root, candidate, windows) {
  const fold = windows === true;
  const rootIdentity = candidateIdentity(String(root ?? ''));
  const candidatePath = candidateIdentity(String(candidate ?? ''));
  if (!rootIdentity.ok || !candidatePath.ok) {
    return false;
  }
  const r = foldCase(rootIdentity.key, fold);
  const c = foldCase(candidatePath.key, fold);
  // 根不作为祖先通过（避免把整个命名空间当成命中）。
  if (r === '' || r === '/') {
    return false;
  }
  return isUnderOrEqual(c, r);
}

/**
 * @typedef {object} CompiledRule
 * @property {number} index 规则在原始数组中的下标
 * @property {string} id 规则 id（缺省为 `#<index>`）
 * @property {string} pattern 原始路径模板（用于回报给调用方，`name:` 前缀保留）
 * @property {string} access 访问档位
 * @property {string | undefined} note 备注
 * @property {'path' | 'name'} kind 路径规则还是文件名规则
 * @property {string | null} namePattern 文件名规则的名称模式（已按 `windows` 折叠）；
 *   路径规则为 null
 * @property {string} normalized 归一化后的模式：路径规则是身份键（可能仍含
 *   `${workspace}`），文件名规则是折叠后的名称模式
 * @property {number} prefixLength 字面量前缀长度（第一个通配符之前）
 * @property {number} wildcards 通配符数量
 * @property {boolean} needsWorkspace 是否必须在 match 期用 workspace 展开（名称规则恒为 false）
 * @property {boolean} windows 该规则是否按 Windows 大小写不敏感语义比较
 * @property {string | null} literal 预编译的字面量模式（无通配符时非空：路径规则是路径键，
 *   名称规则是文件名）
 * @property {RegExp | null} regex 预编译的匹配正则（有通配符且不需要 workspace 时非空）
 */
