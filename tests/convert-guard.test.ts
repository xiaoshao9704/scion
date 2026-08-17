import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// assertSafeOutDir reads homedir() internally with no injection seam, so we mock
// node:os for this file only and point it at a throwaway temp directory. This
// keeps the test off the real user's home directory entirely while still letting
// us construct a "~/.scion-old"-shaped sibling path to exercise the prefix bug.
let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

const { assertSafeOutDir } = await import('../src/commands/convert.js');

beforeAll(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'scion-fakehome-'));
});

afterAll(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

describe('assertSafeOutDir', () => {
  it('refuses a non-empty directory outside ~/.scion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scion-guard-outside-'));
    const keep = join(dir, 'keep.txt');
    await writeFile(keep, 'precious', 'utf8');

    await expect(assertSafeOutDir(dir)).rejects.toThrow(/refusing to overwrite/);
    expect(existsSync(keep)).toBe(true);
  });

  it('refuses a path that merely string-prefixes the scion root but is not inside it', async () => {
    // fakeHome/.scion is the sandbox; fakeHome/.scion-old is a sibling whose name
    // happens to start with the same string. Before the fix this was misclassified
    // as "inside ~/.scion" and let through unconditionally.
    const decoy = join(fakeHome, '.scion-old');
    await mkdir(decoy, { recursive: true });
    await writeFile(join(decoy, 'keep.txt'), 'precious', 'utf8');

    await expect(assertSafeOutDir(decoy)).rejects.toThrow(/refusing to overwrite/);
    expect(existsSync(join(decoy, 'keep.txt'))).toBe(true);
  });

  it('permits a genuinely nested path under ~/.scion', async () => {
    const nested = join(fakeHome, '.scion', 'out', 'plugin', 'kimi');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'stale.txt'), 'old output', 'utf8');

    await expect(assertSafeOutDir(nested)).resolves.toBeUndefined();
  });

  it('permits a non-existent path', async () => {
    const dir = join(fakeHome, 'does-not-exist', 'nested');
    await expect(assertSafeOutDir(dir)).resolves.toBeUndefined();
  });

  it('permits an existing empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scion-guard-empty-'));
    await expect(assertSafeOutDir(dir)).resolves.toBeUndefined();
  });

  it('refuses when the path points at an existing regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scion-guard-file-'));
    const file = join(dir, 'not-a-directory');
    await writeFile(file, 'precious', 'utf8');

    await expect(assertSafeOutDir(file)).rejects.toThrow();
    expect(existsSync(file)).toBe(true);
  });
});
