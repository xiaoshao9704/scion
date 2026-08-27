import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runRepo } from '../src/commands/repo.js';
import { supportedOperations, requireOperation } from '../src/profiles/loader.js';
import { loadProfile } from '../src/profiles/loader.js';
import type { CliIo } from '../src/cli.js';

function collectIo(): { io: CliIo; text: () => string } {
  let buf = '';
  return { io: { write: (s) => (buf += s) }, text: () => buf };
}

const HOOKS_JSON = JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" go' }] },
    ],
  },
});

async function makeRepo() {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
    'hooks/hooks.json': HOOKS_JSON,
    'hooks/run.sh': '#!/bin/sh\n',
  });
}

describe('scion repo', () => {
  it('writes target manifests and derivative files into the repo itself', async () => {
    const dir = await makeRepo();
    const { io } = collectIo();
    const code = await runRepo([dir, '--to', 'codex,kimi'], io);
    expect(code).toBe(0);

    const kimi = JSON.parse(await readFile(join(dir, 'kimi.plugin.json'), 'utf8'));
    expect(kimi.name).toBe('demo');
    expect(kimi.hooks).toEqual([
      { event: 'SessionStart', command: '"./hooks/run.sh" go' },
    ]);

    const codex = JSON.parse(await readFile(join(dir, '.codex-plugin/plugin.json'), 'utf8'));
    expect(codex.hooks).toBe('./hooks/codex-hooks.json');
    expect(existsSync(join(dir, 'hooks/codex-hooks.json'))).toBe(true);
  });

  it('leaves shared bodies untouched', async () => {
    const dir = await makeRepo();
    const before = await readFile(join(dir, 'skills/demo/SKILL.md'), 'utf8');
    await runRepo([dir, '--to', 'kimi'], collectIo().io);
    expect(await readFile(join(dir, 'skills/demo/SKILL.md'), 'utf8')).toBe(before);
  });

  it('--check passes right after a write and fails after manual drift', async () => {
    const dir = await makeRepo();
    await runRepo([dir, '--to', 'kimi'], collectIo().io);
    expect(await runRepo([dir, '--to', 'kimi', '--check'], collectIo().io)).toBe(0);

    const manifest = join(dir, 'kimi.plugin.json');
    const rotted = JSON.parse(await readFile(manifest, 'utf8'));
    rotted.version = '9.9.9';
    await writeFile(manifest, JSON.stringify(rotted, null, 2) + '\n', 'utf8');

    const { io, text } = collectIo();
    expect(await runRepo([dir, '--to', 'kimi', '--check'], io)).toBe(6);
    expect(text()).toContain('kimi.plugin.json');
  });

  it('--check writes nothing', async () => {
    const dir = await makeRepo();
    const { io } = collectIo();
    expect(await runRepo([dir, '--to', 'kimi', '--check'], io)).toBe(6);
    expect(existsSync(join(dir, 'kimi.plugin.json'))).toBe(false);
  });

  it('usage error without a dir or --to', async () => {
    const { io } = collectIo();
    expect(await runRepo(['--to', 'kimi'], io)).toBe(1);
    expect(await runRepo(['/tmp/x'], io)).toBe(1);
  });
});

describe('per-ecosystem operation opt-in', () => {
  it('all shipped profiles support all three operations today', () => {
    for (const id of ['claude', 'kimi', 'codex'] as const) {
      expect(supportedOperations(loadProfile(id))).toEqual(['install', 'market', 'in-repo']);
    }
  });

  it('requireOperation names what a stripped profile supports', () => {
    const stripped = { ...loadProfile('kimi'), install: undefined, marketplaceDialect: undefined };
    expect(supportedOperations(stripped)).toEqual(['in-repo']);
    expect(() => requireOperation(stripped, 'install')).toThrow(/does not implement install.*in-repo/s);
    expect(() => requireOperation(stripped, 'in-repo')).not.toThrow();
  });
});
