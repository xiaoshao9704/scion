import { describe, it, expect } from 'vitest';
import { getSkillInstructions } from '../src/toolmap/index.js';
import { emptyIR } from '../src/ir/schema.js';
import { project } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';

describe('getSkillInstructions', () => {
  it('returns the claude-to-kimi mapping', () => {
    const text = getSkillInstructions('claude', 'kimi')!;
    expect(text).toContain('TodoWrite');
    expect(text).toContain('TodoList');
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('subagent_type');
    expect(text).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('returns null for pairs with no mapping', () => {
    expect(getSkillInstructions('claude', 'codex')).toBeNull();
    expect(getSkillInstructions('claude', 'claude')).toBeNull();
  });

  it('fits inside the kimi single-field budget', () => {
    const bytes = Buffer.byteLength(getSkillInstructions('claude', 'kimi')!, 'utf8');
    expect(bytes).toBeLessThan(32768);
  });
});

describe('runtime projection', () => {
  it('injects skillInstructions when projecting claude to kimi', () => {
    const ir = emptyIR('/src/p', 'claude');
    ir.identity.name = 'p';
    const out = project(ir, loadProfile('kimi'));
    expect(out.manifest.skillInstructions).toContain('TodoList');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'toolmap.injected' }),
    );
  });

  it('does not inject anything when projecting to codex', () => {
    const ir = emptyIR('/src/p', 'claude');
    ir.identity.name = 'p';
    const out = project(ir, loadProfile('codex'));
    expect(out.manifest.skillInstructions).toBeUndefined();
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'LOSS', code: 'toolmap.missing' }),
    );
  });

  it('preserves an existing sessionStart', () => {
    const ir = emptyIR('/src/p', 'claude');
    ir.identity.name = 'p';
    ir.runtime.sessionStart = { skill: 'using-superpowers' };
    const out = project(ir, loadProfile('kimi'));
    expect(out.manifest.sessionStart).toEqual({ skill: 'using-superpowers' });
  });

  it('BLOCKs when skillInstructions exceeds the field budget', () => {
    const ir = emptyIR('/src/p', 'claude');
    ir.identity.name = 'p';
    ir.runtime.skillInstructions = 'x'.repeat(40000);
    const out = project(ir, loadProfile('kimi'));
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'kimi.field-too-large' }),
    );
  });
});
