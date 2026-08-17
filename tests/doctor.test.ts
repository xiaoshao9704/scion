import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { doctor, worstLevel } from '../src/doctor/index.js';
import { formatFindings } from '../src/doctor/report.js';
import { loadProfile } from '../src/profiles/loader.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');
const codex = loadProfile('codex');

describe('doctor', () => {
  it('BLOCKs a name that violates the kimi pattern', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'Metrics Monitor' }),
    });
    const findings = await doctor(await normalize(root, claude), kimi);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'BLOCK', code: 'kimi.name.pattern' }),
    );
  });

  it('accepts a conforming name', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'metrics-monitor' }),
    });
    const findings = await doctor(await normalize(root, claude), kimi);
    expect(findings.some((f) => f.code === 'kimi.name.pattern')).toBe(false);
  });

  it('flags inline bash in commands as unverified', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'commands/status.md': '---\ndescription: s\n---\n\nBranch: !`git branch --show-current`\n',
    });
    const findings = await doctor(await normalize(root, claude), kimi);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'LOSS', code: 'command.inline-bash' }),
    );
    // 内部 spec 编号对用户毫无用处（他们查不到），但"未经验证"这个实质必须留着
    const finding = findings.find((f) => f.code === 'command.inline-bash')!;
    expect(finding.message).not.toMatch(/spec TBD/i);
    expect(finding.message).toMatch(/unverified|untested/);
  });

  it('flags agents when targeting codex, whose agents support is unconfirmed', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'agents/reviewer.md': '---\nname: reviewer\ndescription: r\n---\n\nx\n',
    });
    const findings = await doctor(await normalize(root, claude), codex);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'codex.agents.unverified' }),
    );
    // 内部 spec 编号对用户毫无用处（他们查不到），但"未经验证"这个实质必须留着
    const finding = findings.find((f) => f.code === 'codex.agents.unverified')!;
    expect(finding.message).not.toMatch(/spec TBD/i);
    expect(finding.message).toMatch(/unverified|untested/);
  });

  it('reports inferred fields as INFO when run without a target', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'skills/demo/SKILL.md': '---\nname: demo\n---\n\nx\n',
    });
    const findings = await doctor(await normalize(root, claude));
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'INFO', code: 'provenance.inferred' }),
    );
  });

  it('ranks levels correctly', () => {
    expect(worstLevel([])).toBeNull();
    expect(worstLevel([{ level: 'INFO', code: 'a', message: 'm' }])).toBe('INFO');
    expect(
      worstLevel([
        { level: 'INFO', code: 'a', message: 'm' },
        { level: 'LOSS', code: 'b', message: 'm' },
      ]),
    ).toBe('LOSS');
    expect(
      worstLevel([
        { level: 'LOSS', code: 'b', message: 'm' },
        { level: 'BLOCK', code: 'c', message: 'm' },
      ]),
    ).toBe('BLOCK');
  });

  it('formats findings grouped by level', () => {
    const text = formatFindings([
      { level: 'LOSS', code: 'x.y', message: 'lost a thing', where: 'a.md' },
      { level: 'BLOCK', code: 'z', message: 'cannot' },
    ]);
    expect(text.indexOf('BLOCK')).toBeLessThan(text.indexOf('LOSS'));
    expect(text).toContain('a.md');
    expect(text).toContain('lost a thing');
  });
});
