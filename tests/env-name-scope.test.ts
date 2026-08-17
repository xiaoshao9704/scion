import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EnvNameError, parseEnvNames, parseEnvNamesByPlugin } from '../src/mcp/env-flag.js';
import { runInstall } from '../src/commands/install.js';
import { runSync } from '../src/commands/sync.js';
import { readState } from '../src/install/state.js';

const PLUGIN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  '.mcp.json': JSON.stringify({
    mcpServers: {
      alpha: {
        type: 'http',
        url: 'https://a.example.com/',
        headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
      },
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

function bearerOf(home: string): Promise<string> {
  return readFile(
    join(home, '.scion/markets/scion/kimi/plugins/demo/kimi.plugin.json'),
    'utf8',
  ).then((raw) => JSON.parse(raw).mcpServers.alpha.bearerTokenEnvVar);
}

describe('--env-name carries a plugin scope', () => {
  it('reads <plugin>:OLD=NEW and plain OLD=NEW alike', () => {
    expect(parseEnvNames(['demo:MCP_TOKEN=HUB_TOKEN'], 'demo')).toEqual(
      new Map([['MCP_TOKEN', 'HUB_TOKEN']]),
    );
    expect(parseEnvNames(['MCP_TOKEN=HUB_TOKEN'], 'demo')).toEqual(
      new Map([['MCP_TOKEN', 'HUB_TOKEN']]),
    );
  });

  // 静默忽略一条谁也应用不到的映射，会让用户以为自己改了名，而产物里一个字没动
  it('refuses a scope that names a different plugin', () => {
    expect(() => parseEnvNames(['other:MCP_TOKEN=HUB_TOKEN'], 'demo')).toThrow(
      /scoped to plugin "other"/,
    );
  });

  it('rejects a scope with no plugin name', () => {
    expect(() => parseEnvNames([':MCP_TOKEN=HUB_TOKEN'], 'demo')).toThrow(EnvNameError);
  });

  it('keeps each plugin\'s mapping separate for a whole-marketplace run', () => {
    const byPlugin = parseEnvNamesByPlugin(['a:MCP_TOKEN=A_TOKEN', 'b:MCP_TOKEN=B_TOKEN']);
    expect(byPlugin.get('a')).toEqual(new Map([['MCP_TOKEN', 'A_TOKEN']]));
    expect(byPlugin.get('b')).toEqual(new Map([['MCP_TOKEN', 'B_TOKEN']]));
  });

  // 一个市场里几十个插件，同名变量未必是同一个令牌——不写作用域就一律套上去太危险
  it('requires the scope when one command covers many plugins', () => {
    expect(() => parseEnvNamesByPlugin(['MCP_TOKEN=HUB_TOKEN'])).toThrow(/must say which plugin/);
  });
});

describe('the rename is a per-plugin fact, not a per-command one', () => {
  it('records what the user chose in the install ledger', async () => {
    const { home, dir } = await fixture();
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: () => {} },
      { home },
    );
    const [record] = await readState(home);
    expect(record.envNames).toEqual({ MCP_TOKEN: 'ACME_HUB_TOKEN' });
  });

  it('writes no envNames field when nothing was renamed', async () => {
    const { home, dir } = await fixture();
    await runInstall(['--to', 'kimi', '--yes', dir], { write: () => {} }, { home });
    const [record] = await readState(home);
    expect(record.envNames).toBeUndefined();
  });

  // 这是本次改动要消灭的静默漂移：sync 之后产物退回作者原名，而用户 rc 里那行
  // export 还写着新名字，插件不报错，只是 MCP 再也连不上。
  it('survives scion sync', async () => {
    const { home, dir } = await fixture();
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: () => {} },
      { home },
    );
    expect(await bearerOf(home)).toBe('ACME_HUB_TOKEN');

    expect(await runSync([], { write: () => {} }, { home })).toBe(0);
    expect(await bearerOf(home)).toBe('ACME_HUB_TOKEN');
  });

  it('is reused by a later install that gives no --env-name, and says so', async () => {
    const { home, dir } = await fixture();
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: () => {} },
      { home },
    );

    const out: string[] = [];
    await runInstall(['--to', 'kimi', '--yes', dir], { write: (s) => out.push(s) }, { home });
    expect(await bearerOf(home)).toBe('ACME_HUB_TOKEN');
    // 沿用了藏在账本里的东西就必须说出来，否则这就是另一种"悄悄改名"
    expect(out.join('')).toContain('Reusing the environment-variable names recorded for demo');
    expect(out.join('')).toContain('MCP_TOKEN=ACME_HUB_TOKEN');
  });

  // OLD=OLD 是"退回作者原名"的说法；没有它，账本里的映射就再也去不掉了
  it('goes back to the author name when told OLD=OLD', async () => {
    const { home, dir } = await fixture();
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN', dir],
      { write: () => {} },
      { home },
    );
    await runInstall(
      ['--to', 'kimi', '--yes', '--env-name', 'MCP_TOKEN=MCP_TOKEN', dir],
      { write: () => {} },
      { home },
    );
    expect(await bearerOf(home)).toBe('MCP_TOKEN');
  });
});
