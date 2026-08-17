import { describe, it, expect } from 'vitest';
import { substitutePathVars } from '../src/project/pathvars.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');

describe('substitutePathVars', () => {
  it('relativizes a path under the plugin root', () => {
    const out = substitutePathVars(
      'Read ${CLAUDE_PLUGIN_ROOT}/skills/foo/SKILL.md now.',
      claude,
      kimi,
      'skills/a/SKILL.md',
    );
    expect(out.content).toBe('Read skills/foo/SKILL.md now.');
  });

  it('turns a bare variable into the current directory', () => {
    const out = substitutePathVars('cd ${CLAUDE_PLUGIN_ROOT}', claude, kimi, 'x.md');
    expect(out.content).toBe('cd .');
  });

  it('reports one LOSS per occurrence', () => {
    const out = substitutePathVars(
      '${CLAUDE_PLUGIN_ROOT}/a and ${CLAUDE_PLUGIN_ROOT}/b',
      claude,
      kimi,
      'x.md',
    );
    expect(out.findings).toHaveLength(2);
    expect(out.findings.every((f) => f.level === 'LOSS' && f.code === 'pathvar.relativized')).toBe(
      true,
    );
  });

  it('leaves content without the variable untouched', () => {
    const out = substitutePathVars('no variables here', claude, kimi, 'x.md');
    expect(out.content).toBe('no variables here');
    expect(out.findings).toEqual([]);
  });

  it('keeps the variable when the target strategy is keep', () => {
    const out = substitutePathVars('${CLAUDE_PLUGIN_ROOT}/a', claude, claude, 'x.md');
    expect(out.content).toBe('${CLAUDE_PLUGIN_ROOT}/a');
    expect(out.findings).toEqual([]);
  });

  it('does nothing when the source ecosystem has no path variable', () => {
    const out = substitutePathVars('${CLAUDE_PLUGIN_ROOT}/a', kimi, claude, 'x.md');
    expect(out.content).toBe('${CLAUDE_PLUGIN_ROOT}/a');
  });
});
