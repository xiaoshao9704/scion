import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalizeMarketplace } from '../src/marketplace/normalize.js';
import { projectMarketplace, emitMarketplace } from '../src/marketplace/project.js';
import { loadProfile } from '../src/profiles/loader.js';
import { runConvert } from '../src/commands/convert.js';
import { runMarket } from '../src/commands/market.js';
import type { MarketplaceIR } from '../src/marketplace/types.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');
const codex = loadProfile('codex');

// 逐字复制自 ~/.codex/.tmp/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json
// 里的 42crunch-api-security-testing 条目——手写的 git-subdir fixture 只会验证代码已经内建
// 的假设，用真实数据才能测出代码没考虑到的形态。
const GIT_SUBDIR_ENTRY = {
  name: '42crunch-api-security-testing',
  description:
    'Automate API security directly in Claude Code with 42Crunch - automatically audit OpenAPI specs, ' +
    'detect vulnerabilities aligned with OWASP API Security risks (including BOLA/BFLA), and apply ' +
    'AI-powered fixes. Designed for AI-assisted development workflows, it provides continuous guardrails ' +
    'through an audit->scan->remediate->validate loop, ensuring APIs meet enterprise security standards ' +
    'before deployment.',
  author: { name: '42Crunch' },
  category: 'security',
  source: {
    source: 'git-subdir',
    url: 'https://github.com/42Crunch-AI/claude-plugins.git',
    path: 'plugins/api-security-testing',
    ref: 'v1.5.5',
    sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
  },
  homepage: 'https://42crunch.com',
};

async function marketFixture() {
  return makePluginDir({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'team-skills',
      owner: { name: 'Team Skills Owners' },
      plugins: [
        { name: 'alpha', source: './plugins/alpha', description: 'A 插件' },
        { name: 'remote-one', source: 'https://example.com/r.zip', description: '远端' },
        GIT_SUBDIR_ENTRY,
      ],
    }),
    'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
  });
}

/** 三个本地条目，中间一个指向不存在的插件目录 */
async function brokenMiddleFixture() {
  return makePluginDir({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'three-plugins',
      plugins: [
        { name: 'alpha', source: './plugins/alpha', description: 'A' },
        { name: 'broken', source: './plugins/broken', description: '目录不存在' },
        { name: 'gamma', source: './plugins/gamma', description: 'C' },
      ],
    }),
    'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
    'plugins/gamma/.claude-plugin/plugin.json': JSON.stringify({ name: 'gamma', version: '1.0.0' }),
    'plugins/gamma/skills/c/SKILL.md': '---\nname: c\ndescription: d\n---\n\nbody\n',
  });
}

describe('projectMarketplace', () => {
  it('preserves the marketplace name for codex', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const out = projectMarketplace(mp, codex);
    expect(out.catalog.name).toBe('team-skills');
    expect(out.catalogPath).toBe('.agents/plugins/marketplace.json');
    expect((out.catalog.interface as Record<string, unknown>).displayName).toBe('team-skills');
  });

  it('writes codex entries with object sources and policy', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const entries = projectMarketplace(mp, codex).catalog.plugins as Record<string, unknown>[];
    expect(entries[0]).toEqual({
      name: 'alpha',
      source: { source: 'local', path: './plugins/alpha' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    });
  });

  it('writes kimi entries keyed by id and reports the lost marketplace name', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const out = projectMarketplace(mp, kimi);
    expect(out.catalogPath).toBe('marketplace.json');
    expect(out.catalog.name).toBeUndefined();
    const entries = out.catalog.plugins as Record<string, unknown>[];
    expect(entries[0].id).toBe('alpha');
    expect(entries[0].source).toBe('./plugins/alpha');
    expect(entries[0].description).toBe('A 插件');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'marketplace.name-not-carried' }),
    );
  });

  it('keeps remote entry sources untouched', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const entries = projectMarketplace(mp, kimi).catalog.plugins as Record<string, unknown>[];
    expect(entries[1].source).toBe('https://example.com/r.zip');
  });

  it('round-trips a real git-subdir entry to codex byte-for-byte, with no loss finding', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const out = projectMarketplace(mp, codex);
    const entries = out.catalog.plugins as Record<string, unknown>[];
    const entry = entries.find((e) => e.name === '42crunch-api-security-testing');
    expect(entry?.source).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });
    expect(out.findings).not.toContainEqual(
      expect.objectContaining({ code: 'marketplace.git-subdir-flattened' }),
    );
  });

  it('flattens a git-subdir entry to the bare repo URL for kimi and reports the LOSS', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const out = projectMarketplace(mp, kimi);
    const entries = out.catalog.plugins as Record<string, unknown>[];
    const entry = entries.find((e) => e.id === '42crunch-api-security-testing');
    expect(entry?.source).toBe('https://github.com/42Crunch-AI/claude-plugins.git');
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        level: 'LOSS',
        code: 'marketplace.git-subdir-flattened',
        message: expect.stringContaining('42crunch-api-security-testing'),
      }),
    );
  });
});

