import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginIR } from '../ir/types.js';
import { loadProfile } from '../profiles/loader.js';
import { projectAll } from '../project/index.js';
import { planEmitFiles } from '../emit/write.js';
import { atomicWriteJson, backupFile } from './atomic.js';
import { catalogEntryOp, catalogPathFor, marketPlacement } from './marketplace.js';
import { executePlan } from './apply.js';
import type { InstallAction, InstallOpts, InstallPlan, Installer } from './plan.js';
import type { InstallOutcome } from './types.js';

interface KimiRegistryEntry {
  id: string;
  root: string;
  source: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  originalSource: string;
}

interface KimiRegistry {
  version: number;
  plugins: KimiRegistryEntry[];
}

/** write-foreign-registry 的载荷：注册表条目里那些只有 ir 才知道的字段 */
interface KimiRegistryPayload {
  pluginRoot: string;
  originalSource: string;
}

/**
 * 读 → 解析 → 校验，不写任何东西；文件真正不存在（ENOENT）返回 null。
 * preview 与 execute 都调它：preview 靠它判断新增还是更新，并让损坏的注册表在
 * 还没落任何盘的时候就把安装拦下来；execute 仍要自己再读一次真实文件——preview
 * 与 execute 之间用户完全可能动过这个文件，「preview 查过了」不能替 execute 免检。
 */
