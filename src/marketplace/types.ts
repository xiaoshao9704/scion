import type { EcosystemId, Finding, Provenance } from '../ir/types.js';

/**
 * 条目 source 的三种真实形态（来自实测三边 catalog，而非 brief 的臆测）：
 * - local：本地相对/绝对路径
 * - url：远程 URL（Codex 对象形态里键名是 url，不是 path）
 * - git-subdir：git 仓库 + 子目录 + 可选 ref/sha，只有 Codex 能表达
 */
export type MarketplaceEntrySource =
  | { kind: 'local'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'git-subdir'; url: string; path?: string; ref?: string; sha?: string };

export interface MarketplaceEntryIR {
  /** 条目主键；Claude/Codex 来自 name，Kimi 来自 id */
  name: string;
  source: MarketplaceEntrySource;
  displayName?: string;
  description?: string;
  version?: string;
  homepage?: string;
  keywords?: string[];
  category?: string;
}

export interface MarketplaceIR {
  /** catalog 文件所在的 marketplace 根目录 */
  root: string;
  /** catalog 文件绝对路径 */
  catalogPath: string;
  sourceEcosystem: EcosystemId;
  /** 市场名；Kimi 的格式不承载市场名，此处为 null */
  name: string | null;
  displayName?: string;
  owner?: { name?: string };
  version?: string;
  entries: MarketplaceEntryIR[];
  provenance: Provenance[];
  issues: Finding[];
}

/**
 * BLOCK 码里作用域限定在单个 plugins[i] 条目上的一类：出问题只影响这一个条目，产生时
 * 就已经把它排除在输出之外，市场里其余条目照常转换、不受牵连。与之相对的是作用域覆盖
 * 整个 catalog 的 BLOCK——如市场自己的 name 不安全（整个输出根都靠它，没法安全落盘）、
 * catalog 里没有 plugins 数组（无从转换）——那类问题让整次转换都没有意义或不安全，必须
 * 继续中止整个 run，不在这个集合里。
 *
 * 这个集合按码本身归类，不看产生它的流水线阶段：前三个都在 normalizeMarketplace() 解析
 * 阶段产生、直接进 mp.issues；entry-source-outside-root 要等 emitMarketplace() 真正
 * 解析 source.path 时才发现，但语义上同样只影响这一个条目。
 *
 * 唯一的用途是 `scion market convert` 的中止判断（src/commands/market.ts）：解析阶段的
 * BLOCK 命中这个集合就放行、让其余条目继续转换，不命中就中止整个 run——和 emitMarketplace()
 * 转换循环里那些同样条目级的 BLOCK（doctor() 产生的、entry-convert-failed）从一开始就
 * 从不中止是一致的行为，只是检查发生在流水线更早的阶段。
 */
export const ENTRY_SCOPED_BLOCK_CODES: ReadonlySet<string> = new Set([
  'marketplace.entry-invalid',
  'marketplace.entry-source-unknown',
  'marketplace.entry-name-unsafe',
  'marketplace.entry-source-outside-root',
  'marketplace.remote-entry-unfetchable',
]);
