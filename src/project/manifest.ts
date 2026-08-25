import type { Finding, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { EmittedFile, ProjectionOptions } from './types.js';
import { projectMcpServers } from './mcp.js';
import { projectHooks } from './hooks.js';
import type { EnvVarUse } from '../mcp/env.js';
import { getSkillInstructions } from '../toolmap/index.js';

const IDENTITY_ORDER = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
] as const;

export function projectManifest(
  ir: PluginIR,
  target: EcosystemProfile,
  opts: ProjectionOptions,
): {
  manifest: Record<string, unknown>;
  files: EmittedFile[];
  findings: Finding[];
  envVars: EnvVarUse[];
} {
  const manifest: Record<string, unknown> = {};
  const findings: Finding[] = [];

  for (const field of IDENTITY_ORDER) {
    const value = (ir.identity as unknown as Record<string, unknown>)[field];
    if (value !== undefined) manifest[field] = value;
  }

  for (const kind of ['skills', 'commands', 'agents'] as const) {
    const dir = ir.capabilities[kind];
    if (dir) manifest[kind] = `./${dir.path}`;
  }

  const mcp = projectMcpServers(ir, target, opts);
  if (mcp.manifestValue !== undefined) manifest.mcpServers = mcp.manifestValue;
  findings.push(...mcp.findings);

  const presentationKey = target.fieldDialect.presentationKey;
  const allowed = new Set(target.fieldDialect.presentationFields);
  const iface: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(ir.presentation)) {
    if (value === undefined) continue;
    if (presentationKey && allowed.has(field)) {
      iface[field] = value;
      continue;
    }
    findings.push({
      level: 'LOSS',
      code: 'presentation.field-dropped',
      message: `${target.id} does not carry this presentation field; dropped on conversion`,
      where: `presentation.${field}`,
    });
  }

  if (presentationKey && Object.keys(iface).length > 0) {
    manifest[presentationKey] = iface;
  }

  const runtimeAllowed = new Set(target.fieldDialect.runtimeFields);

  if (runtimeAllowed.has('sessionStart') && ir.runtime.sessionStart) {
    manifest.sessionStart = ir.runtime.sessionStart;
  }

  if (runtimeAllowed.has('skillInstructions')) {
    const injected = getSkillInstructions(ir.sourceEcosystem, target.id);
    const instructions = ir.runtime.skillInstructions ?? injected ?? undefined;
    if (instructions) {
      manifest.skillInstructions = instructions;
      if (!ir.runtime.skillInstructions && injected) {
        findings.push({
          level: 'INFO',
          code: 'toolmap.injected',
          message: `injected the ${ir.sourceEcosystem}→${target.id} tool-name mapping instructions`,
          where: 'runtime.skillInstructions',
        });
      }
    }
  } else if (getSkillInstructions(ir.sourceEcosystem, target.id) === null) {
    findings.push({
      level: 'LOSS',
      code: 'toolmap.missing',
      message: `no ${ir.sourceEcosystem}→${target.id} tool-name mapping table; Claude-specific tool names in skill bodies will not be remapped on the target`,
      where: 'runtime.skillInstructions',
    });
  }

  const fieldBytes = target.limits.fieldBytes;
  if (fieldBytes) {
    for (const [key, value] of Object.entries(manifest)) {
      if (typeof value !== 'string') continue;
      const size = Buffer.byteLength(value, 'utf8');
      if (size > fieldBytes) {
        findings.push({
          level: 'BLOCK',
          code: `${target.id}.field-too-large`,
          message: `field ${key} is ${size} bytes, over the ${target.id} limit of ${fieldBytes} bytes`,
          where: key,
        });
      }
    }
  }

  const hooks = projectHooks(ir, target);
  if (hooks.manifestValue !== undefined) manifest.hooks = hooks.manifestValue;
  findings.push(...hooks.findings);

  return {
    manifest,
    files: [...mcp.files, ...(hooks.files ?? [])],
    findings,
    envVars: mcp.envVars,
  };
}
