import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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

describe('runInstall', () => {
  it('converts for kimi without touching the registry and reports the next step', async () => {
    const dir = await fixtureDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runInstall(['--to', 'kimi', dir], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(0);
    expect(out.join('')).toContain('/plugins');
  });

  it('aborts on BLOCK findings', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'Bad Name' }),
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runInstall(['--to', 'kimi', dir], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(2);
    expect(out.join('')).toContain('BLOCK');
  });

  it('requires --yes when there are LOSS findings', async () => {
    const dir = await fixtureDir({
      'commands/ship.md': '---\ndescription: s\nallowed-tools: Bash(git push:*)\n---\n\nGo.\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runInstall(['--to', 'kimi', dir], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(3);
    expect(out.join('')).toContain('--yes');
  });

  it('proceeds past LOSS with --yes', async () => {
    const dir = await fixtureDir({
      'commands/ship.md': '---\ndescription: s\nallowed-tools: Bash(git push:*)\n---\n\nGo.\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const code = await runInstall(
      ['--to', 'kimi', '--yes', dir],
      { write: (s) => out.push(s) },
      { home },
    );
    expect(code).toBe(0);
  });

  it('installs to several targets in one run', async () => {
    // claude→codex has no toolmap entry (see tests/toolmap.test.ts), so codex
    // always reports a LOSS finding here; --yes is required to proceed.
    const dir = await fixtureDir();
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    const calls: string[][] = [];
    const code = await runInstall(
      ['--to', 'kimi,codex', '--yes', dir],
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
    expect(calls.some((c) => c[1] === 'plugin' && c[2] === 'add')).toBe(true);
  });
});
