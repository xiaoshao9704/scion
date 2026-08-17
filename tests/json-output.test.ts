import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePluginDir } from './helpers/tmp.js';
import { runCli } from '../src/cli.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runInstall } from '../src/commands/install.js';
import { runList } from '../src/commands/list.js';
import { runMarket } from '../src/commands/market.js';
import { recordInstall } from '../src/install/state.js';

/** 收集 stdout；--json 下这一整串必须能被 JSON.parse 吃下去（C1） */
function capture() {
  const out: string[] = [];
  return { io: { write: (s: string) => out.push(s) }, text: () => out.join('') };
}

const DEMO = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n\nbody\n',
};

/** allowed-tools 在目标端没有对应物 → 稳定产出 LOSS */
const LOSSY_COMMAND = {
  'commands/ship.md': '---\ndescription: s\nallowed-tools: Bash(git push:*)\n---\n\nGo.\n',
};

/**
 * 人读输出里每条 finding 都写成 "[code] message"，据此取回它实际报告了哪些 code。
 * 按出现次数取回而不是去重：同一个 code 报了两次，JSON 里也必须是两条。
 */
function codesInHumanText(text: string): string[] {
  return [...text.matchAll(/\[([a-z][\w.-]*)\]/g)].map((m) => m[1]).sort();
}

function deepKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      deepKeys(v, into);
    }
  }
  return into;
}

describe('doctor --json', () => {
  it('writes JSON and nothing but JSON to stdout', async () => {
    const dir = await makePluginDir(DEMO);
    const { io, text } = capture();

    const code = await runDoctor([dir, '--to', 'codex', '--json'], io);

    expect(code).toBe(0);
    const doc = JSON.parse(text()); // C1：一个字节的散文都不许混进来
    expect(doc).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      exitCode: 0,
      plugin: { name: 'demo', version: '1.0.0' },
      from: 'claude',
      to: 'codex',
    });
    expect(Array.isArray(doc.findings)).toBe(true);
  });

  it('reports the same findings as the human rendering (C2)', async () => {
    const dir = await makePluginDir({ ...DEMO, ...LOSSY_COMMAND });

    const human = capture();
    const humanCode = await runDoctor([dir, '--to', 'codex'], human.io);
    const json = capture();
    const jsonCode = await runDoctor([dir, '--to', 'codex', '--json'], json.io);

    expect(jsonCode).toBe(humanCode);
    const doc = JSON.parse(json.text());
    const findings = doc.findings as { level: string; code: string; message: string; where?: string }[];
    expect(findings.length).toBeGreaterThan(0);
    // 逐条比对而非比集合：同一个 code 报了两次，JSON 里少一条就是漏报，去重会看不见
    const humanCodes = codesInHumanText(human.text());
    expect(findings.length).toBe(humanCodes.length);
    expect(findings.map((f) => f.code).sort()).toEqual(humanCodes);
    // 措辞也得是同一份：JSON 若为 agent 另起一套说法，两边就会各说各话
    for (const f of findings) {
      expect(human.text()).toContain(`[${f.code}] ${f.message}${f.where ? `  — ${f.where}` : ''}`);
    }
    expect(doc.worst).toBe('LOSS');
  });

  it('exposes level/code/message/where verbatim, without re-wording', async () => {
    const dir = await makePluginDir({ ...DEMO, ...LOSSY_COMMAND });
    const { io, text } = capture();

    await runDoctor([dir, '--to', 'codex', '--json'], io);

    const findings = JSON.parse(text()).findings as Record<string, unknown>[];
    const loss = findings.find((f) => f.level === 'LOSS')!;
    expect(Object.keys(loss).sort()).toEqual(['code', 'level', 'message', 'where']);
  });

  it('keeps the exit code identical to the human rendering (C3)', async () => {
    const cases: [Record<string, string>, string, number][] = [
      [DEMO, 'codex', 0],
      [{ ...DEMO, ...LOSSY_COMMAND }, 'codex', 0],
      [{ '.claude-plugin/plugin.json': JSON.stringify({ name: 'Bad Name' }) }, 'kimi', 2],
    ];

    for (const [files, to, expected] of cases) {
      const dir = await makePluginDir(files);
      const human = capture();
      const json = capture();
      expect(await runDoctor([dir, '--to', to], human.io)).toBe(expected);
      const code = await runDoctor([dir, '--to', to, '--json'], json.io);
      expect(code).toBe(expected);
      expect(JSON.parse(json.text()).exitCode).toBe(expected);
    }
  });

  it('stays valid JSON on a usage error', async () => {
    const { io, text } = capture();

    const code = await runDoctor(['--json'], io);

    expect(code).toBe(1);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'doctor', exitCode: 1 });
    expect(doc.error.message).toContain('usage:');
  });
});

