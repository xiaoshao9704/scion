import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isInsideRoot } from '../emit/write.js';
import type { EcosystemId } from '../ir/types.js';
import { describeAction, type InstallAction } from './plan.js';

/** exec 没有别的说法时，「为什么没撤」的默认交代 */
const NOT_UNDONE_DEFAULT =
  'external commands are not undone — scion only reverses what it wrote itself';

export interface RestoredNote {
  label: 'Restored' | 'Removed';
  what: string;
}

export interface NotUndoneNote {
  what: string;
  why: string;
}

interface RollbackFailure {
  what: string;
  error: string;
  /** 原内容被救到哪儿了；救不出来则为 null */
  rescue: string | null;
}

export interface FailureReport {
  failedAt: string;
  restored: RestoredNote[];
  notUndone: NotUndoneNote[];
  rollbackFailures: RollbackFailure[];
}

/**
 * 一个动作在执行前的样子，以及把它撤回去的办法。快照与撤销成对写在一起，
 * 是因为「存过什么」和「怎么放回去」必须同时改——拆到两个 switch 里，日后
 * 加一种动作时漏改一边不会有任何东西提醒你。
 */
export interface Snapshot {
  readonly action: InstallAction;
  /** 动作是否真的执行成功了；决定 exec 要不要被点名为「没撤」 */
  succeeded: boolean;
  /** 撤回这个动作，返回报告里的一行；null 表示无事可撤 */
  undo(): Promise<RestoredNote | null>;
  /**
   * 整个 plan 成功后丢弃快照留下的临时物。清理失败不抛错——一次已经成功的安装不该
   * 因为删不掉一个备份目录就变成失败；但也不静默：返回一句给用户的交代，说明现场
   * 留下了什么、在哪儿。
   */
  discard(): Promise<string | null>;
  /** undo 自己失败时，把原内容落到一个用户能找到的地方，返回该路径 */
  rescue(): Promise<string | null>;
  /** 执行成功却撤不回来的东西（只有 exec 有） */
  notUndone?: NotUndoneNote;
}

export class InstallFailedError extends Error {
  constructor(
    readonly target: EcosystemId,
    /** 原始失败，不是回滚失败 */
    readonly failure: unknown,
    readonly report: FailureReport,
  ) {
    super(renderFailure(target, failure, report));
    this.name = 'InstallFailedError';
  }
}

/**
 * 失败报告 + 重跑指引。重跑命令由调用方传进来：只有 CLI 知道用户原本敲的是
 * 什么，installer 层拿不到，也不该去猜一条它没见过的命令行。
 */
export function formatInstallFailure(err: InstallFailedError, rerun: string): string {
  return `${err.message}\n\nOnce fixed, re-run the same command:\n  ${rerun}\n`;
}

export async function snapshotAction(action: InstallAction, stamp: string): Promise<Snapshot> {
  switch (action.kind) {
    case 'write-tree':
      return snapshotTree(action, stamp);
    case 'upsert-catalog':
    case 'write-foreign-registry':
      return snapshotFile(action, action.path, stamp);
    case 'exec':
      // 外部命令没有快照可言，也不试图撤销；它只负责在报告里为自己留个案底。
      return {
        action,
        succeeded: false,
        undo: async () => null,
        discard: async () => null,
        rescue: async () => null,
        notUndone: {
          what: describeAction(action),
          why: action.whyNotUndone ?? NOT_UNDONE_DEFAULT,
        },
      };
  }
}

/**
 * 撤销 write-tree = 删掉整个 root，而不是照 action.files 逐个删：emit() 进门就
 * rm -rf root，所以执行后 root 里只有本次写的东西；而 planEmitFiles() 只列文件
 * 不列空目录，照清单删会留下一堆空目录残骸，看着像装过一半。
 */
async function snapshotTree(
  action: Extract<InstallAction, { kind: 'write-tree' }>,
  stamp: string,
): Promise<Snapshot> {
  // 这里和 emit() 一样在真实目录上 rm / rename，所以套用同一条容纳断言。备份路径
  // 是回滚自己拼出来的，emit 根本看不到它，指望 emit 去挡等于没挡。
  assertContained(action.containmentRoot, action.root);
  const backup = `${action.root}.scion-bak.${stamp}`;
  assertContained(action.containmentRoot, backup);

  const existed = await pathExists(action.root);
  if (existed) {
    // 用 rename 而不是复制：同一父目录必然同一文件系统，一次原子改名就把旧版本
    // 整棵挪开，既不受体积影响，也不会拷到一半留下半棵树。
    await rm(backup, { recursive: true, force: true });
    await rename(action.root, backup);
  }

  return {
    action,
    succeeded: false,
    async undo() {
      await rm(action.root, { recursive: true, force: true });
      if (!existed) {
        return { label: 'Removed', what: `${action.root}/ (it did not exist before this run)` };
      }
      await rename(backup, action.root);
      return { label: 'Restored', what: `${action.root}/ (to its pre-install contents)` };
    },
    async discard() {
      if (!existed) return null;
      try {
        await rm(backup, { recursive: true, force: true });
        return null;
      } catch (err) {
        return (
          `left a temporary backup of the previous contents at ${backup} — removing it failed ` +
          `(${errorMessage(err)}). The install itself is complete and nothing refers to that ` +
          `directory; delete it whenever you like.`
        );
      }
    },
    async rescue() {
      return existed && (await pathExists(backup)) ? backup : null;
    },
  };
}

