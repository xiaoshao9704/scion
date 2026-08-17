import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, FindingLevel, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import { projectAll, type ProjectionOptions } from '../project/index.js';

const LEVEL_ORDER: Record<FindingLevel, number> = { BLOCK: 3, LOSS: 2, INFO: 1 };

export function worstLevel(findings: Finding[]): FindingLevel | null {
  let worst: FindingLevel | null = null;
  for (const f of findings) {
    if (!worst || LEVEL_ORDER[f.level] > LEVEL_ORDER[worst]) worst = f.level;
  }
  return worst;
}

export async function doctor(
  ir: PluginIR,
  target?: EcosystemProfile,
  opts: ProjectionOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [...ir.issues];

  for (const p of ir.provenance) {
    if (p.source !== 'manifest') {
      findings.push({
        level: 'INFO',
        code: 'provenance.inferred',
        message: `${p.field} inferred from ${p.source === 'convention' ? 'directory convention' : 'the profile default'}; the manifest does not declare it${p.detail ? ` (${p.detail})` : ''}`,
        where: p.field,
      });
    }
  }

  findings.push(...(await checkInlineBash(ir)));

  if (!target) return findings;

  const projected = await projectAll(ir, target, opts);
  findings.push(...projected.findings);

  if (target.namePattern && !new RegExp(target.namePattern).test(ir.identity.name)) {
    findings.push({
      level: 'BLOCK',
      code: `${target.id}.name.pattern`,
      message: `name "${ir.identity.name}" does not satisfy the ${target.id} constraint ${target.namePattern}`,
      where: 'identity.name',
    });
  }

  if (target.id === 'codex' && ir.capabilities.agents) {
    // spec 待确认 #1：Codex 的 agents/ 目录约定未实测。编号是内部待办的索引，用户查不到，
    // 放进用户输出没有任何作用，所以只留在这里；消息本身保留「未经验证」这个实质——
    // 那是真实的不确定性，用户需要知道。
    findings.push({
      level: 'INFO',
      code: 'codex.agents.unverified',
      message:
        'no agents/ directory convention has been confirmed on the Codex side; agents are copied as-is, but whether they take effect is unverified',
      where: ir.capabilities.agents.path,
    });
  }

  const budget = target.limits.totalInstructionBytes;
  if (budget) {
    const instructions = projected.manifest.skillInstructions;
    if (typeof instructions === 'string') {
      const size = Buffer.byteLength(instructions, 'utf8');
      // 单插件占满总预算的一半以上时预警：多插件同时启用会互相挤占
      if (size * 2 > budget) {
        findings.push({
          level: 'LOSS',
          code: `${target.id}.instruction-budget`,
          message: `skillInstructions takes ${size} bytes, over half of the ${target.id} global instruction budget of ${budget}; it may be truncated when other plugins are enabled alongside it`,
          where: 'runtime.skillInstructions',
        });
      }
    }
  }

  return findings;
}

/** Claude command 支持 !`cmd` 内联 bash；目标端是否支持未经实测，先按有损处理 */
async function checkInlineBash(ir: PluginIR): Promise<Finding[]> {
  const dir = ir.capabilities.commands;
  if (!dir) return [];
  const out: Finding[] = [];
  for (const entry of dir.entries) {
    const rel = `${dir.path}${entry}`;
    const text = await readFile(join(ir.root, rel), 'utf8');
    if (/!`[^`]+`/.test(text)) {
      // spec 待确认 #3：目标端是否支持内联 bash 未见于文档、也未实测。同 #1，编号不进用户输出。
      out.push({
        level: 'LOSS',
        code: 'command.inline-bash',
        message: 'command body contains inline bash (!`cmd`); whether the target supports it is untested',
        where: rel,
      });
    }
  }
  return out;
}
