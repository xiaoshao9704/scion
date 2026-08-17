import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runMarket } from '../src/commands/market.js';
import { normalizeMarketplace } from '../src/marketplace/normalize.js';
import { emitMarketplace } from '../src/marketplace/project.js';
import { loadProfile } from '../src/profiles/loader.js';
import type { EcosystemProfile } from '../src/profiles/types.js';
import type { Runner } from '../src/install/exec.js';

/** 一个远端条目指向自建 GitLab（不是 GitHub），一个本地条目正常转换 */
async function selfHostedFixture() {
  return makePluginDir({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'acme-hub',
      plugins: [
        { name: 'alpha', source: './plugins/alpha', description: 'A' },
        { name: 'ai-plugin', source: 'https://git.example.com/acme/ai-plugin.git', description: 'B' },
      ],
    }),
    'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
  });
}

const noRunner: Runner = async () => ({ stdout: '', stderr: '' });

async function newHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scion-home-'));
}

describe('market convert — remote entries the target cannot fetch', () => {
  it('excludes a self-hosted git entry for kimi, exits 4 and says the output is incomplete', async () => {
    const dir = await selfHostedFixture();
    const home = await newHome();
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home, run: noRunner },
    );

    expect(code).toBe(4);
    const text = out.join('');
    expect(text).toContain('INCOMPLETE OUTPUT');
    expect(text).toContain('marketplace.remote-entry-unfetchable');
    expect(text).toContain('ai-plugin');
    // 旧那句谎话不能再出现在这个条目上
    expect(text).not.toContain('kept as-is for the target ecosystem to fetch itself');

    // 装不了的条目不写进 catalog：留着它等于让 Kimi 拿到一个永远装不上的条目
    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/acme-hub/kimi/marketplace.json'), 'utf8'),
    );
    expect((catalog.plugins as { id: string }[]).map((p) => p.id)).toEqual(['alpha']);
  });

  it('points at `scion install <plugin>@<marketplace>` as the way to get those entries in', async () => {
    const dir = await selfHostedFixture();
    const home = await newHome();
    const out: string[] = [];
    await runMarket(
      ['convert', dir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home, run: noRunner },
    );

    expect(out.join('')).toContain('scion install ai-plugin@acme-hub --to kimi');
  });

  it('puts the same alternative commands in --json, from the one result object', async () => {
    const dir = await selfHostedFixture();
    const home = await newHome();
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'kimi', '--json'],
      { write: (s) => out.push(s) },
      { home, run: noRunner },
    );

    expect(code).toBe(4);
    const doc = JSON.parse(out.join(''));
    expect(doc.exitCode).toBe(4);
    expect(doc.excluded.map((e: { entry: string }) => e.entry)).toEqual(['ai-plugin']);
    expect(doc.alternatives.join('\n')).toContain(
      'scion install ai-plugin@acme-hub --to kimi',
    );
  });

  it('leaves a GitHub entry alone for kimi: still INFO, still exit 0', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'gh-market',
        plugins: [{ name: 'gh', source: 'https://github.com/acme/gh.git', description: 'B' }],
      }),
    });
    const home = await newHome();
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'kimi'],
      { write: (s) => out.push(s) },
      { home, run: noRunner },
    );

    expect(code).toBe(0);
    expect(out.join('')).toContain('marketplace.remote-entry-skipped');
    expect(out.join('')).not.toContain('INCOMPLETE OUTPUT');
  });

  it('C2: codex still keeps the same self-hosted entry as-is, word for word, and exits 0', async () => {
    const dir = await selfHostedFixture();
    const home = await newHome();
    const out: string[] = [];
    const code = await runMarket(
      ['convert', dir, '--to', 'codex'],
      { write: (s) => out.push(s) },
      { home, run: noRunner },
    );

    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('marketplace.remote-entry-skipped');
    expect(text).toContain('the source is kept as-is for the target ecosystem to fetch itself');
    expect(text).not.toContain('INCOMPLETE OUTPUT');

    const catalog = JSON.parse(
      await readFile(
        join(home, '.scion/markets/acme-hub/codex/.agents/plugins/marketplace.json'),
        'utf8',
      ),
    );
    expect((catalog.plugins as { name: string }[]).map((p) => p.name)).toEqual([
      'alpha',
      'ai-plugin',
    ]);
  });
});

describe('remote fetchability is a profile declaration, not engine knowledge', () => {
  it('follows the profile: the same catalog and the same engine flip with the declaration', async () => {
    const dir = await selfHostedFixture();
    const kimi = loadProfile('kimi');
    const mp = await normalizeMarketplace(dir, loadProfile('claude'));

    const strict = await emitMarketplace(mp, kimi, await newHome());
    expect(strict.findings.some((f) => f.code === 'marketplace.remote-entry-unfetchable')).toBe(true);

    // 只改 profile 的声明，引擎一行不动：同一个自建 GitLab 条目立刻变成"能自取"
    const permissive: EcosystemProfile = {
      ...kimi,
      marketplaceDialect: {
        ...kimi.marketplaceDialect,
        remoteFetch: { ...kimi.marketplaceDialect.remoteFetch, hosts: ['git.example.com'] },
      },
    };
    const relaxed = await emitMarketplace(mp, permissive, await newHome());
    expect(relaxed.findings.some((f) => f.code === 'marketplace.remote-entry-unfetchable')).toBe(
      false,
    );
    expect(relaxed.findings.some((f) => f.code === 'marketplace.remote-entry-skipped')).toBe(true);
  });
});
