import { describe, it, expect } from 'vitest';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';

const SKILL = '---\nname: demo\ndescription: d\n---\n\nbody\n';

describe('capability scanning', () => {
  it('infers skills/ by convention when the manifest omits it', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'skills/alpha/SKILL.md': SKILL,
      'skills/beta/SKILL.md': SKILL,
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.skills).toEqual({ path: 'skills/', entries: ['alpha', 'beta'] });
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'capabilities.skills', source: 'convention' }),
    );
  });

  it('honours an explicit skills path and records manifest provenance', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'p', skills: './lib/skills/' }),
      'lib/skills/one/SKILL.md': SKILL,
    });
    const ir = await normalize(root, loadProfile('codex'));
    expect(ir.capabilities.skills).toEqual({ path: 'lib/skills/', entries: ['one'] });
    expect(ir.provenance).toContainEqual(
      expect.objectContaining({ field: 'capabilities.skills', source: 'manifest' }),
    );
  });

  it('reports a BLOCK issue when a declared dir does not exist', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'p', skills: './nope/' }),
    });
    const ir = await normalize(root, loadProfile('codex'));
    expect(ir.capabilities.skills).toBeNull();
    expect(ir.issues).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'capability.declared-missing' }),
    );
  });

  it('leaves capabilities null when neither manifest nor convention dir exists', async () => {
    const root = await makePluginDir({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }) });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.skills).toBeNull();
    expect(ir.capabilities.commands).toBeNull();
    expect(ir.issues).toEqual([]);
  });

  it('collects commands and agents as files, not directories', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'commands/ship.md': '---\ndescription: ship it\n---\n',
      'commands/notes.txt': 'ignored',
      'agents/reviewer.md': '---\nname: reviewer\n---\n',
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.commands).toEqual({ path: 'commands/', entries: ['ship.md'] });
    expect(ir.capabilities.agents).toEqual({ path: 'agents/', entries: ['reviewer.md'] });
  });

  it('recurses into nested command and agent directories (I1)', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'commands/ship.md': '---\ndescription: ship it\n---\n',
      'commands/ns/deep.md': '---\ndescription: deep\n---\n',
      'agents/reviewer.md': '---\nname: reviewer\n---\n',
      'agents/team/lead.md': '---\nname: lead\n---\n',
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.commands).toEqual({
      path: 'commands/',
      entries: ['ns/deep.md', 'ship.md'],
    });
    expect(ir.capabilities.agents).toEqual({
      path: 'agents/',
      entries: ['reviewer.md', 'team/lead.md'],
    });
  });

  it('records hooks files without converting them', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'hooks/hooks.json': '{}',
      'hooks/on-start.sh': '#!/bin/sh\n',
    });
    const ir = await normalize(root, loadProfile('claude'));
    expect(ir.capabilities.hooks).toEqual(['hooks/hooks.json', 'hooks/on-start.sh']);
  });

  it('skips unreadable entries like broken symlinks and reports LOSS', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'skills/valid/SKILL.md': SKILL,
    });
    // Create a dangling symlink inside skills/
    await symlink('/nonexistent/path', join(root, 'skills/broken'));
    const ir = await normalize(root, loadProfile('claude'));
    // The valid skill should still be collected
    expect(ir.capabilities.skills).toEqual({ path: 'skills/', entries: ['valid'] });
    // A LOSS finding should be present for the broken symlink
    expect(ir.issues).toContainEqual(
      expect.objectContaining({
        level: 'LOSS',
        code: 'capability.entry-unreadable',
      }),
    );
  });
});
