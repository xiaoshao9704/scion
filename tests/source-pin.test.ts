import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '../src/install/exec.js';
import { PinRejectedError, resolveSource } from '../src/source/resolve.js';

const URL = 'https://git.example.com/acme/acme-toolkit.git';
const SHA = '30287f5ea9b2b4c1d6f0a7e8c3b5d4a2f1e0c9b8';

async function newHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scion-home-'));
}

/**
 * 假 git：记下每一次 argv，从不联网。fail() 返回一段 stderr 就让那一次调用失败，
 * 用来铺出"浅取被拒、完整克隆兜底"这条路径。
 */
function runner(calls: string[][], fail: (args: string[]) => string | null = () => null): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const stderr = fail(args);
    if (stderr) {
      const err = new Error('exited with code 128') as Error & { stderr?: string };
      err.stderr = stderr;
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
}

const NO_SHALLOW_SHA = 'error: Server does not allow request for unadvertised object';

describe('resolveSource honours a catalog pin', () => {
  it('clones the pinned ref with --branch when only a ref is given', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const out = await resolveSource(URL, { home, run: runner(calls), pin: { ref: 'v1.5.5' } });

    expect(out.kind).toBe('git');
    expect(calls).toEqual([
      ['git', 'clone', '--depth', '1', '--branch', 'v1.5.5', URL, out.dir],
    ]);
    expect(out.notes).toEqual([]);
  });

  it('fetches the exact commit when a sha is given', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const out = await resolveSource(URL, { home, run: runner(calls), pin: { sha: SHA } });

    expect(calls).toEqual([
      ['git', 'init', out.dir],
      ['git', '-C', out.dir, 'remote', 'add', 'origin', URL],
      ['git', '-C', out.dir, 'fetch', '--depth', '1', 'origin', SHA],
      ['git', '-C', out.dir, 'checkout', 'FETCH_HEAD'],
    ]);
    expect(out.notes).toEqual([]);
  });

  it('prefers the sha over the ref when the entry carries both', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    await resolveSource(URL, { home, run: runner(calls), pin: { ref: 'v1.5.5', sha: SHA } });

    const flat = calls.flat();
    expect(flat).toContain(SHA);
    expect(flat).not.toContain('--branch');
    expect(flat).not.toContain('v1.5.5');
  });

  it('falls back to a full clone when the server refuses a shallow fetch, and says so', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const run = runner(calls, (args) => (args.includes('fetch') ? NO_SHALLOW_SHA : null));
    const out = await resolveSource(URL, { home, run, pin: { sha: SHA } });

    expect(calls).toEqual([
      ['git', 'init', out.dir],
      ['git', '-C', out.dir, 'remote', 'add', 'origin', URL],
      ['git', '-C', out.dir, 'fetch', '--depth', '1', 'origin', SHA],
      ['git', 'clone', URL, out.dir],
      ['git', '-C', out.dir, 'checkout', SHA],
    ]);
    // 回退不是静默的：慢在哪、为什么退，都要出现在给用户的说明里
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain(SHA);
    expect(out.notes[0]).toContain('full clone');
    expect(out.notes[0]).toContain('unadvertised object');
  });

  it('throws instead of settling for the default branch when both attempts fail', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const run = runner(calls, (args) => {
      if (args.includes('fetch')) return NO_SHALLOW_SHA;
      if (args[0] === 'clone') return 'fatal: could not read Username: terminal prompts disabled';
      return null;
    });

    const err = await resolveSource(URL, { home, run, pin: { sha: SHA } }).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = err!.message;
    // 想要哪个 pin、试过哪两种取法、各自怎么失败的——三样都要在错误里
    expect(message).toContain(SHA);
    expect(message).toContain('unadvertised object');
    expect(message).toContain('terminal prompts disabled');
    expect(message).toMatch(/default branch/);
  });

  it('reports a failed --branch clone against the pin rather than retrying without it', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const run = runner(calls, () => 'fatal: Remote branch v9 not found in upstream origin');

    const err = await resolveSource(URL, { home, run, pin: { ref: 'v9' } }).then(
      () => null,
      (e: Error) => e,
    );

    expect(err!.message).toContain('v9');
    expect(err!.message).toContain('Remote branch v9 not found');
    // 一次尝试，没有"再裸克隆一次试试"
    expect(calls).toHaveLength(1);
  });

  for (const sha of ['--upload-pack=/tmp/evil', ';rm -rf /', 'zzzzzzz', 'HEAD']) {
    it(`refuses the unusable sha ${JSON.stringify(sha)} without running git at all`, async () => {
      const home = await newHome();
      const calls: string[][] = [];
      const err = await resolveSource(URL, { home, run: runner(calls), pin: { sha } }).then(
        () => null,
        (e: Error) => e,
      );

      expect(err).toBeInstanceOf(PinRejectedError);
      expect((err as PinRejectedError).finding.level).toBe('BLOCK');
      expect((err as PinRejectedError).finding.code).toBe('source.pin-unsafe');
      expect(err!.message).toContain(sha);
      expect(calls).toEqual([]);
    });
  }

  it('refuses a sha longer than a git object id', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    await expect(
      resolveSource(URL, { home, run: runner(calls), pin: { sha: 'a'.repeat(41) } }),
    ).rejects.toBeInstanceOf(PinRejectedError);
    expect(calls).toEqual([]);
  });

  it('accepts a short but well-formed sha', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    await resolveSource(URL, { home, run: runner(calls), pin: { sha: '30287f5' } });
    expect(calls.flat()).toContain('30287f5');
  });

  for (const ref of ['--upload-pack=/tmp/evil', '-v1.5.5', 'v1 .5', 'main\nrm', '']) {
    it(`refuses the unusable ref ${JSON.stringify(ref)} without running git at all`, async () => {
      const home = await newHome();
      const calls: string[][] = [];
      const err = await resolveSource(URL, { home, run: runner(calls), pin: { ref } }).then(
        () => null,
        (e: Error) => e,
      );

      expect(err).toBeInstanceOf(PinRejectedError);
      expect((err as PinRejectedError).finding.code).toBe('source.pin-unsafe');
      expect(calls).toEqual([]);
    });
  }

  it('leaves the unpinned clone byte-for-byte as it was', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const out = await resolveSource(URL, { home, run: runner(calls) });
    expect(calls).toEqual([['git', 'clone', '--depth', '1', URL, out.dir]]);
  });

  it('is unpinned when the entry carries no ref and no sha', async () => {
    const home = await newHome();
    const calls: string[][] = [];
    const out = await resolveSource(URL, { home, run: runner(calls), pin: {} });
    expect(calls).toEqual([['git', 'clone', '--depth', '1', URL, out.dir]]);
  });
});
