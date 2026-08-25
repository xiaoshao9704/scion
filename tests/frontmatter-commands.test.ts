import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { remapFrontmatter } from '../src/project/frontmatter.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');
const codex = loadProfile('codex');

const COMMAND = `---
description: Ship the branch
argument-hint: "[branch]"
allowed-tools: Bash(git push:*), Read
---

Push $ARGUMENTS.
`;

describe('commands frontmatter remap', () => {
  it('drops allowed-tools for kimi and flags widened permissions', () => {
    const out = remapFrontmatter(COMMAND, 'commands', claude, kimi, 'commands/ship.md');
    expect(matter(out.content).data['allowed-tools']).toBeUndefined();
    const loss = out.findings.find((f) => f.where === 'commands/ship.md#allowed-tools');
    expect(loss?.level).toBe('LOSS');
    expect(loss?.message).toContain('permissions are silently widened');
  });

  it('drops allowed-tools for codex too', () => {
    const out = remapFrontmatter(COMMAND, 'commands', claude, codex, 'commands/ship.md');
    expect(matter(out.content).data['allowed-tools']).toBeUndefined();
    expect(out.findings.some((f) => f.level === 'LOSS' && f.where?.endsWith('#allowed-tools'))).toBe(
      true,
    );
  });

  it('keeps argument-hint on both targets', () => {
    // 实测（Kimi 0.36.1 二进制）：TUI 把 argument-hint 渲染成补全时的灰色提示文本，
    // 字段是被消费的——照搬即可，不再作为损耗丢弃。
    for (const target of [kimi, codex]) {
      const out = remapFrontmatter(COMMAND, 'commands', claude, target, 'c.md');
      expect(matter(out.content).data['argument-hint']).toBe('[branch]');
      expect(out.findings.some((f) => f.where === 'c.md#argument-hint')).toBe(false);
    }
  });

  it('leaves $ARGUMENTS in the body untouched', () => {
    const out = remapFrontmatter(COMMAND, 'commands', claude, kimi, 'c.md');
    expect(matter(out.content).content).toContain('$ARGUMENTS');
  });

  it('keeps description on both targets', () => {
    for (const target of [kimi, codex]) {
      const fm = matter(remapFrontmatter(COMMAND, 'commands', claude, target, 'c.md').content).data;
      expect(fm.description).toBe('Ship the branch');
    }
  });
});
