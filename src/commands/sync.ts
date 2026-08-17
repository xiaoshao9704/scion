import { homedir } from 'node:os';
import type { CliIo } from '../cli.js';
import { readState, type InstallRecord } from '../install/state.js';
import { runInstall, type InstallDeps } from './install.js';

/** 一条记录里记着的改名，还原成 `--env-name OLD=NEW` 参数；没改过名就是空数组 */
function envNameArgs(record: InstallRecord): string[] {
  return Object.entries(record.envNames ?? {})
    .map(([previous, next]) => `${previous}=${next}`)
    .sort();
}

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
  // 分组键里还得带上环境变量映射：同一来源的两条记录若映射不同，合成一次 install 只能
  // 用其中一份，另一个目标就会被悄悄改回别的名字——正是 sync 最该避免的那种静默漂移。
  const bySourceAndRegistered = new Map<string, InstallRecord[]>();
  for (const r of records) {
    const key = `${r.source} ${r.registered} ${envNameArgs(r).join(' ')}`;
    const list = bySourceAndRegistered.get(key) ?? [];
    list.push(r);
    bySourceAndRegistered.set(key, list);
  }

  for (const group of bySourceAndRegistered.values()) {
    const source = group[0].source;
    const registered = group[0].registered;
    const targets = [...new Set(group.map((r) => r.target))].join(',');
    io.write(`Syncing ${group[0].name} (${source} → ${targets})\n`);
    // 重放这个插件当初点过的名。不带上，产物会退回作者的原名，而用户 rc 里那行
    // export 还写着新名字——插件不报错，只是 MCP 连不上。
    const args = [
      '--to',
      targets,
      '--yes',
      ...(registered ? ['--write-registry'] : []),
      ...envNameArgs(group[0]).flatMap((pair) => ['--env-name', pair]),
      source,
    ];
    const code = await runInstall(args, io, { ...deps, home });
    if (code !== 0) return code;
  }
  return 0;
}
