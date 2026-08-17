import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EnvNameError, parseEnvNames } from '../src/mcp/env-flag.js';
import { runInstall } from '../src/commands/install.js';

describe('parseEnvNames', () => {
  it('reads repeated OLD=NEW pairs', () => {
    expect(parseEnvNames(['MCP_TOKEN=ACME_HUB_TOKEN', 'API_KEY=ACME_KEY'])).toEqual(
      new Map([
        ['MCP_TOKEN', 'ACME_HUB_TOKEN'],
        ['API_KEY', 'ACME_KEY'],
      ]),
    );
  });

  it('is empty when the flag is absent', () => {
    expect(parseEnvNames(undefined).size).toBe(0);
  });

  // OLD=OLD 是"这个变量别动"的精确说法，比 --keep-env-names 一刀切好
  it('accepts a pair that maps a name to itself', () => {
    expect(parseEnvNames(['MCP_TOKEN=MCP_TOKEN'])).toEqual(new Map([['MCP_TOKEN', 'MCP_TOKEN']]));
  });

  for (const bad of ['MCP_TOKEN', '=NEW', 'MCP_TOKEN=', 'MCP TOKEN=NEW', 'MCP_TOKEN=9LIVES']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseEnvNames([bad])).toThrow(EnvNameError);
    });
  }

  it('refuses two different new names for one variable', () => {
    expect(() => parseEnvNames(['T=A', 'T=B'])).toThrow(/two different new names/);
  });

  it('tolerates the same pair given twice', () => {
    expect(parseEnvNames(['T=A', 'T=A'])).toEqual(new Map([['T', 'A']]));
  });
});

const PLUGIN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  '.mcp.json': JSON.stringify({
    mcpServers: {
      alpha: { type: 'http', url: 'https://a.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
      beta: { type: 'http', url: 'https://b.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
    },
  }),
  'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
};

async function fixture(): Promise<{ home: string; dir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const dir = join(home, 'plugin');
  for (const [rel, content] of Object.entries(PLUGIN)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return { home, dir };
}

describe('scion install --env-name', () => {
  // 两个 server 共用一个令牌，而这个令牌属于它们背后那台 hub，不属于插件。
  // 名字归谁只有用户说得清，所以改名只能由他点名。
  it('uses the name the user picked', async () => {
    const { home, dir } = await fixture();
    const code = await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: () => {} },
      { home },
    );
    expect(code).toBe(0);

    const manifest = JSON.parse(
      await readFile(
        join(home, '.scion/markets/scion/kimi/plugins/demo/kimi.plugin.json'),
        'utf8',
      ),
    );
    expect(manifest.mcpServers.alpha.bearerTokenEnvVar).toBe('ACME_HUB_TOKEN');
    expect(manifest.mcpServers.beta.bearerTokenEnvVar).toBe('ACME_HUB_TOKEN');
  });

  // 这是本工具最容易犯的错：自作主张给变量换个"更安全"的名字，让用户去 export 一个
  // 上游文档里根本不存在的东西。不给 --env-name 就一个字都不许改。
  it('changes nothing at all without --env-name', async () => {
    const { home, dir } = await fixture();
    const code = await runInstall(['--to', 'kimi', '--yes', dir], { write: () => {} }, { home });
    expect(code).toBe(0);

    const manifest = JSON.parse(
      await readFile(
        join(home, '.scion/markets/scion/kimi/plugins/demo/kimi.plugin.json'),
        'utf8',
      ),
    );
    expect(manifest.mcpServers.alpha.bearerTokenEnvVar).toBe('MCP_TOKEN');
    expect(manifest.mcpServers.beta.bearerTokenEnvVar).toBe('MCP_TOKEN');
  });

  it('reports the name it actually used, so the export line is correct', async () => {
    const { home, dir } = await fixture();
    const out: string[] = [];
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: (s) => out.push(s) },
      { home },
    );
    const text = out.join('');
    expect(text).toContain('export ACME_HUB_TOKEN="$MCP_TOKEN"');
    expect(text).not.toContain('DEMO_MCP_TOKEN');
  });

  // 用户点名之后别再劝他这个名字太泛——他刚做完这个决定。没点名时那条提示要在。
  it('states what it did with each name, and judges none of them', async () => {
    const { home, dir } = await fixture();
    const chosen: string[] = [];
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: (s) => chosen.push(s) },
      { home },
    );
    const text = chosen.join('');
    expect(text).toContain('renamed from MCP_TOKEN as you asked');

    const kept: string[] = [];
    const { home: home2, dir: dir2 } = await fixture();
    await runInstall(['--to', 'kimi', '--yes', dir2], { write: (s) => kept.push(s) }, { home: home2 });
    const keptText = kept.join('');
    expect(keptText).toContain('name kept exactly as the plugin author wrote it');
    // 名字长什么样都不评价：不猜它泛不泛，也不替用户想一个新名字
    expect(keptText).not.toMatch(/generic|DEMO_MCP_TOKEN/);
  });

  it('is a usage error when the pair is malformed', async () => {
    const { home, dir } = await fixture();
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'NOPE', dir],
      { write: (s) => out.push(s) },
      { home },
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('OLD=NEW');
  });
});
