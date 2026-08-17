import type { Finding } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { RemapResult } from './frontmatter.js';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function substitutePathVars(
  content: string,
  from: EcosystemProfile,
  to: EcosystemProfile,
  where: string,
): RemapResult {
  const variable = from.pathVar;
  if (!variable) return { content, findings: [] };

  const strategy = to.pathVarStrategy;
  if (strategy.kind === 'keep') return { content, findings: [] };

  const findings: Finding[] = [];
  // 变量后面跟 "/xxx" 时连斜杠一起吃掉；单独出现时替换为 "."
  const pattern = new RegExp(`${escapeRegExp(variable)}(/)?`, 'g');

  const next = content.replace(pattern, (_match, slash: string | undefined) => {
    if (strategy.kind === 'rename') {
      findings.push({
        level: 'INFO',
        code: 'pathvar.renamed',
        message: `${variable} → ${strategy.to}`,
        where,
      });
      return slash ? `${strategy.to}/` : strategy.to;
    }
    findings.push({
      level: 'LOSS',
      code: 'pathvar.relativized',
      message: `${to.id} has no plugin-root variable; ${variable} was rewritten as a relative path, which breaks if the skill runs from a different working directory`,
      where,
    });
    return slash ? '' : '.';
  });

  return { content: next, findings };
}
