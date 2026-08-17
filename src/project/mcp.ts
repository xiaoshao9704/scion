import type { Finding, McpServerConfig, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { EmittedFile, ProjectionOptions } from './types.js';
import { renderServer, type EnvVarUse } from '../mcp/env.js';

export function projectMcpServers(
  ir: PluginIR,
  target: EcosystemProfile,
  opts: ProjectionOptions,
): {
  manifestValue: unknown | undefined;
  files: EmittedFile[];
  findings: Finding[];
  envVars: EnvVarUse[];
} {
  const servers = ir.capabilities.mcpServers;
  if (Object.keys(servers).length === 0) {
    return { manifestValue: undefined, files: [], findings: [], envVars: [] };
  }

  const notation = target.fieldDialect.mcpServers;
  const file =
    notation === 'inline'
      ? target.manifestPaths[0]
      : (target.fieldDialect.mcpServersFile ?? '.mcp.json');

  const rendered: Record<string, McpServerConfig> = {};
  const findings: Finding[] = [];
  /** 按产物里最终的名字合并：同一个变量被多个 server 引用时，报告里只占一行 */
  const envVars = new Map<string, EnvVarUse>();

  for (const [name, config] of Object.entries(servers)) {
    const out = renderServer(config, ir.capabilities.mcpAuth[name], target.fieldDialect.mcpAuth, {
      targetId: target.id,
      file,
      serverName: name,
      envNames: opts.envNames,
    });
    rendered[name] = out.server;
    findings.push(...out.findings);
    for (const use of out.uses) {
      const merged = envVars.get(use.name);
      if (!merged) {
        envVars.set(use.name, use);
        continue;
      }
      // where 保留第一次出现的那处；servers 与 handling 累加
      for (const h of use.handling) if (!merged.handling.includes(h)) merged.handling.push(h);
      for (const s of use.servers) if (!merged.servers.includes(s)) merged.servers.push(s);
    }
  }

  const body = `${JSON.stringify({ mcpServers: rendered }, null, 2)}\n`;
  const envList = [...envVars.values()];

  switch (notation) {
    case 'inline':
      return { manifestValue: rendered, files: [], findings, envVars: envList };
    case 'path-ref':
      return {
        manifestValue: `./${file}`,
        files: [{ path: file, content: body }],
        findings,
        envVars: envList,
      };
    case 'external-file':
      return {
        manifestValue: undefined,
        files: [{ path: file, content: body }],
        findings,
        envVars: envList,
      };
  }
}
