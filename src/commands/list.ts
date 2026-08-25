import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { marketNameFromPluginRoot } from '../install/marketplace.js';
import { readState, type InstallRecord } from '../install/state.js';
import { writeResult, type CommandResult } from '../output/result.js';

export async function runList(
  argv: string[],
  io: CliIo,
  deps: { home?: string } = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const records = await readState(home);
  const missing = await Promise.all(records.map((r) => missingOnTarget(r, home)));
  return writeResult(io, argv.includes('--json'), listResult(records, missing));
}

/**
 * 账本说 registered，但目标端自己的注册表里已经没有它了——典型来源是用户直接用
 * `codex plugin remove` 或在 Kimi 里删掉了插件。账本不因此改写（改写要 uninstall
 * 明说），list 的职责是把漂移指出来。
 */
async function missingOnTarget(record: InstallRecord, home: string): Promise<boolean> {
  if (!record.registered) return false;

  if (record.target === 'codex') {
    const market = marketNameFromPluginRoot(home, record.pluginRoot);
    if (!market) return false;
    const config = await readTextOrNull(join(home, '.codex', 'config.toml'));
    // codex CLI 写注册项的形状是固定的一行 section 头
    return config === null || !config.includes(`[plugins."${record.name}@${market}"]`);
  }

  if (record.target === 'kimi') {
    const raw = await readTextOrNull(join(home, '.kimi-code', 'plugins', 'installed.json'));
    if (raw === null) return true;
    try {
      const parsed = JSON.parse(raw) as { plugins?: Array<{ id?: unknown }> };
      return !parsed.plugins?.some((p) => p.id === record.name);
    } catch {
      // 注册表读不懂时不指控漂移；uninstall / install 碰到它会用完整的报错说清楚
      return false;
    }
  }

  return false;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** 账本本来就是数据，JSON 一侧原样给出；人读一侧是它的排版。 */
function listResult(records: InstallRecord[], missing: boolean[]): CommandResult {
  const human =
    records.length === 0
      ? 'No plugins installed through scion yet.\n'
      : records
          .map((r, i) => {
            const state = missing[i]
              ? `registered in the ledger, but gone on ${r.target} — scion uninstall ${r.name} cleans this up`
              : r.registered
                ? 'registered'
                : 'not registered';
            return (
              `${r.name}${r.version ? `@${r.version}` : ''}  →  ${r.target}  [${state}]\n` +
              `  source:  ${r.source} (${r.sourceKind})\n` +
              `  root:    ${r.pluginRoot}\n` +
              `  updated: ${r.updatedAt}\n`
            );
          })
          .join('');

  return {
    command: 'list',
    exitCode: 0,
    human,
    json: { plugins: records.map((r, i) => (missing[i] ? { ...r, missingOnTarget: true } : r)) },
  };
}
