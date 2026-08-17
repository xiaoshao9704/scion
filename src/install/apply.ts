import { emit } from '../emit/write.js';
import type { EcosystemId } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';
import { execRunner, runOrThrow, type Runner } from './exec.js';
import { upsertMarketplaceEntry } from './marketplace.js';
import {
  describeAction,
  type InstallAction,
  type InstallPlan,
  type UpsertCatalogPayload,
  type WriteTreePayload,
} from './plan.js';
import {
  InstallFailedError,
  errorMessage,
  snapshotAction,
  type NotUndoneNote,
  type RestoredNote,
  type Snapshot,
} from './rollback.js';

export interface ApplyContext {
  target: EcosystemProfile;
  run?: Runner;
  now?: () => Date;
}

/**
 * 解释执行一个动作——只解释，不推导。写什么文件、条目叫什么、命令行长什么样，
 * 全部在 preview 阶段就定死并放进了 action；这里再算一遍就等于给预览留出了漂移
 * 的余地，而预览一旦不准，本项目要消灭的「说成功但东西少了」就换个形式回来了。
 *
 * 三种通用动作（write-tree / upsert-catalog / exec）在两个生态之间逐字相同，所以
 * 收在这里共用；write-foreign-registry 的注册表格式是每个生态自己的私有约定，
 * 交由所属 installer 处理，不在这里假装通用。
 */
async function applyAction(action: InstallAction, ctx: ApplyContext): Promise<void> {
  switch (action.kind) {
    case 'write-tree': {
      const { ir, projected } = action.payload as WriteTreePayload;
      await emit(ir, projected, action.root, action.containmentRoot);
      return;
    }
    case 'upsert-catalog': {
      const payload = action.payload as UpsertCatalogPayload;
      await upsertMarketplaceEntry(
        payload.marketplaceRoot,
        payload.marketplaceName,
        ctx.target,
        { name: action.entryKey, category: payload.category },
        ctx.now,
      );
      return;
    }
    case 'exec':
      await runOrThrow(ctx.run ?? execRunner, action.cmd, action.args);
      return;
    case 'write-foreign-registry':
      throw new Error(
        `write-foreign-registry must be handled by the ${ctx.target.id} installer itself; registry formats are not interchangeable`,
      );
  }
}

/**
 * 覆盖某一种动作的处理器。返回字符串时，它会成为本次 execute 交付给用户的 note——
 * 这是 kimi 唯一需要的偏差：注册表落盘后要把 plan 里那句预告态改成完成态。
 */
export type ActionHandler = (action: InstallAction, ctx: ApplyContext) => Promise<string | void>;

/**
 * 遍历 plan 的唯一实现。两个 installer 都走这里，不各写各的循环：一旦有两份，
 * 快照与回滚这类「只在出错那条路径上才跑到」的逻辑就会在其中一份里悄悄退化，
 * 而退化的那次正好是用户最需要它的时候。
 *
 * 纪律与 preview/execute 同源：撤销逻辑也只有一份，放在 rollback.ts 里与快照成对。
 */
export async function executePlan(
  plan: InstallPlan,
  ctx: ApplyContext,
  handlers: Partial<Record<InstallAction['kind'], ActionHandler>> = {},
): Promise<{ note?: string; warnings: string[] }> {
  const stamp = (ctx.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const taken: Snapshot[] = [];
  let note: string | undefined;

  for (const action of plan.actions) {
    try {
      // 快照必须先于执行：动作一旦开始落盘，「执行前长什么样」就再也取不回来了。
      // 取快照本身失败也走回滚——前面几个动作已经落地，不能就这么撂在那儿。
      const snapshot = await snapshotAction(action, stamp);
      taken.push(snapshot);

      const result = await (handlers[action.kind] ?? applyAction)(action, ctx);
      if (typeof result === 'string') note = result;
      snapshot.succeeded = true;
    } catch (err) {
      throw await rollback(plan.target, taken, action, err);
    }
  }

  // 清理失败不该把一次已经成功的安装变成失败：留下的只是一个无人引用的备份目录。
  // 但也不能咽下去——现场没打扫干净就得说出来，让用户自己决定要不要动手，而不是
  // 哪天在 plugins/ 底下撞见一个来路不明的目录。
  const warnings: string[] = [];
  for (const snapshot of taken) {
    const warning = await snapshot
      .discard()
      .catch((err: unknown) => `could not clean up a temporary backup: ${errorMessage(err)}`);
    if (warning) warnings.push(warning);
  }
  return { note, warnings };
}

/** 反向遍历撤销栈。回滚途中再出错也继续撤剩下的，最后把所有失败一起报出来。 */
async function rollback(
  target: EcosystemId,
  taken: Snapshot[],
  failedAction: InstallAction,
  failure: unknown,
): Promise<InstallFailedError> {
  const restored: RestoredNote[] = [];
  const notUndone: NotUndoneNote[] = [];
  const rollbackFailures = [];

  for (const snapshot of [...taken].reverse()) {
    if (snapshot.notUndone) {
      // 撤不了的动作（exec）：成功执行过才点名；失败那条已经写在 "Failed at" 里了
      if (snapshot.succeeded) notUndone.push(snapshot.notUndone);
      continue;
    }
    try {
      const note = await snapshot.undo();
      if (note) restored.push(note);
    } catch (err) {
      rollbackFailures.push({
        what: describeAction(snapshot.action),
        error: errorMessage(err),
        rescue: await snapshot.rescue().catch(() => null),
      });
    }
  }

  return new InstallFailedError(target, failure, {
    failedAt: describeAction(failedAction),
    restored,
    notUndone,
    rollbackFailures,
  });
}
