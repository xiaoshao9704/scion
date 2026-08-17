import { describe, it, expect } from 'vitest';
import { runCli } from '../src/cli.js';

describe('runCli', () => {
  it('prints version and exits 0', async () => {
    const out: string[] = [];
    const code = await runCli(['--version'], { write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 1 on unknown command', async () => {
    const out: string[] = [];
    const code = await runCli(['frobnicate'], { write: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join('')).toContain('unknown command');
  });
});
