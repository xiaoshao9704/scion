import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilityDir, Finding, PluginIR } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { EmittedFile, ProjectionOptions, ProjectionResult } from './types.js';
import { projectManifest } from './manifest.js';
import { remapFrontmatter, type FrontmatterKind } from './frontmatter.js';
import { substitutePathVars } from './pathvars.js';
import { loadProfile } from '../profiles/loader.js';

export type { EmittedFile, ProjectionOptions, ProjectionResult } from './types.js';

/** 只投影清单，不读正文。保留给单测与 doctor 使用 */
export function project(
  ir: PluginIR,
  target: EcosystemProfile,
  opts: ProjectionOptions = {},
): ProjectionResult {
  const { manifest, files, findings } = projectManifest(ir, target, opts);
  return { manifest, manifestPath: target.manifestPaths[0], files, findings };
}

/** 完整投影：清单 + 所有需要改写的正文文件 */
export async function projectAll(
  ir: PluginIR,
  target: EcosystemProfile,
  opts: ProjectionOptions = {},
): Promise<ProjectionResult> {
  const base = project(ir, target, opts);
  const from = loadProfile(ir.sourceEcosystem);
  const files: EmittedFile[] = [...base.files];
  const findings: Finding[] = [...base.findings];

  for (const kind of ['commands', 'agents'] as const) {
    const dir = ir.capabilities[kind];
    if (!dir) continue;
    for (const entry of dir.entries) {
      const rel = `${dir.path}${entry}`;
      const source = await readFile(join(ir.root, rel), 'utf8');
      const remapped = remapFrontmatter(source, kind as FrontmatterKind, from, target, rel);
      const substituted = substitutePathVars(remapped.content, from, target, rel);
      findings.push(...remapped.findings, ...substituted.findings);
      if (substituted.content !== source) {
        files.push({ path: rel, content: substituted.content });
      }
    }
  }

  const skills = ir.capabilities.skills;
  if (skills) {
    for (const rel of await listMarkdown(ir.root, skills)) {
      const source = await readFile(join(ir.root, rel), 'utf8');
      const substituted = substitutePathVars(source, from, target, rel);
      findings.push(...substituted.findings);
      if (substituted.content !== source) {
        files.push({ path: rel, content: substituted.content });
      }
    }
  }

  return { ...base, files, findings };
}

/** 递归列出某个能力目录下的所有 .md，返回相对插件根的路径 */
async function listMarkdown(root: string, dir: CapabilityDir): Promise<string[]> {
  const out: string[] = [];

  async function walk(rel: string): Promise<void> {
    const names = await readdir(join(root, rel));
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const child = `${rel}${name}`;
      const info = await stat(join(root, child));
      if (info.isDirectory()) await walk(`${child}/`);
      else if (name.endsWith('.md')) out.push(child);
    }
  }

  await walk(dir.path);
  return out;
}
