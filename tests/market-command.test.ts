import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runMarket } from '../src/commands/market.js';
import type { Runner } from '../src/install/exec.js';

async function fixture() {
  return makePluginDir({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'team-skills',
      owner: { name: 'Team Skills Owners' },
      plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
    }),
    'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
  });
}

/** 三个本地条目，中间一个由调用方注入、其余两个都是能正常转换的合法插件 */
async function threeEntryFixture(middlePlugin: Record<string, unknown>) {
  return makePluginDir({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'three-entries',
      plugins: [
        { name: 'alpha', source: './plugins/alpha', description: 'A' },
        middlePlugin,
        { name: 'gamma', source: './plugins/gamma', description: 'C' },
      ],
    }),
    'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
    'plugins/gamma/.claude-plugin/plugin.json': JSON.stringify({ name: 'gamma', version: '1.0.0' }),
    'plugins/gamma/skills/c/SKILL.md': '---\nname: c\ndescription: d\n---\n\nbody\n',
  });
}

/** 假 runner：记录被调用的命令，永远不触碰真实 codex/~/.codex */
function fakeRunner(stdout: string, calls: string[][] = []): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout, stderr: '' };
  };
}

describe('scion market', () => {
  it('converts to codex under the original marketplace name', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const calls: string[][] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('', calls) },
    );
    expect(code).toBe(0);
    // 未传 --as 时仍然会核对冲突（跑一次 marketplace list），但不会跑任何其他 codex 命令
    expect(calls).toEqual([['codex', 'plugin', 'marketplace', 'list']]);
    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/team-skills/codex/.agents/plugins/marketplace.json'), 'utf8'),
    );
    expect(catalog.name).toBe('team-skills');
    expect(catalog.plugins[0].source).toEqual({ source: 'local', path: './plugins/alpha' });
  });

  it('converts to kimi as a single catalog file without touching any runner', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const calls: string[][] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('', calls) },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]); // kimi 转换不涉及 codex 冲突检查
    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/team-skills/kimi/marketplace.json'), 'utf8'),
    );
    expect(catalog.plugins[0].id).toBe('alpha');
    expect(out.join('')).toContain('KIMI_CODE_PLUGIN_MARKETPLACE_URL');
  });

  it('warns that registering under the same name overwrites the codex entry', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );
    expect(out.join('')).toContain('overwrites');
    expect(out.join('')).toContain('codex plugin marketplace add');
  });

  it('shows a catalog summary without writing anything', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(['show', dir], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(0);
    expect(out.join('')).toContain('team-skills');
    expect(out.join('')).toContain('alpha');
  });

  it('rejects an unknown subcommand', async () => {
    const out: string[] = [];
    expect(await runMarket(['frobnicate'], { write: (s) => out.push(s) })).toBe(1);
  });

  it('rewrites the codex catalog name with --as without touching plugin source paths', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex', '--as', 'renamed-market'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('other-market   Other\n') },
    );
    expect(code).toBe(0);
    const catalog = JSON.parse(
      await readFile(
        join(home, '.scion/markets/renamed-market/codex/.agents/plugins/marketplace.json'),
        'utf8',
      ),
    );
    expect(catalog.name).toBe('renamed-market');
    expect(catalog.plugins[0].source).toEqual({ source: 'local', path: './plugins/alpha' });
  });

  it('blocks with marketplace.name-conflict and writes no files when the name is already registered', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('team-skills   Team Skills\nother   Other\n') },
    );
    expect(code).toBe(2);
    expect(out.join('')).toContain('marketplace.name-conflict');
    await expect(readdir(join(home, '.scion'))).rejects.toThrow();
  });

  it('blocks with marketplace.name-conflict and writes no files when --as picks an already-registered name', async () => {
    // --as 换的是「要核对哪个名字」，不是「要不要核对」：用户往往正是因为撞了名才用 --as，
    // 这个场景比默认路径更需要被拦下来。
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex', '--as', 'claude-plugins-official'],
      { write: (s) => out.push(s) },
      {
        home,
        run: fakeRunner(
          'claude-plugins-official   /Users/you/.codex/.tmp/marketplaces/claude-plugins-official\n' +
            'team-skills               /Users/you/code/team-skills\n',
        ),
      },
    );
    expect(code).toBe(2);
    expect(out.join('')).toContain('marketplace.name-conflict');
    await expect(readdir(join(home, '.scion'))).rejects.toThrow();
  });

  it('proceeds normally under the same fake runner when --as picks a non-conflicting name', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex', '--as', 'brand-new-name'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('team-skills   Team Skills\nother   Other\n') },
    );
    expect(code).toBe(0);
    const catalog = JSON.parse(
      await readFile(
        join(home, '.scion/markets/brand-new-name/codex/.agents/plugins/marketplace.json'),
        'utf8',
      ),
    );
    expect(catalog.name).toBe('brand-new-name');
  });

  it('degrades to a LOSS finding and still converts when the codex CLI is unavailable', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const failingRunner: Runner = async () => {
      throw Object.assign(new Error('spawn codex ENOENT'), { stderr: '' });
    };
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: failingRunner },
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('marketplace.name-conflict-unchecked');
    await readFile(join(home, '.scion/markets/team-skills/codex/.agents/plugins/marketplace.json'), 'utf8');
  });

  it('keeps both target trees intact when converting the same marketplace to codex then kimi', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );
    await runMarket(
      ['convert', dir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );
    const codexPluginEntries = await readdir(join(home, '.scion/markets/team-skills/codex/plugins/alpha'));
    expect(codexPluginEntries.length).toBeGreaterThan(0);
    const kimiPluginEntries = await readdir(join(home, '.scion/markets/team-skills/kimi/plugins/alpha'));
    expect(kimiPluginEntries.length).toBeGreaterThan(0);
    // codex 树没有被 kimi 转换覆盖或清空
    const codexCatalog = JSON.parse(
      await readFile(join(home, '.scion/markets/team-skills/codex/.agents/plugins/marketplace.json'), 'utf8'),
    );
    expect(codexCatalog.plugins[0].name).toBe('alpha');
    const kimiCatalog = JSON.parse(
      await readFile(join(home, '.scion/markets/team-skills/kimi/marketplace.json'), 'utf8'),
    );
    expect(kimiCatalog.plugins[0].id).toBe('alpha');
  });

  it('C2: refuses a catalog whose own name escapes ~/.scion, and leaves a pre-existing file there untouched', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const evilName = `../../../victim2-${Math.random().toString(36).slice(2)}`;
    const dir = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: evilName,
        plugins: [{ name: 'alpha', source: './plugins/alpha', description: 'A' }],
      }),
      'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
      'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
    });

    // Exactly where the vulnerable code would have landed: join(home, '.scion', 'markets', evilName)
    // — three ".." segments walk past ".scion", "markets" and home itself.
    const victimDir = resolve(join(home, '.scion', 'markets', evilName));
    await mkdir(victimDir, { recursive: true });
    const sentinel = join(victimDir, 'precious.txt');
    await writeFile(sentinel, 'precious', 'utf8');

    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );

    expect(code).toBe(2);
    expect(out.join('')).toContain('marketplace.name-unsafe');
    expect(await readFile(sentinel, 'utf8')).toBe('precious');
    expect(await readdir(victimDir)).toEqual(['precious.txt']);
    // Nothing was ever written under home/.scion — the operation aborted before emitMarketplace.
    await expect(readdir(join(home, '.scion'))).rejects.toThrow();
  });

  it('C2: rejects an unsafe --as value as a usage error rather than writing anything', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex', '--as', '../../../evil-as'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('--as');
    await expect(readdir(join(home, '.scion'))).rejects.toThrow();
  });

  it('I2: applies the same -o containment guard as `scion convert` to a non-empty directory outside ~/.scion', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'scion-market-outside-'));
    const keep = join(outsideDir, 'keep.txt');
    await writeFile(keep, 'precious', 'utf8');

    await expect(
      runMarket(
        ['convert', dir, '--to', 'codex', '-o', outsideDir],
        { write: () => {} },
        { home, run: fakeRunner('') },
      ),
    ).rejects.toThrow(/refusing to overwrite/);

    expect(await readFile(keep, 'utf8')).toBe('precious');
  });
});

