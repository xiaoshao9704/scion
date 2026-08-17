import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInstall } from '../src/commands/install.js';
import type { Runner } from '../src/install/exec.js';

const PLUGIN_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
  'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
};

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/** 假 git：把 clone 的目标目录当成仓库内容摆出来，全程不联网 */
function cloningRunner(calls: string[][]): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'clone') {
      await writeFiles(args[args.length - 1], PLUGIN_FILES);
    }
    return { stdout: '', stderr: '' };
  };
}

/** 假 git，pin 版：checkout 落地时才把仓库内容摆出来，同样全程不联网 */
function pinnedRunner(calls: string[][], subdir: string): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === '-C' && args[2] === 'checkout') {
      await writeFiles(join(args[1], subdir), PLUGIN_FILES);
    }
    return { stdout: '', stderr: '' };
  };
}

/** Claude 已添加的市场，目录形态：<home>/.claude/plugins/marketplaces/<name>/ */
async function marketDir(home: string, name: string, catalog: unknown): Promise<string> {
  const root = join(home, '.claude/plugins/marketplaces', name);
  await writeFiles(root, { '.claude-plugin/marketplace.json': JSON.stringify(catalog) });
  return root;
}

/** 同上，裸 JSON 文件形态（无扩展名）——实测的内部市场就是这种 */
async function marketFile(home: string, name: string, catalog: unknown): Promise<string> {
  const dir = join(home, '.claude/plugins/marketplaces');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(catalog), 'utf8');
  return file;
}

async function newHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scion-home-'));
}