describe('emitMarketplace', () => {
  it('writes the catalog and converts every local plugin', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-'));
    const result = await emitMarketplace(mp, codex, outDir);

    expect(result.converted).toEqual(['alpha']);
    const catalog = JSON.parse(await readFile(join(outDir, result.catalogPath), 'utf8'));
    expect(catalog.name).toBe('team-skills');
    expect(existsSync(join(outDir, 'plugins/alpha/.codex-plugin/plugin.json'))).toBe(true);
  });

  it('reports remote entries as skipped rather than fetching them', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-'));
    const result = await emitMarketplace(mp, codex, outDir);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'marketplace.remote-entry-skipped' }),
    );
    expect(existsSync(join(outDir, 'plugins/remote-one'))).toBe(false);
  });

  it('aggregates per-plugin findings under the entry name', async () => {
    const mp = await normalizeMarketplace(await marketFixture(), claude);
    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-'));
    const result = await emitMarketplace(mp, kimi, outDir);
    expect(result.findings.some((f) => f.where?.startsWith('alpha:'))).toBe(true);
  });

  it('drops a local entry whose plugin directory is missing, but still emits the rest', async () => {
    const mp = await normalizeMarketplace(await brokenMiddleFixture(), claude);
    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-'));
    const result = await emitMarketplace(mp, codex, outDir);

    const catalog = JSON.parse(await readFile(join(outDir, result.catalogPath), 'utf8'));
    const entries = catalog.plugins as Record<string, unknown>[];
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'gamma']);
    expect(entries[0].source).toEqual({ source: 'local', path: './plugins/alpha' });
    expect(entries[1].source).toEqual({ source: 'local', path: './plugins/gamma' });

    expect(existsSync(join(outDir, 'plugins/alpha/.codex-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(outDir, 'plugins/gamma/.codex-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(outDir, 'plugins/broken'))).toBe(false);

    expect(result.converted).toEqual(['alpha', 'gamma']);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        level: 'BLOCK',
        code: 'marketplace.entry-convert-failed',
        where: 'broken',
      }),
    );
  });

  it('refuses to write an entry whose name escapes the plugins root, and never touches what is there (C1 sink guard)', async () => {
    // A malicious entry name can only reach emitMarketplace() if something bypasses
    // normalizeMarketplace()'s own guard (tests/marketplace-normalize.test.ts covers that
    // source-side check). This proves the sink in emit() is a real second line of defense,
    // not just a passthrough: even a hand-built MarketplaceIR with a "../"-laden name must
    // not be able to rm -rf anything outside outDir/plugins.
    const pluginSrc = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
      'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
    });

    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-sink-'));
    const victimDir = await mkdtemp(join(tmpdir(), 'scion-market-victim-'));
    const sentinel = join(victimDir, 'precious.txt');
    await writeFile(sentinel, 'precious', 'utf8');

    const entryName = relative(join(outDir, 'plugins'), victimDir);
    const mp: MarketplaceIR = {
      root: pluginSrc,
      catalogPath: join(pluginSrc, '.claude-plugin/marketplace.json'),
      sourceEcosystem: 'claude',
      name: 'evil-market',
      entries: [{ name: entryName, source: { kind: 'local', path: '.' } }],
      provenance: [],
      issues: [],
    };

    const result = await emitMarketplace(mp, codex, outDir);

    expect(result.converted).not.toContain(entryName);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'marketplace.entry-convert-failed', where: entryName }),
    );
    expect(await readFile(sentinel, 'utf8')).toBe('precious');
    expect(await readdir(victimDir)).toEqual(['precious.txt']);
  });

  it('refuses to read a plugin source whose path escapes the marketplace root (C1 read-side guard)', async () => {
    const mpRoot = await makePluginDir({ '.claude-plugin/marketplace.json': '{}' });
    const outDir = await mkdtemp(join(tmpdir(), 'scion-market-'));
    const mp: MarketplaceIR = {
      root: mpRoot,
      catalogPath: join(mpRoot, '.claude-plugin/marketplace.json'),
      sourceEcosystem: 'claude',
      name: 'm',
      entries: [{ name: 'safe-name', source: { kind: 'local', path: '../../../etc' } }],
      provenance: [],
      issues: [],
    };

    const result = await emitMarketplace(mp, codex, outDir);

    expect(result.converted).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        level: 'BLOCK',
        code: 'marketplace.entry-source-outside-root',
        where: 'safe-name',
      }),
    );
    expect(existsSync(join(outDir, 'plugins', 'safe-name'))).toBe(false);
  });
});

