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
export declare const ACCESS_LEVELS: readonly string[];
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
export declare function expandPath(template: string, ctx?: {
    home?: string | undefined;
    workspace?: string | undefined;
}): string;
/** 一条原始规则（配置里的形状）。非法值不抛出，进 `compile().invalid`。 */
export interface RuleInput {
    id?: string | undefined;
    path?: string | undefined;
    access?: string | undefined;
    note?: string | undefined;
}
/** `compile()` 的输入。`rules` 故意收 `unknown`：配置来自用户，非法元素必须被收集而不是让加载崩掉。 */
export interface CompileInput {
    rules?: ReadonlyArray<unknown> | undefined;
    home?: string | undefined;
    windows?: boolean | undefined;
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
export declare function compile(input?: CompileInput): {
    rules: CompiledRule[];
    isEmpty: boolean;
    invalid: Array<{
        index: number;
        path: string;
        reason: string;
    }>;
};
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
export declare function match(compiled: CompiledRule[], absolutePath: string, opts?: {
    workspace?: string | undefined;
}): {
    access: string;
    ruleId: string;
    pattern: string;
} | undefined;
/**
 * 把访问档位映射成能力位。未知档位一律按最严（全 false）处理。
 * @param {string} access
 * @returns {{list: boolean, read: boolean, write: boolean}}
 */
export declare function capabilities(access: string): {
    list: boolean;
    read: boolean;
    write: boolean;
};
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
export declare function contains(root: string, candidate: string, windows?: boolean): boolean;
/**
 * 编译后的一条规则。调用方只需要 `access` / `id` / `pattern`；其余字段是
 * 匹配器的预编译产物（见模块头 §2）与具体性排序键，公开出来是为了可观测与可测试。
 */
export interface CompiledRule {
    /** 规则在原始数组中的下标 */
    index: number;
    /** 规则 id（缺省为 `#<index>`） */
    id: string;
    /** 原始路径模板（用于回报给调用方，`name:` 前缀保留） */
    pattern: string;
    /** 访问档位 */
    access: string;
    /** 备注 */
    note?: string | undefined;
    /** 路径规则还是文件名规则 */
    kind: 'path' | 'name';
    /**
     * 文件名规则的名称模式（已按 `windows` 折叠）；路径规则为 null
     */
    namePattern: string | null;
    /**
     * 归一化后的模式：路径规则是身份键（可能仍含 `${workspace}`），
     * 文件名规则是折叠后的名称模式
     */
    normalized: string;
    /** 字面量前缀长度（第一个通配符之前） */
    prefixLength: number;
    /** 通配符数量 */
    wildcards: number;
    /** 是否必须在 match 期用 workspace 展开（名称规则恒为 false） */
    needsWorkspace: boolean;
    /** 该规则是否按 Windows 大小写不敏感语义比较 */
    windows: boolean;
    /**
     * 预编译的字面量模式（无通配符时非空：路径规则是路径键，名称规则是文件名）
     */
    literal: string | null;
    /** 预编译的匹配正则（有通配符且不需要 workspace 时非空） */
    regex: RegExp | null;
}
