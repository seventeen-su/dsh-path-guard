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
