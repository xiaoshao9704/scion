import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { findManifest, normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';

const CLAUDE_MANIFEST = JSON.stringify({
  name: 'superpowers',
  version: '6.3.0',
  description: 'Core skills library',
  author: { name: 'Jesse Vincent', email: 'jesse@fsck.com' },
  homepage: 'https://github.com/obra/superpowers',
  license: 'MIT',
  keywords: ['skills', 'tdd'],
});

describe('findManifest', () => {
  it('finds the claude manifest', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': CLAUDE_MANIFEST });
    const found = await findManifest(root, loadProfile('claude'));
    expect(found?.path).toBe('.claude-plugin/plugin.json');
    expect(found?.raw.name).toBe('superpowers');
  });

  it('prefers kimi.plugin.json when both exist', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({ name: 'winner' }),
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'loser' }),
    });
    const found = await findManifest(root, loadProfile('kimi'));
    expect(found?.raw.name).toBe('winner');
  });

  it('returns null when no manifest exists', async () => {
    const root = await makePluginDir({ 'README.md': '# hi' });
    expect(await findManifest(root, loadProfile('claude'))).toBeNull();
  });

  it('throws a readable error on malformed JSON', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': '{ not json' });
    await expect(findManifest(root, loadProfile('claude'))).rejects.toThrow(
      /\.claude-plugin\/plugin\.json/,
    );
  });
});

describe('normalize identity', () => {
  it('copies identity fields and records manifest provenance', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': CLAUDE_MANIFEST });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.identity.name).toBe('superpowers');
    expect(ir.identity.version).toBe('6.3.0');
    expect(ir.identity.author?.email).toBe('jesse@fsck.com');
    expect(ir.sourceEcosystem).toBe('claude');
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'identity.name', source: 'manifest' }),
    );
  });

  it('falls back to the directory name when name is absent', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': '{}' });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.identity.name).toBe(root.split('/').pop());
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'identity.name', source: 'convention' }),
    );
  });

  it('fails when the directory is not a plugin at all', async () => {
    const root = await makePluginDir({ 'README.md': '# hi' });
    await expect(normalize(root, loadProfile('claude'))).rejects.toThrow(/no claude manifest/);
  });

  it('accepts an ordinary name unchanged, with manifest provenance', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'metrics-monitor' }),
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.identity.name).toBe('metrics-monitor');
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'identity.name', source: 'manifest' }),
    );
    expect(ir.issues.filter((i) => i.code === 'identity.name.unsafe')).toHaveLength(0);
  });

  it.each([['path traversal', '../../../../tmp/evil'], ['bare slash', 'foo/bar'], ['exactly ..', '..']])(
    'falls back to the directory name and BLOCKs an unsafe manifest name (%s)',
    async (_label, unsafeName) => {
      const root = await makePluginDir({
        '.claude-plugin/plugin.json': JSON.stringify({ name: unsafeName }),
      });
      const ir = await normalize(root, loadProfile('claude'));
      expect(ir.identity.name).toBe(root.split('/').pop());
      expect(ir.provenance).toContainEqual(
        expect.objectContaining({ field: 'identity.name', source: 'convention' }),
      );
      expect(ir.issues).toContainEqual(
        expect.objectContaining({ level: 'BLOCK', code: 'identity.name.unsafe', where: 'identity.name' }),
      );
    },
  );
});
