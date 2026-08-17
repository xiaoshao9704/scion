import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordInstall, readState } from '../src/install/state.js';

const base = {
  name: 'demo',
  version: '1.0.0',
  target: 'kimi' as const,
  source: 'obra/superpowers',
  sourceKind: 'git' as const,
  pluginRoot: '/tmp/x',
  registered: false,
};

describe('scion state', () => {
  it('returns an empty list when nothing is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    expect(await readState(home)).toEqual([]);
  });

  it('records an install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, base, () => new Date('2026-08-13T10:00:00.000Z'));
    const state = await readState(home);
    expect(state).toHaveLength(1);
    expect(state[0].installedAt).toBe('2026-08-13T10:00:00.000Z');
  });

  it('keys records by name + target, updating in place', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, base, () => new Date('2026-08-13T10:00:00.000Z'));
    await recordInstall(home, base, () => new Date('2026-08-14T10:00:00.000Z'));
    await recordInstall(home, { ...base, target: 'codex' }, () => new Date('2026-08-14T10:00:00.000Z'));

    const state = await readState(home);
    expect(state).toHaveLength(2);
    const kimi = state.find((r) => r.target === 'kimi')!;
    expect(kimi.installedAt).toBe('2026-08-13T10:00:00.000Z');
    expect(kimi.updatedAt).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('scion state — corrupt ledger handling', () => {
  async function seedRaw(home: string, content: string): Promise<string> {
    const dir = join(home, '.scion');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'installed.json');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it('throws on invalid JSON and leaves the file byte-identical', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const path = await seedRaw(home, 'not json at all {{{');

    await expect(readState(home)).rejects.toThrow(/installed\.json/);
    expect(await readFile(path, 'utf8')).toBe('not json at all {{{');
  });

  it('throws when the top-level value is an array', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await seedRaw(home, '[]');

    await expect(readState(home)).rejects.toThrow();
  });

  it('throws when installs is present but not an array', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await seedRaw(home, JSON.stringify({ version: 1, installs: 'nope' }));

    await expect(readState(home)).rejects.toThrow();
  });

  it('treats a genuinely absent ledger as empty, with no throw and no backup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    expect(await readState(home)).toEqual([]);

    const files = await readdir(join(home, '.scion')).catch(() => []);
    expect(files.some((f) => f.includes('.scion-bak.'))).toBe(false);
  });

  it('backs up the existing ledger before recordInstall overwrites it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, base, () => new Date('2026-08-13T10:00:00.000Z'));
    await recordInstall(home, { ...base, target: 'codex' }, () => new Date('2026-08-14T10:00:00.000Z'));

    const files = await readdir(join(home, '.scion'));
    expect(files.some((f) => f.includes('.scion-bak.'))).toBe(true);
  });
});
