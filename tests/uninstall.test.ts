import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runUninstall } from '../src/commands/uninstall.js';
import { recordInstall, readState } from '../src/install/state.js';
import type { CliIo } from '../src/cli.js';

function collectIo(): { io: CliIo; text: () => string } {
  let buf = '';
  return { io: { write: (s) => (buf += s) }, text: () => buf };
}

async function seedFile(abs: string, content: string) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function setupCodex() {
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const pluginRoot = join(home, '.scion/markets/scion/codex/plugins/demo');
  await seedFile(join(pluginRoot, '.codex-plugin/plugin.json'), '{"name":"demo"}');
  await seedFile(
    join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json'),
    JSON.stringify({ name: 'scion', plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' } }] }),
  );
  await recordInstall(home, {
    name: 'demo',
    target: 'codex',
    source: '/src/demo',
    sourceKind: 'path',
    pluginRoot,
    registered: true,
  });
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '' };
  };
  return { home, pluginRoot, calls, run };
}

describe('scion uninstall', () => {
  it('removes a codex install: CLI, catalog entry, files, ledger', async () => {
    const { home, pluginRoot, calls, run } = await setupCodex();
    const { io } = collectIo();
    const code = await runUninstall(['demo'], io, { home, run });
    expect(code).toBe(0);
    expect(calls).toContainEqual(['codex', 'plugin', 'remove', 'demo@scion']);
    expect(existsSync(pluginRoot)).toBe(false);
    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/codex/.agents/plugins/marketplace.json'), 'utf8'),
    );
    expect(catalog.plugins).toEqual([]);
    expect(await readState(home)).toEqual([]);
  });

  it('continues cleanup when the codex CLI fails (already removed by hand)', async () => {
    const { home, pluginRoot } = await setupCodex();
    const run = async () => {
      throw Object.assign(new Error('not found'), { stderr: 'plugin not found' });
    };
    const { io, text } = collectIo();
    const code = await runUninstall(['demo'], io, { home, run });
    expect(code).toBe(0);
    expect(existsSync(pluginRoot)).toBe(false);
    expect(await readState(home)).toEqual([]);
    expect(text()).toMatch(/already|failed/i);
  });

  it('removes a registered kimi install from the kimi registry with a backup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const pluginRoot = join(home, '.scion/markets/scion/kimi/plugins/demo');
    await seedFile(join(pluginRoot, 'kimi.plugin.json'), '{"name":"demo"}');
    await seedFile(
      join(home, '.scion/markets/scion/kimi/marketplace.json'),
      JSON.stringify({ plugins: [{ id: 'demo', source: './plugins/demo' }] }),
    );
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await seedFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: 'demo', root: pluginRoot, source: 'local-path', enabled: true, installedAt: 'x', updatedAt: 'x' },
          { id: 'other', root: '/elsewhere', source: 'local-path', enabled: true, installedAt: 'x', updatedAt: 'x' },
        ],
      }),
    );
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: '/src/demo',
      sourceKind: 'path',
      pluginRoot,
      registered: true,
    });
    const { io } = collectIo();
    const code = await runUninstall(['demo'], io, { home, run: async () => ({ stdout: '', stderr: '' }) });
    expect(code).toBe(0);
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(registry.plugins.map((p: { id: string }) => p.id)).toEqual(['other']);
    expect(existsSync(pluginRoot)).toBe(false);
    expect(await readState(home)).toEqual([]);
  });

  it('errors with the known names when the plugin is not in the ledger', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'known',
      target: 'kimi',
      source: '/s',
      sourceKind: 'path',
      pluginRoot: join(home, '.scion/markets/scion/kimi/plugins/known'),
      registered: false,
    });
    const { io, text } = collectIo();
    const code = await runUninstall(['nope'], io, { home, run: async () => ({ stdout: '', stderr: '' }) });
    expect(code).toBe(1);
    expect(text()).toContain('known');
  });

  it('honors --to and leaves the other target installed', async () => {
    const { home, run } = await setupCodex();
    const kimiRoot = join(home, '.scion/markets/scion/kimi/plugins/demo');
    await seedFile(join(kimiRoot, 'kimi.plugin.json'), '{"name":"demo"}');
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: '/src/demo',
      sourceKind: 'path',
      pluginRoot: kimiRoot,
      registered: false,
    });
    const { io } = collectIo();
    const code = await runUninstall(['demo', '--to', 'codex'], io, { home, run });
    expect(code).toBe(0);
    const left = await readState(home);
    expect(left.map((r) => r.target)).toEqual(['kimi']);
    expect(existsSync(kimiRoot)).toBe(true);
  });

  it('refuses to delete files outside ~/.scion but still cleans the ledger', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const outside = await mkdtemp(join(tmpdir(), 'scion-outside-'));
    await seedFile(join(outside, 'kimi.plugin.json'), '{"name":"demo"}');
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: '/s',
      sourceKind: 'path',
      pluginRoot: outside,
      registered: false,
    });
    const { io, text } = collectIo();
    const code = await runUninstall(['demo'], io, { home, run: async () => ({ stdout: '', stderr: '' }) });
    expect(code).toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(await readState(home)).toEqual([]);
    expect(text()).toMatch(/outside|left in place/i);
  });
});
