import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, McpServerAuth, McpServerConfig, Provenance } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import { readServerAuth } from '../mcp/env.js';

export interface McpReadResult {
  servers: Record<string, McpServerConfig>;
  auth: Record<string, McpServerAuth>;
  provenance: Provenance | null;
  issues: Finding[];
}

/** .mcp.json 既可能是 { mcpServers: {...} } 也可能直接是 {...} */
function unwrap(parsed: unknown): Record<string, McpServerConfig> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const inner = obj.mcpServers;
  const target = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : obj;
  return target as Record<string, McpServerConfig>;
}

/** 原始读取结果；鉴权记法的解析统一在 readMcpServers 的出口做一次 */
type RawRead = Omit<McpReadResult, 'auth'>;

async function readFromFile(
  root: string,
  rel: string,
  declared: boolean,
): Promise<RawRead> {
  let text: string;
  try {
    text = await readFile(join(root, rel), 'utf8');
  } catch {
    if (!declared) return { servers: {}, provenance: null, issues: [] };
    return {
      servers: {},
      provenance: null,
      issues: [
        {
          level: 'BLOCK',
          code: 'mcp.declared-missing',
          message: `the manifest references mcpServers: "${rel}", but that file does not exist`,
          where: rel,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      servers: {},
      provenance: null,
      issues: [
        {
          level: 'BLOCK',
          code: 'mcp.parse-error',
          message: `cannot parse ${rel}: ${(err as Error).message}`,
          where: rel,
        },
      ],
    };
  }

  return {
    servers: unwrap(parsed),
    provenance: { field: 'capabilities.mcpServers', source: 'manifest', detail: rel },
    issues: [],
  };
}

export async function readMcpServers(
  root: string,
  raw: Record<string, unknown>,
  profile: EcosystemProfile,
): Promise<McpReadResult> {
  return splitAuth(await readRaw(root, raw, profile), profile);
}

async function readRaw(
  root: string,
  raw: Record<string, unknown>,
  profile: EcosystemProfile,
): Promise<RawRead> {
  const declared = raw.mcpServers;

  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    return {
      servers: unwrap(declared),
      provenance: { field: 'capabilities.mcpServers', source: 'manifest', detail: 'inline' },
      issues: [],
    };
  }

  if (typeof declared === 'string') {
    return readFromFile(root, declared.replace(/^\.\//, ''), true);
  }

  // 未在清单声明：Claude 靠外部 .mcp.json 约定
  if (profile.fieldDialect.mcpServers === 'external-file' && profile.fieldDialect.mcpServersFile) {
    return readFromFile(root, profile.fieldDialect.mcpServersFile, false);
  }

  return { servers: {}, provenance: null, issues: [] };
}

/** 每个 server 条目按源生态的记法解出鉴权事实，其余字段原样留在 servers 里 */
function splitAuth(read: RawRead, profile: EcosystemProfile): McpReadResult {
  const servers: Record<string, McpServerConfig> = {};
  const auth: Record<string, McpServerAuth> = {};

  for (const [name, config] of Object.entries(read.servers)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      servers[name] = config;
      continue;
    }
    const parsed = readServerAuth(config, profile.fieldDialect.mcpAuth);
    servers[name] = parsed.config;
    if (parsed.auth) auth[name] = parsed.auth;
  }

  return { ...read, servers, auth };
}
