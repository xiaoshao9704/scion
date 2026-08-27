import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { EcosystemProfile } from '../profiles/types.js';
import type { MarketplaceEntryIR, MarketplaceEntrySource, MarketplaceIR } from './types.js';
import { isSafePathSegment } from '../normalize/index.js';
import { marketDialect } from '../profiles/loader.js';

function str(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

type SourceResult =
  | { kind: 'ok'; source: MarketplaceEntrySource }
  | { kind: 'missing' }
  | { kind: 'unknown-discriminant' };

/**
 * 解析条目的 source 字段。按值的运行时形态分两条路，不看 profile 的 entrySourceForm——
 * 那是写出时的偏好，不是读入时的保证：同一份真实 catalog（如 claude-plugins-official）
 * 里对象形态和字符串形态混用是常态，一个 ecosystem 不代表一种写法。
 * - 对象形态：source 本身带判别字段，switch 其 `source` 键（local / url / git-subdir）
 * - 字符串形态：source 是裸字符串（或 Kimi 的 url/downloadUrl 别名），按 http(s) 前缀分 url/local
 */
function parseEntrySource(entry: Record<string, unknown>): SourceResult {
  const raw = entry.source;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const discriminant = str(obj, 'source');

    if (discriminant === 'local') {
      const path = str(obj, 'path');
      return path ? { kind: 'ok', source: { kind: 'local', path } } : { kind: 'missing' };
    }
    if (discriminant === 'url') {
      const url = str(obj, 'url');
      return url ? { kind: 'ok', source: { kind: 'url', url } } : { kind: 'missing' };
    }
    if (discriminant === 'git-subdir') {
      const url = str(obj, 'url');
      if (!url) return { kind: 'missing' };
      const source: MarketplaceEntrySource = { kind: 'git-subdir', url };
      const path = str(obj, 'path');
      const ref = str(obj, 'ref');
      const sha = str(obj, 'sha');
      if (path) source.path = path;
      if (ref) source.ref = ref;
      if (sha) source.sha = sha;
      return { kind: 'ok', source };
    }
    return { kind: 'unknown-discriminant' };
  }

  const value = str(entry, 'source', 'url', 'downloadUrl');
  if (!value) return { kind: 'missing' };
  return {
    kind: 'ok',
    source: /^https?:\/\//.test(value) ? { kind: 'url', url: value } : { kind: 'local', path: value },
  };
}

/** target 既可以是 marketplace 根目录，也可以直接是 catalog 文件 */
async function locateCatalog(
  target: string,
  profile: EcosystemProfile,
): Promise<{ catalogPath: string; root: string } | null> {
  const abs = resolve(target);
  const info = await stat(abs).catch(() => null);

  if (info?.isFile()) {
    const rel = marketDialect(profile).catalogPaths.find((p) => abs.endsWith(p));
    // 直接给文件时，root 是去掉 catalog 相对路径后的那一层
    const root = rel ? abs.slice(0, abs.length - rel.length - 1) : dirname(abs);
    return { catalogPath: abs, root: root || dirname(abs) };
  }

  for (const rel of marketDialect(profile).catalogPaths) {
    const candidate = join(abs, rel);
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      return { catalogPath: candidate, root: abs };
    }
  }
  return null;
}