/** catalog 与外部注册表都是单个 JSON 文件，快照就是它的原始字节 */
async function snapshotFile(
  action: InstallAction,
  path: string,
  stamp: string,
): Promise<Snapshot> {
  const before = await readFileOrNull(path);
  // 写入端（upsertMarketplaceEntry / writeKimiRegistry）覆盖前会自己留一份 .scion-bak
  // 副本。那是为成功安装准备的后悔药；这次安装被撤销后它就成了纯噪声，而报告刚说过
  // 「已恢复原样」，目录里却多出一个文件，那句话就打了折。记下执行前有哪些，撤销时
  // 只清掉本次新增的——用户自己以前留下的副本一个不动。
  const backupsBefore = await siblingBackups(path);

  return {
    action,
    succeeded: false,
    async undo() {
      if (before === null) {
        await rm(path, { force: true });
        await sweepNewBackups(path, backupsBefore);
        return { label: 'Removed', what: `${path} (it did not exist before this run)` };
      }
      await mkdir(dirname(path), { recursive: true });
      // 写回原始 Buffer 而不是重新序列化：用户的缩进、键序、行尾都原样保留，
      // 「恢复原样」才真的是原样。
      await writeFile(path, before);
      await sweepNewBackups(path, backupsBefore);
      return { label: 'Restored', what: path };
    },
    async discard() {
      // 文件快照只在内存里，没有临时物需要丢弃
      return null;
    },
    async rescue() {
      if (before === null) return null;
      const target = `${path}.scion-rescue.${stamp}`;
      await writeFile(target, before);
      return target;
    },
  };
}

/** 同目录下针对 path 的 .scion-bak 副本文件名 */
async function siblingBackups(path: string): Promise<Set<string>> {
  const prefix = `${basename(path)}.scion-bak.`;
  try {
    const names = await readdir(dirname(path));
    return new Set(names.filter((name) => name.startsWith(prefix)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

async function sweepNewBackups(path: string, before: Set<string>): Promise<void> {
  for (const name of await siblingBackups(path)) {
    if (!before.has(name)) await rm(join(dirname(path), name), { force: true });
  }
}

function assertContained(root: string, target: string): void {
  if (!isInsideRoot(root, target)) {
    throw new Error(
      `refusing to touch a path outside containment root ${resolve(root)}: ${resolve(target)}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 报告的立场：回滚成功也要把「没撤的那些」摆在同一块里；回滚失败则连标题都改口，
 * 绝不让用户读完以为机器已经回到原样。
 */
function renderFailure(target: EcosystemId, failure: unknown, report: FailureReport): string {
  const broken = report.rollbackFailures.length > 0;
  const lines = [
    broken
      ? `[${target}] Install failed AND the rollback failed; this run left changes behind.`
      : `[${target}] Install failed; this run's changes have been rolled back.`,
    ...field('Failed at:', report.failedAt),
    ...field('Error:', errorMessage(failure)),
  ];

  for (const failed of report.rollbackFailures) {
    lines.push(`  ROLLBACK FAILED: could not undo ${failed.what}`);
    lines.push(...continuation(failed.error));
    lines.push(
      ...continuation(
        failed.rescue
          ? `the pre-install content is saved at ${failed.rescue} — put it back by hand`
          : 'the pre-install content could not be saved anywhere; inspect this path by hand',
      ),
    );
  }

  for (const item of report.restored) lines.push(...field(`${item.label}:`, item.what));
  for (const item of report.notUndone) {
    lines.push(...field('NOT undone:', item.what), ...continuation(`(${item.why})`));
  }

  return lines.join('\n');
}

/** 左侧一列标签，续行对齐到同一栏——多行的错误信息不会看起来像另一条目 */
function field(label: string, text: string): string[] {
  const [first, ...rest] = text.split('\n');
  return [`  ${label.padEnd(13)}${first}`, ...continuation(rest.join('\n'))];
}

function continuation(text: string): string[] {
  if (!text) return [];
  return text.split('\n').map((line) => `${' '.repeat(15)}${line}`);
}
