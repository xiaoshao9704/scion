import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';

describe('presentation and runtime normalization', () => {
  it('reads the codex interface block into presentation', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'p',
        interface: {
          displayName: 'Observe',
          shortDescription: 'monitoring',
          category: 'Developer Tools',
          capabilities: ['Read', 'Write'],
          defaultPrompt: ['查日志'],
          brandColor: '#FF7D00',
          screenshots: [],
          unknownField: 'dropped',
        },
      }),
    });
    const ir = await normalize(root, loadProfile('codex'));
    expect(ir.presentation.displayName).toBe('Observe');
    expect(ir.presentation.capabilities).toEqual(['Read', 'Write']);
    expect(ir.presentation.brandColor).toBe('#FF7D00');
    expect((ir.presentation as Record<string, unknown>).unknownField).toBeUndefined();
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'presentation.displayName', source: 'manifest' }),
    );
  });

  it('reads kimi runtime fields', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({
        name: 'p',
        sessionStart: { skill: 'using-superpowers' },
        skillInstructions: 'map TodoWrite to TodoList',
      }),
    });
    const ir = await normalize(root, loadProfile('kimi'));
    expect(ir.runtime.sessionStart).toEqual({ skill: 'using-superpowers' });
    expect(ir.runtime.skillInstructions).toContain('TodoList');
  });

  it('leaves presentation empty for claude, which has no interface block', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', interface: { displayName: 'X' } }),
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.presentation).toEqual({});
  });
});
