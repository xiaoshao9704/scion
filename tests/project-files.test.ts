import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { projectAll } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');

async function fixture() {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
    'skills/demo/SKILL.md':
      '---\nname: demo\ndescription: d\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/scripts/go.sh\n',
    'commands/ship.md': '---\ndescription: ship\nallowed-tools: Bash(git push:*)\n---\n\nGo.\n',
    'agents/reviewer.md': '---\nname: reviewer\ndescription: r\nmodel: opus\n---\n\nReview.\n',
  });
}

describe('projectAll', () => {
  it('rewrites command and agent frontmatter', async () => {
    const ir = await normalize(await fixture(), claude);
    const out = await projectAll(ir, kimi);
    const command = out.files.find((f) => f.path === 'commands/ship.md')!;
    const agent = out.files.find((f) => f.path === 'agents/reviewer.md')!;
    expect(command.content).not.toContain('allowed-tools');
    expect(agent.content).toContain('model_preference: primary');
  });

  it('rewrites path variables inside skill bodies', async () => {
    const ir = await normalize(await fixture(), claude);
    const out = await projectAll(ir, kimi);
    const skill = out.files.find((f) => f.path === 'skills/demo/SKILL.md')!;
    expect(skill.content).toContain('Run scripts/go.sh');
    expect(skill.content).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  it('aggregates findings from every stage', async () => {
    const ir = await normalize(await fixture(), claude);
    const out = await projectAll(ir, kimi);
    const codes = new Set(out.findings.map((f) => f.code));
    expect(codes.has('frontmatter.field-dropped')).toBe(true);
    expect(codes.has('frontmatter.value-mapped')).toBe(true);
    expect(codes.has('pathvar.relativized')).toBe(true);
    expect(codes.has('toolmap.injected')).toBe(true);
  });

  it('still emits the manifest', async () => {
    const ir = await normalize(await fixture(), claude);
    const out = await projectAll(ir, kimi);
    expect(out.manifestPath).toBe('kimi.plugin.json');
    expect(out.manifest.name).toBe('p');
  });

  it('converts a nested command file the same way as a top-level one (I1)', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
      'commands/ns/deep.md':
        '---\ndescription: deep\nallowed-tools: Bash(git push:*)\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/lib/go.sh\n',
    });
    const ir = await normalize(root, claude);
    expect(ir.capabilities.commands).toEqual({ path: 'commands/', entries: ['ns/deep.md'] });

    const out = await projectAll(ir, kimi);
    const nested = out.files.find((f) => f.path === 'commands/ns/deep.md')!;
    expect(nested).toBeDefined();
    // allowed-tools 字段被丢弃（kimi 没有对应的权限声明字段）
    expect(nested.content).not.toContain('allowed-tools');
    // ${CLAUDE_PLUGIN_ROOT} 被改写为相对路径，不再原样出现
    expect(nested.content).toContain('Run lib/go.sh');
    expect(nested.content).not.toContain('CLAUDE_PLUGIN_ROOT');

    expect(out.findings).toContainEqual(
      expect.objectContaining({
        level: 'LOSS',
        code: 'frontmatter.field-dropped',
        where: 'commands/ns/deep.md#allowed-tools',
      }),
    );
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        level: 'LOSS',
        code: 'pathvar.relativized',
        where: 'commands/ns/deep.md',
      }),
    );
  });
});
