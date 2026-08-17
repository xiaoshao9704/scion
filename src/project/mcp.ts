import type { Finding, McpServerConfig, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { EmittedFile, ProjectionOptions } from './types.js';
import { renameFinding, renderServer, type EnvRename } from '../mcp/env.js';

export function projectMcpServers(
  ir: PluginIR,
  target: EcosystemProfile,
  opts: ProjectionOptions,
): { manifestValue: unknown | undefined; files: EmittedFile[]; findings: Finding[] } {
  const servers = ir.capabilities.mcpServers;
  if (Object.keys(servers).length === 0) {
    return { manifestValue: undefined, files: [], findings: [] };
  }

  const notation = target.fieldDialect.mcpServers;
  const file =
    notation === 'inline'
      ? target.manifestPaths[0]
      : (target.fieldDialect.mcpServersFile ?? '.mcp.json');

  const rendered: Record<string, McpServerConfig> = {};
  const findings: Finding[] = [];
  const renames = new Map<string, EnvRename>();

  for (const [name, config] of Object.entries(servers)) {
    const out = renderServer(config, ir.capabilities.mcpAuth[name], target.fieldDialect.mcpAuth, {
      targetId: target.id,
      file,
      serverName: name,
      pluginName: ir.identity.name,
      keepEnvNames: opts.keepEnvNames ?? false,
      envNames: opts.envNames,
    });
    rendered[name] = out.server;
    findings.push(...out.findings);
    // 同一个变量被多个 server 引用时只说一次，指向它第一次出现的字段
    for (const rename of out.renames) {
      if (!renames.has(rename.previous)) renames.set(rename.previous, rename);
    }
  }

  for (const rename of renames.values()) findings.push(renameFinding(rename, target.id));

  const body = `${JSON.stringify({ mcpServers: rendered }, null, 2)}\n`;

  switch (notation) {
    case 'inline':
      return { manifestValue: rendered, files: [], findings };
    case 'path-ref':
      return { manifestValue: `./${file}`, files: [{ path: file, content: body }], findings };
    case 'external-file':
      return { manifestValue: undefined, files: [{ path: file, content: body }], findings };
  }
}
