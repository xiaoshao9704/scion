import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson, backupFile } from './atomic.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { Finding } from '../ir/types.js';
import type { MarketplaceEntryIR } from '../marketplace/types.js';
import { projectEntry } from '../marketplace/project.js';

/**
 * 这次安装实际用哪个市场名，以及它对应的根目录。两个 installer 共用这一份，
 * 免得 codex 和 kimi 各自决定一次「叫什么」——两边算出不同名字的话，同一个插件在
 * 两个生态里会挂在不同市场下，而这种漂移不会有任何报错。
 *
 * 来自市场的插件用它官方的市场名；其余回落到 profile 声明的兜底名。
 */
export function marketPlacement(
  home: string,
  strategy: { marketplaceName: string; marketplaceRoot: string },
  marketName: string | undefined,
): { name: string; root: string } {
  const name = marketName ?? strategy.marketplaceName;
  return { name, root: join(home, strategy.marketplaceRoot.replace('<market>', name)) };
}

/** catalog 的绝对路径。dialect 的候选路径按优先级排，写入端只认第一个。 */
export function catalogPathFor(marketplaceRoot: string, target: EcosystemProfile): string {
  return join(marketplaceRoot, target.marketplaceDialect.catalogPaths[0]);
}

/**
 * 读 → 解析 → 校验，不写任何东西；文件真正不存在（ENOENT）返回 null。
 * 损坏或截断的 catalog 在这里就抛错，而不是被静默地当成"从未装过任何插件"，
 * 用一份只有当前这条记录的新文件整体覆盖掉——那样会让之前登记过的所有插件从
 * catalog 里悄悄消失。与 install/kimi.ts 对 Kimi 注册表、install/state.ts 对
 * scion 账本的处理保持同一纪律。
 *
 * preview 与 upsertMarketplaceEntry 共用这一份读取器：preview 靠它判断条目是新增
 * 还是更新，写入端仍会自己再读一次真实文件（两次之间文件可能已变），损坏检查因此
 * 两处都在，且报错措辞天然一致。
 */
export async function readCatalog(
  abs: string,
  target: EcosystemProfile,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${abs} is not a readable ${target.id} marketplace manifest (not valid JSON). Inspect it or move it aside, then retry.`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    ('plugins' in parsed && !Array.isArray((parsed as { plugins: unknown }).plugins))
  ) {
    throw new Error(
      `${abs} is not a readable ${target.id} marketplace manifest (unexpected structure). Inspect it or move it aside, then retry.`,
    );
  }

  const file = parsed as Record<string, unknown>;
  if (!Array.isArray(file.plugins)) file.plugins = [];
  return file;
}

/** preview 用：这条 upsert 落下去究竟是新增还是更新。零副作用。 */
export async function catalogEntryOp(
  marketplaceRoot: string,
  target: EcosystemProfile,
  entryName: string,
): Promise<'add' | 'update'> {
  const file = await readCatalog(catalogPathFor(marketplaceRoot, target), target);
  if (file === null) return 'add';
  const plugins = file.plugins as Record<string, unknown>[];
  return plugins.some((p) => p[target.marketplaceDialect.entryKeyField] === entryName)
    ? 'update'
    : 'add';
}

/**
 * 按 target 的 marketplaceDialect 泛化，同一份实现服务于 codex（对象形态 source，
 * 键名 name）和 kimi（字符串形态 source，键名 id）两种 catalog 格式——条目形状本身
 * 复用 marketplace/project.ts 的 projectEntry()，不重新实现一遍字段映射规则。
 */
/**
 * 从 pluginRoot 反推这次安装挂在哪个市场名下。安装时的布局是
 * `<home>/.scion/markets/<market>/<target>/plugins/<name>`；不匹配（比如账本被手工
 * 改过）返回 null，调用方按"不知道市场"处理，不要瞎猜。
 */
export function marketNameFromPluginRoot(home: string, pluginRoot: string): string | null {
  const prefix = join(home, '.scion', 'markets') + '/';
  if (!pluginRoot.startsWith(prefix)) return null;
  const [market] = pluginRoot.slice(prefix.length).split('/');
  return market || null;
}

/** 从 catalog 删一个条目；catalog 不存在或条目不在时不写任何东西 */
export async function removeMarketplaceEntry(
  marketplaceRoot: string,
  target: EcosystemProfile,
  name: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const abs = catalogPathFor(marketplaceRoot, target);
  const existing = await readCatalog(abs, target);
  if (existing === null) return false;
  const key = target.marketplaceDialect.entryKeyField;
  const plugins = existing.plugins;
  if (!Array.isArray(plugins)) return false;
  const next = plugins.filter((p) => (p as Record<string, unknown>)[key] !== name);
  if (next.length === plugins.length) return false;
  existing.plugins = next;
  await backupFile(abs, now().toISOString().replace(/[:.]/g, '-'));
  await atomicWriteJson(abs, existing);
  return true;
}

export async function upsertMarketplaceEntry(
  marketplaceRoot: string,
  marketplaceName: string,
  target: EcosystemProfile,
  entry: { name: string; category?: string },
  now: () => Date = () => new Date(),
): Promise<void> {
  const dialect = target.marketplaceDialect;
  const abs = catalogPathFor(marketplaceRoot, target);

  const existing = await readCatalog(abs, target);
  let file: Record<string, unknown>;
  if (existing === null) {
    // 真正不存在：首次安装，没有旧内容需要保留或备份。
    file = {};
    if (dialect.nameField) file[dialect.nameField] = marketplaceName;
    if (dialect.ownerField === 'interface') file.interface = { displayName: 'Scion' };
    else if (dialect.ownerField === 'owner') file.owner = { name: marketplaceName };
    file.plugins = [];
  } else {
    file = existing;
  }

  const entryIR: MarketplaceEntryIR = {
    name: entry.name,
    source: { kind: 'local', path: `./plugins/${entry.name}` },
    category: entry.category,
  };
  // 安装时的条目永远是本地 source，projectEntry() 不会为它产生 findings（那只在
  // git-subdir 被压扁成字符串形态时发生），丢弃即可。
  const next = projectEntry(entryIR, target, [] as Finding[]);

  const plugins = file.plugins as Record<string, unknown>[];
  const index = plugins.findIndex((p) => p[dialect.entryKeyField] === entry.name);
  if (index >= 0) plugins[index] = next;
  else plugins.push(next);

  await mkdir(dirname(abs), { recursive: true });
  if (existing !== null) {
    // 已有一份校验通过的 catalog，覆盖前先备份；文件本就不存在时无需备份。
    await backupFile(abs, now().toISOString().replace(/[:.]/g, '-'));
  }
  await atomicWriteJson(abs, file);
}
