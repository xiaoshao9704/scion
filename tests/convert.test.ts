import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePluginDir } from './helpers/tmp.js';
import { runConvert } from '../src/commands/convert.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

async function fixture() {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
  });
}

describe('runConvert without -o', () => {
  it('writes to a fresh OS temp directory, prints the path, and warns it is ephemeral', async () => {
    const dir = await fixture();
    const out: string[] = [];
    const code = await runConvert([dir, '--to', 'kimi'], { write: (s) => out.push(s) });
    expect(code).toBe(0);

    const text = out.join('');
    // 输出必须点名一个真实存在的临时目录，路径要落在 OS 的临时目录下，不是 ~/.scion/out。
    const match = text.match(new RegExp(`(${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s]*)`));
    expect(match).not.toBeNull();
    const printedDir = match![1];
    expect(existsSync(join(printedDir, 'kimi.plugin.json'))).toBe(true);

    // 三件事都要说清楚：这是临时目录、操作系统会自动清理、-o 是保留产物的办法。
    expect(text).toMatch(/temp directory/);
    expect(text).toMatch(/cleans it up|not stick around/);
    expect(text).toContain('-o');
  });

  it('never writes under ~/.scion/out', async () => {
    const dir = await fixture();
    const out: string[] = [];
    await runConvert([dir, '--to', 'kimi'], { write: (s) => out.push(s) });
    expect(out.join('')).not.toContain('.scion/out');
  });
});

describe('source hygiene', () => {
  it('no source file references .scion/out any more', async () => {
    const srcRoot = join(TESTS_DIR, '..', 'src');
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const { readFile } = await import('node:fs/promises');
          const content = await readFile(abs, 'utf8');
          if (content.includes('.scion/out')) {
            offenders.push(abs);
          }
        }
      }
    }

    await walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe('runConvert and environment variable names', () => {
  async function authFixture() {
    return makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'acme-toolkit', version: '1.0.0' }),
      '.mcp.json': JSON.stringify({
        mcpServers: {
          tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
        },
      }),
    });
  }

  it('keeps the author name by default', async () => {
    const dir = await authFixture();
    const out = join(await makePluginDir({}), 'out');
    const code = await runConvert([dir, '--to', 'kimi', '-o', out], { write: () => {} });
    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
    expect(manifest.mcpServers.tracker.bearerTokenEnvVar).toBe('MCP_TOKEN');
  });

  it('renames only when --env-name says so', async () => {
    const dir = await authFixture();
    const out = join(await makePluginDir({}), 'out');
    const code = await runConvert(
      [dir, '--to', 'kimi', '-o', out, '--env-name', 'MCP_TOKEN=ACME_HUB_TOKEN'],
      { write: () => {} },
    );
    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
    expect(manifest.mcpServers.tracker.bearerTokenEnvVar).toBe('ACME_HUB_TOKEN');
  });

  it('prints the environment-variable column even when nothing is wrong', async () => {
    const dir = await authFixture();
    const out = join(await makePluginDir({}), 'out');
    const printed: string[] = [];
    await runConvert([dir, '--to', 'kimi', '-o', out], { write: (s) => printed.push(s) });
    const text = printed.join('');
    expect(text).toContain('environment variables this plugin reads');
    expect(text).toContain('MCP_TOKEN');
    expect(text).toContain('name kept exactly as the plugin author wrote it');
  });
});
