import { describe, it, expect } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';
import { codexInstaller } from '../src/install/codex.js';
import { executePlan } from '../src/install/apply.js';
import { InstallFailedError } from '../src/install/rollback.js';
import type { Runner } from '../src/install/exec.js';
import { runInstall } from '../src/commands/install.js';
import { readState } from '../src/install/state.js';

const CODEX_ROOT = '.scion/markets/scion/codex';
const CODEX_PLUGIN = `${CODEX_ROOT}/plugins/demo`;
const CODEX_CATALOG = `${CODEX_ROOT}/.agents/plugins/marketplace.json`;
const KIMI_PLUGIN = '.scion/markets/scion/kimi/plugins/demo';

async function sourceDir(files: Record<string, string> = {}): Promise<string> {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    ...files,
  });
}

async function setup(files?: Record<string, string>) {
  const src = await sourceDir(files);
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const ir = await normalize(src, loadProfile('claude'));
  const now = () => new Date('2026-08-13T10:00:00.000Z');
  return { src, home, ir, now };
}

const okRunner: Runner = async () => ({ stdout: '', stderr: '' });

/** 在某条命令上抛错的 Runner；hook 让测试在抛错前先动一下文件系统 */
function failingRunner(
  match: (cmd: string, args: string[]) => boolean,
  hook?: () => Promise<void>,
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (match(cmd, args)) {
      await hook?.();
      throw new Error('codex: plugin add exploded');
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

const failsOnPluginAdd = (cmd: string, args: string[]) =>
  args[0] === 'plugin' && args[1] === 'add';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录树的内容级快照：相对路径 → 内容 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out[relative(root, abs)] = await readFile(abs, 'utf8');
    }
  }
  await walk(root);
  return out;
}

describe('rollback on a failed install', () => {
  it('removes a plugin root that did not exist before the run', async () => {
    const { home, ir } = await setup();
    const { run } = failingRunner(failsOnPluginAdd);

    const plan = await codexInstaller.preview(ir, { home, run });
    await expect(codexInstaller.execute(plan, { home, run })).rejects.toBeInstanceOf(
      InstallFailedError,
    );

    expect(await exists(join(home, CODEX_PLUGIN))).toBe(false);
    // catalog 本来也不存在，同样该消失，而不是留下一份只有半个安装的清单
    expect(await exists(join(home, CODEX_CATALOG))).toBe(false);
  });

  it('restores the previously installed version byte for byte', async () => {
    const { home, ir } = await setup();
    await codexInstaller.execute(await codexInstaller.preview(ir, { home, run: okRunner }), {
      home,
      run: okRunner,
    });

    const treeBefore = await snapshotTree(join(home, CODEX_PLUGIN));
    const catalogBefore = await readFile(join(home, CODEX_CATALOG));

    // 升级到一个内容不同、还多了一个文件的版本，最后一步失败
    const src2 = await sourceDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nBRAND NEW BODY\n',
      'docs/new.md': 'only in v2\n',
    });
    const ir2 = await normalize(src2, loadProfile('claude'));
    const { run } = failingRunner(failsOnPluginAdd);

    await expect(
      codexInstaller.execute(await codexInstaller.preview(ir2, { home, run }), { home, run }),
    ).rejects.toBeInstanceOf(InstallFailedError);

    expect(await snapshotTree(join(home, CODEX_PLUGIN))).toEqual(treeBefore);
    expect(await readFile(join(home, CODEX_CATALOG))).toEqual(catalogBefore);
    // 「已恢复原样」得当真：catalog 目录里不该多出本次失败安装留下的备份副本
    expect(await readdir(join(home, CODEX_ROOT, '.agents/plugins'))).toEqual([
      'marketplace.json',
    ]);
  });

  it('keeps backups the user already had while sweeping only this run\'s', async () => {
    const { home, ir } = await setup();
    await codexInstaller.execute(await codexInstaller.preview(ir, { home, run: okRunner }), {
      home,
      run: okRunner,
    });
    const mine = join(home, CODEX_CATALOG + '.scion-bak.an-older-run');
    await writeFile(mine, 'an earlier backup\n', 'utf8');

    const { run } = failingRunner(failsOnPluginAdd);
    await expect(
      codexInstaller.execute(await codexInstaller.preview(ir, { home, run }), { home, run }),
    ).rejects.toBeInstanceOf(InstallFailedError);

    expect((await readdir(join(home, CODEX_ROOT, '.agents/plugins'))).sort()).toEqual(
      ['marketplace.json', 'marketplace.json.scion-bak.an-older-run'].sort(),
    );
    expect(await readFile(mine, 'utf8')).toBe('an earlier backup\n');
  });

  it('leaves no snapshot leftovers behind after a successful install', async () => {
    const { home, ir } = await setup();
    for (let i = 0; i < 2; i++) {
      await codexInstaller.execute(await codexInstaller.preview(ir, { home, run: okRunner }), {
        home,
        run: okRunner,
      });
    }
    const siblings = await readdir(join(home, CODEX_ROOT, 'plugins'));
    expect(siblings).toEqual(['demo']);
  });

  it('names the successful command it could not undo', async () => {
    const { home, ir } = await setup();
    const { run } = failingRunner(failsOnPluginAdd);
    const plan = await codexInstaller.preview(ir, { home, run });

    const err = await codexInstaller
      .execute(plan, { home, run })
      .then(() => null)
      .catch((e: unknown) => e as InstallFailedError);

    expect(err).toBeInstanceOf(InstallFailedError);
    const message = (err as InstallFailedError).message;
    expect(message).toContain('rolled back');
    expect(message).toContain('Failed at:');
    expect(message).toContain('codex plugin add demo@scion');
    expect(message).toContain('NOT undone:');
    expect(message).toContain(`codex plugin marketplace add ${join(home, CODEX_ROOT)}`);
    expect(message).toContain('shared');
    // 原始失败原因不能被回滚报告吃掉
    expect(message).toContain('codex: plugin add exploded');
  });

  it('reports both the original failure and a rollback that itself failed', async () => {
    const { home, ir } = await setup();
    // 先成功装一次，让 catalog 有一份需要恢复的旧内容
    await codexInstaller.execute(await codexInstaller.preview(ir, { home, run: okRunner }), {
      home,
      run: okRunner,
    });

    const catalog = join(home, CODEX_CATALOG);
    // 在最后一条命令失败的同一时刻把 catalog 换成一个目录，让恢复写回必然失败
    const { run } = failingRunner(failsOnPluginAdd, async () => {
      await rm(catalog);
      await mkdir(catalog);
    });

    const err = await codexInstaller
      .execute(await codexInstaller.preview(ir, { home, run }), { home, run })
      .then(() => null)
      .catch((e: unknown) => e as InstallFailedError);

    const message = (err as InstallFailedError).message;
    expect(message).toContain('codex: plugin add exploded');
    expect(message).toContain('ROLLBACK FAILED');
    expect(message).toContain(catalog);
    // 恢复不了就得说清楚原内容被放到哪儿了
    expect(message).toMatch(/scion-rescue/);
  });
});

