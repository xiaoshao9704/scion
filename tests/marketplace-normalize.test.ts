import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalizeMarketplace } from '../src/marketplace/normalize.js';
import { loadProfile } from '../src/profiles/loader.js';

async function readFixture(name: string): Promise<string> {
  return readFile(join('tests/fixtures/marketplace', name), 'utf8');
}

const CLAUDE_CATALOG = JSON.stringify({
  name: 'team-skills',
  owner: { name: 'Team Skills Owners' },
  plugins: [
    { name: 'team-api-docs', source: './plugins/team-api-docs', description: 'API 文档链' },
    { name: 'team-dev-env', source: './plugins/team-dev-env', description: '开发环境' },
  ],
});

const KIMI_CATALOG = JSON.stringify({
  version: '1',
  plugins: [
    {
      id: 'team-api-docs',
      source: './plugins/team-api-docs',
      displayName: 'Member API Docs',
      version: '1.2.0',
      description: 'API 文档链',
      keywords: ['openapi'],
    },
  ],
});

describe('normalizeMarketplace', () => {
  it('reads a claude catalog from a marketplace root', async () => {
    const root = await makePluginDir({ '.claude-plugin/marketplace.json': CLAUDE_CATALOG });
    const mp = await normalizeMarketplace(root, loadProfile('claude'));
    expect(mp.name).toBe('team-skills');
    expect(mp.owner?.name).toBe('Team Skills Owners');
    expect(mp.entries.map((e) => e.name)).toEqual(['team-api-docs', 'team-dev-env']);
    expect(mp.entries[0].source).toEqual({ kind: 'local', path: './plugins/team-api-docs' });
    expect(mp.entries[0].description).toBe('API 文档链');
  });

  it('reads a codex catalog with object sources', async () => {
    const root = await makePluginDir({
      '.agents/plugins/marketplace.json': JSON.stringify({
        name: 'team-skills',
        interface: { displayName: 'Team Skills' },
        plugins: [
          {
            name: 'team-api-docs',
            source: { source: 'local', path: './plugins/team-api-docs' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Developer Tools',
          },
        ],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('codex'));
    expect(mp.name).toBe('team-skills');
    expect(mp.displayName).toBe('Team Skills');
    expect(mp.entries[0].source).toEqual({ kind: 'local', path: './plugins/team-api-docs' });
    expect(mp.entries[0].category).toBe('Developer Tools');
  });

  it('reads a codex catalog with a git-subdir source, preserving path/ref/sha', async () => {
    const root = await makePluginDir({
      '.agents/plugins/marketplace.json': JSON.stringify({
        name: 'claude-plugins-official',
        plugins: [
          {
            name: 'api-security-testing',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/42Crunch-AI/claude-plugins.git',
              path: 'plugins/api-security-testing',
              ref: 'v1.5.5',
              sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
            },
          },
        ],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('codex'));
    expect(mp.entries[0].source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });
  });

  it('reads a codex catalog with a url source, reading the url key', async () => {
    const root = await makePluginDir({
      '.agents/plugins/marketplace.json': JSON.stringify({
        plugins: [
          { name: 'metrics-mcp-server', source: { source: 'url', url: 'https://example.com/repo.git' } },
        ],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('codex'));
    expect(mp.entries[0].source).toEqual({ kind: 'url', url: 'https://example.com/repo.git' });
  });

  it('reports a codex entry with an unrecognised source discriminant and skips it', async () => {
    const root = await makePluginDir({
      '.agents/plugins/marketplace.json': JSON.stringify({
        plugins: [{ name: 'x', source: { source: 'ftp', url: 'ftp://example.com/x' } }],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('codex'));
    expect(mp.entries).toHaveLength(0);
    expect(mp.issues).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'marketplace.entry-source-unknown' }),
    );
  });

  it('reads a real claude catalog mixing string, url-object and git-subdir sources', async () => {
    // Fixture is verbatim entries copied from a real, shipping catalog
    // (~/.codex/.tmp/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json),
    // not hand-written — the whole point is that this shape cannot drift from reality.
    const catalog = await readFixture('claude-mixed-sources.json');
    const root = await makePluginDir({ '.claude-plugin/marketplace.json': catalog });
    const mp = await normalizeMarketplace(root, loadProfile('claude'));

    expect(mp.issues.filter((i) => i.level === 'BLOCK')).toEqual([]);
    expect(mp.entries).toHaveLength(3);

    const gitSubdir = mp.entries.find((e) => e.name === '42crunch-api-security-testing');
    expect(gitSubdir?.source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });

    const urlEntry = mp.entries.find((e) => e.name === 'agentforce-adlc');
    expect(urlEntry?.source).toEqual({
      kind: 'url',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
    });

    const localEntry = mp.entries.find((e) => e.name === 'agent-sdk-dev');
    expect(localEntry?.source).toEqual({ kind: 'local', path: './plugins/agent-sdk-dev' });
  });

  it('reads a real codex catalog mixing string, url-object and git-subdir sources', async () => {
    // The url entry is copied verbatim from a real Codex catalog
    // (~/.codex/.tmp/marketplaces/metrics-mcp-server/.agents/plugins/marketplace.json).
    // No real Codex catalog on this machine happens to also carry git-subdir or bare-string
    // entries, so those two reuse the real source *values* verified from claude-plugins-official
    // (the object-source grammar is shared across ecosystems) under the real Codex entry
    // envelope (name/source/policy/category) observed in metrics-mcp-server.
    const catalog = await readFixture('codex-mixed-sources.json');
    const root = await makePluginDir({ '.agents/plugins/marketplace.json': catalog });
    const mp = await normalizeMarketplace(root, loadProfile('codex'));

    expect(mp.issues.filter((i) => i.level === 'BLOCK')).toEqual([]);
    expect(mp.entries).toHaveLength(3);

    const urlEntry = mp.entries.find((e) => e.name === 'metrics-mcp-server');
    expect(urlEntry?.source).toEqual({
      kind: 'url',
      url: 'https://github.com/example-org/metrics-mcp-server.git',
    });

    const gitSubdir = mp.entries.find((e) => e.name === '42crunch-api-security-testing');
    expect(gitSubdir?.source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });

    const localEntry = mp.entries.find((e) => e.name === 'agent-sdk-dev');
    expect(localEntry?.source).toEqual({ kind: 'local', path: './plugins/agent-sdk-dev' });
  });

  it('reads a kimi catalog keyed by id, with no marketplace name', async () => {
    const root = await makePluginDir({ 'marketplace.json': KIMI_CATALOG });
    const mp = await normalizeMarketplace(root, loadProfile('kimi'));
    expect(mp.name).toBeNull();
    expect(mp.version).toBe('1');
    expect(mp.entries[0].name).toBe('team-api-docs');
    expect(mp.entries[0].displayName).toBe('Member API Docs');
    expect(mp.entries[0].keywords).toEqual(['openapi']);
  });

  it('accepts a direct path to a catalog file', async () => {
    const root = await makePluginDir({ '.claude-plugin/marketplace.json': CLAUDE_CATALOG });
    const mp = await normalizeMarketplace(
      join(root, '.claude-plugin/marketplace.json'),
      loadProfile('claude'),
    );
    expect(mp.name).toBe('team-skills');
    expect(mp.root).toBe(root);
  });

  it('classifies an https string source as url (kimi)', async () => {
    const root = await makePluginDir({
      'marketplace.json': JSON.stringify({
        plugins: [{ id: 'x', source: 'https://example.com/x.zip' }],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('kimi'));
    expect(mp.entries[0].source).toEqual({ kind: 'url', url: 'https://example.com/x.zip' });
  });

  it('classifies a relative string source as local (kimi)', async () => {
    const root = await makePluginDir({
      'marketplace.json': JSON.stringify({
        plugins: [{ id: 'x', source: './plugins/x' }],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('kimi'));
    expect(mp.entries[0].source).toEqual({ kind: 'local', path: './plugins/x' });
  });

  it('classifies an https string source as url (claude)', async () => {
    const root = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [{ name: 'x', source: 'https://example.com/x.git' }],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('claude'));
    expect(mp.entries[0].source).toEqual({ kind: 'url', url: 'https://example.com/x.git' });
  });

  it('reports an entry missing its required key', async () => {
    const root = await makePluginDir({
      'marketplace.json': JSON.stringify({ plugins: [{ source: './x' }] }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('kimi'));
    expect(mp.entries).toHaveLength(0);
    expect(mp.issues).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'marketplace.entry-invalid' }),
    );
    // message 与 where 必须指向同一个定位串。以前 message 用 1-based 序号、where 用
    // 0-based 下标，一条 finding 里出现两个指向同一条目的不同编号，两边都不可靠。
    const issue = mp.issues.find((i) => i.code === 'marketplace.entry-invalid')!;
    expect(issue.where).toBe('plugins[0]');
    expect(issue.message).toContain('plugins[0]');
    expect(issue.message).not.toMatch(/entry 1\b/);
  });

  it('rejects an entry name that is not a safe path segment and skips it (C1 source-side guard)', async () => {
    const root = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'm',
        plugins: [
          { name: '../../../victim', source: './plugins/victim' },
          { name: 'alpha', source: './plugins/alpha' },
        ],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('claude'));
    expect(mp.entries.map((e) => e.name)).toEqual(['alpha']);
    expect(mp.issues).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'marketplace.entry-name-unsafe' }),
    );
  });

  it('rejects an entry name equal to "." or ".." or containing a backslash', async () => {
    const root = await makePluginDir({
      'marketplace.json': JSON.stringify({
        plugins: [{ id: '..', source: './x' }, { id: 'a\\b', source: './y' }],
      }),
    });
    const mp = await normalizeMarketplace(root, loadProfile('kimi'));
    expect(mp.entries).toHaveLength(0);
    expect(mp.issues.filter((i) => i.code === 'marketplace.entry-name-unsafe')).toHaveLength(2);
  });

  it('throws when no catalog exists', async () => {
    const root = await makePluginDir({ 'README.md': '# x' });
    await expect(normalizeMarketplace(root, loadProfile('claude'))).rejects.toThrow(
      /no claude marketplace catalog/,
    );
  });
});
