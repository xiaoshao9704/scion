import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Finding } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { MarketplaceEntryIR, MarketplaceIR } from './types.js';
import { normalize } from '../normalize/index.js';
import { projectAll } from '../project/index.js';
import { emit, isInsideRoot } from '../emit/write.js';
import { doctor, worstLevel } from '../doctor/index.js';
import { marketDialect, loadProfile } from '../profiles/loader.js';
import { canSelfFetch } from './remote.js';

export interface MarketplaceProjection {
  catalog: Record<string, unknown>;
  /** 相对输出根的 catalog 路径 */
  catalogPath: string;
  findings: Finding[];
}

/**
 * 把单条 IR 条目投影成目标生态的 catalog 条目形状（键名、source 写法、字段白名单）。
 * 导出给 install/marketplace.ts 复用——install 时只有一个条目要写，没有完整的
 * MarketplaceIR，但条目本身的方言规则（entryKeyField / entrySourceForm / entryFields）
 * 和 `scion market convert` 走的是同一份，不该有第二份实现。
 */
export function projectEntry(
  entry: MarketplaceEntryIR,
  target: EcosystemProfile,
  findings: Finding[],
): Record<string, unknown> {
  const dialect = marketDialect(target);
  const out: Record<string, unknown> = {};

  out[dialect.entryKeyField] = entry.name;

  // entrySourceForm 在这里（写出时）才有意义；读取端按条目实际值的类型分派，不查它。
  if (dialect.entrySourceForm === 'object') {
    // 对象形态能完整表达三种来源，包括 git-subdir 的 path/ref/sha
    switch (entry.source.kind) {
      case 'local':
        out.source = { source: 'local', path: entry.source.path };
        break;
      case 'url':
        out.source = { source: 'url', url: entry.source.url };
        break;
      case 'git-subdir': {
        const s: Record<string, unknown> = { source: 'git-subdir', url: entry.source.url };
        if (entry.source.path !== undefined) s.path = entry.source.path;
        if (entry.source.ref !== undefined) s.ref = entry.source.ref;
        if (entry.source.sha !== undefined) s.sha = entry.source.sha;
        out.source = s;
        break;
      }
    }
  } else {
    // 字符串形态只能承载一个位置。git-subdir 的子目录与版本锁定无处安放——这是真损耗。
    switch (entry.source.kind) {
      case 'local':
        out.source = entry.source.path;
        break;
      case 'url':
        out.source = entry.source.url;
        break;
      case 'git-subdir':
        out.source = entry.source.url;
        findings.push({
          level: 'LOSS',
          code: 'marketplace.git-subdir-flattened',
          message:
            `a ${target.id} entry source is a single string and cannot express a subdirectory or a version lock; ` +
            `entry "${entry.name}" loses path=${entry.source.path ?? '(none)'} / ` +
            `ref=${entry.source.ref ?? '(none)'} / sha=${entry.source.sha ?? '(none)'}, ` +
            `keeping only the repository URL. Installing it fetches the root of that repository's default branch, not the revision originally pinned`,
          where: `plugins[].${entry.name}`,
        });
        break;
    }
  }

  const allowed = new Set(dialect.entryFields);
  if (allowed.has('displayName') && entry.displayName) out.displayName = entry.displayName;
  if (allowed.has('description') && entry.description) out.description = entry.description;
  if (allowed.has('version') && entry.version) out.version = entry.version;
  if (allowed.has('homepage') && entry.homepage) out.homepage = entry.homepage;
  if (allowed.has('keywords') && entry.keywords?.length) out.keywords = entry.keywords;
  if (allowed.has('policy')) {
    out.policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL' };
  }
  if (allowed.has('category')) out.category = entry.category ?? 'Developer Tools';

  return out;
}

export function projectMarketplace(
  mp: MarketplaceIR,
  target: EcosystemProfile,
): MarketplaceProjection {
  const dialect = marketDialect(target);
  const findings: Finding[] = [...mp.issues];
  const catalog: Record<string, unknown> = {};

  if (dialect.nameField) {
    if (mp.name) catalog[dialect.nameField] = mp.name;
  } else if (mp.name) {
    findings.push({
      level: 'INFO',
      code: 'marketplace.name-not-carried',
      message: `the ${target.id} catalog format has no marketplace name field; "${mp.name}" survives only in the output path`,
      where: 'marketplace.name',
    });
  }

  if (dialect.ownerField === 'owner' && mp.owner?.name) {
    catalog.owner = { name: mp.owner.name };
  } else if (dialect.ownerField === 'interface') {
    catalog.interface = { displayName: mp.displayName ?? mp.name ?? 'Marketplace' };
  }

  // 顶层字段用 catalogFields 判定，不能借用 entryFields——那是条目级白名单，判定轴不同
  if (dialect.catalogFields.includes('version') && mp.version) catalog.version = mp.version;

  catalog.plugins = mp.entries.map((entry) => projectEntry(entry, target, findings));

  return { catalog, catalogPath: dialect.catalogPaths[0], findings };
}

export interface MarketplaceEmitResult {
  catalogPath: string;
  /** 实际转换过的本地插件名 */
  converted: string[];
  findings: Finding[];
}

