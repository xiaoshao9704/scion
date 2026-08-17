import type { EcosystemId, PluginIR } from '../ir/types.js';
import type { ProjectionResult } from '../project/types.js';
import type { Runner } from './exec.js';
import type { InstallOutcome } from './types.js';

/** 一次安装要做的单个动作。新增生态时优先复用已有 kind，不要为每个生态发明新 kind。 */
export type InstallAction =
  /** 把转换产物写到 root 下（emit 会先清空 root） */
  | {
      kind: 'write-tree';
      root: string;
      /** emit 的容纳根，用于路径逃逸断言 */
      containmentRoot: string;
      /** 相对 root 的文件路径，已排序，供预览展示 */
      files: string[];
      /** execute 用的载荷：preview 阶段算好的投影结果，execute 不再重算 */
      payload: unknown;
    }
  /** 在 scion 自己维护的 catalog 里增改一个条目 */
  | {
      kind: 'upsert-catalog';
      path: string;
      entryKey: string;
      op: 'add' | 'update';
      payload: unknown;
    }
  /** 执行一条外部命令 */
  | {
      kind: 'exec';
      cmd: string;
      args: string[];
      /**
       * 回滚时这条命令已经成功执行过的话，报告里跟在「NOT undone」后面的原因。
       * 由构造 plan 的 installer 给出：为什么不撤是这条命令自己的性质（共享市场、
       * 幂等与否），回滚驱动无从判断，只能照抄。
       */
      whyNotUndone?: string;
    }
  /** 写目标工具自己的注册表（仅 kimi --write-registry 这条 opt-in 路径） */
  | {
      kind: 'write-foreign-registry';
      path: string;
      entryKey: string;
      op: 'add' | 'update';
      payload: unknown;
    };

export interface InstallPlan {
  target: EcosystemId;
  /** 转换产物最终落地的目录 */
  pluginRoot: string;
  actions: InstallAction[];
  /** 执行完这些动作后，是否算「已在目标生态完成注册」 */
  registers: boolean;
  /** 未注册时给用户的下一步指引（原 InstallOutcome.note） */
  note?: string;
}

export interface InstallOpts {
  home: string;
  /** 透传给投影：保留作者写的环境变量名，不做消歧改名 */
  keepEnvNames?: boolean;
  /** 用户点名的环境变量改名，透传给投影 */
  envNames?: Map<string, string>;
  /**
   * 这个插件所属市场的**官方名字**，来自 `<插件>@<市场>` 查到的那份 catalog。
   * 装的是市场里的条目，就该继续挂在那个市场名下——把别人的插件收编进一个叫 "scion"
   * 的市场，等于用工具名盖掉了插件真正的出处。不来自市场的源（git URL / 目录 / zip）
   * 没有官方名字可用，留空，由 profile 的 marketplaceName 兜底。
   */
  marketName?: string;
  run?: Runner;
  writeRegistry?: boolean;
  now?: () => Date;
}

export interface Installer {
  readonly target: EcosystemId;
  /** 算准要做什么，零副作用 */
  preview(ir: PluginIR, opts: InstallOpts): Promise<InstallPlan>;
  /** 照 plan 执行 */
  execute(plan: InstallPlan, opts: InstallOpts): Promise<InstallOutcome>;
}

/**
 * 各动作的 payload 类型。之所以在公共类型里把 payload 留成 unknown、只在这里给出
 * 具体形状：plan 的展示面（files / path / entryKey / op）是稳定契约，谁都能读；
 * 载荷则是 installer 与自己 execute 之间的私事，调用方不该、也不需要认识
 * ProjectionResult 这种内部类型。构造方与消费方都在 install/ 内部，用断言取回即可。
 */
export interface WriteTreePayload {
  ir: PluginIR;
  projected: ProjectionResult;
}

export interface UpsertCatalogPayload {
  marketplaceRoot: string;
  marketplaceName: string;
  category?: string;
}

/**
 * 一个动作的人读描述。预览与失败/回滚报告共用这一份措辞：同一个动作在两处出现时
 * 必须长得一样，否则用户得自己在「预览里说要 run 什么」和「报告里说没撤什么」之间
 * 做对照翻译。
 */
export function describeAction(action: InstallAction): string {
  switch (action.kind) {
    case 'write-tree':
      return `write ${action.files.length} ${action.files.length === 1 ? 'file' : 'files'} → ${action.root}/`;
    case 'upsert-catalog':
      return `update catalog ${action.path} (${describeOp(action.op, action.entryKey)})`;
    case 'exec':
      // 用空格拼出可读命令行。刻意不做引号转义：转义后的字符串看着像可以直接粘进
      // shell，但真正执行走的是 execFile（参数数组、不过 shell），两者一旦不同就是
      // 又一处「预览说的和实际做的不一样」。展示就老实按展示写。
      return `run ${[action.cmd, ...action.args].join(' ')}`;
    case 'write-foreign-registry':
      return `write registry ${action.path} (${describeOp(action.op, action.entryKey)})`;
  }
}

/** 把 plan 渲染成给人看的预览。展示用，不做 shell 转义——见 describeAction 的说明。 */
export function formatPlan(plan: InstallPlan): string {
  const lines = [`[${plan.target}] preview (--dry-run, nothing is changed)`];

  for (const action of plan.actions) {
    lines.push(`  · ${describeAction(action)}`);
  }

  // note 是多行的，逐行缩进：只缩第一行会让其余几行平齐左边距，读起来像脱离了这个 plan
  // 另起一段，而它讲的正是这个 plan 落地之后要做的事。空行不补空格，免得留下行尾空白。
  if (plan.note) {
    lines.push(...plan.note.split('\n').map((line) => (line ? `  ${line}` : line)));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * plan 的 JSON 形态。逐字段挑出来写，而不是把 action 整个丢进 JSON.stringify 再删
 * payload：payload 是 installer 与自己 execute 之间的私事（还可能很大），新增一种动作时
 * 忘了删就漏出去了。白名单的方向反过来——忘了加的字段只是没出现，不会变成泄漏。
 */
export function planToJson(plan: InstallPlan): Record<string, unknown> {
  return {
    target: plan.target,
    pluginRoot: plan.pluginRoot,
    registers: plan.registers,
    ...(plan.note ? { note: plan.note } : {}),
    actions: plan.actions.map(actionToJson),
  };
}

function actionToJson(action: InstallAction): Record<string, unknown> {
  switch (action.kind) {
    case 'write-tree':
      return {
        kind: action.kind,
        root: action.root,
        containmentRoot: action.containmentRoot,
        files: action.files,
      };
    case 'upsert-catalog':
      return { kind: action.kind, path: action.path, entryKey: action.entryKey, op: action.op };
    case 'exec':
      return {
        kind: action.kind,
        cmd: action.cmd,
        args: action.args,
        ...(action.whyNotUndone ? { whyNotUndone: action.whyNotUndone } : {}),
      };
    case 'write-foreign-registry':
      return { kind: action.kind, path: action.path, entryKey: action.entryKey, op: action.op };
  }
}

function describeOp(op: 'add' | 'update', entryKey: string): string {
  return op === 'add' ? `add entry ${entryKey}` : `update entry ${entryKey}`;
}
