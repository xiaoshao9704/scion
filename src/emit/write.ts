import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import type { PluginIR } from '../ir/types.js';
import type { ProjectionResult } from '../project/types.js';
import { loadProfile, ALL_PROFILE_IDS } from '../profiles/loader.js';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.in_use']);

/**
 * true 当 target 落在 root 内部（或就是 root 本身）。用分隔符边界比较而非裸
 * startsWith——否则 "<root>-evil" 这类前缀相似但并不在目录内部的路径会被
 * 误判为安全，这是本分支已经在 convert.ts / resolve.ts 里各修过一次的同一个坑，
 * 这里不重蹈覆辙。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

/** 所有生态的清单路径首段，转换时一律不带过去 */
function manifestTopSegments(): Set<string> {
  const out = new Set<string>();
  for (const id of ALL_PROFILE_IDS) {
    for (const rel of loadProfile(id).manifestPaths) {
      out.add(rel.split('/')[0]);
    }
  }
  return out;
}

/** emit 在顶层要跳过的目录名。跳过只发生在顶层，与 cp 的递归行为保持一致。 */
function topLevelSkip(): Set<string> {
  return new Set([...ALWAYS_SKIP, ...manifestTopSegments()]);
}

/**
 * emit(ir, result, outDir, ...) 跑完后 outDir 下会存在的文件，相对 outDir 且已排序。
 * 只读——preview 靠它给出真实文件数，而不是自己另编一套估算：emit 先清空 outDir，
 * 因此最终文件集合就是「原样拷过去的」∪「投影出的」∪「清单」，去重后即为所得。
 *
 * 这里没有让 emit 改用这份清单去逐个拷贝：cp 的递归拷贝会连符号链接、空目录、
 * 权限位一起带过去，改成按文件清单复制反而会悄悄改变落盘结果。两边各自实现、
 * 由 tests/install-plan.ts 的「preview 承诺 == execute 落盘」断言守住一致性。
 */
export async function planEmitFiles(
  ir: PluginIR,
  result: ProjectionResult,
): Promise<string[]> {
  const skip = topLevelSkip();
  const files = new Set<string>();

  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(ir.root, rel), { withFileTypes: true })) {
      const child = rel ? posix.join(rel, entry.name) : entry.name;
      // 符号链接按 cp 的默认行为原样拷成一个链接，算一个条目，不跟进去展开
      if (entry.isDirectory()) await walk(child);
      else files.add(child);
    }
  }

  for (const entry of await readdir(ir.root, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    if (entry.isDirectory()) await walk(entry.name);
    else files.add(entry.name);
  }

  for (const file of result.files) files.add(file.path);
  files.add(result.manifestPath);

  return [...files].sort();
}

/**
 * @param root 允许写入的containment 根目录；outDir 必须落在其内部（或就是它本身），
 * 否则在任何 rm/mkdir/cp 之前直接抛错。这是 sink 端的强制点——emit() 有五个调用方，
 * 其中 marketplace 那一路把未经 normalize() 校验的条目名拼进 outDir，只在各个调用点
 * 单独查一次名字够不够安全并不能兜底所有情况，必须在真正落盘前统一收口。
 */
export async function emit(
  ir: PluginIR,
  result: ProjectionResult,
  outDir: string,
  root: string,
): Promise<string[]> {
  if (!isInsideRoot(root, outDir)) {
    throw new Error(
      `refusing to write outside containment root ${resolve(root)}: ${resolve(outDir)}`,
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const skip = topLevelSkip();

  for (const name of await readdir(ir.root)) {
    if (skip.has(name)) continue;
    await cp(join(ir.root, name), join(outDir, name), { recursive: true });
  }

  const written: string[] = [];

  for (const file of result.files) {
    const abs = join(outDir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
    written.push(file.path);
  }

  const manifestAbs = join(outDir, result.manifestPath);
  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  written.push(result.manifestPath);

  return written;
}
