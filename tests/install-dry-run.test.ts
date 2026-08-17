import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runInstall } from '../src/commands/install.js';

async function fixtureDir(extra: Record<string, string> = {}) {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    ...extra,
  });
}

describe('scion install --dry-run', () => {
  it('prints the plan, touches nothing and records nothing', async () => {
    const dir = await fixtureDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const calls: string[][] = [];

    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', dir],
      { write: (s) => out.push(s) },
      {
        home,
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return { stdout: '', stderr: '' };
        },
      },
    );

    expect(code).toBe(0);
    expect(out.join('')).toContain('[kimi] preview (--dry-run, nothing is changed)');
    expect(out.join('')).toContain('files →');
    expect(calls).toEqual([]);
    // home 里连 .scion 都不该出现：既没落插件树，也没写账本
    expect(await readdir(home)).toEqual([]);
    expect(existsSync(join(home, '.scion'))).toBe(false);
  });

  it('still prints the plan for LOSS without --yes, and exits 0', async () => {
    const dir = await fixtureDir({
      'commands/ship.md': '---\ndescription: s\nallowed-tools: Bash(git push:*)\n---\n\nGo.\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];

    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', dir],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('LOSS');
    expect(text).toContain('[kimi] preview');
    expect(text).toContain('--yes');
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses to print a plan behind a BLOCK finding', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'Bad Name' }),
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];

    const code = await runInstall(
      ['--to', 'kimi', '--dry-run', dir],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(2);
    expect(out.join('')).toContain('BLOCK');
    expect(out.join('')).not.toContain('preview');
  });

  it('previews every target in one run', async () => {
    const dir = await fixtureDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];

    const code = await runInstall(
      ['--to', 'kimi,codex', '--dry-run', dir],
      { write: (s) => out.push(s) },
      { home },
    );

    expect(code).toBe(0);
    expect(out.join('')).toContain('[kimi] preview');
    expect(out.join('')).toContain('[codex] preview');
    expect(out.join('')).toContain('run codex plugin add demo@scion');
    expect(await readdir(home)).toEqual([]);
  });
});
