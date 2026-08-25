import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliIo } from '../cli.js';
import type { EcosystemId } from '../ir/types.js';
import { execRunner, runOrThrow, type Runner } from '../install/exec.js';
import { marketNameFromPluginRoot, removeMarketplaceEntry } from '../install/marketplace.js';
import { removeFromKimiRegistry } from '../install/kimi.js';
import { readState, removeInstall, type InstallRecord } from '../install/state.js';
import { loadProfile } from '../profiles/loader.js';
import { writeResult, usageError } from '../output/result.js';

export async function runUninstall(
  argv: string[],
  io: CliIo,
  deps: { home?: string; run?: Runner } = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const run = deps.run ?? execRunner;
  const json = argv.includes('--json');

  const positional = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--to');
  const name = positional[0];
  if (!name) {
    return writeResult(io, json, usageError('uninstall', 'usage: scion uninstall <name> [--to codex,kimi]'));
  }

  const toIndex = argv.indexOf('--to');
  const targets =
    toIndex >= 0 && argv[toIndex + 1] ? (argv[toIndex + 1].split(',') as EcosystemId[]) : null;

  const records = (await readState(home)).filter(
    (r) => r.name === name && (targets === null || targets.includes(r.target)),
  );
  if (records.length === 0) {
    const known = [...new Set((await readState(home)).map((r) => r.name))];
    return writeResult(
      io,
      json,
      usageError(
        'uninstall',
        `scion has not installed '${name}'${targets ? ` for ${targets.join(', ')}` : ''}.` +
          (known.length > 0 ? ` Installed plugins: ${known.join(', ')}` : ' Nothing is installed.'),
      ),
    );
  }

  const lines: string[] = [];
  for (const record of records) {
    lines.push(...(await uninstallRecord(record, home, run)));
    await removeInstall(home, record.name, record.target);
    lines.push(`${record.name} → ${record.target}: removed from the scion ledger`);
  }

  const human = lines.map((l) => `${l}\n`).join('');
  return writeResult(io, json, {
    command: 'uninstall',
    exitCode: 0,
    human,
    json: { removed: records.map((r) => ({ name: r.name, target: r.target })) },
  });
}

/** 目标端逆操作：注销（codex CLI / Kimi 注册表）→ 摘 catalog 条目 → 删产物目录 */
async function uninstallRecord(record: InstallRecord, home: string, run: Runner): Promise<string[]> {
  const lines: string[] = [];
  const profile = loadProfile(record.target);
  const market = marketNameFromPluginRoot(home, record.pluginRoot);

  if (record.target === 'codex' && market) {
    try {
      await runOrThrow(run, 'codex', ['plugin', 'remove', `${record.name}@${market}`]);
      lines.push(`${record.name} → codex: ran codex plugin remove ${record.name}@${market}`);
    } catch (err) {
      // 目标端可能早被 `codex plugin remove` 手动清掉了（这正是账本漂移的来源）；
      // 注销失败不该拦住其余清理，如实说一句继续。
      lines.push(
        `${record.name} → codex: codex plugin remove failed (already removed by hand?): ${(err as Error).message.split('\n')[0]}; continuing cleanup`,
      );
    }
  }

  if (record.target === 'kimi' && record.registered) {
    const strategy = profile.install.strategy;
    if (strategy.kind === 'kimi-managed') {
      const registryPath = join(home, strategy.registryPath);
      const removed = await removeFromKimiRegistry(registryPath, record.name);
      lines.push(
        removed
          ? `${record.name} → kimi: removed from ${registryPath} (the existing file was backed up first)`
          : `${record.name} → kimi: not present in ${registryPath} (already removed by hand?)`,
      );
    }
  }

  // 产物目录只有确实是 scion 自己的市场布局才删；账本被改过指向别处时，宁可留着
  const scionRoot = join(home, '.scion') + '/';
  if (record.pluginRoot.startsWith(scionRoot)) {
    if (market) {
      // marketplaceRoot 是 pluginRoot 往上两级（<root>/plugins/<name>）
      const marketplaceRoot = dirname(dirname(record.pluginRoot));
      const removedEntry = await removeMarketplaceEntry(marketplaceRoot, profile, record.name);
      if (removedEntry) {
        lines.push(`${record.name} → ${record.target}: removed the ${market} catalog entry`);
      }
    }
    await rm(record.pluginRoot, { recursive: true, force: true });
    lines.push(`${record.name} → ${record.target}: deleted ${record.pluginRoot}`);
  } else {
    lines.push(
      `${record.name} → ${record.target}: ${record.pluginRoot} is outside ~/.scion and was left in place`,
    );
  }

  return lines;
}
