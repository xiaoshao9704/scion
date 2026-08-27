import type { EcosystemId } from '../ir/types.js';
import type { EcosystemProfile, InstallSpec, MarketplaceDialect } from './types.js';
import { assertProfile } from './schema.js';
import { claudeProfile } from './claude.js';
import { kimiProfile } from './kimi.js';
import { codexProfile } from './codex.js';

export const ALL_PROFILE_IDS = ['claude', 'kimi', 'codex'] as const satisfies readonly EcosystemId[];

const REGISTRY: Record<EcosystemId, EcosystemProfile> = {
  claude: claudeProfile,
  kimi: kimiProfile,
  codex: codexProfile,
};

export function loadProfile(id: EcosystemId): EcosystemProfile {
  const profile = REGISTRY[id];
  if (!profile) throw new Error(`unknown ecosystem: ${id}`);
  return assertProfile(profile);
}

export type EcosystemOperation = 'install' | 'market' | 'in-repo';

export function supportedOperations(profile: EcosystemProfile): EcosystemOperation[] {
  const ops: EcosystemOperation[] = [];
  if (profile.install) ops.push('install');
  if (profile.marketplaceDialect) ops.push('market');
  if (profile.manifestPaths.length > 0) ops.push('in-repo');
  return ops;
}

/** 命令入口的操作把关：目标生态没实现这个操作时给一句能行动的错误 */
export function requireOperation(profile: EcosystemProfile, op: EcosystemOperation): void {
  if (supportedOperations(profile).includes(op)) return;
  throw new Error(
    `the ${profile.id} profile does not implement ${op}; it supports: ${supportedOperations(profile).join(', ') || 'nothing'}`,
  );
}

/** install 数据的取用点。命令层已把关，这里抛错只会因为内部调用顺序错了 */
export function installSpec(profile: EcosystemProfile): InstallSpec {
  if (!profile.install) {
    throw new Error(`the ${profile.id} profile does not implement install`);
  }
  return profile.install;
}

/** marketplaceDialect 的取用点，同上 */
export function marketDialect(profile: EcosystemProfile): MarketplaceDialect {
  if (!profile.marketplaceDialect) {
    throw new Error(`the ${profile.id} profile does not implement marketplace conversion`);
  }
  return profile.marketplaceDialect;
}
