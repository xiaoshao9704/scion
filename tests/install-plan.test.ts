import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';
import { codexInstaller } from '../src/install/codex.js';
import { kimiInstaller } from '../src/install/kimi.js';
import { formatPlan, type InstallAction } from '../src/install/plan.js';

/**
 * 专门用来踩 planEmitFiles 与 emit 分歧点的插件：emit 用 cp 递归复制，planEmitFiles
 * 是对 cp 结果的预测，两者不是同一份实现。预测最容易错在这四处——符号链接（指向
 * 文件和指向目录各一个）、空目录、多层嵌套、以及顶层被跳过的目录——所以 fixture
 * 里每一样都要有，否则一致性断言只是在两个平坦文件上空转。
 */
async function makeGnarlyPluginDir(): Promise<string> {
  const root = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'gnarly', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    // 多层嵌套：不止一层子目录
    'skills/demo/nested/deep/NOTES.md': '# notes\n',
    'docs/readme.md': 'readme\n',
    // 顶层被跳过的目录：.git / node_modules 属 ALWAYS_SKIP，
    // .claude-plugin 属清单首段——三者都不该出现在落盘结果里
    '.git/config': '[core]\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
  });

  await mkdir(join(root, 'empty'));
  await mkdir(join(root, 'skills/demo/empty-nested'));
  await symlink('docs/readme.md', join(root, 'link-to-file'));
  await symlink('docs', join(root, 'link-to-dir'));
  await symlink('readme.md', join(root, 'docs/link-to-readme'));

  return root;
}

/** gnarly fixture 落盘后应当存在的文件，与目标生态的清单路径无关的那部分 */
const GNARLY_COPIED = [
  'docs/link-to-readme',
  'docs/readme.md',
  'link-to-dir',
  'link-to-file',
  'skills/demo/SKILL.md',
  'skills/demo/nested/deep/NOTES.md',
];

async function setup() {
  const src = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
  });
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const ir = await normalize(src, loadProfile('claude'));
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '' };
  };
  const now = () => new Date('2026-08-13T10:00:00.000Z');
  return { ir, home, calls, run, now };
}

/** 递归列出目录下所有文件的相对路径（排序），用于快照与一致性断言 */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(relative(root, abs));
    }
  }
  await walk(root);
  return out.sort();
}

