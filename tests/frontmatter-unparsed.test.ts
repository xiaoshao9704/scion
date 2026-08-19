import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { projectAll } from '../src/project/index.js';
import { remapFrontmatter } from '../src/project/frontmatter.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');

// 真实样本：argument-hint 的值以 "[" 开头，YAML 当它是流式序列，而 "]" 之后还有内容。
// Claude 侧的插件就这么发着，gray-matter 会抛。
const BAD = [
  '---',
  'description: Save, load or delete client profiles',
  'argument-hint: [list|save|load|delete] [name]',
  '---',
  '',
  'body',
  '',
].join('\n');

describe('frontmatter that is not valid YAML', () => {
  async function convert() {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      'commands/profile.md': BAD,
      'commands/fine.md': '---\ndescription: ok\n---\n\nbody\n',
    });
    return projectAll(await normalize(root, claude), kimi);
  }

  // 从前这里抛出的异常会冒到顶层，变成一条既没有插件名也没有文件名的报错
  it('is reported as LOSS against the file, not thrown', async () => {
    const { findings } = await convert();
    const hit = findings.find((f) => f.code === 'frontmatter.unparsed');
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('LOSS');
    expect(hit!.where).toBe('commands/profile.md');
    expect(hit!.message).toMatch(/not valid YAML/);
  });

  // 跳过这个文件等于静默丢一条命令，比报错更坏：正文一个字节都不能动
  it('hands the file back verbatim instead of dropping it', () => {
    const out = remapFrontmatter(BAD, 'commands', claude, kimi, 'commands/profile.md');
    expect(out.content).toBe(BAD);
    expect(out.findings.map((f) => f.code)).toEqual(['frontmatter.unparsed']);
  });

  it('does not disturb the valid file next to it', async () => {
    const { findings } = await convert();
    expect(findings.filter((f) => f.code === 'frontmatter.unparsed')).toHaveLength(1);
    // description 在 kimi 侧有对应字段，干净转换本就不该产出任何 finding
    expect(findings.filter((f) => f.where?.startsWith('commands/fine.md'))).toEqual([]);
  });
});

// gray-matter 的全局缓存按内容字符串索引，且在解析抛错之后仍留下条目：同一份坏内容
// 第二次解析不再抛，而是返回空 frontmatter。一次 install 里同一个文件要过好几遍
// （doctor 一遍、preview 再一遍，多目标再乘一遍），所以这条不守住，第二遍开始整个
// 文件就被静默放行了。
describe('the report does not depend on how many times the file was parsed', () => {
  it('reports the same thing on every pass over identical content', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      'commands/profile.md': BAD,
    });
    const ir = await normalize(root, claude);
    for (const pass of [1, 2, 3]) {
      const { findings } = await projectAll(ir, kimi);
      expect(
        findings.filter((f) => f.code === 'frontmatter.unparsed'),
        `pass ${pass}`,
      ).toHaveLength(1);
    }
  });
});
