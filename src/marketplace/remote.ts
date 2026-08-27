import type { EcosystemProfile } from '../profiles/types.js';
import type { MarketplaceEntrySource } from './types.js';
import { marketDialect } from '../profiles/loader.js';

/**
 * 从条目源的 URL 里取主机名。除了标准 URL，还认 scp 形态的 git 地址
 * （git@host:owner/repo.git）——真实 catalog 里两种都出现。取不出来返回 null，
 * 调用方一律按"取不到"处理：拿不准的时候说不确定，好过替目标生态打包票。
 */
export function hostOf(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (scp) return scp[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** 条目源指向的远端地址；本地条目没有 */
export function remoteUrlOf(source: MarketplaceEntrySource): string | null {
  return source.kind === 'local' ? null : source.url;
}

/**
 * 目标生态能不能自己把这个条目源拉下来。
 *
 * 判据全部来自 profile 的 marketplaceDialect.remoteFetch，这里只做匹配，不认识任何
 * 具体生态——新增生态时只写它自己的声明，这个函数和调用它的转换引擎都不用改。
 */
export function canSelfFetch(target: EcosystemProfile, source: MarketplaceEntrySource): boolean {
  const url = remoteUrlOf(source);
  if (url === null) return true; // 本地条目不需要谁去拉

  const { hosts } = marketDialect(target).remoteFetch;
  if (hosts.includes('*')) return true;

  const host = hostOf(url);
  if (host === null) return false;
  return hosts.some((h) => {
    const allowed = h.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}