export async function emitMarketplace(
  mp: MarketplaceIR,
  target: EcosystemProfile,
  outDir: string,
  /** 按插件分开的环境变量改名。一个市场里几十个插件，映射必然是按插件给的 */
  envNamesByPlugin: Map<string, Map<string, string>> = new Map(),
): Promise<MarketplaceEmitResult> {
  const dialect = marketDialect(target);
  const projection = projectMarketplace(mp, target);
  const findings: Finding[] = [...projection.findings];
  const converted: string[] = [];
  const failed = new Set<string>();
  const source = loadProfile(mp.sourceEcosystem);

  for (const entry of mp.entries) {
    if (entry.source.kind !== 'local') {
      // 「原样留给目标生态自己去拉」只有在目标真拉得动时才是实话。拉不动的条目留在
      // catalog 里是最坏的一种输出：工具报告成功，用户到了目标生态里才发现一个都装不上。
      // 拉得动/拉不动是 profile 声明的事实（remoteFetch），这里只读不判。
      if (!canSelfFetch(target, entry.source)) {
        failed.add(entry.name);
        findings.push({
          level: 'BLOCK',
          code: 'marketplace.remote-entry-unfetchable',
          message:
            `entry "${entry.name}" points at a remote source (${entry.source.url}) that ${target.id} cannot fetch itself` +
            `${dialect.remoteFetch.limitation ? `: ${dialect.remoteFetch.limitation}` : ''}. ` +
            `Keeping it would put an entry in the catalog that ${target.id} can never install, so it was dropped from the output catalog; the rest still convert`,
          // where 用条目名，与其余条目级 BLOCK 一致——market convert 的排除汇总按 where
          // 的首段分组，放 URL 进去会被 "https:" 的冒号切开，错误地把所有远端条目并成一组。
          where: entry.name,
        });
        continue;
      }
      findings.push({
        level: 'INFO',
        code: 'marketplace.remote-entry-skipped',
        message: `entry ${entry.name} points at a remote source (${entry.source.kind}) and was not converted; the source is kept as-is for the target ecosystem to fetch itself`,
        where: entry.source.url,
      });
      continue;
    }

    const pluginDir = join(mp.root, entry.source.path.replace(/^\.\//, ''));

    // 条目名已在 normalizeMarketplace 里校验过是安全路径片段，但 source.path
    // 是另一个独立的、同样来自未经信任的 catalog 的字段——"../../etc" 这类值
    // 能同样轻易地把 pluginDir 带出 mp.root。名字安全不等于路径安全，两处都要查。
    if (!isInsideRoot(mp.root, pluginDir)) {
      failed.add(entry.name);
      findings.push({
        level: 'BLOCK',
        code: 'marketplace.entry-source-outside-root',
        message:
          `local entry "${entry.name}" has source.path "${entry.source.path}", which resolves outside the marketplace root ` +
          `${mp.root}; refusing to read it. The entry was dropped from the output catalog; the rest still convert`,
        where: entry.name,
      });
      continue;
    }

    try {
      const ir = await normalize(pluginDir, source);
      // 单条目转换必须走 doctor()，不能只调 projectAll()：doctor 才会带上
      // ir.issues（清单里的结构性问题）、命名校验、inline-bash 等检查——这些
      // 正是 `scion convert` 和 `scion market convert` 在同一份插件上产生不同
      // exit code 的根因。findings 直接取 doctor 的结果，projectAll 只在
      // 通过后为了拿到要落盘的 manifest/files 再调一次，不重复计入 findings。
      // 映射按**插件名**取，不是按 catalog 条目名：产物里读这个变量的是插件自己，
      // 而条目名只是市场对它的称呼，两者完全可以不同。
      const entryOpts = { envNames: envNamesByPlugin.get(ir.identity.name) };
      const { findings: entryFindings } = await doctor(ir, target, entryOpts);
      const prefixed = entryFindings.map((f) => ({ ...f, where: `${entry.name}:${f.where ?? ''}` }));

      if (worstLevel(entryFindings) === 'BLOCK') {
        failed.add(entry.name);
        findings.push(...prefixed);
        continue;
      }

      const projected = await projectAll(ir, target, entryOpts);
      await emit(ir, projected, join(outDir, 'plugins', entry.name), join(outDir, 'plugins'));
      converted.push(entry.name);
      findings.push(...prefixed);
    } catch (err) {
      // 单个本地条目转换失败不该拖垮整个市场：记 BLOCK，从输出 catalog 里剔除这一条，其余条目照常处理
      failed.add(entry.name);
      findings.push({
        level: 'BLOCK',
        code: 'marketplace.entry-convert-failed',
        message:
          `local entry "${entry.name}" failed to convert (plugin directory ${pluginDir}): ${(err as Error).message}; ` +
          `the entry was dropped from the output catalog; the rest still convert`,
        where: entry.name,
      });
    }
  }

  // 本地条目一律改指向输出目录里的 plugins/<name>；远端条目（url / git-subdir）不动。
  // 按条目名匹配对应的已投影条目，而不是按下标——一旦有条目可能被剔除，下标就不再和
  // mp.entries 对齐，按位置改写会把 source 错配到相邻条目上。
  const catalogEntries = projection.catalog.plugins as Record<string, unknown>[];
  for (const entry of mp.entries) {
    if (entry.source.kind !== 'local' || failed.has(entry.name)) continue;
    const projectedEntry = catalogEntries.find((e) => e[dialect.entryKeyField] === entry.name);
    if (!projectedEntry) continue;
    const path = `./plugins/${entry.name}`;
    projectedEntry.source = dialect.entrySourceForm === 'object' ? { source: 'local', path } : path;
  }

  // 转换失败的本地条目不写进最终 catalog：指向一个从未生成的目录，比诚实地缺席更糟
  projection.catalog.plugins = catalogEntries.filter(
    (e) => !failed.has(e[dialect.entryKeyField] as string),
  );

  const catalogAbs = join(outDir, projection.catalogPath);
  await mkdir(dirname(catalogAbs), { recursive: true });
  await writeFile(catalogAbs, `${JSON.stringify(projection.catalog, null, 2)}\n`, 'utf8');

  return { catalogPath: projection.catalogPath, converted, findings };
}
