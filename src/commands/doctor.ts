import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import type { EcosystemId, PluginIdentity } from '../ir/types.js';
import { normalize } from '../normalize/index.js';
import { loadProfile, ALL_PROFILE_IDS } from '../profiles/loader.js';
import { doctor, worstLevel, type DoctorReport } from '../doctor/index.js';
import { formatEnvVars, formatFindings } from '../doctor/report.js';
import { EnvNameError, parseEnvNames } from '../mcp/env-flag.js';
import { usageError, writeResult, type CommandResult } from '../output/result.js';

const USAGE =
  'usage: scion doctor <dir> [--to kimi|codex] [--from claude] [--env-name OLD=NEW] [--json]\n';

export function parseEcosystem(value: string): EcosystemId {
  if (!(ALL_PROFILE_IDS as readonly string[]).includes(value)) {
    throw new Error(`unknown ecosystem '${value}' (expected one of: ${ALL_PROFILE_IDS.join(', ')})`);
  }
  return value as EcosystemId;
}

/** 插件身份的 JSON 形态：agent 用它核对手上这份产物到底是谁 */
export function identityJson(identity: PluginIdentity): Record<string, unknown> {
  return { name: identity.name, ...(identity.version ? { version: identity.version } : {}) };
}

export async function runDoctor(argv: string[], io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      from: { type: 'string', default: 'claude' },
      json: { type: 'boolean', default: false },
      'env-name': { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });
  const json = values.json as boolean;

  const dir = positionals[0];
  if (!dir) return writeResult(io, json, usageError('doctor', USAGE));

  const source = loadProfile(parseEcosystem(values.from as string));
  const ir = await normalize(dir, source);
  const target = values.to ? loadProfile(parseEcosystem(values.to)) : undefined;

  // doctor 报的必须是 convert/install 同样参数下会发生的事，所以同一个旋钮这里也要认
  const report = await doctor(ir, target, {
    envNames: parseEnvNames(values['env-name'] as string[] | undefined),
  });
  return writeResult(
    io,
    json,
    doctorResult(identityJson(ir.identity), source.id, target?.id, report),
  );
}

/**
 * 人读文案与 JSON 在这里并排产出。findings 逐字进 JSON，不重新措辞、不重新分类：
 * level 与 code 是 agent 分支的依据，为 JSON 另起一套说法等于给它一个会和人读输出
 * 各说各话的世界。
 */
function doctorResult(
  plugin: Record<string, unknown>,
  from: EcosystemId,
  to: EcosystemId | undefined,
  report: DoctorReport,
): CommandResult {
  const { findings, envVars } = report;
  const worst = worstLevel(findings);
  const head = `${plugin.name}${plugin.version ? `@${plugin.version}` : ''} · ${from}${to ? ` → ${to}` : ''}\n\n`;
  return {
    command: 'doctor',
    exitCode: worst === 'BLOCK' ? 2 : 0,
    human: head + formatFindings(findings) + (to ? formatEnvVars(envVars, to) : ''),
    json: { plugin, from, ...(to ? { to } : {}), worst, findings, envVars },
  };
}
