import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalize } from '../src/normalize/index.js';
import { project } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');

export interface ManifestDiff {
  onlyGenerated: string[];
  onlyHandWritten: string[];
  differing: Array<{ field: string; generated: unknown; handWritten: unknown }>;
}

function diffManifests(
  generated: Record<string, unknown>,
  handWritten: Record<string, unknown>,
): ManifestDiff {
  const fields = new Set([...Object.keys(generated), ...Object.keys(handWritten)]);
  const diff: ManifestDiff = { onlyGenerated: [], onlyHandWritten: [], differing: [] };
  for (const field of [...fields].sort()) {
    const a = generated[field];
    const b = handWritten[field];
    if (a !== undefined && b === undefined) diff.onlyGenerated.push(field);
    else if (a === undefined && b !== undefined) diff.onlyHandWritten.push(field);
    else if (JSON.stringify(a) !== JSON.stringify(b)) {
      diff.differing.push({ field, generated: a, handWritten: b });
    }
  }
  return diff;
}

async function handWritten(fixture: string, rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join('tests/fixtures/golden', fixture, rel), 'utf8'));
}

describe('golden: superpowers claude -> kimi', () => {
  it('agrees with the hand-written manifest on identity', async () => {
    const ir = await normalize('tests/fixtures/golden/superpowers', claude);
    const generated = project(ir, loadProfile('kimi')).manifest;
    const manual = await handWritten('superpowers', '.kimi-plugin/plugin.json');

    expect(generated.name).toBe(manual.name);
    expect(generated.version).toBe(manual.version);
    expect(generated.license).toBe(manual.license);
    expect(generated.author).toEqual(manual.author);
    expect(generated.skills).toBe(manual.skills);
  });

  it('has only the documented differences', async () => {
    const ir = await normalize('tests/fixtures/golden/superpowers', claude);
    const generated = project(ir, loadProfile('kimi')).manifest;
    const manual = await handWritten('superpowers', '.kimi-plugin/plugin.json');
    const diff = diffManifests(generated, manual);

    // description / keywords / skillInstructions 是人工为 Kimi 单独重写的文案，
    // Claude 清单里没有对应来源，Scion 只能沿用 Claude 侧原值或注入自己的 L3 常量。
    // interface / sessionStart 在生成结果里完全不存在（undefined），所以落在
    // onlyHandWritten 而不是 differing —— 两边都缺失时 diffManifests 不会当作"值不同"。
    // 详见 docs/golden-diff-notes.md。
    expect(diff.differing.map((d) => d.field).sort()).toEqual([
      'description',
      'keywords',
      'skillInstructions',
    ]);
    expect(diff.onlyHandWritten.sort()).toEqual(['interface', 'sessionStart']);
    // repository 是 Claude 源清单里就有的字段，Scion 按设计原样带出；
    // 人工维护的 Kimi 清单省略了它（与 homepage 重复），这是人工清单的缺项，不是 Scion 的 bug。
    expect(diff.onlyGenerated).toEqual(['repository']);
  });
});

describe('golden: metrics-monitor claude -> codex', () => {
  it('keeps the claude name instead of inheriting the drifted one', async () => {
    const ir = await normalize('tests/fixtures/golden/metrics-monitor', claude);
    const generated = project(ir, loadProfile('codex')).manifest;
    const manual = await handWritten('metrics-monitor', '.codex-plugin/plugin.json');

    expect(generated.name).toBe('metrics-monitor');
    expect(manual.name).toBe('metrics-mcp-server');
    // 这条差异是人工清单腐烂，不是 Scion 的 bug —— 见 docs/golden-diff-notes.md
    expect(generated.name).not.toBe(manual.name);
  });

  it('carries mcpServers across as a path reference', async () => {
    const ir = await normalize('tests/fixtures/golden/metrics-monitor', claude);
    const out = project(ir, loadProfile('codex'));
    expect(out.manifest.mcpServers).toBe('./.mcp.json');
    expect(Object.keys(ir.capabilities.mcpServers).length).toBeGreaterThan(0);
  });

  it('reports the version gap the hand-written manifests introduced', async () => {
    const ir = await normalize('tests/fixtures/golden/metrics-monitor', claude);
    const manual = await handWritten('metrics-monitor', '.codex-plugin/plugin.json');
    expect(ir.identity.version).toBeUndefined();
    expect(manual.version).toBe('1.2.1');
  });

  it('has only the documented differences', async () => {
    const ir = await normalize('tests/fixtures/golden/metrics-monitor', claude);
    const generated = project(ir, loadProfile('codex')).manifest;
    const manual = await handWritten('metrics-monitor', '.codex-plugin/plugin.json');
    const diff = diffManifests(generated, manual);

    // name / author / description 三处是人工分别维护 codex 清单时各自漂移出来的措辞或身份差异 —
    // 归类见 docs/golden-diff-notes.md（name/author 为 manual-rot，description 为 by-design）。
    expect(diff.differing.map((d) => d.field).sort()).toEqual(['author', 'description', 'name']);
    // Claude 源清单没有 keywords / interface，Scion 不发明；version 已在上一个用例单独覆盖。
    expect(diff.onlyHandWritten.sort()).toEqual(['interface', 'keywords', 'version']);
    // license / repository 是 Claude 源清单里就有、Scion 按设计原样带出的字段；
    // 人工维护的 codex 清单省略了它们，属人工清单缺项，不是 Scion 的 bug。
    expect(diff.onlyGenerated.sort()).toEqual(['license', 'repository']);
  });
});
