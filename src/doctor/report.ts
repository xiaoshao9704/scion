import type { Finding, FindingLevel } from '../ir/types.js';

const ORDER: FindingLevel[] = ['BLOCK', 'LOSS', 'INFO'];

const HEADINGS: Record<FindingLevel, string> = {
  BLOCK: 'BLOCK  the target cannot structurally carry this; the install will fail or the plugin will not work',
  LOSS: 'LOSS   converts, but lossily — the following is dropped or changes meaning on the target',
  INFO: 'INFO   for reference: target-only fields left empty, values arrived at by inference',
};

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'No issues found.\n';

  const lines: string[] = [];
  for (const level of ORDER) {
    const group = findings.filter((f) => f.level === level);
    if (group.length === 0) continue;
    lines.push(`${HEADINGS[level]} (${group.length})`);
    for (const f of group) {
      lines.push(`  · [${f.code}] ${f.message}${f.where ? `  — ${f.where}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