describe('convert vs market convert parity (C3)', () => {
  /** 声明了 skills 但目录不存在 —— normalize/scan.ts 会报 BLOCK capability.declared-missing */
  async function brokenSkillsFixture() {
    return makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'broken-skills', skills: './nope/' }),
    });
  }

  it('scion convert reports the BLOCK and aborts', async () => {
    const dir = await brokenSkillsFixture();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runConvert(
      [dir, '--to', 'kimi', '-o', join(home, 'out')],
      { write: (s) => out.push(s) },
    );
    expect(code).toBe(2);
    expect(out.join('')).toContain('capability.declared-missing');
  });

  it('scion market convert surfaces the same BLOCK for the entry instead of silently succeeding', async () => {
    // Same manifest shape as brokenSkillsFixture, but reachable via a marketplace-relative
    // "./plugins/broken-skills" source, exactly like a real catalog would express it.
    const marketDir = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'parity-market',
        plugins: [{ name: 'broken-skills', source: './plugins/broken-skills', description: 'broken' }],
      }),
      'plugins/broken-skills/.claude-plugin/plugin.json': JSON.stringify({
        name: 'broken-skills',
        skills: './nope/',
      }),
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runMarket(
      ['convert', marketDir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home },
    );
    // 单个坏条目不该拖垮整个市场（其余条目正常产出），但这个条目自己的 BLOCK 必须可见——
    // 这正是 C3 修的：以前 market convert 只看 projectAll 的 findings，从不调 doctor()，
    // 这条 BLOCK（来自 ir.issues）从未出现过。exit code 现在是 4（完成但排除了条目），
    // 不再是 0——一个条目被排除掉不该被 exit code 悄悄压成"完全成功"。
    expect(code).toBe(4);
    expect(out.join('')).toContain('capability.declared-missing');
    expect(out.join('')).toContain('INCOMPLETE OUTPUT');
    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/parity-market/kimi/marketplace.json'), 'utf8'),
    );
    expect((catalog.plugins as unknown[]).map((p) => (p as { id: string }).id)).not.toContain(
      'broken-skills',
    );
  });
});
