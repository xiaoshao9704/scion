import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';

const SERVERS = {
  observe: { command: 'node', args: ['./dist/index.js'], env: { OBSERVE_ENV: 'prod' } },
};

describe('mcpServers normalization', () => {
  it('reads claude external .mcp.json', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      '.mcp.json': JSON.stringify({ mcpServers: SERVERS }),
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.mcpServers).toEqual(SERVERS);
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'capabilities.mcpServers', source: 'manifest' }),
    );
  });

  it('reads a kimi inline object', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({ name: 'p', mcpServers: SERVERS }),
    });
    const ir = await normalize(root, loadProfile('kimi'));
    expect(ir.capabilities.mcpServers).toEqual(SERVERS);
  });

  it('follows a codex path reference', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'p', mcpServers: './.mcp.json' }),
      '.mcp.json': JSON.stringify({ mcpServers: SERVERS }),
    });
    const ir = await normalize(root, loadProfile('codex'));
    expect(ir.capabilities.mcpServers).toEqual(SERVERS);
  });

  it('accepts a bare server map without the mcpServers wrapper', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      '.mcp.json': JSON.stringify(SERVERS),
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.mcpServers).toEqual(SERVERS);
  });

  it('BLOCKs when a referenced mcp file is missing', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'p', mcpServers: './missing.json' }),
    });
    const ir = await normalize(root, loadProfile('codex'));
    expect(ir.capabilities.mcpServers).toEqual({});
    expect(ir.issues).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'mcp.declared-missing' }),
    );
  });

  it('leaves mcpServers empty when there is none', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }) });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.mcpServers).toEqual({});
    expect(ir.issues).toEqual([]);
  });
});
