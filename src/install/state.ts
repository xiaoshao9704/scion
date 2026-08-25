import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemId } from '../ir/types.js';
import { atomicWriteJson, backupFile } from './atomic.js';

export interface InstallRecord {
  name: string;
  version?: string;
  target: EcosystemId;
  source: string;
  sourceKind: 'path' | 'zip' | 'git';
  pluginRoot: string;
  registered: boolean;
  /**
   * 这个插件的环境变量改名（旧名 → 新名），用户用 --env-name 点的名。
   *
   * 记在账本里而不是只活在那一次命令行里，是因为改名是**插件维度**的一件长期事实：
   * 用户按新名字在 rc 文件里写了 export，之后 `scion sync` 重新转换安装时若不带上
   * 同一份映射，产物会悄悄退回作者的原名，那行 export 就再也没人读——插件不报错，
   * 只是 MCP 连不上。没改过名的插件不写这个字段。
   */
  envNames?: Record<string, string>;
  installedAt: string;
  updatedAt: string;
}

interface StateFile {
  version: number;
  installs: InstallRecord[];
}

function statePath(home: string): string {
  return join(home, '.scion', 'installed.json');
}

/** 读原始文件内容；文件不存在时返回 null，其它读错误直接抛出 */
async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 解析并校验账本内容。这本账本是 scion 唯一知道自己装过什么的地方——正因为
 * scion 从不解析别的工具的配置文件去重建它，一旦损坏就再也找不回来。所以
 * 宁可在这里抛错，也不把损坏或形状不对的内容当成"没装过任何东西"悄悄吞掉
 * （那样下一次 recordInstall 会直接用一条新记录整体覆盖，历史全丢）。
 * 顶层值本身是数组时 typeof 仍是 'object'，必须单独排除，否则会被当成合法
 * 账本放行（Task 19 在 Kimi 注册表上踩过这同一个坑）。
 */
function parseState(raw: string, path: string): InstallRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not a readable scion install ledger (not valid JSON). Inspect it or move it aside, then retry.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a readable scion install ledger (unexpected structure). Inspect it or move it aside, then retry.`,
    );
  }
  const installs = (parsed as StateFile).installs;
  if (installs !== undefined && !Array.isArray(installs)) {
    throw new Error(
      `${path} is not a readable scion install ledger (unexpected structure). Inspect it or move it aside, then retry.`,
    );
  }
  return installs ?? [];
}

export async function readState(home: string): Promise<InstallRecord[]> {
  const path = statePath(home);
  const raw = await readRaw(path);
  if (raw === null) return [];
  return parseState(raw, path);
}

/** 从账本移除一条记录；账本不存在或记录不在时不写任何东西，返回是否真的移除了 */
export async function removeInstall(
  home: string,
  name: string,
  target: EcosystemId,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const path = statePath(home);
  const raw = await readRaw(path);
  if (raw === null) return false;
  const installs = parseState(raw, path);
  const next = installs.filter((r) => !(r.name === name && r.target === target));
  if (next.length === installs.length) return false;
  await backupFile(path, now().toISOString().replace(/[:.]/g, '-'));
  await atomicWriteJson(path, { version: 1, installs: next });
  return true;
}

export async function recordInstall(
  home: string,
  record: Omit<InstallRecord, 'installedAt' | 'updatedAt'>,
  now: () => Date = () => new Date(),
): Promise<void> {
  const path = statePath(home);
  const raw = await readRaw(path);
  // 校验先于任何写入：损坏的账本会在这里抛出，而不是被下面的写入静默替换掉。
  const installs = raw === null ? [] : parseState(raw, path);

  const iso = now().toISOString();
  const index = installs.findIndex((r) => r.name === record.name && r.target === record.target);
  const previous = index >= 0 ? installs[index] : undefined;
  const next: InstallRecord = {
    ...record,
    installedAt: previous?.installedAt ?? iso,
    updatedAt: iso,
  };
  if (index >= 0) installs[index] = next;
  else installs.push(next);

  if (raw !== null) {
    // 已有一份校验通过的账本，覆盖前先备份，和 installToKimi 对 Kimi 注册表
    // 的处理保持同一纪律；文件本就不存在时无需备份。
    await backupFile(path, iso.replace(/[:.]/g, '-'));
  }
  await atomicWriteJson(path, { version: 1, installs });
}