async function readKimiRegistry(path: string): Promise<KimiRegistry | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not a readable Kimi plugin registry (not valid JSON). Inspect it or move it aside, then retry.`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    ('plugins' in parsed && !Array.isArray((parsed as { plugins: unknown }).plugins))
  ) {
    throw new Error(
      `${path} is not a readable Kimi plugin registry (unexpected structure). Inspect it or move it aside, then retry.`,
    );
  }

  const registry = parsed as KimiRegistry;
  if (!Array.isArray(registry.plugins)) registry.plugins = [];
  return registry;
}

/** 从 Kimi 注册表删掉一个插件条目；文件不存在或条目不在时不写任何东西 */
export async function removeFromKimiRegistry(
  registryPath: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const registry = await readKimiRegistry(registryPath);
  if (registry === null) return false;
  const next = registry.plugins.filter((p) => p.id !== id);
  if (next.length === registry.plugins.length) return false;
  await backupFile(registryPath, now().toISOString().replace(/[:.]/g, '-'));
  await atomicWriteJson(registryPath, { ...registry, plugins: next });
  return true;
}

export const kimiInstaller: Installer = {
  target: 'kimi',

  async preview(ir: PluginIR, opts: InstallOpts): Promise<InstallPlan> {
    const profile = loadProfile('kimi');
    const strategy = profile.install.strategy;
    if (strategy.kind !== 'kimi-managed') throw new Error('kimi profile must use the kimi-managed strategy');

    const projected = await projectAll(ir, profile, { envNames: opts.envNames });

    if (!opts.writeRegistry) {
      // 默认路径：落到 scion 维护的本地 marketplace，与 codex-cli 同一形状——只是 catalog
      // 是 Kimi 自己的格式（plugins[] 按 id 键，source 是字符串）。用户只需把 Kimi 指向这份
      // catalog 一次，以后每次 scion install 都会自动出现在这里，不必每次都给一个新路径。
      const market = marketPlacement(opts.home, strategy, opts.marketName);
      const marketplaceRoot = market.root;
      const pluginsRoot = join(marketplaceRoot, 'plugins');
      const pluginRoot = join(pluginsRoot, ir.identity.name);
      const catalogAbs = catalogPathFor(marketplaceRoot, profile);

      const actions: InstallAction[] = [
        {
          kind: 'write-tree',
          root: pluginRoot,
          containmentRoot: pluginsRoot,
          files: await planEmitFiles(ir, projected),
          payload: { ir, projected },
        },
        {
          kind: 'upsert-catalog',
          path: catalogAbs,
          entryKey: ir.identity.name,
          op: await catalogEntryOp(marketplaceRoot, profile, ir.identity.name),
          payload: {
            marketplaceRoot,
            marketplaceName: market.name,
            category: ir.presentation.category,
          },
        },
      ];

      return {
        target: 'kimi',
        pluginRoot,
        actions,
        registers: false,
        // 这段话曾经写着"设好一次，以后每次 scion install 都会自动出现在 Kimi 里"。
        // 实测（Kimi 0.36）不是这样：Kimi 在安装时把插件**整份复制**到
        // ~/.kimi-code/plugins/managed/<name>，之后就只读那份副本。所以再跑一次
        // scion install 只更新 scion 这边的目录，已经装好的那个插件仍是旧的——
        // 版本、技能、连 mcp 的环境变量名都停在上次安装的样子。
        // 「装好了但跑的是旧的」正是本项目要消灭的那类谎，宁可多说一句也不能省。
        note:
          `Kimi ships no plugin-management CLI. Point Kimi at the catalog scion maintains:\n` +
          `  KIMI_CODE_PLUGIN_MARKETPLACE_URL=${catalogAbs}\n` +
          `  or run /plugins ${catalogAbs} inside Kimi\n` +
          `New plugins appear in this catalog on their own. Updates do not: Kimi copies a plugin into\n` +
          `its own directory when you install it and reads only that copy, so re-running scion install\n` +
          `refreshes this catalog but leaves an already-installed plugin on its old version. Re-add it\n` +
          `in Kimi to pick up changes.`,
      };
    }

    // --write-registry 不是另一种转换，只是在同一份产物之上多做一步登记：产物仍然落在
    // scion 维护的市场里（市场来源的插件用它自己的官方市场名），注册表把 Kimi 指过去。
    //
    // 这条路径曾经把产物直接写进 Kimi 的 managed/ 目录，绕开市场。后果有两个，都真实
    // 发生过：一是同一个插件出现两份产物，一份在市场一份在 managed/，改了转换选项之后
    // 两份的环境变量名都能不一样；二是 Kimi 读的是自己那份副本，重跑 scion install
    // 更新不到它。让注册表直接指向市场产物就同时解决这两件事——只有一份，而且它就是
    // 每次转换更新的那一份。实测 Kimi 0.36 不要求 root 落在 managed/ 之内。
    const market = marketPlacement(opts.home, strategy, opts.marketName);
    const pluginsRoot = join(market.root, 'plugins');
    const pluginRoot = join(pluginsRoot, ir.identity.name);
    const registryPath = join(opts.home, strategy.registryPath);

    const registry = await readKimiRegistry(registryPath);
    // originalSource 记转换产物，而不是转换前的源目录：装进 Kimi 的是产物，
    // 指着源目录会让人以为 Kimi 读的是那儿。
    const payload: KimiRegistryPayload = { pluginRoot, originalSource: pluginRoot };

    const actions: InstallAction[] = [
      {
        kind: 'write-tree',
        root: pluginRoot,
        containmentRoot: pluginsRoot,
        files: await planEmitFiles(ir, projected),
        payload: { ir, projected },
      },
      {
        kind: 'upsert-catalog',
        path: catalogPathFor(market.root, profile),
        entryKey: ir.identity.name,
        op: await catalogEntryOp(market.root, profile, ir.identity.name),
        payload: {
          marketplaceRoot: market.root,
          marketplaceName: market.name,
          category: ir.presentation.category,
        },
      },
      {
        kind: 'write-foreign-registry',
        path: registryPath,
        entryKey: ir.identity.name,
        op: registry?.plugins.some((p) => p.id === ir.identity.name) ? 'update' : 'add',
        payload,
      },
    ];

    return {
      target: 'kimi',
      pluginRoot,
      actions,
      registers: true,
      // preview 为了校验已经读过这个文件，所以它知道存不存在，也就知道会不会产生
      // 备份——没有理由让 dry-run 的用户看不到「重启 Kimi 会话后生效」这句。措辞按
      // preview 当下已知的事实写；preview 与 execute 之间文件恰好被删/被建这种竞态
      // 下会不准，但那只影响一句提示的措辞，不值得为它加锁或复查。
      note:
        (registry
          ? `Will write ${registryPath} (the existing file is backed up first).`
          : `Will write ${registryPath} (first write, no backup needed).`) +
        ` Kimi will read the plugin straight from ${pluginRoot}, so a later scion install updates it in place.` +
        ' Restart the Kimi session for it to take effect.',
    };
  },

  async execute(plan: InstallPlan, opts: InstallOpts): Promise<InstallOutcome> {
    const profile = loadProfile('kimi');
    const now = (opts.now ?? (() => new Date()))();

    // 注册表格式是 Kimi 私有的，applyAction 不认；但也不为它另写一遍遍历——用共用
    // 驱动的按 kind 覆盖钩子接管这一种，快照与回滚仍然只有那一份实现。
    const { note, warnings } = await executePlan(
      plan,
      { target: profile, run: opts.run, now: opts.now },
      {
        // 落盘后改用完成态措辞覆盖 plan 里那句预告（"将写入" → "已写入"），备份与否
        // 以真正落盘那一刻为准，而不是沿用 preview 当时的判断。
        'write-foreign-registry': (action) =>
          writeKimiRegistry(
            action as Extract<InstallAction, { kind: 'write-foreign-registry' }>,
            now,
          ),
      },
    );

    return {
      target: 'kimi',
      pluginRoot: plan.pluginRoot,
      plan,
      registered: plan.registers,
      note: note ?? plan.note,
      warnings,
    };
  },
};

/** 写 Kimi 自己的注册表，返回给用户的下一步说明 */
async function writeKimiRegistry(
  action: Extract<InstallAction, { kind: 'write-foreign-registry' }>,
  now: Date,
): Promise<string> {
  const { pluginRoot, originalSource } = action.payload as KimiRegistryPayload;
  const registry = (await readKimiRegistry(action.path)) ?? { version: 1, plugins: [] };

  const backupPath = await backupFile(action.path, now.toISOString().replace(/[:.]/g, '-'));

  const iso = now.toISOString();
  const index = registry.plugins.findIndex((p) => p.id === action.entryKey);
  const previous = index >= 0 ? registry.plugins[index] : undefined;
  const entry: KimiRegistryEntry = {
    id: action.entryKey,
    root: pluginRoot,
    source: 'local-path',
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? iso,
    updatedAt: iso,
    originalSource,
  };
  if (index >= 0) registry.plugins[index] = entry;
  else registry.plugins.push(entry);

  await atomicWriteJson(action.path, registry);

  return backupPath
    ? `Wrote ${action.path} (the previous file was backed up). Restart the Kimi session for it to take effect.`
    : `Wrote ${action.path}. Restart the Kimi session for it to take effect.`;
}

/** preview → execute 的直通封装，给不关心 plan 的调用方（单测、脚本）用 */
export async function installToKimi(
  ir: PluginIR,
  opts: { home: string; writeRegistry?: boolean; now?: () => Date },
): Promise<InstallOutcome> {
  return kimiInstaller.execute(await kimiInstaller.preview(ir, opts), opts);
}
