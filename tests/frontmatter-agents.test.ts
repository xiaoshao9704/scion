import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { remapFrontmatter } from '../src/project/frontmatter.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');

const AGENT = `---
name: reviewer
description: Reviews code
model: opus
tools:
  - Read
  - Grep
---

You are a reviewer.
`;

describe('agents frontmatter remap claude -> kimi', () => {
  it('maps model to model_preference and reports the loss', () => {
    const out = remapFrontmatter(AGENT, 'agents', claude, kimi, 'agents/reviewer.md');
    const fm = matter(out.content).data;
    expect(fm.model_preference).toBe('primary');
    expect(fm.model).toBeUndefined();
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        level: 'LOSS',
        code: 'frontmatter.value-mapped',
        where: 'agents/reviewer.md#model',
      }),
    );
  });

  it('maps haiku to secondary', () => {
    const src = AGENT.replace('model: opus', 'model: haiku');
    const fm = matter(remapFrontmatter(src, 'agents', claude, kimi, 'a.md').content).data;
    expect(fm.model_preference).toBe('secondary');
  });

  it('passes name, description and tools through untouched', () => {
    const fm = matter(remapFrontmatter(AGENT, 'agents', claude, kimi, 'a.md').content).data;
    expect(fm.name).toBe('reviewer');
    expect(fm.description).toBe('Reviews code');
    expect(fm.tools).toEqual(['Read', 'Grep']);
  });

  it('preserves the body verbatim', () => {
    const out = remapFrontmatter(AGENT, 'agents', claude, kimi, 'a.md');
    expect(matter(out.content).content.trim()).toBe('You are a reviewer.');
  });

  it('reports an unknown value instead of guessing', () => {
    const src = AGENT.replace('model: opus', 'model: gpt-5');
    const out = remapFrontmatter(src, 'agents', claude, kimi, 'a.md');
    expect(matter(out.content).data.model_preference).toBeUndefined();
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'LOSS', code: 'frontmatter.value-unmapped' }),
    );
  });

  it('reports fields the target profile does not know about', () => {
    const src = AGENT.replace('model: opus', 'color: red');
    const out = remapFrontmatter(src, 'agents', claude, kimi, 'a.md');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'frontmatter.field-unknown' }),
    );
  });

  it('leaves files without frontmatter alone', () => {
    const out = remapFrontmatter('just prose\n', 'agents', claude, kimi, 'a.md');
    expect(out.content).toBe('just prose\n');
    expect(out.findings).toEqual([]);
  });
});
