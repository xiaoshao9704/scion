import { join } from 'node:path';
import type { PluginIR } from '../ir/types.js';
import { installSpec, loadProfile } from '../profiles/loader.js';
import { projectAll } from '../project/index.js';
import { planEmitFiles } from '../emit/write.js';
import { catalogEntryOp, catalogPathFor, marketPlacement } from './marketplace.js';
import { executePlan } from './apply.js';
import type { Runner } from './exec.js';
import type { InstallAction, InstallOpts, InstallPlan, Installer } from './plan.js';
import type { InstallOutcome } from './types.js';

export type { InstallOutcome } from './types.js';

export const codexInstaller: Installer = {
  target: 'codex',

  async preview(ir: PluginIR, opts: InstallOpts): Promise<InstallPlan> {
    const profile = loadProfile('codex');
    const strategy = installSpec(profile).strategy;
    if (strategy.kind !== 'codex-cli') throw new Error('codex profile must use the codex-cli strategy');

    const market = marketPlacement(opts.home, strategy, opts.marketName);
    const marketplaceRoot = market.root;
    const pluginsRoot = join(marketplaceRoot, 'plugins');
    const pluginRoot = join(pluginsRoot, ir.identity.name);

    // 投影在这里做一次，结果连同文件清单一起进 plan；execute 拿的就是这一份，
    // 不会为了写盘再投影一次——两次投影之间的任何差异都会让预览变成谎言。
    const projected = await projectAll(ir, profile, { envNames: opts.envNames });
    const files = await planEmitFiles(ir, projected);

    const actions: InstallAction[] = [
      {
        kind: 'write-tree',
        root: pluginRoot,
        containmentRoot: pluginsRoot,
        files,
        payload: { ir, projected },
      },
      {
        kind: 'upsert-catalog',
        path: catalogPathFor(marketplaceRoot, profile),
        entryKey: ir.identity.name,
        op: await catalogEntryOp(marketplaceRoot, profile, ir.identity.name),
        payload: {
          marketplaceRoot,
          marketplaceName: market.name,
          category: ir.presentation.category,
        },
      },
      {
        kind: 'exec',
        cmd: 'codex',
        args: ['plugin', 'marketplace', 'add', marketplaceRoot],
        whyNotUndone:
          `the ${market.name} marketplace is shared — other installed plugins still\ndepend on it, so undoing this would break them`,
      },
      {
        kind: 'exec',
        cmd: 'codex',
        args: ['plugin', 'add', `${ir.identity.name}@${market.name}`],
      },
    ];

    return { target: 'codex', pluginRoot, actions, registers: true };
  },

  async execute(plan: InstallPlan, opts: InstallOpts): Promise<InstallOutcome> {
    const profile = loadProfile('codex');
    const { warnings } = await executePlan(plan, {
      target: profile,
      run: opts.run,
      now: opts.now,
    });
    return {
      target: 'codex',
      pluginRoot: plan.pluginRoot,
      plan,
      registered: plan.registers,
      note: plan.note,
      warnings,
    };
  },
};

/** preview → execute 的直通封装，给不关心 plan 的调用方（单测、脚本）用 */
export async function installToCodex(
  ir: PluginIR,
  opts: { home: string; run?: Runner; now?: () => Date },
): Promise<InstallOutcome> {
  return codexInstaller.execute(await codexInstaller.preview(ir, opts), opts);
}
