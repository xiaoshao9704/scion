import type { EcosystemId } from '../ir/types.js';
import type { EcosystemProfile } from './types.js';
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
