import { homedir } from 'node:os';
import type { CliIo } from '../cli.js';
import { readState, type InstallRecord } from '../install/state.js';
import { runInstall, type InstallDeps } from './install.js';

export async function runSync(
  argv: string[],
  io: CliIo,
  deps: InstallDeps = {},
): Promise<number> {
  const home = deps.home ?? homedir();
  const only = argv[0];
  const records = (await readState(home)).filter((r) => !only || r.name === only);

  if (records.length === 0) {
    io.write(only ? `No installed plugin named ${only}.\n` : 'Nothing to sync.\n');
    return only ? 1 : 0;
  }

  // 同一来源、同一 registered 状态的多个目标合并成一次 install，避免重复拉取。
  // 按 (source, registered) 分组而不是只按 source：同一来源装到 codex（总是
  // registered:true）和 kimi（默认 registered:false）时，若只按 source 合并，
  // 组内 registered 状态不一致，group.some(...) 会让整组都带上
  // --write-registry ——把用户从未选过的 Kimi 注册表写入静默打开。拆成两次
  // install，一次这个 flag，一次不带，牺牲的只是 group 内再拉一次源（sync
  // 不是热路径，正确性优先）。
  const bySourceAndRegistered = new Map<string, InstallRecord[]>();
  for (const r of records) {
    const key = `${r.source} ${r.registered}`;
    const list = bySourceAndRegistered.get(key) ?? [];
    list.push(r);
    bySourceAndRegistered.set(key, list);
  }

  for (const group of bySourceAndRegistered.values()) {
    const source = group[0].source;
    const registered = group[0].registered;
    const targets = [...new Set(group.map((r) => r.target))].join(',');
    io.write(`Syncing ${group[0].name} (${source} → ${targets})\n`);
    const args = ['--to', targets, '--yes', ...(registered ? ['--write-registry'] : []), source];
    const code = await runInstall(args, io, { ...deps, home });
    if (code !== 0) return code;
  }
  return 0;
}
