import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilityDir, Finding, Provenance } from '../ir/types.js';

export type CapabilityKind = 'skills' | 'commands' | 'agents';

export interface ScanResult {
  dir: CapabilityDir | null;
  provenance: Provenance | null;
  issues: Finding[];
}

/** 把 "./lib/skills/" 之类统一成 "lib/skills/" */
export function normalizeDirPath(raw: string): string {
  const trimmed = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed.length === 0 ? '' : `${trimmed}/`;
}

export async function scanCapabilityDir(
  root: string,
  declared: string | undefined,
  conventionDir: string,
  kind: CapabilityKind,
): Promise<ScanResult> {
  const isDeclared = typeof declared === 'string' && declared.length > 0;
  const rel = normalizeDirPath(isDeclared ? declared : conventionDir);
  const abs = join(root, rel);

  let names: string[];
  try {
    names = await readdir(abs);
  } catch {
    if (isDeclared) {
      return {
        dir: null,
        provenance: null,
        issues: [
          {
            level: 'BLOCK',
            code: 'capability.declared-missing',
            message: `the manifest declares ${kind}: "${declared}", but that directory does not exist`,
            where: rel,
          },
        ],
      };
    }
    // 约定目录不存在 = 该插件没有这类能力，不是问题
    return { dir: null, provenance: null, issues: [] };
  }

  const issues: Finding[] = [];
  // skills 是一个目录一个技能，只看顶层一层；commands / agents 是一个 .md 一个条目，
  // 且可以嵌套在子目录里（如 commands/ns/deep.md）——递归收集，否则嵌套文件对
  // normalize/project/doctor 全程不可见，会被 emit() 原样拷贝出去但从未被转换或报告。
  const entries =
    kind === 'skills'
      ? await collectSkillDirs(abs, names, issues, rel)
      : await collectMarkdownFiles(abs, '', issues);

  return {
    dir: { path: rel, entries },
    provenance: {
      field: `capabilities.${kind}`,
      source: isDeclared ? 'manifest' : 'convention',
      detail: isDeclared ? `declared as "${declared}"` : `scanned ${rel}`,
    },
    issues,
  };
}

async function collectSkillDirs(
  abs: string,
  names: string[],
  issues: Finding[],
  rel: string,
): Promise<string[]> {
  const entries: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    let info;
    try {
      info = await stat(join(abs, name));
    } catch (err) {
      issues.push({
        level: 'LOSS',
        code: 'capability.entry-unreadable',
        message: `cannot read directory entry "${name}" (${(err as NodeJS.ErrnoException).code ?? 'unknown'}); it may be a broken symlink. Entry skipped`,
        where: `${rel}${name}`,
      });
      continue;
    }
    if (info.isDirectory()) entries.push(name);
  }
  return entries;
}

/** 递归收集 .md 文件，返回相对能力目录（不是插件根）的路径，如 "ship.md" 或 "ns/deep.md" */
async function collectMarkdownFiles(
  abs: string,
  rel: string,
  issues: Finding[],
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(abs, rel));
  } catch (err) {
    issues.push({
      level: 'LOSS',
      code: 'capability.entry-unreadable',
      message: `cannot read subdirectory "${rel}" (${(err as NodeJS.ErrnoException).code ?? 'unknown'}); it may be a broken symlink. Subtree skipped`,
      where: rel,
    });
    return [];
  }

  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const childRel = `${rel}${name}`;
    let info;
    try {
      info = await stat(join(abs, childRel));
    } catch (err) {
      issues.push({
        level: 'LOSS',
        code: 'capability.entry-unreadable',
        message: `cannot read directory entry "${childRel}" (${(err as NodeJS.ErrnoException).code ?? 'unknown'}); it may be a broken symlink. Entry skipped`,
        where: childRel,
      });
      continue;
    }
    if (info.isDirectory()) {
      out.push(...(await collectMarkdownFiles(abs, `${childRel}/`, issues)));
    } else if (info.isFile() && name.endsWith('.md')) {
      out.push(childRel);
    }
  }
  return out;
}

/** hooks 只登记不解析；v1 不转换 */
export async function scanHooks(root: string): Promise<string[]> {
  const rel = 'hooks';
  let names: string[];
  try {
    names = await readdir(join(root, rel));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    let info;
    try {
      info = await stat(join(root, rel, name));
    } catch {
      // hooks 整体由后续任务报告为 not-converted；单个条目的问题没有反馈通道
      continue;
    }
    if (info.isFile()) out.push(`${rel}/${name}`);
  }
  return out;
}
