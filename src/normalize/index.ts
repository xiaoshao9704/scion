import { basename, resolve } from 'node:path';
import type { PluginIR, PluginIdentity, Provenance } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import { emptyIR } from '../ir/schema.js';
import { findManifest } from './manifest.js';
import { scanCapabilityDir, scanHooks } from './scan.js';
import { readMcpServers } from './mcp.js';

export { findManifest } from './manifest.js';
export type { FoundManifest } from './manifest.js';

const IDENTITY_STRING_FIELDS = [
  'version',
  'description',
  'homepage',
  'repository',
  'license',
] as const;

export async function normalize(root: string, profile: EcosystemProfile): Promise<PluginIR> {
  const abs = resolve(root);
  const found = await findManifest(abs, profile);
  if (!found) {
    throw new Error(
      `no ${profile.id} manifest found in ${abs} (looked for: ${profile.manifestPaths.join(', ')})`,
    );
  }

  const ir = emptyIR(abs, profile.id);
  const prov = ir.provenance;
  const raw = found.raw;

  if (typeof raw.name === 'string' && raw.name.length > 0 && isSafePathSegment(raw.name)) {
    ir.identity.name = raw.name;
    push(prov, 'identity.name', 'manifest', found.path);
  } else {
    ir.identity.name = basename(abs);
    push(prov, 'identity.name', 'convention', 'derived from directory name');
    if (typeof raw.name === 'string' && raw.name.length > 0) {
      ir.issues.push({
        level: 'BLOCK',
        code: 'identity.name.unsafe',
        message: `the manifest name "${raw.name}" is not safe to use as a single path segment (contains "/", "\\" or NUL, or is exactly "." / ".."); fell back to the directory name`,
        where: 'identity.name',
      });
    }
  }

  for (const field of IDENTITY_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string') {
      (ir.identity as unknown as Record<string, unknown>)[field] = value;
      push(prov, `identity.${field}`, 'manifest', found.path);
    }
  }

  if (Array.isArray(raw.keywords)) {
    ir.identity.keywords = raw.keywords.filter((k): k is string => typeof k === 'string');
    push(prov, 'identity.keywords', 'manifest', found.path);
  }

  const author = raw.author;
  if (author && typeof author === 'object' && !Array.isArray(author)) {
    const a = author as Record<string, unknown>;
    const out: NonNullable<PluginIdentity['author']> = {};
    for (const k of ['name', 'email', 'url'] as const) {
      if (typeof a[k] === 'string') out[k] = a[k] as string;
    }
    ir.identity.author = out;
    push(prov, 'identity.author', 'manifest', found.path);
  } else if (typeof author === 'string') {
    ir.identity.author = { name: author };
    push(prov, 'identity.author', 'manifest', `${found.path} (string form)`);
  }

  const kinds = [
    ['skills', profile.conventions.skills],
    ['commands', profile.conventions.commands],
    ['agents', profile.conventions.agents],
  ] as const;

  for (const [kind, conventionDir] of kinds) {
    const declared = typeof raw[kind] === 'string' ? (raw[kind] as string) : undefined;
    const result = await scanCapabilityDir(abs, declared, conventionDir, kind);
    ir.capabilities[kind] = result.dir;
    if (result.provenance) prov.push(result.provenance);
    ir.issues.push(...result.issues);
  }

  ir.capabilities.hooks = await scanHooks(abs);

  const mcp = await readMcpServers(abs, raw, profile);
  ir.capabilities.mcpServers = mcp.servers;
  ir.capabilities.mcpAuth = mcp.auth;
  if (mcp.provenance) prov.push(mcp.provenance);
  ir.issues.push(...mcp.issues);

  const presentationKey = profile.fieldDialect.presentationKey;
  if (presentationKey) {
    const block = raw[presentationKey];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const src = block as Record<string, unknown>;
      for (const field of profile.fieldDialect.presentationFields) {
        if (src[field] === undefined) continue;
        (ir.presentation as Record<string, unknown>)[field] = src[field];
        push(prov, `presentation.${field}`, 'manifest', `${found.path}#${presentationKey}`);
      }
    }
  }

  for (const field of profile.fieldDialect.runtimeFields) {
    if (raw[field] === undefined) continue;
    (ir.runtime as Record<string, unknown>)[field] = raw[field];
    push(prov, `runtime.${field}`, 'manifest', found.path);
  }

  return ir;
}

function push(
  list: Provenance[],
  field: string,
  source: Provenance['source'],
  detail?: string,
): void {
  list.push({ field, source, detail });
}

/**
 * name 会被直接当作路径片段（插件安装目录名、marketplace 条目目录名等）使用，
 * 必须是不含分隔符、不含 NUL 的单个路径片段。跨模块共用同一份定义——见
 * src/marketplace/normalize.ts 对市场条目名的校验。
 */
export function isSafePathSegment(name: string): boolean {
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  return true;
}
