import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { installToKimi } from '../src/install/kimi.js';
import { loadProfile } from '../src/profiles/loader.js';

async function setup() {
  const src = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
  });
  const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
  const ir = await normalize(src, loadProfile('claude'));
  const now = () => new Date('2026-08-13T10:00:00.000Z');
  return { ir, home, now };
}

describe('installToKimi', () => {
  it('defaults to the scion marketplace, leaving kimi and ~/.scion/out untouched', async () => {
    const { ir, home, now } = await setup();
    const outcome = await installToKimi(ir, { home, now });
    expect(outcome.registered).toBe(false);
    expect(outcome.pluginRoot).toBe(join(home, '.scion/markets/scion/kimi/plugins/demo'));
    expect(
      existsSync(join(home, '.scion/markets/scion/kimi/plugins/demo/kimi.plugin.json')),
    ).toBe(true);

    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/kimi/marketplace.json'), 'utf8'),
    );
    expect(catalog.plugins).toContainEqual(
      expect.objectContaining({ id: 'demo', source: './plugins/demo' }),
    );

    expect(existsSync(join(home, '.scion/out'))).toBe(false);
    expect(existsSync(join(home, '.kimi-code'))).toBe(false);
    expect(outcome.note).toContain('KIMI_CODE_PLUGIN_MARKETPLACE_URL');
    expect(outcome.note).toContain(join(home, '.scion/markets/scion/kimi/marketplace.json'));

    // Kimi 装插件时整份复制到自己目录，之后只读那份副本（实测 Kimi 0.36）。所以这条提示
    // 不许再说"以后每次 scion install 都会自动生效"——已装好的插件不会因为重跑而更新。
    // 这是一条会随措辞漂回去的谎，钉死它。
    expect(outcome.note).toMatch(/re-?add it\s+in Kimi|Re-add it/i);
    expect(outcome.note).not.toMatch(/you never repeat this step/i);
    expect(outcome.note).not.toMatch(/every later scion install shows up/i);
  });

  it('lets a second plugin join the same catalog without disturbing the first', async () => {
    const { ir, home, now } = await setup();
    const other = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'other', version: '1.0.0' }),
      'skills/other/SKILL.md': '---\nname: other\ndescription: d\n---\n\nbody\n',
    });
    const otherIr = await normalize(other, loadProfile('claude'));

    await installToKimi(ir, { home, now });
    await installToKimi(otherIr, { home, now });

    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/kimi/marketplace.json'), 'utf8'),
    );
    expect(catalog.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['demo', 'other']);
    expect(
      existsSync(join(home, '.scion/markets/scion/kimi/plugins/demo/kimi.plugin.json')),
    ).toBe(true);
    expect(
      existsSync(join(home, '.scion/markets/scion/kimi/plugins/other/kimi.plugin.json')),
    ).toBe(true);
  });

  it('updates rather than duplicates the catalog entry on reinstall', async () => {
    const { ir, home, now } = await setup();
    await installToKimi(ir, { home, now });
    await installToKimi(ir, { home, now: () => new Date('2026-08-14T00:00:00.000Z') });

    const catalog = JSON.parse(
      await readFile(join(home, '.scion/markets/scion/kimi/marketplace.json'), 'utf8'),
    );
    expect(catalog.plugins.filter((p: { id: string }) => p.id === 'demo')).toHaveLength(1);
  });

  it('refuses to touch a corrupt kimi catalog rather than silently replacing it', async () => {
    const { ir, home, now } = await setup();
    const catalogPath = join(home, '.scion/markets/scion/kimi/marketplace.json');
    await mkdir(join(home, '.scion/markets/scion/kimi'), { recursive: true });
    const original = '{ not valid json';
    await writeFile(catalogPath, original, 'utf8');

    await expect(installToKimi(ir, { home, now })).rejects.toThrow(/marketplace\.json/);
    expect(await readFile(catalogPath, 'utf8')).toBe(original);
  });

  // Kimi 从市场产物直接读（实测 0.36 不要求 root 在 managed/ 之内）。这样只有一份产物，
  // 重跑 scion install 就地更新，Kimi 立刻看到；复制一份进 managed/ 会让它停在旧版本。
  it('points the kimi registry at the marketplace artifact, not a second copy', async () => {
    const { ir, home, now } = await setup();
    const outcome = await installToKimi(ir, { home, writeRegistry: true, now });
    expect(outcome.registered).toBe(true);
    expect(outcome.pluginRoot).toBe(join(home, '.scion/markets/scion/kimi/plugins/demo'));
    expect(existsSync(join(home, '.kimi-code/plugins/managed/demo'))).toBe(false);
    const registry = JSON.parse(
      await readFile(join(home, '.kimi-code/plugins/installed.json'), 'utf8'),
    );
    expect(registry.version).toBe(1);
    expect(registry.plugins).toContainEqual(
      expect.objectContaining({
        id: 'demo',
        root: join(home, '.scion/markets/scion/kimi/plugins/demo'),
        source: 'local-path',
        enabled: true,
        installedAt: '2026-08-13T10:00:00.000Z',
      }),
    );
  });

  it('preserves existing registry entries and backs the file up', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: 'other', root: '/x', enabled: true }] }),
      'utf8',
    );

    await installToKimi(ir, { home, writeRegistry: true, now });

    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(registry.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['demo', 'other']);
    const backups = (await readdir(join(home, '.kimi-code/plugins'))).filter((n) =>
      n.startsWith('installed.json.scion-bak.'),
    );
    expect(backups).toHaveLength(1);
  });

  it('updates rather than duplicates on reinstall', async () => {
    const { ir, home, now } = await setup();
    await installToKimi(ir, { home, writeRegistry: true, now });
    await installToKimi(ir, { home, writeRegistry: true, now: () => new Date('2026-08-14T00:00:00.000Z') });
    const registry = JSON.parse(
      await readFile(join(home, '.kimi-code/plugins/installed.json'), 'utf8'),
    );
    const entries = registry.plugins.filter((p: { id: string }) => p.id === 'demo');
    expect(entries).toHaveLength(1);
    expect(entries[0].installedAt).toBe('2026-08-13T10:00:00.000Z');
    expect(entries[0].updatedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('does not silently re-enable a plugin the user disabled', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root: join(home, '.kimi-code/plugins/managed/demo'),
            source: 'local-path',
            enabled: false,
            installedAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            originalSource: '/somewhere',
          },
        ],
      }),
      'utf8',
    );

    await installToKimi(ir, { home, writeRegistry: true, now });

    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    const entry = registry.plugins.find((p: { id: string }) => p.id === 'demo');
    expect(entry.enabled).toBe(false);
    expect(entry.updatedAt).toBe('2026-08-13T10:00:00.000Z');
  });

  it('refuses to touch a registry that is not valid JSON', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    const original = '{ not valid json';
    await writeFile(registryPath, original, 'utf8');

    await expect(installToKimi(ir, { home, writeRegistry: true, now })).rejects.toThrow(
      /installed\.json/,
    );

    expect(await readFile(registryPath, 'utf8')).toBe(original);
    const backups = (await readdir(join(home, '.kimi-code/plugins'))).filter((n) =>
      n.startsWith('installed.json.scion-bak.'),
    );
    expect(backups).toHaveLength(0);
  });

  it('refuses to touch a registry whose plugins field is not an array', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    const original = JSON.stringify({ version: 1, plugins: { oops: true } });
    await writeFile(registryPath, original, 'utf8');

    await expect(installToKimi(ir, { home, writeRegistry: true, now })).rejects.toThrow(
      /installed\.json/,
    );

    expect(await readFile(registryPath, 'utf8')).toBe(original);
    const backups = (await readdir(join(home, '.kimi-code/plugins'))).filter((n) =>
      n.startsWith('installed.json.scion-bak.'),
    );
    expect(backups).toHaveLength(0);
  });

  it('treats an absent registry as a first install, with no backup created', async () => {
    const { ir, home, now } = await setup();
    const outcome = await installToKimi(ir, { home, writeRegistry: true, now });
    expect(outcome.registered).toBe(true);
    const files = await readdir(join(home, '.kimi-code/plugins'));
    expect(files.filter((n) => n.startsWith('installed.json.scion-bak.'))).toHaveLength(0);
    expect(files).toContain('installed.json');
  });

  it('refuses to touch a registry whose top-level value is a JSON array', async () => {
    const { ir, home, now } = await setup();
    const registryPath = join(home, '.kimi-code/plugins/installed.json');
    await mkdir(join(home, '.kimi-code/plugins'), { recursive: true });
    const original = JSON.stringify([{ id: 'other' }]);
    await writeFile(registryPath, original, 'utf8');

    await expect(installToKimi(ir, { home, writeRegistry: true, now })).rejects.toThrow(
      /installed\.json/,
    );

    expect(await readFile(registryPath, 'utf8')).toBe(original);
    const backups = (await readdir(join(home, '.kimi-code/plugins'))).filter((n) =>
      n.startsWith('installed.json.scion-bak.'),
    );
    expect(backups).toHaveLength(0);
  });
});
