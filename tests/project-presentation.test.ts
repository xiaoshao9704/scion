import { describe, it, expect } from 'vitest';
import { emptyIR } from '../src/ir/schema.js';
import { project } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';

function irWithPresentation() {
  const ir = emptyIR('/src/p', 'codex');
  ir.identity.name = 'p';
  ir.presentation = {
    displayName: 'Observe',
    shortDescription: 'monitoring',
    longDescription: 'long',
    developerName: 'example-org',
    category: 'Developer Tools',
    capabilities: ['Read'],
    defaultPrompt: ['查日志'],
    brandColor: '#FF7D00',
  };
  return ir;
}

describe('presentation projection', () => {
  it('keeps all nine fields for codex', () => {
    const out = project(irWithPresentation(), loadProfile('codex'));
    const iface = out.manifest.interface as Record<string, unknown>;
    expect(iface.category).toBe('Developer Tools');
    expect(iface.brandColor).toBe('#FF7D00');
    expect(out.findings.filter((f) => f.code === 'presentation.field-dropped')).toHaveLength(0);
  });

  it('trims to four fields for kimi and reports what was dropped', () => {
    const out = project(irWithPresentation(), loadProfile('kimi'));
    const iface = out.manifest.interface as Record<string, unknown>;
    expect(Object.keys(iface).sort()).toEqual([
      'developerName',
      'displayName',
      'longDescription',
      'shortDescription',
    ]);
    const dropped = out.findings.filter((f) => f.code === 'presentation.field-dropped');
    expect(dropped.map((f) => f.where).sort()).toEqual([
      'presentation.brandColor',
      'presentation.capabilities',
      'presentation.category',
      'presentation.defaultPrompt',
    ]);
    expect(dropped.every((f) => f.level === 'LOSS')).toBe(true);
  });

  it('omits the interface block entirely when the target has no presentation key', () => {
    const out = project(irWithPresentation(), loadProfile('claude'));
    expect(out.manifest.interface).toBeUndefined();
    expect(out.findings.filter((f) => f.code === 'presentation.field-dropped')).toHaveLength(8);
  });

  it('omits the interface block when the IR has no presentation at all', () => {
    const ir = emptyIR('/src/p', 'claude');
    ir.identity.name = 'p';
    expect(project(ir, loadProfile('kimi')).manifest.interface).toBeUndefined();
  });
});
