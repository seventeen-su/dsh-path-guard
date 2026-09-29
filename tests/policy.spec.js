/**
 * dsh-path-guard — L0 纯策略引擎单测。
 *
 * 运行：node --test tests/policy.spec.js
 * 零依赖，仅用 node 内置测试器与断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_LEVELS,
  capabilities,
  compile,
  contains,
  expandPath,
  match,
} from '../src/policy.js';

const HOME = '/home/u';
const WS = 'D:/proj';

/** 常用：编译 windows 语义下的规则表。 */
function compileWin(rules, home = HOME) {
  return compile({ rules, home, windows: true });
}

// ---------------------------------------------------------------------------
// 1. 空规则表
// ---------------------------------------------------------------------------

test('1. 空规则表 → match 返回 undefined，isEmpty 为 true', () => {
  const compiled = compile({ rules: [], home: HOME, windows: true });
  assert.equal(compiled.isEmpty, true);
  assert.deepEqual(compiled.rules, []);
  assert.deepEqual(compiled.invalid, []);
  assert.equal(match(compiled.rules, 'D:/anything/x.txt', { workspace: WS }), undefined);

  // 容错：缺 rules / 传 undefined 也不抛。
  assert.equal(compile({}).isEmpty, true);
  assert.equal(compile().isEmpty, true);
  assert.equal(match(undefined, 'D:/x', {}), undefined);
  assert.equal(match([], 'D:/x', {}), undefined);
  assert.equal(match(compileWin([{ path: 'D:/a', access: 'read' }]).rules, '', {}), undefined);
});

// ---------------------------------------------------------------------------
// 2 & 3. 半访问与豁免（最具体规则胜出）
// ---------------------------------------------------------------------------

test('2. ~/.ssh = list：~/.ssh/id_rsa 命中 list', () => {
  const compiled = compileWin([{ id: 'ssh-dir', path: '~/.ssh', access: 'list' }]);
  assert.equal(compiled.isEmpty, false);
  assert.deepEqual(compiled.invalid, []);

  const hit = match(compiled.rules, `${HOME}/.ssh/id_rsa`, { workspace: WS });
  assert.deepEqual(hit, { access: 'list', ruleId: 'ssh-dir', pattern: '~/.ssh' });
});

test('3. 豁免：~/.ssh= list 下 README.md → read，id_rsa → list', () => {
  const compiled = compileWin([
    { id: 'ssh-dir', path: '~/.ssh', access: 'list' },
    { id: 'ssh-readme', path: '~/.ssh/README.md', access: 'read' },
  ]);
  assert.equal(compiled.rules.length, 2);

  assert.deepEqual(match(compiled.rules, `${HOME}/.ssh/README.md`, {}), {
    access: 'read',
    ruleId: 'ssh-readme',
    pattern: '~/.ssh/README.md',
  });
  assert.deepEqual(match(compiled.rules, `${HOME}/.ssh/id_rsa`, {}), {
    access: 'list',
    ruleId: 'ssh-dir',
    pattern: '~/.ssh',
  });
  // 更深的后代仍然落到目录规则上。
  assert.equal(match(compiled.rules, `${HOME}/.ssh/keys/deep.pem`, {}).access, 'list');
  // 目录本身也命中。
  assert.equal(match(compiled.rules, `${HOME}/.ssh`, {}).access, 'list');
  // 超出规则范围的路径不命中。
  assert.equal(match(compiled.rules, `${HOME}/other/id_rsa`, {}), undefined);
});

test('3b. 通配符同样参与具体性排序：D:/ws/* = list，D:/ws/ok.txt = write', () => {
  const compiled = compileWin([
    { id: 'any', path: 'D:/ws/*', access: 'list' },
    { id: 'one', path: 'D:/ws/ok.txt', access: 'write' },
  ]);
  assert.equal(match(compiled.rules, 'D:/ws/ok.txt', {}).access, 'write');
  assert.equal(match(compiled.rules, 'D:/ws/nope.txt', {}).access, 'list');
});

// ---------------------------------------------------------------------------
// 4. `**` 跨分隔符
// ---------------------------------------------------------------------------

test('4. D:/secrets/** = none：D:/secrets/a/b.txt 命中 none', () => {
  const compiled = compileWin([{ id: 'sec', path: 'D:/secrets/**', access: 'none' }]);
  assert.deepEqual(match(compiled.rules, 'D:/secrets/a/b.txt', {}), {
    access: 'none',
    ruleId: 'sec',
    pattern: 'D:/secrets/**',
  });
  assert.equal(match(compiled.rules, 'D:/secrets/x', {}).access, 'none');
  // `p/**` 也覆盖 p 自身。
  assert.equal(match(compiled.rules, 'D:/secrets', {}).access, 'none');
  // 同级前缀不算命中。
  assert.equal(match(compiled.rules, 'D:/secrets2/a.txt', {}), undefined);
});

// ---------------------------------------------------------------------------
// 5. 大小写
// ---------------------------------------------------------------------------

test('5. 大小写：windows=true 时 D:/Secrets/x 命中 d:/secrets；windows=false 时不命中', () => {
  const win = compile({ rules: [{ id: 's', path: 'd:/secrets', access: 'none' }], home: HOME, windows: true });
  assert.equal(match(win.rules, 'D:/Secrets/x', {}).access, 'none');
  assert.equal(match(win.rules, 'd:/secrets/x', {}).access, 'none');
  assert.equal(match(win.rules, 'D:/SECRETS', {}).access, 'none');

  const posix = compile({ rules: [{ id: 's', path: 'd:/secrets', access: 'none' }], home: HOME, windows: false });
  assert.equal(match(posix.rules, 'D:/Secrets/x', {}), undefined);
  assert.equal(match(posix.rules, 'd:/secrets/x', {}).access, 'none');
});

// ---------------------------------------------------------------------------
// 6. 深浅（越深越具体）
// ---------------------------------------------------------------------------

test('6. 深浅：a/b 与 a/b/c 同时命中时，a/b/c/d 取 a/b/c', () => {
  const compiled = compileWin([
    { id: 'shallow', path: 'D:/a/b', access: 'list' },
    { id: 'deep', path: 'D:/a/b/c', access: 'read' },
  ]);
  assert.equal(match(compiled.rules, 'D:/a/b/c/d', {}).ruleId, 'deep');
  assert.equal(match(compiled.rules, 'D:/a/b/c', {}).ruleId, 'deep');
  assert.equal(match(compiled.rules, 'D:/a/b/z', {}).ruleId, 'shallow');
});

test('6b. 命中祖先长度优先于字面量前缀长度', () => {
  // 后者字面量前缀更长，但命中的祖先更浅，应当落败。
  const compiled = compileWin([
    { id: 'suffix-literal', path: '**/b.txt', access: 'read' },
    { id: 'root', path: 'D:/root', access: 'none' },
  ]);
  assert.equal(match(compiled.rules, 'D:/root/sub/b.txt', {}).ruleId, 'root');
});

