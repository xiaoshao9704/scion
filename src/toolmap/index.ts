import type { EcosystemId } from '../ir/types.js';
import { CLAUDE_TO_KIMI_INSTRUCTIONS } from './claude-to-kimi.js';

const TABLE: Partial<Record<`${EcosystemId}->${EcosystemId}`, string>> = {
  'claude->kimi': CLAUDE_TO_KIMI_INSTRUCTIONS,
};

export function getSkillInstructions(from: EcosystemId, to: EcosystemId): string | null {
  if (from === to) return null;
  return TABLE[`${from}->${to}`] ?? null;
}
