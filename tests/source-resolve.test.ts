import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { resolveSource, sourceSlug } from '../src/source/resolve.js';

describe('resolveSource', () => {
  it('passes a local directory through untouched', async () => {
    const dir = await makePluginDir({ '.claude-plugin/plugin.json': '{"name":"p"}' });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const out = await resolveSource(dir, { home });
    expect(out).toEqual({ dir, kind: 'path', original: dir, notes: [] });
  });

  it('clones an https git url into the scion cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    };
    const out = await resolveSource('https://github.com/obra/superpowers', { home, run });
    expect(out.kind).toBe('git');
    expect(out.dir).toBe(join(home, '.scion/src/github.com_obra_superpowers'));
    expect(calls[0].slice(0, 3)).toEqual(['git', 'clone', '--depth']);
    expect(calls[0]).toContain('https://github.com/obra/superpowers');
  });

  it('expands owner/repo shorthand to a github url', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    };
    await resolveSource('obra/superpowers', { home, run });
    expect(calls[0]).toContain('https://github.com/obra/superpowers.git');
  });

  it('rejects a spec that is neither a path, a zip, nor a git url', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await expect(resolveSource('not a source', { home })).rejects.toThrow(/cannot resolve source/);
  });

  it('clones a .zip source into the cache normally', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'scion-zip-'));
    const zipPath = join(workDir, 'plugin.zip');
    await writeFile(zipPath, 'not a real zip, unzip is stubbed in this test', 'utf8');
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    };
    const out = await resolveSource(zipPath, { home, run });
    expect(out.kind).toBe('zip');
    expect(out.dir).toBe(join(home, '.scion', 'src', sourceSlug(zipPath)));
    expect(calls[0][0]).toBe('unzip');
  });

  it('refuses "https://.." instead of silently resolving it to the cwd', async () => {
    // Node's path.resolve collapses "https://.." to the current working
    // directory (the "https:" segment cancels against the trailing ".."), and a
    // process's cwd always exists — so a local-directory check that runs before
    // the git-URL check would swallow this spec and report it as
    // { kind: 'path' } pointing at the caller's cwd. A URL-shaped spec is never
    // a local directory: it must be classified as git and then be caught by the
    // cache-containment guard (its slug, "..", escapes ~/.scion/src).
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    };
    await expect(resolveSource('https://..', { home, run })).rejects.toThrow(
      /refusing to touch|cannot resolve source/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a git spec whose slug collapses to "." instead of deleting the whole cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    };
    await expect(resolveSource('https://.', { home, run })).rejects.toThrow(/https:\/\/\./);
    expect(calls).toEqual([]);
  });
});
