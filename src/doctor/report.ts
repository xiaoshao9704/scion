import type { EcosystemId, Finding, FindingLevel } from '../ir/types.js';
import type { EnvHandling, EnvVarUse } from '../mcp/env.js';

const ORDER: FindingLevel[] = ['BLOCK', 'LOSS', 'INFO'];

const HEADINGS: Record<FindingLevel, string> = {
  BLOCK: 'BLOCK  the target cannot structurally carry this; the install will fail or the plugin will not work',
  LOSS: 'LOSS   converts, but lossily — the following is dropped or changes meaning on the target',
  INFO: 'INFO   for reference: target-only fields left empty, values arrived at by inference',
};

/**
 * 每种落法怎么跟用户说。措辞里带上目标生态名，因为「谁来展开这个值」正是三家生态的
 * 差别所在——用户读完这一行就该知道自己还要不要动手。
 */
function handlingText(handling: EnvHandling, target: EcosystemId, field: string): string {
  switch (handling) {
    case 'bearer-field':
      return `bearer token — ${target} reads it from ${field} when it connects`;
    case 'bearer-inline':
      return `bearer token — written into the Authorization header as \${...}, which ${target} expands when it connects`;
    case 'header-field':
      return `header value — ${target} reads it from ${field} when it connects`;
    case 'header-inline':
      return `header value — written as \${...}, which ${target} expands when it connects`;
    case 'inline-expanded':
      return `\${...} placeholder left in place, which ${target} expands when it connects`;
    case 'inline-literal':
      return `\${...} placeholder written out literally — ${target} does NOT expand it; put the real value in by hand`;
  }
}

/** where 是 "文件#mcpServers.<server>.<字段…>"，取最后一段当字段名 */
function fieldOf(where: string): string {
  const tail = where.split('#').pop() ?? where;
  return tail.split('.').pop() ?? tail;
}

/**
 * 环境变量这一段。它和 findings 分开渲染，也和 findings 不同——**没有问题时也要打印**。
 * 用户装完插件最需要知道的一件事就是「我还得 export 什么」，那不是一个 issue，是一份清单。
 */
export function formatEnvVars(envVars: EnvVarUse[], target: EcosystemId): string {
  if (envVars.length === 0) return '';

  // 前置空行：findings 各组之间靠空行分隔，这一段紧贴上一组会读成它的续行
  const lines = ['', `ENV    environment variables this plugin reads (${envVars.length})`];
  for (const use of envVars) {
    const servers = use.servers.join(', ');
    lines.push(`  · ${use.name}  — used by ${servers}`);
    for (const h of use.handling) {
      lines.push(`      ${handlingText(h, target, fieldOf(use.where))}`);
    }
    if (use.previous) {
      // 名字是用户点名换的，所以只陈述事实 + 给出那条能直接粘的 export，不再劝什么
      lines.push(
        `      renamed from ${use.previous} as you asked with --env-name; the plugin's own docs still call it ${use.previous}`,
      );
      lines.push(`      export ${use.name}="$${use.previous}"   # before starting ${target}`);
    } else {
      lines.push(`      name kept exactly as the plugin author wrote it`);
      lines.push(`      export ${use.name}=…   # before starting ${target}`);
    }
  }
  // 一行中性说明，不对任何名字下判断：哪个名字该换、会不会跟别的插件撞车，只有用户
  // 知道自己机器上还装着什么。scion 曾经拿一份写死的「泛化名清单」去猜，那种命名方式
  // 枚举不全，猜中与否都只是噪音。
  lines.push('  Rename any of these with --env-name OLD=NEW.');
  lines.push('');
  return lines.join('\n');
}

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
