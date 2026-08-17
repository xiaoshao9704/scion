import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runList } from '../src/commands/list.js';
import { runSync } from '../src/commands/sync.js';
import { recordInstall } from '../src/install/state.js';

describe('runList', () => {
  it('says so when nothing is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out: string[] = [];
    expect(await runList([], { write: (s) => out.push(s) }, { home })).toBe(0);
    expect(out.join('')).toContain('No plugins installed through scion yet');
  });

  it('lists name, target, source and registration state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'demo',
      version: '1.0.0',
      target: 'kimi',
      source: 'obra/superpowers',
      sourceKind: 'git',
      pluginRoot: '/tmp/x',
      registered: false,
    });
    const out: string[] = [];
    await runList([], { write: (s) => out.push(s) }, { home });
    const text = out.join('');
    expect(text).toContain('demo');
    expect(text).toContain('kimi');
    expect(text).toContain('obra/superpowers');
    expect(text).toContain('not registered');
  });
});

describe('runSync', () => {
  it('reinstalls every recorded plugin from its original source', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: dir,
      sourceKind: 'path',
      pluginRoot: '/tmp/x',
      registered: false,
    });

    const out: string[] = [];
    const code = await runSync([], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(0);
    expect(out.join('')).toContain('demo');
  });

  it('syncs only the named plugin', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'demo', target: 'kimi', source: dir, sourceKind: 'path',
      pluginRoot: '/tmp/x', registered: false,
    });
    await recordInstall(home, {
      name: 'other', target: 'kimi', source: '/nonexistent', sourceKind: 'path',
      pluginRoot: '/tmp/y', registered: false,
    });

    const out: string[] = [];
    // 'other' 的来源不存在，若被一并同步就会抛错；限定名字后应当正常返回
    expect(await runSync(['demo'], { write: (s) => out.push(s) }, { home })).toBe(0);
  });
});