describe('scion market convert — entry-scoped BLOCK exclusion', () => {
  it('excludes only the unsafely-named middle entry, converts the other two, and exits 4', async () => {
    const dir = await threeEntryFixture({
      name: 'b/roken',
      source: './plugins/broken',
      description: 'B',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );

    expect(code).toBe(4);
    const text = out.join('');
    expect(text).toContain('marketplace.entry-name-unsafe');
    expect(text).toContain('b/roken');
    expect(text).toContain('INCOMPLETE OUTPUT');
    expect(text).toContain('excluded 1 entry');
    expect(text).toContain('converted 2 plugins');

    const outDir = join(home, '.scion/markets/three-entries/codex');
    const catalog = JSON.parse(await readFile(join(outDir, '.agents/plugins/marketplace.json'), 'utf8'));
    expect((catalog.plugins as { name: string }[]).map((p) => p.name)).toEqual(['alpha', 'gamma']);
    expect((await readdir(join(outDir, 'plugins/alpha'))).length).toBeGreaterThan(0);
    expect((await readdir(join(outDir, 'plugins/gamma'))).length).toBeGreaterThan(0);
    await expect(readdir(join(outDir, 'plugins/broken'))).rejects.toThrow();
  });

  it('excludes only the invalid middle entry (missing source), converts the other two, and exits 4', async () => {
    const dir = await threeEntryFixture({ name: 'broken', description: 'B' });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );

    expect(code).toBe(4);
    const text = out.join('');
    expect(text).toContain('marketplace.entry-invalid');
    expect(text).toContain('broken');
    expect(text).toContain('INCOMPLETE OUTPUT');

    const outDir = join(home, '.scion/markets/three-entries/codex');
    const catalog = JSON.parse(await readFile(join(outDir, '.agents/plugins/marketplace.json'), 'utf8'));
    expect((catalog.plugins as { name: string }[]).map((p) => p.name)).toEqual(['alpha', 'gamma']);
    expect((await readdir(join(outDir, 'plugins/alpha'))).length).toBeGreaterThan(0);
    expect((await readdir(join(outDir, 'plugins/gamma'))).length).toBeGreaterThan(0);
  });

  it('excludes only the middle entry with an unrecognised source discriminant, converts the other two, and exits 4', async () => {
    const dir = await threeEntryFixture({
      name: 'broken',
      source: { source: 'ftp', url: 'ftp://example.com/x' },
      description: 'B',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );

    expect(code).toBe(4);
    const text = out.join('');
    expect(text).toContain('marketplace.entry-source-unknown');
    expect(text).toContain('broken');
    expect(text).toContain('INCOMPLETE OUTPUT');

    const outDir = join(home, '.scion/markets/three-entries/codex');
    const catalog = JSON.parse(await readFile(join(outDir, '.agents/plugins/marketplace.json'), 'utf8'));
    expect((catalog.plugins as { name: string }[]).map((p) => p.name)).toEqual(['alpha', 'gamma']);
    expect((await readdir(join(outDir, 'plugins/alpha'))).length).toBeGreaterThan(0);
    expect((await readdir(join(outDir, 'plugins/gamma'))).length).toBeGreaterThan(0);
  });

  it('a wholly clean catalog exits 0 with no exclusion summary', async () => {
    const dir = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: fakeRunner('') },
    );

    expect(code).toBe(0);
    const text = out.join('');
    expect(text).not.toContain('INCOMPLETE OUTPUT');
    expect(text).not.toContain('excluded');
  });
});
