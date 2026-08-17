import { describe, it, expect } from 'vitest';
import { emptyIR } from '../src/ir/schema.js';
import { project } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';
import type { PluginIR } from '../src/ir/types.js';

function sampleIR(): PluginIR {
  const ir = emptyIR('/src/superpowers', 'claude');
  ir.identity = {
    name: 'superpowers',
    version: '6.3.0',
    description: 'Core skills library',
    author: { name: 'Jesse Vincent', email: 'jesse@fsck.com' },
    homepage: 'https://github.com/obra/superpowers',
    repository: 'https://github.com/obra/superpowers',
    license: 'MIT',
    keywords: ['skills', 'tdd'],
  };
  ir.capabilities.skills = { path: 'skills/', entries: ['brainstorming', 'writing-plans'] };
  return ir;
}

describe('project to kimi', () => {
  const kimi = loadProfile('kimi');

  it('emits identity fields and the manifest path', () => {
    const out = project(sampleIR(), kimi);
    expect(out.manifestPath).toBe('kimi.plugin.json');
    expect(out.manifest.name).toBe('superpowers');
    expect(out.manifest.version).toBe('6.3.0');
    expect(out.manifest.license).toBe('MIT');
    expect(out.manifest.author).toEqual({ name: 'Jesse Vincent', email: 'jesse@fsck.com' });
  });

  it('makes the implicit skills dir explicit', () => {
    const out = project(sampleIR(), kimi);
    expect(out.manifest.skills).toBe('./skills/');
  });

  it('omits capabilities the plugin does not have', () => {
    const out = project(sampleIR(), kimi);
    expect(out.manifest.commands).toBeUndefined();
    expect(out.manifest.agents).toBeUndefined();
  });

  it('inlines mcpServers and emits no extra file', () => {
    const ir = sampleIR();
    ir.capabilities.mcpServers = { observe: { command: 'node' } };
    const out = project(ir, kimi);
    expect(out.manifest.mcpServers).toEqual({ observe: { command: 'node' } });
    expect(out.files.filter((f) => f.path === '.mcp.json')).toHaveLength(0);
  });

  it('reports hooks as LOSS instead of converting them', () => {
    const ir = sampleIR();
    ir.capabilities.hooks = ['hooks/hooks.json'];
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toBeUndefined();
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'LOSS', code: 'hooks.not-converted' }),
    );
  });
});

describe('project to codex', () => {
  const codex = loadProfile('codex');

  it('writes mcpServers as a path reference plus a .mcp.json file', () => {
    const ir = sampleIR();
    ir.capabilities.mcpServers = { observe: { command: 'node', args: ['x'] } };
    const out = project(ir, codex);
    expect(out.manifest.mcpServers).toBe('./.mcp.json');
    const emitted = out.files.find((f) => f.path === '.mcp.json');
    expect(emitted).toBeDefined();
    expect(JSON.parse(emitted!.content)).toEqual({
      mcpServers: { observe: { command: 'node', args: ['x'] } },
    });
  });

  it('emits the codex manifest path', () => {
    expect(project(sampleIR(), codex).manifestPath).toBe('.codex-plugin/plugin.json');
  });
});
