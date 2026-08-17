import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EcosystemProfile } from '../profiles/types.js';
import type { MarketplaceEntryIR, MarketplaceIR } from '../marketplace/types.js';
import { normalizeMarketplace } from '../marketplace/normalize.js';
import { isInsideRoot } from '../emit/write.js';
import type { GitPin } from './resolve.js';

export interface MarketRef {
  plugin: string;
  market: string;
}

/**
 * `<plugin>@<marketplace>`。两边都限制成单个安全片段（字母数字开头，之后只允许
 * 词字符、点、连字符），所以它与其他源形态不会相撞：git@host:owner/repo 带冒号和斜杠，
 * https URL 带斜杠，本地路径几乎总带斜杠或点开头。判定只看字符串本身，不查文件系统——
 * 源形态的分派必须是可预测的，不能因为 cwd 下恰好有个同名目录就换一条路。
 */
const MARKET_REF = /^([A-Za-z0-9][\w.-]*)@([A-Za-z0-9][\w.-]*)$/;

export function parseMarketRef(spec: string): MarketRef | null {
  const m = MARKET_REF.exec(spec);
  return m ? { plugin: m[1], market: m[2] } : null;
}

/** 查过的一个位置，以及它为什么没用上——找不到市场时要逐条报给用户 */
export interface MarketProbe {
  path: string;
  problem: string;
}

export type MarketRefLookup =
  | { kind: 'ok'; entry: MarketplaceEntryIR; marketplace: MarketplaceIR }
  | { kind: 'market-not-found'; probes: MarketProbe[] }
  | {
      kind: 'entry-not-found';
      catalogPath: string;
      /** 名字相近的条目（前缀/子串），可能为空 */
      candidates: string[];
      entryCount: number;
    };

/**
 * 按名字找市场时依次查的位置。顺序固定且可预测，找不到时原样列给用户：
 * 1. Claude 已添加的市场——目录形态和无扩展名的裸 JSON 文件形态都有，两种都要认
 * 2. scion 自己转换出来的市场（`market convert` 就写在这里，按目标生态分目录）
 *
 * 只有这两条。曾经还列过 `~/.scion/markets/<name>` 这个市场根，但转换产物一律落在
 * 它下面的 <生态> 子目录里，那条路径不可能命中——在"我查过哪儿"里列一条永远命不中的
 * 路径，是在指使用户去那儿放文件。
 */
export function marketSearchPaths(home: string, market: string, from: string): string[] {
  return [
    join(home, '.claude', 'plugins', 'marketplaces', market),
    join(home, '.scion', 'markets', market, from),
  ];
}

/** 两个名字开头有多少个字符相同 */
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 名字相近的候选。两条规则，都简单到能一句话解释清楚：一个包含另一个，或者开头至少有
 * 3 个字符相同（打错一两个字母的典型情形——"local-toool" 与 "local-tool" 互不包含）。
 * 不上编辑距离之类的模糊匹配：那会让"它凭什么推荐这个"变得说不清。
 */
const MIN_SHARED_PREFIX = 3;

function nearbyNames(entries: MarketplaceEntryIR[], wanted: string): string[] {
  const needle = wanted.toLowerCase();
  return entries
    .map((e) => e.name)
    .filter((name) => {
      const n = name.toLowerCase();
      if (n.includes(needle) || needle.includes(n)) return true;
      return commonPrefixLength(n, needle) >= MIN_SHARED_PREFIX;
    })
    .slice(0, 8);
}

export async function lookupMarketRef(
  ref: MarketRef,
  opts: { home: string; profile: EcosystemProfile },
): Promise<MarketRefLookup> {
  const probes: MarketProbe[] = [];
  let marketplace: MarketplaceIR | null = null;

  for (const path of marketSearchPaths(opts.home, ref.market, opts.profile.id)) {
    if (!(await stat(path).catch(() => null))) {
      probes.push({ path, problem: 'does not exist' });
      continue;
    }
    try {
      marketplace = await normalizeMarketplace(path, opts.profile);
      break;
    } catch (err) {
      // 位置存在但读不出 catalog（没有清单、JSON 坏了）——照实说，别让它退化成"不存在"
      probes.push({ path, problem: (err as Error).message });
    }
  }

  if (!marketplace) return { kind: 'market-not-found', probes };

  const entry = marketplace.entries.find((e) => e.name === ref.plugin);
  if (!entry) {
    return {
      kind: 'entry-not-found',
      catalogPath: marketplace.catalogPath,
      candidates: nearbyNames(marketplace.entries, ref.plugin),
      entryCount: marketplace.entries.length,
    };
  }

  return { kind: 'ok', entry, marketplace };
}

/**
 * 把条目的 source 翻译成 `resolveSource()` 认得的 spec。这里只做翻译，绝不自己拉取——
 * path / zip / git 三种形态 resolveSource 早就支持了。
 */
export interface EntrySpec {
  spec: string;
  /** git-subdir 的子目录，拉下来之后再往下走一层 */
  subdir?: string;
  /** catalog 写下的 pin，原样交给 resolveSource 去遵守 */
  pin?: GitPin;
  /** 有损或需要说明的地方，原样报给用户 */
  notes: string[];
}

export function entrySourceSpec(entry: MarketplaceEntryIR, mp: MarketplaceIR): EntrySpec {
  if (entry.source.kind === 'local') {
    const dir = resolve(join(mp.root, entry.source.path.replace(/^\.\//, '')));
    // catalog 是下载来的、未经信任的数据，source.path 可以是 "../../etc"。与
    // emitMarketplace() 里同一个道理：读之前先确认它没走出市场根。
    if (!isInsideRoot(mp.root, dir)) {
      throw new Error(
        `entry "${entry.name}" has source.path "${entry.source.path}", which resolves outside the marketplace root ${mp.root}; refusing to read it`,
      );
    }
    return { spec: dir, notes: [] };
  }

  if (entry.source.kind === 'url') return { spec: entry.source.url, notes: [] };

  // sha 优先于 ref：两者都在时 sha 更精确，而 catalog 作者写下 sha 的意思就是"就装这个
  // commit"。说清楚取的是哪一个，用户才能拿它跟 catalog 对账。
  const notes: string[] = [];
  const pin: GitPin = { ref: entry.source.ref, sha: entry.source.sha };
  if (pin.sha) {
    notes.push(
      `the catalog pins this entry at sha ${pin.sha}; scion fetches that exact commit` +
        (pin.ref ? ` (the entry also names ref ${pin.ref}, which the sha overrides)` : ''),
    );
  } else if (pin.ref) {
    notes.push(`the catalog pins this entry at ref ${pin.ref}; scion clones that ref`);
  }
  return { spec: entry.source.url, subdir: entry.source.path, pin, notes };
}