describe('executePlan', () => {
  // root 身份下权限位形同虚设，删不掉的备份目录造不出来
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('says so when it cannot clean up its own backup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const plugins = join(home, 'plugins');
    const root = join(plugins, 'demo');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'old.txt'), 'v1\n', 'utf8');

    const plan = {
      target: 'codex' as const,
      pluginRoot: root,
      registers: true,
      actions: [
        {
          kind: 'write-tree' as const,
          root,
          containmentRoot: plugins,
          files: ['new.txt'],
          payload: {},
        },
      ],
    };

    const result = await executePlan(plan, { target: loadProfile('codex') }, {
      // 假装 emit：写出新版本，然后把父目录设成不可写，让备份目录删不掉
      'write-tree': async () => {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'new.txt'), 'v2\n', 'utf8');
        await chmod(plugins, 0o500);
      },
    });

    await chmod(plugins, 0o700);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('.scion-bak.');
    expect(result.warnings[0]).toContain('delete it whenever you like');
    // 安装本身仍然算成功：新版本在，没有抛错
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('v2\n');
  });

  it('reports no warnings when the cleanup goes through', async () => {
    const { home, ir } = await setup();
    const plan = await codexInstaller.preview(ir, { home, run: okRunner });
    const outcome = await codexInstaller.execute(plan, { home, run: okRunner });
    expect(outcome.warnings).toEqual([]);
  });


  it('rolls back a kind it hands to an override handler', async () => {
    // kimi 的注册表写入走的是覆盖钩子，而 kimi 的 plan 里没有会失败的动作；用一个
    // 合成 plan 直接盯住「钩子处理的那一种也进撤销栈」这件事。
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const registry = join(home, 'installed.json');
    const original = '{\n  "version": 1,\n  "plugins": [ "hand written" ]\n}\n';
    await writeFile(registry, original, 'utf8');

    const plan = {
      target: 'kimi' as const,
      pluginRoot: join(home, 'plugins/demo'),
      registers: true,
      actions: [
        {
          kind: 'write-foreign-registry' as const,
          path: registry,
          entryKey: 'demo',
          op: 'update' as const,
          payload: {},
        },
        { kind: 'exec' as const, cmd: 'kimi', args: ['reload'] },
      ],
    };

    const run: Runner = async () => {
      throw new Error('kimi: reload failed');
    };

    await expect(
      executePlan(plan, { target: loadProfile('kimi'), run }, {
        'write-foreign-registry': async () => {
          await writeFile(registry, 'clobbered\n', 'utf8');
          return 'wrote the registry';
        },
      }),
    ).rejects.toBeInstanceOf(InstallFailedError);

    expect(await readFile(registry, 'utf8')).toBe(original);
  });
});

describe('runInstall with a failing target', () => {
  it('keeps the target that succeeded and rolls back only the one that failed', async () => {
    const src = await sourceDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const { run } = failingRunner(failsOnPluginAdd);

    const code = await runInstall(
      ['--to', 'kimi,codex', '--yes', src],
      { write: (s) => out.push(s) },
      { home, run },
    );

    expect(code).toBe(5);
    expect(await exists(join(home, KIMI_PLUGIN, 'kimi.plugin.json'))).toBe(true);
    expect(await exists(join(home, CODEX_PLUGIN))).toBe(false);

    const ledger = await readState(home);
    expect(ledger.map((r) => r.target)).toEqual(['kimi']);

    const text = out.join('');
    expect(text).toContain('[kimi] converted');
    expect(text).toContain('[codex] Install failed');
  });

  it('prints a re-run command that actually works', async () => {
    const src = await sourceDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const argv = ['--to', 'codex', '--yes', src];

    const first: string[] = [];
    const { run } = failingRunner(failsOnPluginAdd);
    expect(await runInstall(argv, { write: (s) => first.push(s) }, { home, run })).toBe(5);
    expect(first.join('')).toContain(`scion install ${argv.join(' ')}`);
    expect(await readState(home)).toEqual([]);

    const second: string[] = [];
    expect(
      await runInstall(argv, { write: (s) => second.push(s) }, { home, run: okRunner }),
    ).toBe(0);
    expect(await exists(join(home, CODEX_PLUGIN, '.codex-plugin/plugin.json'))).toBe(true);
    expect((await readState(home)).map((r) => r.target)).toEqual(['codex']);
  });
});
