import matter from 'gray-matter';
import type { Finding } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';

export interface RemapResult {
  content: string;
  findings: Finding[];
}

export type FrontmatterKind = 'agents' | 'commands';

export function remapFrontmatter(
  source: string,
  kind: FrontmatterKind,
  from: EcosystemProfile,
  to: EcosystemProfile,
  where: string,
): RemapResult {
  const parsed = matter(source);
  const findings: Finding[] = [];

  // gray-matter 对无 frontmatter 的文件返回空 data，此时原样返回，避免平白加上 "---"
  if (Object.keys(parsed.data).length === 0) {
    return { content: source, findings };
  }

  const sourceRules = from.frontmatterMap[kind];
  const targetRules = to.frontmatterMap[kind];
  const out: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(parsed.data)) {
    if (!(field in sourceRules)) {
      findings.push({
        level: 'INFO',
        code: 'frontmatter.field-unknown',
        message: `the ${from.id} profile does not declare the ${kind} field "${field}"; kept as-is`,
        where: `${where}#${field}`,
      });
      out[field] = value;
      continue;
    }

    const rule = targetRules[field];

    if (!rule || rule.to === null) {
      findings.push({
        level: 'LOSS',
        code: 'frontmatter.field-dropped',
        message: rule?.note ?? `${to.id} has no matching field; "${field}" dropped`,
        where: `${where}#${field}`,
      });
      continue;
    }

    if (rule.valueMap && typeof value === 'string') {
      const mapped = rule.valueMap[value];
      if (mapped === undefined) {
        findings.push({
          level: 'LOSS',
          code: 'frontmatter.value-unmapped',
          message: `"${field}: ${value}" has no matching value on ${to.id}; the field is dropped`,
          where: `${where}#${field}`,
        });
        continue;
      }
      out[rule.to] = mapped;
      findings.push({
        level: rule.lossy ? 'LOSS' : 'INFO',
        code: 'frontmatter.value-mapped',
        message: rule.note
          ? `${rule.note} (${field}: ${value} → ${rule.to}: ${mapped})`
          : `${field}: ${value} → ${rule.to}: ${mapped}`,
        where: `${where}#${field}`,
      });
      continue;
    }

    out[rule.to] = value;
    if (rule.lossy) {
      findings.push({
        level: 'LOSS',
        code: 'frontmatter.field-lossy',
        message: rule.note ?? `${field} → ${rule.to} is a lossy mapping`,
        where: `${where}#${field}`,
      });
    }
  }

  return { content: matter.stringify(parsed.content, out), findings };
}