export async function normalizeMarketplace(
  target: string,
  profile: EcosystemProfile,
): Promise<MarketplaceIR> {
  const dialect = marketDialect(profile);
  const located = await locateCatalog(target, profile);
  if (!located) {
    throw new Error(
      `no ${profile.id} marketplace catalog found at ${target} (looked for: ${dialect.catalogPaths.join(', ')})`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(located.catalogPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to parse ${basename(located.catalogPath)}: ${(err as Error).message}`);
  }

  const mp: MarketplaceIR = {
    root: located.root,
    catalogPath: located.catalogPath,
    sourceEcosystem: profile.id,
    name: null,
    entries: [],
    provenance: [],
    issues: [],
  };

  if (dialect.nameField && typeof raw[dialect.nameField] === 'string') {
    mp.name = raw[dialect.nameField] as string;
    mp.provenance.push({ field: 'marketplace.name', source: 'manifest', detail: dialect.nameField });
  }

  if (typeof raw.version === 'string') mp.version = raw.version;

  if (dialect.ownerField === 'owner') {
    const owner = raw.owner;
    if (owner && typeof owner === 'object') {
      mp.owner = { name: str(owner as Record<string, unknown>, 'name') };
    }
  } else if (dialect.ownerField === 'interface') {
    const iface = raw.interface;
    if (iface && typeof iface === 'object') {
      mp.displayName = str(iface as Record<string, unknown>, 'displayName');
    }
  }

  const plugins = raw.plugins;
  if (!Array.isArray(plugins)) {
    mp.issues.push({
      level: 'BLOCK',
      code: 'marketplace.no-plugins',
      message: 'catalog has no plugins array',
      where: located.catalogPath,
    });
    return mp;
  }

  plugins.forEach((value, index) => {
    // where 用 plugins[i] 兜底而不是 catalogPath：同一份 catalog 里可能有多个坏条目，
    // 用同一个文件路径当 where 会让它们在按 where 分组的报告（如 market convert 的
    // 排除汇总）里被错误地合并成一条。条目一旦有可用的 name，下面会换成更好认的那个。
    const position = `plugins[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      mp.issues.push({
        level: 'BLOCK',
        code: 'marketplace.entry-invalid',
        message: `entry ${position} is not an object`,
        where: position,
      });
      return;
    }
    const entry = value as Record<string, unknown>;
    const name = str(entry, dialect.entryKeyField);
    const parsed = parseEntrySource(entry);
    // message 与 where 共用这一个定位串。以前 message 用 1-based 序号、where 用 0-based
    // 下标，同一条 finding 里出现两个指向同一条目的编号——agent 拿 where 去定位、用户拿
    // 它去 catalog 里搜，两边都会被另一个编号带偏。
    const locator = name ?? position;

    if (parsed.kind === 'unknown-discriminant') {
      mp.issues.push({
        level: 'BLOCK',
        code: 'marketplace.entry-source-unknown',
        message: `entry ${locator} has an unrecognized source discriminant`,
        where: locator,
      });
      return;
    }

    if (!name || parsed.kind === 'missing') {
      mp.issues.push({
        level: 'BLOCK',
        code: 'marketplace.entry-invalid',
        message: `entry ${locator} is missing ${!name ? dialect.entryKeyField : 'source'}`,
        where: locator,
      });
      return;
    }

    // 条目名来自下载的 catalog，从未经过 normalize() 的 isSafePathSegment 校验——不像
    // 插件自己的 identity.name。它会被原样拼进 emit() 的输出路径（plugins/<name>/），
    // 在这里就近校验，让用户拿到一条干净的 BLOCK 而不是运行时异常；emit() 侧的收口检查
    // 是兜底，不是唯一防线。
    if (!isSafePathSegment(name)) {
      mp.issues.push({
        level: 'BLOCK',
        code: 'marketplace.entry-name-unsafe',
        message: `entry ${locator}: ${dialect.entryKeyField} "${name}" is not safe to use as a single path segment (contains "/", "\\" or NUL, or is exactly "." / ".."); entry skipped`,
        where: name,
      });
      return;
    }

    const out: MarketplaceEntryIR = {
      name,
      source: parsed.source,
    };
    out.displayName = str(entry, 'displayName');
    out.description = str(entry, 'description', 'shortDescription');
    out.version = str(entry, 'version');
    out.homepage = str(entry, 'homepage', 'websiteURL');
    out.category = str(entry, 'category');
    if (Array.isArray(entry.keywords)) {
      out.keywords = entry.keywords.filter((k): k is string => typeof k === 'string');
    }
    mp.entries.push(out);
  });

  return mp;
}