/** 目录树的内容级快照：路径 → 内容，用于断言 preview 零副作用 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(root)) {
    out[rel] = await readFile(join(root, rel), 'utf8');
  }
  return out;
}

describe('codexInstaller.preview', () => {
  it('yields write-tree → upsert-catalog → exec ×2 in order', async () => {
    const { ir, home, run } = await setup();
    const plan = await codexInstaller.preview(ir, { home, run });

    expect(plan.target).toBe('codex');
    expect(plan.registers).toBe(true);
    expect(plan.pluginRoot).toBe(join(home, '.scion/markets/scion/codex/plugins/demo'));
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'write-tree',
      'upsert-catalog',
      'exec',
      'exec',
    ]);

    const tree = plan.actions[0] as Extract<InstallAction, { kind: 'write-tree' }>;
    expect(tree.root).toBe(plan.pluginRoot);
    expect(tree.containmentRoot).toBe(join(home, '.scion/markets/scion/codex/plugins'));
    // 真实投影：源里的 SKILL.md 原样带过去，加上转出的 codex 清单
    expect(tree.files).toEqual(['.codex-plugin/plugin.json', 'skills/demo/SKILL.md']);

    const catalog = plan.actions[1] as Extract<InstallAction, { kind: 'upsert-catalog' }>;
    expect(catalog.path).toBe(
      join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json'),
    );
    expect(catalog.entryKey).toBe('demo');
    expect(catalog.op).toBe('add');

    expect(plan.actions.slice(2)).toEqual([
      {
        kind: 'exec',
        cmd: 'codex',
        args: ['plugin', 'marketplace', 'add', join(home, '.scion/markets/scion/codex')],
        // 回滚不撤这条，理由随动作一起进 plan（见 tests/install-rollback.test.ts）
        whyNotUndone: expect.stringContaining('shared'),
      },
      { kind: 'exec', cmd: 'codex', args: ['plugin', 'add', 'demo@scion'] },
    ]);
  });

  it('reports update rather than add once the catalog already lists the entry', async () => {
    const { ir, home, run, now } = await setup();
    const plan = await codexInstaller.preview(ir, { home, run, now });
    await codexInstaller.execute(plan, { home, run, now });

    const second = await codexInstaller.preview(ir, { home, run, now });
    const catalog = second.actions[1] as Extract<InstallAction, { kind: 'upsert-catalog' }>;
    expect(catalog.op).toBe('update');
  });

  it('leaves the filesystem byte-for-byte unchanged and never runs a command', async () => {
    const { ir, home, run, calls, now } = await setup();
    // 先真装一次，让 home 里有 catalog 与插件树——空目录上的"零副作用"太容易通过
    await codexInstaller.execute(await codexInstaller.preview(ir, { home, run, now }), {
      home,
      run,
      now,
    });
    calls.length = 0;

    const before = await snapshotTree(home);
    await codexInstaller.preview(ir, { home, run, now });
    expect(await snapshotTree(home)).toEqual(before);
    expect(calls).toEqual([]);
  });

  it('promises exactly the files execute goes on to write, symlinks and skips included', async () => {
    const src = await makeGnarlyPluginDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const ir = await normalize(src, loadProfile('claude'));
    const run = async () => ({ stdout: '', stderr: '' });

    const plan = await codexInstaller.preview(ir, { home, run });
    const tree = plan.actions[0] as Extract<InstallAction, { kind: 'write-tree' }>;
    // 显式写出期望，让「跳过了什么」肉眼可见：.git / node_modules / .claude-plugin
    // 一个都不在，两个空目录不算文件，三条符号链接各算一个条目
    expect(tree.files).toEqual([...GNARLY_COPIED, '.codex-plugin/plugin.json'].sort());

    await codexInstaller.execute(plan, { home, run });

    expect(await listFiles(plan.pluginRoot)).toEqual(tree.files);
  });

  it('formats a plan the way the brief spells it out', async () => {
    const { ir, home, run } = await setup();
    const plan = await codexInstaller.preview(ir, { home, run });
    expect(formatPlan(plan)).toBe(
      [
        '[codex] preview (--dry-run, nothing is changed)',
        `  · write 2 files → ${join(home, '.scion/markets/scion/codex/plugins/demo')}/`,
        `  · update catalog ${join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json')} (add entry demo)`,
        `  · run codex plugin marketplace add ${join(home, '.scion/markets/scion/codex')}`,
        '  · run codex plugin add demo@scion',
        '',
      ].join('\n'),
    );
  });
});

describe('kimiInstaller.preview', () => {
  it('stops at the scion catalog by default, registering nothing', async () => {
    const { ir, home, now } = await setup();
    const plan = await kimiInstaller.preview(ir, { home, now });

    expect(plan.target).toBe('kimi');
    expect(plan.registers).toBe(false);
    expect(plan.actions.map((a) => a.kind)).toEqual(['write-tree', 'upsert-catalog']);
    expect(plan.pluginRoot).toBe(join(home, '.scion/markets/scion/kimi/plugins/demo'));

    const catalog = plan.actions[1] as Extract<InstallAction, { kind: 'upsert-catalog' }>;
    expect(catalog.path).toBe(join(home, '.scion/markets/scion/kimi/marketplace.json'));
    expect(catalog.op).toBe('add');
    expect(plan.note).toContain('KIMI_CODE_PLUGIN_MARKETPLACE_URL');
  });

  // --write-registry 不是另一种转换，只是在同一份产物之上多一步登记：产物仍在市场里，
  // 注册表把 Kimi 指过去。产物落到 Kimi 自己的目录会立刻产生第二份、并且和市场那份分叉。
  it('adds the kimi registry on top of the same marketplace artifact', async () => {
    const { ir, home, now } = await setup();
    const plan = await kimiInstaller.preview(ir, { home, writeRegistry: true, now });

    expect(plan.registers).toBe(true);
    expect(plan.pluginRoot).toBe(join(home, '.scion/markets/scion/kimi/plugins/demo'));
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'write-tree',
      'upsert-catalog',
      'write-foreign-registry',
    ]);

    const registry = plan.actions[2] as Extract<
      InstallAction,
      { kind: 'write-foreign-registry' }
    >;
    expect(registry.path).toBe(join(home, '.kimi-code/plugins/installed.json'));
    expect(registry.entryKey).toBe('demo');
    expect(registry.op).toBe('add');
  });

  it('tells the dry-run reader what writing the registry will mean', async () => {
    const { ir, home, now } = await setup();

    const first = await kimiInstaller.preview(ir, { home, writeRegistry: true, now });
    expect(first.note).toContain('first write, no backup needed');
    expect(first.note).toContain('Restart the Kimi session for it to take effect');
    expect(formatPlan(first)).toContain('first write, no backup needed');

    const outcome = await kimiInstaller.execute(first, { home, writeRegistry: true, now });
    // 落盘后换成完成态措辞，与抽象之前逐字一致
    expect(outcome.note).toBe(
      `Wrote ${join(home, '.kimi-code/plugins/installed.json')}. Restart the Kimi session for it to take effect.`,
    );

    // 注册表已存在，第二次预览应当预告备份
    const second = await kimiInstaller.preview(ir, { home, writeRegistry: true, now });
    expect(second.note).toContain('the existing file is backed up first');
    const again = await kimiInstaller.execute(second, { home, writeRegistry: true, now });
    expect(again.note).toBe(
      `Wrote ${join(home, '.kimi-code/plugins/installed.json')} (the previous file was backed up). Restart the Kimi session for it to take effect.`,
    );
  });

  it('reports update when the registry already carries the entry', async () => {
    const { ir, home, now } = await setup();
    await kimiInstaller.execute(
      await kimiInstaller.preview(ir, { home, writeRegistry: true, now }),
      { home, writeRegistry: true, now },
    );

    const plan = await kimiInstaller.preview(ir, { home, writeRegistry: true, now });
    const registry = plan.actions[2] as Extract<
      InstallAction,
      { kind: 'write-foreign-registry' }
    >;
    expect(registry.op).toBe('update');
  });

  it('rejects a corrupt registry during preview, before anything is written', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    const original = '{ not valid json';
    await writeFile(registryPath, original, 'utf8');

    const before = await snapshotTree(home);
    await expect(kimiInstaller.preview(ir, { home, writeRegistry: true, now })).rejects.toThrow(
      /installed\.json/,
    );
    expect(await snapshotTree(home)).toEqual(before);
  });

  it('rejects a corrupt catalog during preview on the default path', async () => {
    const { ir, home, now } = await setup();
    const catalogPath = join(home, '.scion/markets/scion/kimi/marketplace.json');
    await mkdir(join(home, '.scion/markets/scion/kimi'), { recursive: true });
    await writeFile(catalogPath, '{ not valid json', 'utf8');

    await expect(kimiInstaller.preview(ir, { home, now })).rejects.toThrow(/marketplace\.json/);
  });

  it('leaves the filesystem byte-for-byte unchanged', async () => {
    const { ir, home, now } = await setup();
    await kimiInstaller.execute(await kimiInstaller.preview(ir, { home, now }), { home, now });

    const before = await snapshotTree(home);
    await kimiInstaller.preview(ir, { home, now });
    await kimiInstaller.preview(ir, { home, writeRegistry: true, now });
    expect(await snapshotTree(home)).toEqual(before);
  });

  it('promises exactly the files execute goes on to write, symlinks and skips included', async () => {
    const src = await makeGnarlyPluginDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const ir = await normalize(src, loadProfile('claude'));
    const now = () => new Date('2026-08-13T10:00:00.000Z');

    const plan = await kimiInstaller.preview(ir, { home, now });
    const tree = plan.actions[0] as Extract<InstallAction, { kind: 'write-tree' }>;
    expect(tree.files).toEqual([...GNARLY_COPIED, 'kimi.plugin.json'].sort());

    await kimiInstaller.execute(plan, { home, now });

    expect(await listFiles(plan.pluginRoot)).toEqual(tree.files);
  });

  it('promises exactly the files execute writes on the --write-registry path too', async () => {
    const src = await makeGnarlyPluginDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const ir = await normalize(src, loadProfile('claude'));
    const now = () => new Date('2026-08-13T10:00:00.000Z');

    const plan = await kimiInstaller.preview(ir, { home, writeRegistry: true, now });
    const tree = plan.actions[0] as Extract<InstallAction, { kind: 'write-tree' }>;

    await kimiInstaller.execute(plan, { home, writeRegistry: true, now });

    expect(await listFiles(plan.pluginRoot)).toEqual(tree.files);
  });

  it('formats a plan with the note indented under the actions, every line of it', async () => {
    const { ir, home, now } = await setup();
    const plan = await kimiInstaller.preview(ir, { home, now });
    const noteLines = plan.note!.split('\n');
    // 这条 note 本来就是多行的；断言前先钉住这一点，否则下面的逐行缩进断言会在
    // 单行 note 上平凡通过，等于没测到"每一行都缩进"。
    expect(noteLines.length).toBeGreaterThan(1);

    expect(formatPlan(plan)).toBe(
      [
        '[kimi] preview (--dry-run, nothing is changed)',
        `  · write 2 files → ${join(home, '.scion/markets/scion/kimi/plugins/demo')}/`,
        `  · update catalog ${join(home, '.scion/markets/scion/kimi/marketplace.json')} (add entry demo)`,
        ...noteLines.map((line) => `  ${line}`),
        '',
      ].join('\n'),
    );
  });
});
