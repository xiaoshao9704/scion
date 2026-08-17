import type { EcosystemId } from '../ir/types.js';
import type { InstallPlan } from './plan.js';

export interface InstallOutcome {
  target: EcosystemId;
  /** 转换产物落地的目录 */
  pluginRoot: string;
  /** 实际执行的 plan。要查外部命令就 filter kind === 'exec'，不再单独存一份 */
  plan: InstallPlan;
  /** 是否已在目标生态完成注册 */
  registered: boolean;
  /** 未注册时给用户的下一步指引 */
  note?: string;
  /**
   * 安装成功了，但现场有没收拾干净的地方（例如删不掉的临时备份目录）。空数组表示
   * 干干净净。不并进 note：note 讲的是「接下来该做什么」，这些讲的是「机器留下了什么」，
   * 混在一起会让本来就该显眼的残留被当成操作指引的一部分读过去。
   */
  warnings: string[];
}
