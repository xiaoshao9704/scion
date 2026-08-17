import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordInstall } from '../src/install/state.js';

// sync 的分组逻辑本身是本测试要盯住的行为，不需要真的走一遍 doctor/normalize/
// install 流水线——mock 掉 runInstall，直接检查 sync 传给它的参数，既隔离又
// 不产生任何真实副作用（不解析 source、不跑外部命令）。
const runInstallMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../src/commands/install.js', () => ({ runInstall: runInstallMock }));

const { runSync } = await import('../src/commands/sync.js');

beforeEach(() => {
  runInstallMock.mockClear();
});

describe('runSync — per-target registered flag', () => {
  it('does not upgrade a convert-only Kimi install to --write-registry via a registered Codex sibling', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    // 同一来源装到 codex（总是 registered:true）和 kimi（用户选了 convert-only,
    // registered:false）——sync 之前会把两者合成一次 install，被 codex 的
    // registered:true 带偏，连 kimi 也传上 --write-registry。
    await recordInstall(home, {
      name: 'demo',
      target: 'codex',
      source: 'shared-source',
      sourceKind: 'path',
      pluginRoot: '/tmp/codex-root',
      registered: true,
    });
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: 'shared-source',
      sourceKind: 'path',
      pluginRoot: '/tmp/kimi-root',
      registered: false,
    });

    const out: string[] = [];
    const code = await runSync([], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(0);

    expect(runInstallMock).toHaveBeenCalledTimes(2);
    const calls = runInstallMock.mock.calls.map(([argv]) => argv as string[]);

    const codexCall = calls.find((a) => a.includes('codex'));
    const kimiCall = calls.find((a) => a.includes('kimi'));
    expect(codexCall).toBeDefined();
    expect(kimiCall).toBeDefined();
    expect(codexCall).toContain('--write-registry');
    expect(kimiCall).not.toContain('--write-registry');
  });

  it('still merges into a single install when a source group agrees on registered', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'demo',
      target: 'codex',
      source: 'shared-source',
      sourceKind: 'path',
      pluginRoot: '/tmp/codex-root',
      registered: true,
    });
    await recordInstall(home, {
      name: 'demo',
      target: 'kimi',
      source: 'shared-source',
      sourceKind: 'path',
      pluginRoot: '/tmp/kimi-root',
      registered: true,
    });

    const out: string[] = [];
    const code = await runSync([], { write: (s) => out.push(s) }, { home });
    expect(code).toBe(0);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    const [argv] = runInstallMock.mock.calls[0] as [string[]];
    expect(argv).toContain('--write-registry');
    const toIndex = argv.indexOf('--to');
    expect(argv[toIndex + 1].split(',').sort()).toEqual(['codex', 'kimi']);
  });
});