describe('scion install <plugin>@<marketplace>', () => {
  it('resolves an entry from a marketplace stored as a directory', async () => {
    const home = await newHome();
    const root = await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
    });
    await writeFiles(join(root, 'plugins/alpha'), PLUGIN_FILES);

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('alpha@team-skills');
    expect(text).toContain('[kimi] preview');
  });

  it('resolves an entry from a marketplace stored as a bare extension-less JSON file', async () => {
    const home = await newHome();
    await marketFile(home, 'acme-hub', {
      name: 'acme-hub',
      plugins: [
        { name: 'alpha', source: 'https://git.example.com/ee/alpha.git', description: 'A' },
      ],
    });

    const calls: string[][] = [];
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@acme-hub'],
      { write: (s) => out.push(s) },
      { home, run: cloningRunner(calls) },
    );

    expect(code).toBe(0);
    expect(out.join('')).toContain('[kimi] preview');
  });

  it('hands a git-URL entry to resolveSource, which clones it (injected runner, no network)', async () => {
    const home = await newHome();
    await marketFile(home, 'acme-hub', {
      name: 'acme-hub',
      plugins: [
        { name: 'alpha', source: 'https://git.example.com/ee/alpha.git', description: 'A' },
      ],
    });

    const calls: string[][] = [];
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@acme-hub'],
      { write: (s) => out.push(s) },
      { home, run: cloningRunner(calls) },
    );

    expect(code).toBe(0);
    const clone = calls.find((c) => c[0] === 'git' && c[1] === 'clone');
    expect(clone).toBeDefined();
    expect(clone!.slice(0, 5)).toEqual([
      'git',
      'clone',
      '--depth',
      '1',
      'https://git.example.com/ee/alpha.git',
    ]);
  });

  it('fetches the pinned commit for a git-subdir entry and says which pin it took', async () => {
    const home = await newHome();
    const sha = '30287f5ea9b2b4c1d6f0a7e8c3b5d4a2f1e0c9b8';
    await marketFile(home, 'acme-hub', {
      name: 'acme-hub',
      plugins: [
        {
          name: 'alpha',
          source: {
            source: 'git-subdir',
            url: 'https://git.example.com/ee/acme-toolkit.git',
            path: 'plugins/alpha',
            ref: 'v1.5.5',
            sha,
          },
        },
      ],
    });

    const calls: string[][] = [];
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@acme-hub'],
      { write: (s) => out.push(s) },
      { home, run: pinnedRunner(calls, 'plugins/alpha') },
    );

    expect(code).toBe(0);
    const doc = JSON.parse(out.join(''));
    // 报告跟着行为走：note 说的是实际取了哪个 pin，不是"不遵守 pin"
    expect(doc.via.notes.join('\n')).toContain(sha);
    expect(doc.via.notes.join('\n')).not.toMatch(/does not honour/);
    expect(calls.flat()).toContain(sha);
    expect(calls.flat()).not.toContain('v1.5.5');
  });

  it('refuses to install an entry whose pin git would read as an option', async () => {
    const home = await newHome();
    await marketFile(home, 'acme-hub', {
      name: 'acme-hub',
      plugins: [
        {
          name: 'alpha',
          source: {
            source: 'git-subdir',
            url: 'https://git.example.com/ee/acme-toolkit.git',
            path: 'plugins/alpha',
            sha: '--upload-pack=/tmp/evil',
          },
        },
      ],
    });

    const calls: string[][] = [];
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@acme-hub'],
      { write: (s) => out.push(s) },
      { home, run: cloningRunner(calls) },
    );

    expect(code).toBe(2);
    const doc = JSON.parse(out.join(''));
    expect(doc.findings[0]).toMatchObject({ level: 'BLOCK', code: 'source.pin-unsafe' });
    expect(calls).toEqual([]);
  });

  it('exits 1 and names every path it looked in when the marketplace is unknown', async () => {
    const home = await newHome();
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@nope'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain(join(home, '.claude/plugins/marketplaces/nope'));
    expect(text).toContain(join(home, '.scion/markets/nope/claude'));
  });

  it('lists exactly the paths it can actually find a marketplace in — no dead ones', async () => {
    // 一条永远命不中的路径出现在"我查过哪儿"里，等于叫用户去那儿放文件。用 --json 逐条
    // 核对，人读那一段是同一个结果对象渲染出来的。
    const home = await newHome();
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@nope'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(1);
    const doc = JSON.parse(out.join(''));
    expect(doc.error.searched.map((p: { path: string }) => p.path)).toEqual([
      join(home, '.claude/plugins/marketplaces/nope'),
      join(home, '.scion/markets/nope/claude'),
    ]);
  });

  it('exits 1 and suggests near-miss entry names when the plugin is not in the catalog', async () => {
    const home = await newHome();
    await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [
        { name: 'alpha-tools', source: './plugins/alpha-tools' },
        { name: 'unrelated', source: './plugins/unrelated' },
      ],
    });

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('alpha-tools');
    expect(text).not.toContain('unrelated');
  });

  it('suggests the entry a one-letter typo was aiming at', async () => {
    const home = await newHome();
    await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [
        { name: 'local-tool', source: './plugins/local-tool' },
        { name: 'unrelated', source: './plugins/unrelated' },
      ],
    });

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'local-toool@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('local-tool');
    expect(text).not.toContain('unrelated');
  });

  it('--dry-run resolves for real but writes nothing under home', async () => {
    const home = await newHome();
    const root = await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
    });
    await writeFiles(join(root, 'plugins/alpha'), PLUGIN_FILES);

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    // 预览说清楚 dry-run 究竟做了什么：查找与拉取真的发生了，只是不落盘
    expect(out.join('')).toContain('--dry-run');
    // 市场目录之外什么都没多出来：没有插件树，也没有账本
    expect(await readdir(home)).toEqual(['.claude']);
    expect(existsSync(join(home, '.scion'))).toBe(false);
  });

  it('carries the same resolution into --json, from the one result object', async () => {
    const home = await newHome();
    const root = await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
    });
    await writeFiles(join(root, 'plugins/alpha'), PLUGIN_FILES);

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    const doc = JSON.parse(out.join(''));
    expect(doc.via).toMatchObject({
      ref: 'alpha@team-skills',
      plugin: 'alpha',
      market: 'team-skills',
      sourceKind: 'path',
    });
    expect(doc.via.catalog).toContain('team-skills');
  });

  it('reports an unknown entry as parseable JSON, candidates included', async () => {
    const home = await newHome();
    await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [{ name: 'alpha-tools', source: './plugins/alpha-tools' }],
    });

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(1);
    const doc = JSON.parse(out.join(''));
    expect(doc.exitCode).toBe(1);
    expect(doc.error.code).toBe('entry-not-found');
    expect(doc.error.candidates).toEqual(['alpha-tools']);
  });

  // 装市场里的条目，就该继续挂在那个市场的名字下。收编进一个叫 "scion" 的市场，等于用
  // 工具名盖掉插件真正的出处——用户在 Kimi/Codex 里看到的市场名会跟他添加的那个对不上。
  it('installs a marketplace entry under the marketplace\'s own name, not "scion"', async () => {
    const home = await newHome();
    const root = await marketDir(home, 'team-skills', {
      name: 'team-skills',
      plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
    });
    await writeFiles(join(root, 'plugins/alpha'), PLUGIN_FILES);

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', 'alpha@team-skills'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    expect(existsSync(join(home, '.scion/markets/team-skills/kimi/plugins/alpha'))).toBe(true);
    expect(existsSync(join(home, '.scion/markets/scion'))).toBe(false);
  });

  // 反过来：不来自任何市场的源没有官方名字可继承，才回落到 scion。
  it('falls back to the scion marketplace for a source that belongs to no marketplace', async () => {
    const home = await newHome();
    const dir = join(home, 'loose-plugin');
    await writeFiles(dir, PLUGIN_FILES);

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', dir],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    expect(existsSync(join(home, '.scion/markets/scion/kimi/plugins/alpha'))).toBe(true);
  });

  it('refuses a catalog marketplace name that is not a safe path segment', async () => {
    const home = await newHome();
    await marketFile(home, 'evil', {
      name: '../../escape',
      plugins: [{ name: 'alpha', source: './plugins/alpha' }],
    });

    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', '--json', 'alpha@evil'],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(2);
    const doc = JSON.parse(out.join(''));
    expect(doc.findings[0]).toMatchObject({
      level: 'BLOCK',
      code: 'marketplace.name-unsafe',
    });
  });
});