test('6c. 同一祖先下：字面量前缀更长者胜', () => {
  const compiled = compileWin([
    { id: 'star', path: 'D:/*.txt', access: 'list' },
    { id: 'literal', path: 'D:/readme.txt', access: 'read' },
  ]);
  assert.equal(match(compiled.rules, 'D:/readme.txt', {}).ruleId, 'literal');
  assert.equal(match(compiled.rules, 'D:/other.txt', {}).ruleId, 'star');
});

test('6d. 前缀与下标都相同时：通配符更少者胜', () => {
  const compiled = compileWin([
    { id: 'two', path: 'D:/a/*/*', access: 'list' },
    { id: 'one', path: 'D:/a/*/x', access: 'read' },
  ]);
  assert.equal(match(compiled.rules, 'D:/a/b/x', {}).ruleId, 'one');
});

// ---------------------------------------------------------------------------
// 7. `*` 不跨分隔符
// ---------------------------------------------------------------------------

test('7. `*` 不跨分隔符', () => {
  // 直接匹配层面：`D:/x/*` 只覆盖「D:/x 的直接子项」。
  const compiled = compileWin([{ id: 'x', path: 'D:/x/*', access: 'none' }]);
  assert.equal(match(compiled.rules, 'D:/x/y', {}).access, 'none');
  assert.equal(match(compiled.rules, 'D:/x', {}), undefined);
  assert.equal(match(compiled.rules, 'D:/other/y', {}), undefined);

  // 关键对照：`*` 绝不能跨越分隔符，而 `**` 可以。
  // 用「带字面尾巴」的模式才能观察到这一点：`D:/x/*/z` 要求中间恰好一段。
  const star = compileWin([{ id: 'star', path: 'D:/x/*/z', access: 'none' }]);
  assert.equal(match(star.rules, 'D:/x/y/z', {}).access, 'none');
  assert.equal(match(star.rules, 'D:/x/a/b/z', {}), undefined); // `*` 无法吃掉 `a/b`

  const globstar = compileWin([{ id: 'gs', path: 'D:/x/**/z', access: 'none' }]);
  assert.equal(match(globstar.rules, 'D:/x/a/b/z', {}).access, 'none'); // `**` 可以
  assert.equal(match(globstar.rules, 'D:/x/z', {}).access, 'none'); // `**` 可为空
});

test('7a. 祖先覆盖：规则命中某祖先时，其后代全部被覆盖（规格步骤 2）', () => {
  // 规格步骤 2 规定「glob 命中祖先链中任意一项即命中」。因此 `D:/x/*` 会命中
  // 祖先 `D:/x/y`，从而覆盖 `D:/x/y/z`。这与 `~/.ssh` 覆盖 `~/.ssh/id_rsa`
  // 是同一个机制，也是「规则路径含义 = 该路径本身或任意后代」的直接推论。
  // 注意：这与任务描述里测试 7 的字面期望（`D:/x/*` 不匹配 `D:/x/y/z`）冲突，
  // 见交付说明中的歧义报告。
  const compiled = compileWin([{ id: 'x', path: 'D:/x/*', access: 'none' }]);
  const hit = match(compiled.rules, 'D:/x/y/z', {});
  assert.equal(hit.access, 'none');
  assert.equal(hit.ruleId, 'x');
  // 但覆盖来自祖先，而不是 `*` 跨了分隔符：多插一层后仍命中（因为 `D:/x/y` 这一层
  // 依旧是 `D:/x/*` 的命中项）。
  assert.equal(match(compiled.rules, 'D:/x/y/z/w/deep.txt', {}).access, 'none');
  // 与 `D:/x` 自身无关：`D:/x` 不是 `D:/x/*` 的命中项，也不是其后代。
  assert.equal(match(compiled.rules, 'D:/x', {}), undefined);
  assert.equal(match(compiled.rules, 'D:/xx/y/z', {}), undefined);
});

test('7b. `?` 匹配单个非分隔符字符', () => {
  const compiled = compileWin([{ id: 'q', path: 'D:/x/?', access: 'read' }]);
  assert.equal(match(compiled.rules, 'D:/x/a', {}).access, 'read');
  assert.equal(match(compiled.rules, 'D:/x/ab', {}), undefined);
  assert.equal(match(compiled.rules, 'D:/x//', {}), undefined);
});

// ---------------------------------------------------------------------------
// 8. 归一化
// ---------------------------------------------------------------------------

test('8. `..` 与分隔符归一化：D:/a/../b 与 D:/b 等价', () => {
  const compiled = compileWin([{ id: 'b', path: 'D:/b', access: 'read' }]);
  assert.equal(match(compiled.rules, 'D:/a/../b', {}).access, 'read');
  assert.equal(match(compiled.rules, 'D:\\a\\..\\b\\c.txt', {}).access, 'read');
  assert.equal(match(compiled.rules, 'D:/b/', {}).access, 'read');
  assert.equal(match(compiled.rules, 'D://b//c.txt', {}).access, 'read');
  assert.equal(match(compiled.rules, 'D:/b/./c.txt', {}).access, 'read');
});

test('8b. `..` 不越过根', () => {
  assert.equal(match(compileWin([{ path: 'D:/', access: 'none' }]).rules, 'D:/../..', {}).access, 'none');
  const compiled = compileWin([{ id: 'r', path: 'D:/a', access: 'read' }]);
  assert.equal(match(compiled.rules, 'D:/a/../a/b', {}).access, 'read');
});

test('8c. 规则模式自身也被归一化（`~` 展开 + `..`）', () => {
  const compiled = compileWin([{ id: 'norm', path: '~/.ssh/../public/file.txt', access: 'read' }]);
  assert.equal(match(compiled.rules, `${HOME}/public/file.txt`, {}).ruleId, 'norm');
  assert.equal(match(compiled.rules, '/home/u/.ssh/../public/file.txt', {}).ruleId, 'norm');
});

// ---------------------------------------------------------------------------
// 9. ${workspace}
// ---------------------------------------------------------------------------

test('9. ${workspace} 在 match 时展开；workspace 缺省时该规则不生效', () => {
  const compiled = compileWin([{ id: 'ws', path: '${workspace}/src/**', access: 'write' }]);
  assert.equal(compiled.isEmpty, false);
  assert.deepEqual(compiled.invalid, []);

  assert.deepEqual(match(compiled.rules, `${WS}/src/a/b.js`, { workspace: WS }), {
    access: 'write',
    ruleId: 'ws',
    pattern: '${workspace}/src/**',
  });
  // 缺省 workspace：既不命中，也绝不能按空字符串匹配。
  assert.equal(match(compiled.rules, `${WS}/src/a/b.js`, {}), undefined);
  assert.equal(match(compiled.rules, '/src/a/b.js', {}), undefined);
  assert.equal(match(compiled.rules, `${WS}/src/a/b.js`, { workspace: '' }), undefined);
  // 传了别的 workspace 也不命中。
  assert.equal(match(compiled.rules, `${WS}/src/a/b.js`, { workspace: 'D:/other' }), undefined);
});

