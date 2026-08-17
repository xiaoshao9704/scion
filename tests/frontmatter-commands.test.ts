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

  it('keeps argument-hint for codex but drops it for kimi', () => {
    expect(
      matter(remapFrontmatter(COMMAND, 'commands', claude, codex, 'c.md').content).data[
        'argument-hint'
      ],
    ).toBe('[branch]');

    const toKimi = remapFrontmatter(COMMAND, 'commands', claude, kimi, 'c.md');
    expect(matter(toKimi.content).data['argument-hint']).toBeUndefined();
    expect(toKimi.findings.some((f) => f.where === 'c.md#argument-hint')).toBe(true);
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
