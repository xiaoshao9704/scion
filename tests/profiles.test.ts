import { describe, it, expect } from 'vitest';
import { loadProfile, ALL_PROFILE_IDS } from '../src/profiles/loader.js';

describe('ecosystem profiles', () => {
  it('every profile validates against the schema', () => {
    for (const id of ALL_PROFILE_IDS) {
      expect(loadProfile(id).id).toBe(id);
    }
  });

  it('kimi prefers kimi.plugin.json over .kimi-plugin/plugin.json', () => {
    expect(loadProfile('kimi').manifestPaths).toEqual([
      'kimi.plugin.json',
      '.kimi-plugin/plugin.json',
    ]);
  });

  it('claude keeps mcpServers in an external .mcp.json', () => {
    const p = loadProfile('claude');
    expect(p.fieldDialect.mcpServers).toBe('external-file');
    expect(p.fieldDialect.mcpServersFile).toBe('.mcp.json');
  });

  it('kimi inlines mcpServers, codex references a path', () => {
    expect(loadProfile('kimi').fieldDialect.mcpServers).toBe('inline');
    expect(loadProfile('codex').fieldDialect.mcpServers).toBe('path-ref');
  });

  it('kimi declares the name pattern and size limits', () => {
    const p = loadProfile('kimi');
    expect(new RegExp(p.namePattern!).test('metrics-monitor')).toBe(true);
    expect(new RegExp(p.namePattern!).test('Metrics Monitor')).toBe(false);
    expect(p.limits.fieldBytes).toBe(32768);
  });

  it('throws on an unknown ecosystem', () => {
    expect(() => loadProfile('cursor' as never)).toThrow(/unknown ecosystem/);
  });
});
