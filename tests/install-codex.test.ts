import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { installToCodex } from '../src/install/codex.js';
import { loadProfile } from '../src/profiles/loader.js';

async function setup() {
  const src = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
  });
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const ir = await normalize(src, loadProfile('claude'));
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '' };
  };
  return { ir, home, calls, run };
}

describe('installToCodex', () => {
  it('stages the plugin under the scion marketplace, never under ~/.codex', async () => {
    const { ir, home, run } = await setup();
    const outcome = await installToCodex(ir, { home, run });
    expect(outcome.pluginRoot).toBe(join(home, '.scion/markets/scion/codex/plugins/demo'));
    expect(
      existsSync(join(home, '.scion/markets/scion/codex/plugins/demo/.codex-plugin/plugin.json')),
    ).toBe(true);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('writes a marketplace.json entry in the codex layout', async () => {
    const { ir, home, run } = await setup();
    await installToCodex(ir, { home, run });
    const mp = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json'), 'utf8'),
    );
    expect(mp.name).toBe('scion');
    expect(mp.plugins).toContainEqual({
      name: 'demo',
      source: { source: 'local', path: './plugins/demo' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    });
  });

  it('delegates registration to the codex CLI', async () => {
    const { ir, home, calls, run } = await setup();
    const outcome = await installToCodex(ir, { home, run });
    expect(calls).toEqual([
      ['codex', 'plugin', 'marketplace', 'add', join(home, '.scion/markets/scion/codex')],
      ['codex', 'plugin', 'add', 'demo@scion'],
    ]);
    expect(outcome.registered).toBe(true);
  });

  it('does not duplicate an existing marketplace entry on reinstall', async () => {
    const { ir, home, run } = await setup();
    await installToCodex(ir, { home, run });
    await installToCodex(ir, { home, run });
    const mp = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json'), 'utf8'),
    );
    expect(mp.plugins.filter((p: { name: string }) => p.name === 'demo')).toHaveLength(1);
  });

  it('keeps pluginRoot contained under the marketplace even for a hostile manifest name', async () => {
    const src = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: '../../../../evil' }),
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const ir = await normalize(src, loadProfile('claude'));
    const run = async (cmd: string, args: string[]) => {
      void cmd;
      void args;
      return { stdout: '', stderr: '' };
    };
    const outcome = await installToCodex(ir, { home, run });
    expect(outcome.pluginRoot.startsWith(join(home, '.scion/markets/scion/codex/plugins') + '/')).toBe(
      true,
    );
  });

  it('surfaces a readable error when the codex CLI fails', async () => {
    const { ir, home } = await setup();
    const failing = async () => {
      throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    };
    await expect(installToCodex(ir, { home, run: failing })).rejects.toThrow(
      /codex plugin marketplace add.*ENOENT/s,
    );
  });
});