test('9b. 混合模板 D:/proj/${workspace}/src 在 match 期按路径分量拼接', () => {
  const compiled = compileWin([{ id: 'mix', path: 'D:/proj/${workspace}/src', access: 'read' }]);
  assert.equal(compiled.invalid.length, 0);
  // `${workspace}` 是路径分量：必须补回两侧分隔符，不能拼成 D:/proj w1 src。
  assert.equal(match(compiled.rules, 'D:/proj/w1/src/x.js', { workspace: 'w1' }).ruleId, 'mix');
  assert.equal(match(compiled.rules, 'D:/proj/w1/src', { workspace: 'w1' }).ruleId, 'mix');
  assert.equal(match(compiled.rules, 'D:/projw1/src/x.js', { workspace: 'w1' }), undefined);
  assert.equal(match(compiled.rules, 'D:/proj/w2/src/x.js', { workspace: 'w1' }), undefined);
  assert.equal(match(compiled.rules, 'D:/proj/w1/src/x.js', {}), undefined);
});

test('9c. 相对路径视为相对于 workspace', () => {
  const compiled = compileWin([{ id: 'rel', path: 'src/**', access: 'read' }]);
  assert.equal(match(compiled.rules, `${WS}/src/a.js`, { workspace: WS }).ruleId, 'rel');
  assert.equal(match(compiled.rules, `${WS}/src/a.js`, {}), undefined);
});

test('9d. expandPath 的展开规则', () => {
  assert.equal(expandPath('~', { home: HOME }), HOME);
  assert.equal(expandPath('~/.ssh', { home: HOME }), `${HOME}/.ssh`);
  assert.equal(expandPath('~/', { home: HOME }), HOME);
  assert.equal(expandPath('${workspace}', { workspace: WS }), WS);
  assert.equal(expandPath('${workspace}/src', { workspace: WS }), `${WS}/src`);
  assert.equal(expandPath('D:\\x\\../y', {}), 'D:/y');
  assert.equal(expandPath('/a//b/./c', {}), '/a/b/c');
  assert.equal(expandPath('rel/x', {}), 'rel/x');
  assert.equal(expandPath('rel/x', { workspace: '/ws' }), '/ws/rel/x');
  assert.equal(expandPath('..', {}), '');
  // 缺少上下文时不猜：原样保留，便于调用方判定「此刻不可用」。
  assert.equal(expandPath('~/.ssh', {}), '~/.ssh');
  assert.equal(expandPath('${workspace}/src', {}), '${workspace}/src');
  assert.equal(expandPath('', {}), '');
  assert.equal(expandPath(null, {}), '');
});

test('9e. 缺 home 时 `~` 规则不生效（不会被当成字面量误匹配）', () => {
  const compiled = compile({ rules: [{ id: 'h', path: '~/.ssh', access: 'none' }], windows: true });
  assert.equal(match(compiled.rules, `${HOME}/.ssh/id_rsa`, {}), undefined);
});

// ---------------------------------------------------------------------------
// 10. invalid 收集
// ---------------------------------------------------------------------------