describe('install --dry-run --json', () => {
  it('emits the plan actions in order and never leaks the execute payload', async () => {
    const dir = await makePluginDir(DEMO);
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const { io, text } = capture();

    const code = await runInstall(['--to', 'codex', '--dry-run', '--json', dir], io, { home });

    expect(code).toBe(0);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'install', exitCode: 0, dryRun: true });
    const target = doc.targets[0];
    expect(target.target).toBe('codex');
    // codex 装一个插件是四步：落盘、改 catalog、注册市场、装插件。顺序即执行顺序，
    // agent 据此判断这次 dry-run 会动什么。
    expect(target.plan.actions.map((a: { kind: string }) => a.kind)).toEqual([
      'write-tree',
      'upsert-catalog',
      'exec',
      'exec',
    ]);
    expect(target.plan.actions[0].files.length).toBeGreaterThan(0);
    // payload 是 execute 的私事，序列化出去既是实现细节泄漏，也可能很大
    expect(deepKeys(doc).has('payload')).toBe(false);
    expect(text()).not.toContain('payload');
  });

  it('keeps the BLOCK exit code and says which target stopped the run', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'Bad Name' }),
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const { io, text } = capture();

    const code = await runInstall(['--to', 'kimi', '--dry-run', '--json', dir], io, { home });

    expect(code).toBe(2);
    const doc = JSON.parse(text());
    expect(doc.exitCode).toBe(2);
    expect(doc.stoppedAt).toEqual({ target: 'kimi', reason: 'block' });
    expect(doc.targets[0].plan).toBeUndefined();
  });

  it('refuses --json for a real install, in JSON', async () => {
    const dir = await makePluginDir(DEMO);
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const { io, text } = capture();

    const code = await runInstall(['--to', 'codex', '--json', dir], io, { home });

    expect(code).toBe(1);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'install', exitCode: 1 });
    expect(doc.error.message).toContain('--dry-run');
  });
});

describe('market convert --json', () => {
  it('names the excluded entries and their reasons, and still exits 4', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'three-entries',
        plugins: [
          { name: 'alpha', source: './plugins/alpha', description: 'A' },
          { name: 'b/roken', source: './plugins/broken', description: 'B' },
          { name: 'gamma', source: './plugins/gamma', description: 'C' },
        ],
      }),
      'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
      'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n\nbody\n',
      'plugins/gamma/.claude-plugin/plugin.json': JSON.stringify({ name: 'gamma', version: '1.0.0' }),
      'plugins/gamma/skills/c/SKILL.md': '---\nname: c\ndescription: d\n---\n\nbody\n',
    });
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const { io, text } = capture();

    const code = await runMarket(['convert', dir, '--to', 'codex', '--json'], io, {
      home,
      run: async () => ({ stdout: '', stderr: '' }),
    });

    expect(code).toBe(4);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'market convert', exitCode: 4 });
    expect(doc.converted).toEqual(['alpha', 'gamma']);
    expect(doc.excluded).toHaveLength(1);
    expect(doc.excluded[0].entry).toBe('b/roken');
    expect(doc.excluded[0].findings[0].code).toBe('marketplace.entry-name-unsafe');
    expect(doc.marketplace.name).toBe('three-entries');
    expect(doc.next.join(' ')).toContain('codex plugin marketplace add');
  });

  it('stays valid JSON on a usage error', async () => {
    const { io, text } = capture();

    const code = await runMarket(['frobnicate', '--json'], io, {});

    expect(code).toBe(1);
    expect(JSON.parse(text())).toMatchObject({ command: 'market', exitCode: 1 });
  });
});

describe('market show --json', () => {
  it('emits the catalog overview as data', async () => {
    const dir = await makePluginDir({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'two-entries',
        plugins: [
          { name: 'alpha', source: './plugins/alpha', description: 'A' },
          { name: 'gamma', source: './plugins/gamma', description: 'C' },
        ],
      }),
      'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha' }),
      'plugins/gamma/.claude-plugin/plugin.json': JSON.stringify({ name: 'gamma' }),
    });
    const { io, text } = capture();

    const code = await runMarket(['show', dir, '--json'], io, {});

    expect(code).toBe(0);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'market show', exitCode: 0 });
    expect(doc.marketplace.name).toBe('two-entries');
    expect(doc.entries.map((e: { name: string }) => e.name)).toEqual(['alpha', 'gamma']);
    expect(Array.isArray(doc.findings)).toBe(true);
  });
});

describe('list --json', () => {
  it('emits the ledger as data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    await recordInstall(home, {
      name: 'demo',
      version: '1.0.0',
      target: 'kimi',
      source: 'obra/superpowers',
      sourceKind: 'git',
      pluginRoot: '/tmp/x',
      registered: false,
    });
    const { io, text } = capture();

    const code = await runList(['--json'], io, { home });

    expect(code).toBe(0);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'list', exitCode: 0 });
    expect(doc.plugins).toHaveLength(1);
    expect(doc.plugins[0]).toMatchObject({
      name: 'demo',
      target: 'kimi',
      source: 'obra/superpowers',
      registered: false,
    });
  });

  it('emits an empty array rather than a sentence when nothing is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scion-home-'));
    const { io, text } = capture();

    expect(await runList(['--json'], io, { home })).toBe(0);
    expect(JSON.parse(text()).plugins).toEqual([]);
  });
});

describe('scion --json at the top level', () => {
  it('reports an unknown command as JSON', async () => {
    const { io, text } = capture();

    const code = await runCli(['frobnicate', '--json'], io);

    expect(code).toBe(1);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'scion', exitCode: 1 });
    expect(doc.error.message).toContain('unknown command');
  });

  it('reports a thrown error as JSON instead of leaving stdout empty', async () => {
    const { io, text } = capture();

    const code = await runCli(['doctor', '/no/such/plugin/dir', '--json'], io);

    expect(code).toBe(1);
    const doc = JSON.parse(text());
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'doctor', exitCode: 1 });
    expect(typeof doc.error.message).toBe('string');
  });
});
