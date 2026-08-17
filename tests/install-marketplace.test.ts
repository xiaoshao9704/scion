import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMarketplaceEntry } from '../src/install/marketplace.js';
import { loadProfile } from '../src/profiles/loader.js';

const codex = loadProfile('codex');
const kimi = loadProfile('kimi');

const MANIFEST_REL = '.agents/plugins/marketplace.json';

async function setup() {
  const marketplaceRoot = await mkdtemp(join(tmpdir(), 'scion-codex-market-'));
  const abs = join(marketplaceRoot, MANIFEST_REL);
  return { marketplaceRoot, abs };
}

describe('upsertMarketplaceEntry (I3) — codex dialect', () => {
  it('treats a genuinely absent catalog as first install, with no backup created', async () => {
    const { marketplaceRoot, abs } = await setup();
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo' });

    const file = JSON.parse(await readFile(abs, 'utf8'));
    expect(file.plugins).toContainEqual(
      expect.objectContaining({ name: 'demo', source: { source: 'local', path: './plugins/demo' } }),
    );
    const siblings = await readdir(join(marketplaceRoot, '.agents/plugins'));
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(0);
  });

  it('updates rather than duplicates an existing entry, and backs the file up first', async () => {
    const { marketplaceRoot, abs } = await setup();
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo', category: 'A' });
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo', category: 'B' });

    const file = JSON.parse(await readFile(abs, 'utf8'));
    expect(file.plugins.filter((p: { name: string }) => p.name === 'demo')).toHaveLength(1);
    expect(file.plugins[0].category).toBe('B');

    const siblings = await readdir(join(marketplaceRoot, '.agents/plugins'));
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(1);
  });

  it('refuses to touch a catalog that is not valid JSON — throws, file byte-identical, no partial write', async () => {
    const { marketplaceRoot, abs } = await setup();
    await mkdir(join(marketplaceRoot, '.agents/plugins'), { recursive: true });
    const original = '{ not valid json';
    await writeFile(abs, original, 'utf8');

    await expect(
      upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo' }),
    ).rejects.toThrow(/marketplace\.json/);

    expect(await readFile(abs, 'utf8')).toBe(original);
    const siblings = await readdir(join(marketplaceRoot, '.agents/plugins'));
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(0);
    expect(siblings.filter((n) => n.includes('.scion-tmp'))).toHaveLength(0);
  });

  it('refuses to touch a catalog whose top-level value is a JSON array', async () => {
    const { marketplaceRoot, abs } = await setup();
    await mkdir(join(marketplaceRoot, '.agents/plugins'), { recursive: true });
    const original = JSON.stringify([{ name: 'other' }]);
    await writeFile(abs, original, 'utf8');

    await expect(
      upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo' }),
    ).rejects.toThrow(/marketplace\.json/);

    expect(await readFile(abs, 'utf8')).toBe(original);
    const siblings = await readdir(join(marketplaceRoot, '.agents/plugins'));
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(0);
  });

  it('refuses to touch a catalog whose plugins field is present but not an array', async () => {
    const { marketplaceRoot, abs } = await setup();
    await mkdir(join(marketplaceRoot, '.agents/plugins'), { recursive: true });
    const original = JSON.stringify({ name: 'scion', plugins: { oops: true } });
    await writeFile(abs, original, 'utf8');

    await expect(
      upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'demo' }),
    ).rejects.toThrow(/marketplace\.json/);

    expect(await readFile(abs, 'utf8')).toBe(original);
    const siblings = await readdir(join(marketplaceRoot, '.agents/plugins'));
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(0);
  });

  it('preserves every previously-registered plugin across an upsert', async () => {
    const { marketplaceRoot, abs } = await setup();
    await mkdir(join(marketplaceRoot, '.agents/plugins'), { recursive: true });
    const original = {
      name: 'scion',
      interface: { displayName: 'Scion' },
      plugins: [
        { name: 'alpha', source: { source: 'local', path: './plugins/alpha' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'A' },
        { name: 'beta', source: { source: 'local', path: './plugins/beta' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'B' },
      ],
    };
    await writeFile(abs, JSON.stringify(original), 'utf8');

    await upsertMarketplaceEntry(marketplaceRoot, 'scion', codex, { name: 'gamma' });

    const file = JSON.parse(await readFile(abs, 'utf8'));
    expect(file.plugins.map((p: { name: string }) => p.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('upsertMarketplaceEntry — kimi dialect', () => {
  it('creates a fresh catalog keyed by id with a string source, no name/interface field', async () => {
    const marketplaceRoot = await mkdtemp(join(tmpdir(), 'scion-kimi-market-'));
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', kimi, { name: 'demo' });

    const file = JSON.parse(await readFile(join(marketplaceRoot, 'marketplace.json'), 'utf8'));
    expect(file.name).toBeUndefined();
    expect(file.interface).toBeUndefined();
    expect(file.plugins).toContainEqual(
      expect.objectContaining({ id: 'demo', source: './plugins/demo' }),
    );
  });

  it('updates rather than duplicates an existing kimi entry, and backs the file up first', async () => {
    const marketplaceRoot = await mkdtemp(join(tmpdir(), 'scion-kimi-market-'));
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', kimi, { name: 'demo', category: 'A' });
    await upsertMarketplaceEntry(marketplaceRoot, 'scion', kimi, { name: 'demo', category: 'B' });

    const abs = join(marketplaceRoot, 'marketplace.json');
    const file = JSON.parse(await readFile(abs, 'utf8'));
    expect(file.plugins.filter((p: { id: string }) => p.id === 'demo')).toHaveLength(1);

    const siblings = await readdir(marketplaceRoot);
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(1);
  });

  it('refuses to touch a corrupt kimi catalog rather than silently replacing it', async () => {
    const marketplaceRoot = await mkdtemp(join(tmpdir(), 'scion-kimi-market-'));
    const abs = join(marketplaceRoot, 'marketplace.json');
    const original = '{ not valid json';
    await writeFile(abs, original, 'utf8');

    await expect(
      upsertMarketplaceEntry(marketplaceRoot, 'scion', kimi, { name: 'demo' }),
    ).rejects.toThrow(/marketplace\.json/);

    expect(await readFile(abs, 'utf8')).toBe(original);
    const siblings = await readdir(marketplaceRoot);
    expect(siblings.filter((n) => n.includes('.scion-bak.'))).toHaveLength(0);
  });

  it('preserves every previously-registered plugin across a kimi upsert', async () => {
    const marketplaceRoot = await mkdtemp(join(tmpdir(), 'scion-kimi-market-'));
    const abs = join(marketplaceRoot, 'marketplace.json');
    const original = { plugins: [{ id: 'alpha', source: './plugins/alpha' }] };
    await writeFile(abs, JSON.stringify(original), 'utf8');

    await upsertMarketplaceEntry(marketplaceRoot, 'scion', kimi, { name: 'beta' });

    const file = JSON.parse(await readFile(abs, 'utf8'));
    expect(file.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['alpha', 'beta']);
  });
});
