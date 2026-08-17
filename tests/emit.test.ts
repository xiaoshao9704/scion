import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { projectAll } from '../src/project/index.js';
import { emit } from '../src/emit/write.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');

async function convertFixture() {
  const root = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
    '.kimi-plugin/plugin.json': JSON.stringify({ name: 'stale-hand-written' }),
    'skills/demo/SKILL.md': '---\nname: demo\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/go.sh\n',
    'scripts/go.sh': '#!/bin/sh\necho hi\n',
    'README.md': '# p\n',
    'node_modules/junk/index.js': 'module.exports = 1;',
  });
  const ir = await normalize(root, claude);
  const out = await mkdtemp(join(tmpdir(), 'scion-out-'));
  const written = await emit(ir, await projectAll(ir, kimi), out, out);
  return { out, written };
}

describe('emit', () => {
  it('writes the target manifest', async () => {
    const { out } = await convertFixture();
    const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
    expect(manifest.name).toBe('p');
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.skillInstructions).toContain('TodoList');
  });

  it('applies rewritten file contents', async () => {
    const { out } = await convertFixture();
    const skill = await readFile(join(out, 'skills/demo/SKILL.md'), 'utf8');
    expect(skill).toContain('Run go.sh');
    expect(skill).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  it('carries non-capability files along', async () => {
    const { out } = await convertFixture();
    expect(await readFile(join(out, 'scripts/go.sh'), 'utf8')).toContain('echo hi');
    expect(await readFile(join(out, 'README.md'), 'utf8')).toBe('# p\n');
  });

  it('drops every ecosystem manifest and vcs/dependency dirs', async () => {
    const { out } = await convertFixture();
    expect(existsSync(join(out, '.claude-plugin'))).toBe(false);
    expect(existsSync(join(out, '.kimi-plugin'))).toBe(false);
    expect(existsSync(join(out, 'node_modules'))).toBe(false);
  });

  it('returns the list of written paths', async () => {
    const { written } = await convertFixture();
    expect(written).toContain('kimi.plugin.json');
    expect(written).toContain('skills/demo/SKILL.md');
  });

  it('refuses to write outside the containment root and never touches a pre-existing file there', async () => {
    // Mirrors the C1 sink guard: even if some caller manages to build an outDir that
    // escapes its declared root (e.g. a marketplace entry name with "../" segments),
    // emit() must refuse before its rm(outDir, { recursive: true, force: true }) ever runs.
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
      'skills/demo/SKILL.md': '---\nname: demo\n---\n\nbody\n',
    });
    const claude = loadProfile('claude');
    const kimi = loadProfile('kimi');
    const ir = await normalize(root, claude);

    const sandbox = await mkdtemp(join(tmpdir(), 'scion-sink-sandbox-'));
    const safeRoot = join(sandbox, 'nested', 'plugins');
    await mkdir(safeRoot, { recursive: true });
    const victimDir = join(sandbox, 'victim');
    await mkdir(victimDir, { recursive: true });
    const sentinel = join(victimDir, 'precious.txt');
    await writeFile(sentinel, 'precious', 'utf8');

    // outDir escapes safeRoot via "../" the same way an unsafe marketplace entry name would.
    const escapee = join(safeRoot, relative(safeRoot, victimDir));

    await expect(emit(ir, await projectAll(ir, kimi), escapee, safeRoot)).rejects.toThrow(
      /containment root/,
    );

    expect(await readFile(sentinel, 'utf8')).toBe('precious');
    expect(await readdir(victimDir)).toEqual(['precious.txt']);
  });
});