test('10. invalid 规则收集：空 path、非法 access 不抛异常', () => {
  const compiled = compile({
    rules: [
      { id: 'ok', path: 'D:/ok', access: 'read' },
      { id: 'empty', path: '', access: 'read' },
      { id: 'blank', path: '   ', access: 'read' },
      { id: 'missing', access: 'read' },
      { id: 'bad-access', path: 'D:/bad', access: 'execute' },
      { id: 'upper-access', path: 'D:/bad2', access: 'READ' },
      { id: 'no-access', path: 'D:/bad3' },
      null,
      'not-an-object',
      { id: 'ok2', path: 'D:/ok2', access: 'none' },
    ],
    home: HOME,
    windows: true,
  });

  assert.equal(compiled.rules.length, 2);
  assert.deepEqual(
    compiled.rules.map((r) => r.id),
    ['ok', 'ok2'],
  );
  assert.deepEqual(
    compiled.invalid.map((i) => i.index),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (const item of compiled.invalid) {
    assert.equal(typeof item.reason, 'string');
    assert.ok(item.reason.length > 0);
    assert.equal(typeof item.path, 'string');
  }
  // 有合法规则时 isEmpty 为 false；invalid 里的 path 原样回传（便于报错指出位置）。
  assert.equal(compiled.isEmpty, false);
  const pathByIndex = new Map(compiled.invalid.map((i) => [i.index, i.path]));
  assert.deepEqual(
    [...pathByIndex.entries()],
    [
      [1, ''],
      [2, '   '], // 空白 path 原样保留，便于定位配置
      [3, ''],
      [4, 'D:/bad'],
      [5, 'D:/bad2'],
      [6, 'D:/bad3'],
      [7, ''],
      [8, ''],
    ],
  );
  assert.match(compiled.invalid.find((i) => i.index === 1).reason, /empty/);
  assert.match(compiled.invalid.find((i) => i.index === 4).reason, /execute/);

  // 只有非法规则时 isEmpty 为 true，且没有任何规则可命中。
  const allBad = compile({ rules: [{ path: '', access: 'nope' }], home: HOME, windows: true });
  assert.equal(allBad.isEmpty, true);
  assert.equal(allBad.rules.length, 0);
  assert.equal(allBad.invalid.length, 1);
  assert.equal(match(allBad.rules, 'D:/x', {}), undefined);
});

test('10b. 归一化去重：同模式同档位只留最后一条（last-wins）', () => {
  const compiled = compileWin([
    { id: 'first', path: 'D:/dup', access: 'read' },
    { id: 'second', path: 'D:/dup/', access: 'read' }, // 归一化后与 first 同模式同档位 → 顶掉 first
    { id: 'other-access', path: 'D:/dup', access: 'list' },
  ]);
  assert.equal(compiled.rules.length, 2);
  assert.deepEqual(
    compiled.rules.map((r) => r.id),
    ['second', 'other-access'],
  );
  // 同模式下不同档位仍是两条规则，由具体性排序决定谁胜出（同键时下标大者胜）。
  assert.deepEqual(match(compiled.rules, 'D:/dup/x', {}), {
    access: 'list',
    ruleId: 'other-access',
    pattern: 'D:/dup',
  });
  assert.equal(match(compiled.rules, 'D:/dup', {}).ruleId, 'other-access');
});

// ---------------------------------------------------------------------------
// 11. capabilities
// ---------------------------------------------------------------------------

test('11. capabilities 与 ACCESS_LEVELS', () => {
  assert.deepEqual(ACCESS_LEVELS, ['none', 'list', 'read', 'write']);
  assert.deepEqual(capabilities('none'), { list: false, read: false, write: false });
  assert.deepEqual(capabilities('list'), { list: true, read: false, write: false });
  assert.deepEqual(capabilities('read'), { list: true, read: true, write: false });
  assert.equal(capabilities('read').write, false);
  assert.deepEqual(capabilities('write'), { list: true, read: true, write: true });
  // 未知档位按最严处理。
  assert.deepEqual(capabilities('execute'), { list: false, read: false, write: false });
  assert.deepEqual(capabilities(undefined), { list: false, read: false, write: false });
});

// ---------------------------------------------------------------------------
// contains
// ---------------------------------------------------------------------------

test('contains：词法祖先判定', () => {
  assert.equal(contains('D:/a', 'D:/a/b/c.txt', true), true);
  assert.equal(contains('D:/a', 'D:/a', true), true);
  assert.equal(contains('D:/a', 'D:/ab/c.txt', true), false);
  assert.equal(contains('/a/b', '/a/b/c', false), true);
  assert.equal(contains('/a/b', '/a/bc', false), false);
  assert.equal(contains('D:/A', 'd:/a/b.txt', true), true);
  assert.equal(contains('D:/A', 'd:/a/b.txt', false), false);
  // 不同驱动器前缀不通用。
  assert.equal(contains('D:/a', 'E:/a/b', true), false);
  // 大小写不同的盘符在 windows 语义下相等。
  assert.equal(contains('d:/a', 'D:/a/b', true), true);
  // 归一化参与判定。
  assert.equal(contains('D:/a/../b', 'D:/b/c', true), true);
  assert.equal(contains('D:\\a', 'D:/a/b', true), true);
  // 根不作为祖先通过（避免把整个盘符当成命中）。
  assert.equal(contains('/', '/a/b', false), false);
  // 空输入不抛。
  assert.equal(contains('', 'D:/a', true), false);
  assert.equal(contains(undefined, 'D:/a', true), false);
});

// ---------------------------------------------------------------------------
// 综合：默认档位与半访问语义
// ---------------------------------------------------------------------------

test('综合：调用方用 capabilities 把命中结果落成能力位', () => {
  const compiled = compile({
    rules: [
      { id: 'ssh', path: '~/.ssh', access: 'list' },
      { id: 'secrets', path: 'D:/secrets/**', access: 'none' },
      { id: 'work', path: '${workspace}/**', access: 'write' },
      { id: 'notes', path: '~/.ssh/notes.txt', access: 'read' },
    ],
    home: HOME,
    windows: true,
  });

  const decide = (p, workspace = WS) => {
    const hit = match(compiled.rules, p, { workspace });
    return capabilities(hit ? hit.access : undefined); // 无命中 → defaultAccess = none
  };

  assert.deepEqual(decide(`${HOME}/.ssh/id_rsa`), { list: true, read: false, write: false });
  assert.deepEqual(decide(`${HOME}/.ssh/notes.txt`), { list: true, read: true, write: false });
  assert.deepEqual(decide('D:/secrets/token.txt'), { list: false, read: false, write: false });
  assert.deepEqual(decide(`${WS}/src/a.js`), { list: true, read: true, write: true });
  assert.deepEqual(decide('D:/elsewhere/a.js'), { list: false, read: false, write: false });
});

// ---------------------------------------------------------------------------
// 12. Windows 路径模型：UNC 身份（docs/ARCHITECTURE.md §3.3）
// ---------------------------------------------------------------------------

test('12. UNC 与 POSIX 是不同身份；两种 UNC 拼写是同一身份', () => {
  const compiled = compileWin([{ id: 'unc', path: '\\\\srv\\share\\sec', access: 'none' }]);
  assert.equal(compiled.invalid.length, 0);

  // 两种 UNC 写法（DOS 设备路径 / 正斜杠）互相命中。
  assert.equal(match(compiled.rules, '\\\\srv\\share\\sec\\a.txt', {}).ruleId, 'unc');
  assert.equal(match(compiled.rules, '//srv/share/sec/a.txt', {}).ruleId, 'unc');
  // 共享根本身与其下任意深度都覆盖。
  assert.equal(match(compiled.rules, '\\\\srv\\share\\sec', {}).ruleId, 'unc');
  assert.equal(match(compiled.rules, '//srv/share/sec/deep/a/b.txt', {}).ruleId, 'unc');

  // 关键：不得与同后缀的 POSIX 路径碰撞（旧实现把 UNC 折成 /srv/share/sec）。
  assert.equal(match(compiled.rules, '/srv/share/sec/a.txt', {}), undefined);
  assert.equal(match(compiled.rules, '/srv/share/sec', {}), undefined);

  // 反向：POSIX 规则不命中 UNC 候选。
  const posix = compileWin([{ id: 'posix', path: '/srv/share/sec', access: 'none' }]);
  assert.equal(match(posix.rules, '/srv/share/sec/a.txt', {}).ruleId, 'posix');
  assert.equal(match(posix.rules, '\\\\srv\\share\\sec\\a.txt', {}), undefined);
  assert.equal(match(posix.rules, '//srv/share/sec/a.txt', {}), undefined);
});

test('12b. UNC 规则的祖先语义不越过 server/share 边界', () => {
  const compiled = compileWin([{ id: 'share', path: '\\\\srv\\share', access: 'read' }]);
  assert.equal(match(compiled.rules, '\\\\srv\\share', {}).ruleId, 'share');
  assert.equal(match(compiled.rules, '\\\\srv\\share\\a\\b', {}).ruleId, 'share');
  assert.equal(match(compiled.rules, '\\\\srv\\other\\a', {}), undefined);
  assert.equal(match(compiled.rules, '\\\\other\\share\\a', {}), undefined);
  // POSIX 同后缀同样不命中。
  assert.equal(match(compiled.rules, '/srv/share/a', {}), undefined);
  // 通配符在 UNC 共享下照常工作。
  const glob = compileWin([{ id: 'g', path: '//srv/share/**', access: 'none' }]);
  assert.equal(match(glob.rules, '\\\\srv\\share\\x\\y', {}).ruleId, 'g');
  assert.equal(match(glob.rules, '//srv/share', {}).ruleId, 'g');
  assert.equal(match(glob.rules, '//srv/share2/x', {}), undefined);
});

test('12c. contains 在命名空间边界上不误判', () => {
  assert.equal(contains('//srv/share', '//srv/share/a', true), true);
  assert.equal(contains('//srv/share', '//srv/share', true), true);
  assert.equal(contains('//srv/share', '/srv/share/a', true), false);
  assert.equal(contains('/srv/share', '//srv/share/a', true), false);
  assert.equal(contains('//srv/share', '//srv/other/a', true), false);
  assert.equal(contains('//SRV/SHARE', '//srv/share/a', true), true);
  assert.equal(contains('//SRV/SHARE', '//srv/share/a', false), false);
});

// ---------------------------------------------------------------------------
// 13. 扩展长度前缀 / 设备命名空间
// ---------------------------------------------------------------------------

test('13. \\\\?\\C:\\x 与 C:\\x 同一身份；\\\\?\\UNC\\… 与 UNC 同一身份', () => {
  const plain = compileWin([{ id: 'c', path: 'C:\\x', access: 'write' }]);
  assert.equal(match(plain.rules, '\\\\?\\C:\\x', {}).ruleId, 'c');
  assert.equal(match(plain.rules, '\\\\?\\C:\\x\\deep\\a.txt', {}).ruleId, 'c');
  assert.equal(match(plain.rules, 'C:\\x\\deep', {}).ruleId, 'c');

  // 规则写成扩展前缀时同样命中普通写法（双向）。
  const ext = compileWin([{ id: 'e', path: '\\\\?\\C:\\y', access: 'none' }]);
  assert.equal(match(ext.rules, 'C:\\y', {}).ruleId, 'e');
  assert.equal(match(ext.rules, 'C:/y/z.txt', {}).ruleId, 'e');

  const extUnc = compileWin([{ id: 'u', path: '\\\\?\\UNC\\srv\\share\\x', access: 'none' }]);
  assert.equal(match(extUnc.rules, '\\\\srv\\share\\x', {}).ruleId, 'u');
  assert.equal(match(extUnc.rules, '//srv/share/x', {}).ruleId, 'u');
  assert.equal(match(extUnc.rules, '/srv/share/x', {}), undefined);
});

test('13b. 设备命名空间 \\\\.\\C:\\x 不与普通路径/扩展前缀混同', () => {
  const plain = compileWin([{ id: 'plain', path: 'C:\\x', access: 'write' }]);
  assert.equal(match(plain.rules, '\\\\.\\C:\\x', {}), undefined);

  const device = compileWin([{ id: 'dev', path: '\\\\.\\C:\\x', access: 'read' }]);
  assert.equal(match(device.rules, '\\\\.\\C:\\x', {}).ruleId, 'dev');
  assert.equal(match(device.rules, 'C:\\x', {}), undefined);
  assert.equal(match(device.rules, '\\\\?\\C:\\x', {}), undefined);
  assert.equal(contains('\\\\.\\C:', '\\\\.\\C:\\x', true), true);
  assert.equal(contains('C:/x', '\\\\.\\C:\\x', true), false);
});

test('13c. 卷 GUID 目标保留独立命名空间，不被当成盘符', () => {
  const volume = compileWin([{ id: 'vol', path: '\\\\?\\Volume{1a2b}\\data', access: 'none' }]);
  assert.equal(match(volume.rules, '\\\\?\\Volume{1a2b}\\data\\x', {}).ruleId, 'vol');
  // 词法层无法把卷 GUID 映射成盘符，因此两者绝不互相命中。
  assert.equal(match(volume.rules, 'C:\\data\\x', {}), undefined);
  assert.equal(match(volume.rules, '\\\\srv\\share\\data\\x', {}), undefined);
  const drive = compileWin([{ id: 'd', path: 'C:\\data', access: 'none' }]);
  assert.equal(match(drive.rules, '\\\\?\\Volume{1a2b}\\data\\x', {}), undefined);
});

// ---------------------------------------------------------------------------
// 14. 驱动器相对路径：不可判定 + fail-safe
// ---------------------------------------------------------------------------

test('14. 驱动器相对 C:foo：规则进 invalid，候选 fail-safe 拒绝', () => {
  const compiled = compileWin([
    { id: 'safe', path: 'C:/safe', access: 'write' },
    { id: 'rel-drive', path: 'C:foo', access: 'write' },
    { id: 'drive-only', path: 'C:', access: 'write' },
  ]);
  assert.deepEqual(compiled.rules.map((r) => r.id), ['safe']);
  assert.deepEqual(compiled.invalid.map((i) => i.index), [1, 2]);
  assert.match(compiled.invalid[0].reason, /drive-relative/);
  assert.match(compiled.invalid[0].reason, /C:foo/);
  assert.match(compiled.invalid[1].reason, /C:/);

  // 候选不可判定 → 不套用任何规则、也不落到 defaultAccess，而是 fail-safe 拒绝。
  assert.deepEqual(match(compiled.rules, 'C:foo', {}), {
    access: 'none',
    ruleId: '<undecidable>',
    pattern: 'C:foo',
  });
  assert.equal(match(compiled.rules, 'C:', {}).access, 'none');
  assert.equal(match(compiled.rules, 'C:', {}).ruleId, '<undecidable>');
  // 绝对拼写照常可判定。
  assert.equal(match(compiled.rules, 'C:/safe/x', {}).ruleId, 'safe');
  // 空规则表也不影响 fail-safe：判定不依赖「有没有规则」。
  assert.equal(match([], 'C:foo', {}).access, 'none');
});

test('14b. C:foo 不再被当作 workspace 相对路径（旧行为的回归测试）', () => {
  // 旧实现：expandPath('C:foo', {workspace}) → '<workspace>/C:foo'，把盘符相对
  // 当成了普通相对路径。现在原样回传，调用方能看到「此刻不可判定」。
  assert.equal(expandPath('C:foo', { workspace: WS }), 'C:foo');
  assert.equal(expandPath('C:', { workspace: WS }), 'C:');
  assert.equal(expandPath('C:\\foo', { workspace: WS }), 'C:/foo');
  assert.equal(expandPath('C:/foo', { workspace: WS }), 'C:/foo');

  // 单字母冒号前缀在 POSIX 上也是合法文件名（`a:b`），歧义必须由调用方消解
  // （写成 `./a:b`），策略层不替它选。
  assert.equal(expandPath('a:b', { workspace: WS }), 'a:b');
  assert.equal(expandPath('./a:b', { workspace: '/ws' }), '/ws/a:b');
  // 但落在盘符命名空间下时，`a:b` 就是 `a` 的 ADS（同一个 `a`）——命名空间决定语义。
  assert.equal(expandPath('./a:b', { workspace: WS }), `${WS}/a`);
  const single = compileWin([{ id: 'x', path: 'a:b', access: 'read' }]);
  assert.equal(single.isEmpty, true);
  assert.equal(match(single.rules, 'a:b', {}).access, 'none');
  // 显式相对写法在盘符 workspace 下与宿主文件等价（规则不会成为永不命中的死规则）。
  const streamy = compileWin([{ id: 'sa', path: './a:b', access: 'none' }]);
  assert.equal(match(streamy.rules, `${WS}/a`, { workspace: WS }).ruleId, 'sa');
  assert.equal(match(streamy.rules, `${WS}/a:$DATA`, { workspace: WS }).ruleId, 'sa');
});

test('14c. 缺 share 的 UNC 与只有命名空间标记的输入 → 不可判定', () => {
  const compiled = compileWin([
    { id: 'bad1', path: '\\\\srv', access: 'none' },
    { id: 'bad2', path: '//srv', access: 'none' },
    { id: 'bad3', path: '\\\\?\\', access: 'none' },
    { id: 'bad4', path: '\\\\.\\', access: 'none' },
    { id: 'ok', path: '\\\\srv\\share', access: 'read' },
  ]);
  assert.deepEqual(compiled.rules.map((r) => r.id), ['ok']);
  assert.deepEqual(compiled.invalid.map((i) => i.index), [0, 1, 2, 3]);
  for (const bad of compiled.invalid) {
    assert.match(bad.reason, /UNC|names no/);
  }
  assert.equal(match(compiled.rules, '\\\\srv', {}).ruleId, '<undecidable>');
  assert.equal(match(compiled.rules, '//srv', {}).ruleId, '<undecidable>');
});

// ---------------------------------------------------------------------------
// 15. Windows 末段尾部点/空格（含 GetFullPathNameW 实测证据）
// ---------------------------------------------------------------------------

test('15. Windows 末段尾部点/空格归一：C:\\x. ≡ C:\\x ≡ C:\\x␠', () => {
  const compiled = compileWin([{ id: 'x', path: 'C:/x', access: 'none' }]);
  assert.equal(match(compiled.rules, 'C:\\x.', {}).ruleId, 'x');
  assert.equal(match(compiled.rules, 'C:\\x ', {}).ruleId, 'x');
  assert.equal(match(compiled.rules, 'C:\\x.\\y.txt', {}).ruleId, 'x');
  assert.equal(match(compiled.rules, 'C:/x/', {}).ruleId, 'x');

  // 规则一侧同样归一化：`C:/y.` 与 `C:/y` 是同一条规则（被归一化去重合并）。
  const dotted = compileWin([
    { id: 'first', path: 'C:/y', access: 'read' },
    { id: 'second', path: 'C:/y.', access: 'read' },
  ]);
  assert.equal(dotted.rules.length, 1);
  assert.equal(dotted.rules[0].id, 'second');
  assert.equal(match(dotted.rules, 'C:/y/z', {}).ruleId, 'second');
});

test('15b. 中间段只剥尾部点、不剥尾部空格（GetFullPathNameW 实测行为）', () => {
  const compiled = compileWin([{ id: 'x', path: 'C:/x', access: 'none' }]);
  // `C:\x.\y` → `C:\x\y`：中间段的尾部点被剥掉。
  assert.equal(match(compiled.rules, 'C:\\x.\\y', {}).ruleId, 'x');
  // `C:\x .\y` → `C:\x \y`：中间段的尾部空格保留，因此不落在 `C:/x` 之下。
  assert.equal(match(compiled.rules, 'C:\\x .\\y', {}), undefined);
  // 中间段的「点 + 空格」只剥到空格为止（`x. .` → `x. `）。
  assert.equal(match(compiled.rules, 'C:\\x. .\\y', {}), undefined);

  // 末段的点/空格混合尾一起剥掉（`x. .` → `x`，`x .` → `x`）。
  const mixed = compileWin([{ id: 'z', path: 'C:/z', access: 'none' }]);
  assert.equal(match(mixed.rules, 'C:\\z. .', {}).ruleId, 'z');
  assert.equal(match(mixed.rules, 'C:\\z .', {}).ruleId, 'z');
  assert.equal(match(mixed.rules, 'C:\\z...', {}).ruleId, 'z');
});

test('15c. POSIX 不折叠尾部点/空格（同一字符串在两套语义下不同）', () => {
  // POSIX 文件名可以以点/空格结尾：`/x.` 与 `/x` 是两个资源。
  const posix = compile({ rules: [{ id: 'px', path: '/x', access: 'none' }], windows: true });
  assert.equal(match(posix.rules, '/x.', {}), undefined);
  assert.equal(match(posix.rules, '/x ', {}), undefined);
  assert.equal(expandPath('/x.', {}), '/x.');
  assert.equal(expandPath('/x ', {}), '/x ');
  // 反过来也一样：写 `/x.` 的规则只覆盖 `/x.`。
  const dotted = compile({ rules: [{ id: 'pd', path: '/x.', access: 'none' }], windows: true });
  assert.equal(match(dotted.rules, '/x.', {}).ruleId, 'pd');
  assert.equal(match(dotted.rules, '/x', {}), undefined);
});

test('15d. 全点分量：中间段保留原样，末段剥空后消失', () => {
  // 中间段 `...` 保留（`GetFullPathNameW('...\y')` → `...\y`），所以它不是空段。
  const dottedRule = compileWin([{ id: 'dd', path: 'C:/x/.../y', access: 'read' }]);
  assert.equal(match(dottedRule.rules, 'C:\\x\\...\\y', {}).ruleId, 'dd');
  assert.equal(match(dottedRule.rules, 'C:\\x\\y', {}), undefined);

  // 末段 `...` 剥空 → 该分量消失（`GetFullPath('...')` → 父目录）。
  const parent = compileWin([{ id: 'x', path: 'C:/x', access: 'none' }]);
  assert.equal(match(parent.rules, 'C:\\x\\...', {}).ruleId, 'x');
});

// ---------------------------------------------------------------------------
// 16. ADS：file.txt:stream
// ---------------------------------------------------------------------------

test('16. ADS 决定：流折叠到宿主文件，deny 规则不会被 :stream 绕过', () => {
  const compiled = compileWin([{ id: 'secrets', path: 'C:/secrets/token.txt', access: 'none' }]);
  assert.equal(match(compiled.rules, 'C:/secrets/token.txt:$DATA', {}).ruleId, 'secrets');
  assert.equal(match(compiled.rules, 'C:/secrets/token.txt:hidden', {}).ruleId, 'secrets');
  assert.equal(match(compiled.rules, 'C:\\secrets\\token.txt:evil', {}).ruleId, 'secrets');
  // 更长的流名与空流名（`f.txt:` 就是默认流）同样折叠。
  assert.equal(match(compiled.rules, 'C:/secrets/token.txt:', {}).ruleId, 'secrets');
  // `:` 出现在非末段（`token.txt:a/b`）时不折叠：Windows 不接受这种拼写，
  // 它指向不了任何真实资源，本层保持其为独立身份（见 16b）。
  assert.equal(match(compiled.rules, 'C:/secrets/token.txt:a/b', {}), undefined);

  // 目录规则覆盖其下所有文件的流。
  const dir = compileWin([{ id: 'dir', path: 'C:/secrets/**', access: 'none' }]);
  assert.equal(match(dir.rules, 'C:/secrets/a/b.txt:s', {}).ruleId, 'dir');

  // 规则一侧也折叠：写 `:private` 的规则等于写宿主文件（这是「同一资源」的宣告）。
  const streamRule = compileWin([{ id: 'sr', path: 'C:/x/f.txt:private', access: 'none' }]);
  assert.equal(match(streamRule.rules, 'C:/x/f.txt', {}).ruleId, 'sr');
  assert.equal(match(streamRule.rules, 'C:/x/f.txt:other', {}).ruleId, 'sr');
  // 回传给调用方的 pattern 永远是用户写的原文，不做改写。
  assert.equal(match(streamRule.rules, 'C:/x/f.txt', {}).pattern, 'C:/x/f.txt:private');
});

test('16b. ADS 折叠只作用于 Windows 命名空间与最后一个分量', () => {
  // POSIX 上 `:` 是普通文件名字符。
  const posix = compile({ rules: [{ id: 'pf', path: '/x/f.txt', access: 'read' }], windows: true });
  assert.equal(match(posix.rules, '/x/f.txt:s', {}), undefined);
  assert.equal(expandPath('/x/f.txt:s', {}), '/x/f.txt:s');
  const posixStream = compile({ rules: [{ id: 'ps', path: '/x/f.txt:s', access: 'read' }], windows: true });
  assert.equal(match(posixStream.rules, '/x/f.txt:s', {}).ruleId, 'ps');
  assert.equal(match(posixStream.rules, '/x/f.txt', {}), undefined);

  // 非末段分量里的 `:` 不折叠（Windows 也不接受这种拼写），保持独立身份。
  const mid = compileWin([{ id: 'mid', path: 'C:/a:b/c', access: 'read' }]);
  assert.equal(match(mid.rules, 'C:/a:b/c', {}).ruleId, 'mid');
  assert.equal(match(mid.rules, 'C:/a/c', {}), undefined);
});

// ---------------------------------------------------------------------------
// 17. 词法层解决不了的边界：记录，而不是假装处理
// ---------------------------------------------------------------------------

test('17. 8.3 短名/长名：词法层不统一（由 ctx.fs.resolve() 的规范化 pass 负责）', () => {
  // 实测：`fs.realpathSync('C:\\Users\\SUSEVE~1')` 连大小写都不改写，所以只有
  // 文件系统身份（dev+ino / realpath）能识别 8.3 别名；DSH 自己在
  // packages/fs/fs-sandbox/src/containment.ts:46-76 就是「词法快路径 + stat 兜底」。
  // 因此本层**不假装**能展开短名，只保证不会因为不认识就放宽判定。
  const long = compileWin([{ id: 'long', path: 'C:/Program Files/app/config.json', access: 'none' }]);
  assert.equal(match(long.rules, 'C:/PROGRA~1/app/config.json', {}), undefined);
  const short = compileWin([{ id: 'short', path: 'C:/PROGRA~1/app', access: 'none' }]);
  assert.equal(match(short.rules, 'C:/Program Files/app/config.json', {}), undefined);
  assert.equal(contains('C:/PROGRA~1', 'C:/Program Files/app/config.json', true), false);

  // 本层能做的只有大小写折叠这一件，它不能替代身份解析。
  assert.equal(match(long.rules, 'c:/program files/app/config.json', {}).ruleId, 'long');
});

test('17b. junction/symlink 与 ADS 的真实身份同样委派给 canonical target', () => {
  // 词法层只看拼写：`C:/link/x` 不会因为 link 指向 C:/real 就命中 `C:/real/**`。
  const real = compileWin([{ id: 'real', path: 'C:/real/**', access: 'none' }]);
  assert.equal(match(real.rules, 'C:/link/x', {}), undefined);
  const link = compileWin([{ id: 'link', path: 'C:/link/**', access: 'none' }]);
  assert.equal(match(link.rules, 'C:/real/x', {}), undefined);
  // 这条测试是**边界记录**，不是「已处理」的声明：真实判定由 index.js 在
  // `ctx.fs.resolve()` 之后用 canonical path 再判一次。
});

test('17c. 边界记录：POSIX 上 `\\` 仍被当作分隔符（刻意的跨平台近似）', () => {
  // POSIX 文件名可以含 `\`（DSH 的 tool-fs-search 有专门测试记录这点）。本层为了
  // 兼容跨平台配置在所有命名空间里都折叠 `\`：POSIX 上名为 `a\b` 的文件会被
  // `/x/a/b` 的规则覆盖（deny 方向是收紧，allow 方向是既有的近似）。
  const compiled = compile({ rules: [{ id: 'p', path: '/x/a/b', access: 'read' }], windows: true });
  assert.equal(match(compiled.rules, '/x/a\\b', {}).ruleId, 'p');
  assert.equal(expandPath('/x/a\\b', {}), '/x/a/b');
});

// ---------------------------------------------------------------------------
// 18. 预编译匹配器（docs/ARCHITECTURE.md §3.4）
// ---------------------------------------------------------------------------

/**
 * 测试自带的独立「逐条扫描」实现，用于给优化后的匹配器做对照。
 * 它只用公开 API（`expandPath`）与规则对象上的公开字段，不碰实现内部。
 */

/** 独立的 glob→regex（只覆盖对照用例用到的形态：字面量、`*`、`?`、结尾 `**`）。 */
function refGlobToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; ) {
    const ch = glob[i];
    if (ch === '*') {
      let run = 0;
      while (glob[i + run] === '*') {
        run += 1;
      }
      const nextSlash = glob[i + run] === '/';
      if (run === 1) {
        out += '[^/]*';
      } else if (out.endsWith('/')) {
        out = `${out.slice(0, -1)}${nextSlash ? '(?:/.*)?/' : '(?:/.*)?'}`;
      } else {
        out += nextSlash ? '(?:.*/)?' : '.*';
      }
      i += run;
      if (run > 1 && nextSlash) {
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/** 独立的祖先链：按 `/` 逐层上溯（多出的 `C:` / `//srv` 等前缀不可能是合法规则键）。 */
function refAncestors(key) {
  const chain = [key];
  let current = key;
  for (;;) {
    const cut = current.lastIndexOf('/');
    if (cut <= 0) {
      return chain;
    }
    current = current.slice(0, cut);
    chain.push(current);
  }
}

/** 独立的判定：每条规则 × 每个祖先，必要时现建 regex。 */
function refDecide(rules, path, workspace, home) {
  const candidate = expandPath(path, { home, workspace });
  let best;
  for (const rule of rules) {
    let pattern;
    if (rule.needsWorkspace === true) {
      if (workspace === undefined) {
        continue;
      }
      pattern = expandPath(rule.pattern, { home, workspace });
    } else {
      pattern = rule.normalized;
    }
    const folded = rule.windows === true ? pattern.toLowerCase() : pattern;
    const cand = rule.windows === true ? candidate.toLowerCase() : candidate;
    const regex = refGlobToRegExp(folded);
    let ancestorLength = -1;
    for (const ancestor of refAncestors(cand)) {
      if (regex.test(ancestor)) {
        ancestorLength = ancestor.length;
        break;
      }
    }
    if (ancestorLength < 0) {
      continue;
    }
    const hit = { rule, ancestorLength };
    if (best === undefined) {
      best = hit;
      continue;
    }
    const moreSpecific =
      hit.ancestorLength !== best.ancestorLength
        ? hit.ancestorLength > best.ancestorLength
        : hit.rule.prefixLength !== best.rule.prefixLength
          ? hit.rule.prefixLength > best.rule.prefixLength
          : hit.rule.wildcards !== best.rule.wildcards
            ? hit.rule.wildcards < best.rule.wildcards
            : hit.rule.index > best.rule.index;
    if (moreSpecific) {
      best = hit;
    }
  }
  return best === undefined
    ? undefined
    : { access: best.rule.access, ruleId: best.rule.id, pattern: best.rule.pattern };
}

test('18. compile 预编译匹配物：literal / regex / workspace 各就各位', () => {
  const compiled = compileWin([
    { id: 'lit', path: 'D:/a/b', access: 'read' },
    { id: 'glob', path: 'D:/a/*', access: 'list' },
    { id: 'ws', path: '${workspace}/src/**', access: 'write' },
  ]);
  const [lit, glob, ws] = compiled.rules;
  assert.equal(lit.literal, 'd:/a/b');
  assert.equal(lit.regex, null);
  assert.equal(glob.literal, null);
  assert.ok(glob.regex instanceof RegExp);
  // `RegExp#source` 会把分隔符 `/` 转义，这是标准的 source 拼写。
  assert.equal(glob.regex.source, '^d:\\/a\\/[^/]*$');
  assert.equal(ws.literal, null);
  assert.equal(ws.regex, null); // workspace 规则在 match 期按 workspace 编译并缓存
  assert.equal(ws.normalized, '${workspace}/src/**');
  assert.equal(ws.needsWorkspace, true);

  // 反复判定结果稳定（workspace 缓存不会串味，多 workspace 交替也一致）。
  for (let i = 0; i < 3; i += 1) {
    assert.equal(match(compiled.rules, 'D:/a/b/c', { workspace: WS }).ruleId, 'lit');
    assert.equal(match(compiled.rules, `${WS}/src/x.js`, { workspace: WS }).ruleId, 'ws');
    assert.equal(match(compiled.rules, 'D:/w2/src/x.js', { workspace: 'D:/w2' }).ruleId, 'ws');
    assert.equal(match(compiled.rules, `${WS}/src/x.js`, { workspace: 'D:/other' }), undefined);
    assert.equal(match(compiled.rules, `${WS}/src/x.js`, {}), undefined);
  }
});

test('18b. 200 规则 × 1000 路径：与逐条扫描一致，且总耗时 < 300ms', () => {
  const PERF_HOME = '/home/perf';
  const PERF_WS = 'D:/perf';
  const ACCESSES = ['none', 'list', 'read', 'write'];

  const perfRules = [];
  for (let i = 0; i < 200; i += 1) {
    const access = ACCESSES[i % ACCESSES.length];
    switch (i % 5) {
      case 0:
        perfRules.push({ id: `lit-${i}`, path: `D:/perf/t${i}/sub/file.txt`, access });
        break;
      case 1:
        perfRules.push({ id: `star-${i}`, path: `D:/perf/t${i}/*`, access });
        break;
      case 2:
        perfRules.push({ id: `gs-${i}`, path: `D:/perf/t${i}/**`, access });
        break;
      case 3:
        perfRules.push({ id: `ws-${i}`, path: `\${workspace}/src/t${i}/**`, access });
        break;
      default:
        perfRules.push({ id: `home-${i}`, path: `~/.perf/t${i}/**`, access });
        break;
    }
  }

  const perfPaths = [];
  for (let n = 0; n < 1000; n += 1) {
    const i = n % 200;
    switch (n % 5) {
      case 0:
        perfPaths.push(`D:/perf/t${i}/sub/file.txt`);
        break;
      case 1:
        perfPaths.push(`D:/perf/t${i}/child.txt`);
        break;
      case 2:
        perfPaths.push(`D:/perf/t${i}/deep/a/b.txt`);
        break;
      case 3:
        perfPaths.push(`D:/perf/src/t${i}/x/y.js`);
        break;
      default:
        perfPaths.push(`/home/perf/.perf/t${i}/notes.md`);
        break;
    }
  }

  const compiled = compile({ rules: perfRules, home: PERF_HOME, windows: true });
  assert.equal(compiled.invalid.length, 0);
  assert.equal(compiled.rules.length, 200);

  // 1) 正确性：与逐条扫描逐项一致（每一条路径都必须有决定，避免「两边都是 undefined」的假通过）。
  let decided = 0;
  for (const path of perfPaths) {
    const actual = match(compiled.rules, path, { workspace: PERF_WS });
    const expected = refDecide(compiled.rules, path, PERF_WS, PERF_HOME);
    assert.deepEqual(actual, expected, path);
    if (actual !== undefined) {
      decided += 1;
    }
  }
  assert.equal(decided, perfPaths.length);

  // 2) 性能：用一份**新的** compile 产物计时，让 workspace 缓存也是冷的（最坏情况）。
  const cold = compile({ rules: perfRules, home: PERF_HOME, windows: true });
  const started = performance.now();
  for (const path of perfPaths) {
    match(cold.rules, path, { workspace: PERF_WS });
  }
  const elapsed = performance.now() - started;
  const warmStarted = performance.now();
  for (const path of perfPaths) {
    match(cold.rules, path, { workspace: PERF_WS });
  }
  const warmElapsed = performance.now() - warmStarted;
  console.log(
    `[perf] 200 规则 × 1000 路径：冷 ${elapsed.toFixed(1)}ms / 热 ${warmElapsed.toFixed(1)}ms（上限 300ms）`,
  );
  // 宽松上限：容忍慢机器与 CI 抖动，只拦住「回到了每次重建 regex」的退化。
  assert.ok(elapsed < 300, `200 规则 × 1000 路径耗时 ${elapsed.toFixed(1)}ms，超过 300ms 上限`);
});
