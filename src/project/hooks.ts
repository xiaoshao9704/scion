import type { Finding, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import { loadProfile } from '../profiles/loader.js';

interface KimiHookDef {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

/**
 * 把 Claude 的 hooks/hooks.json（{hooks: {事件: [{matcher?, hooks: [{type, command, …}]}]}}）
 * 投影成目标清单里的扁平数组。目标不支持（hooksDialect 'none'）或源解析不了时，
 * 回落为 not-converted 的 LOSS——和 v1 的行为一致，只是措辞按目标说清楚。
 */
export function projectHooks(
  ir: PluginIR,
  target: EcosystemProfile,
): { manifestValue?: KimiHookDef[]; findings: Finding[] } {
  const files = ir.capabilities.hooks;
  if (files.length === 0) return { findings: [] };

  const dialect = target.hooksDialect;
  if (dialect.kind === 'none') {
    return {
      findings: [
        {
          level: 'LOSS',
          code: 'hooks.not-converted',
          message: `${files.length} hooks ${files.length === 1 ? 'file' : 'files'} not converted (scion does not convert hooks for ${target.id}): ${files.join(', ')}`,
          where: 'hooks/',
        },
      ],
    };
  }

  const declared = files.includes('hooks/hooks.json');
  const config = ir.capabilities.hooksConfig;
  const events =
    config !== null && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).hooks
      : undefined;
  if (!declared || events === null || typeof events !== 'object' || Array.isArray(events)) {
    return {
      findings: [
        {
          level: 'LOSS',
          code: 'hooks.not-converted',
          message: declared
            ? `hooks/hooks.json could not be parsed as a Claude hooks declaration; ${files.length} hooks files not converted`
            : `no hooks/hooks.json found; ${files.length} hooks files not converted: ${files.join(', ')}`,
          where: 'hooks/',
        },
      ],
    };
  }

  const findings: Finding[] = [];
  const out: KimiHookDef[] = [];

  for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;

    if (!dialect.events.includes(event)) {
      findings.push({
        level: 'LOSS',
        code: 'hooks.event-unsupported',
        message: `${target.id} has no ${event} hook event; the hooks declared under it are dropped`,
        where: `hooks/hooks.json#${event}`,
      });
      continue;
    }

    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue;
      const matcher = (group as Record<string, unknown>).matcher;
      const defs = (group as Record<string, unknown>).hooks;
      if (!Array.isArray(defs)) continue;

      for (const def of defs) {
        if (def === null || typeof def !== 'object') continue;
        const d = def as Record<string, unknown>;

        if (d.type !== 'command' || typeof d.command !== 'string') {
          findings.push({
            level: 'LOSS',
            code: 'hooks.type-unsupported',
            message: `only command hooks convert to ${target.id}; a ${typeof d.type === 'string' ? d.type : 'non-command'} hook under ${event} is dropped`,
            where: `hooks/hooks.json#${event}`,
          });
          continue;
        }

        const converted: KimiHookDef = {
          event,
          command: relativizeCommand(d.command, ir, target, event, findings),
        };
        if (typeof matcher === 'string') converted.matcher = matcher;

        if (typeof d.timeout === 'number') {
          const clamped = Math.min(dialect.timeoutMaxSeconds, Math.max(1, Math.round(d.timeout)));
          converted.timeout = clamped;
          if (clamped !== d.timeout) {
            findings.push({
              level: 'LOSS',
              code: 'hooks.timeout-clamped',
              message: `hook timeout ${d.timeout}s is outside ${target.id}'s 1–${dialect.timeoutMaxSeconds}s range; written as ${clamped}s`,
              where: `hooks/hooks.json#${event}`,
            });
          }
        }

        // async:false 与不写等价；true 或指定 shell 才是会被丢掉的事实
        for (const field of ['async', 'shell'] as const) {
          const value = d[field];
          if (value === undefined || (field === 'async' && value === false)) continue;
          findings.push({
            level: 'LOSS',
            code: 'hooks.field-dropped',
            message: `${target.id} hook declarations have no ${field} field; ${field}: ${JSON.stringify(value)} is dropped and the hook runs with ${target.id}'s default behavior`,
            where: `hooks/hooks.json#${event}`,
          });
        }

        out.push(converted);
      }
    }
  }

  return { manifestValue: out.length > 0 ? out : undefined, findings };
}

/**
 * hook 命令里的源生态插件根变量改写为相对路径。对 Kimi 这是保真的：实测宿主给
 * hook 进程 cwd=插件根，所以是 INFO 而不是 pathvar.relativized 那样的 LOSS。
 */
function relativizeCommand(
  command: string,
  ir: PluginIR,
  target: EcosystemProfile,
  event: string,
  findings: Finding[],
): string {
  const sourceVar = loadProfile(ir.sourceEcosystem).pathVar;
  if (!sourceVar || !command.includes(sourceVar)) return command;
  findings.push({
    level: 'INFO',
    code: 'hooks.pathvar-relativized',
    message: `${sourceVar} rewritten as a relative path; ${target.id} runs plugin hooks with the plugin root as the working directory`,
    where: `hooks/hooks.json#${event}`,
  });
  return command.replaceAll(`${sourceVar}/`, './').replaceAll(sourceVar, '.');
}
