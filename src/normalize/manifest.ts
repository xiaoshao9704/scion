import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemProfile } from '../profiles/types.js';

export interface FoundManifest {
  /** 相对插件根的清单路径 */
  path: string;
  raw: Record<string, unknown>;
}

export async function findManifest(
  root: string,
  profile: EcosystemProfile,
): Promise<FoundManifest | null> {
  for (const rel of profile.manifestPaths) {
    let text: string;
    try {
      text = await readFile(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      return { path: rel, raw };
    } catch (err) {
      throw new Error(`failed to parse ${rel}: ${(err as Error).message}`);
    }
  }
  return null;
}
