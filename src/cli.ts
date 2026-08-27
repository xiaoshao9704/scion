#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runDoctor } from './commands/doctor.js';
import { runConvert } from './commands/convert.js';
import { runInstall } from './commands/install.js';
import { runUninstall } from './commands/uninstall.js';
import { runList } from './commands/list.js';
import { runSync } from './commands/sync.js';
import { runMarket } from './commands/market.js';
import { runRepo } from './commands/repo.js';
import { runtimeError, usageError, writeResult } from './output/result.js';

export interface CliIo {
  write: (s: string) => void;
}

const COMMANDS = ['install', 'uninstall', 'convert', 'doctor', 'list', 'sync', 'market', 'repo'] as const;

function isCommand(s: string): s is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly string[]).includes(s);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [first] = argv;
  const json = argv.includes('--json');

  if (first === '--version' || first === '-v') {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
    io.write(`${pkg.version}\n`);
    return 0;
  }

  if (!first || first === '--help' || first === '-h') {
    io.write(usage());
    return first ? 0 : 1;
  }

  if (!isCommand(first)) {
    return writeResult(io, json, usageError('scion', `scion: unknown command '${first}'\n\n${usage()}`));
  }

  const rest = argv.slice(1);
  try {
    switch (first) {
      case 'install':
        return await runInstall(rest, io);
      case 'uninstall':
        return await runUninstall(rest, io);
      case 'doctor':
        return await runDoctor(rest, io);
      case 'convert':
        return await runConvert(rest, io);
      case 'list':
        return await runList(rest, io);
      case 'sync':
        return await runSync(rest, io);
      case 'market':
        return await runMarket(rest, io);
      case 'repo':
        return await runRepo(rest, io);
    }
  } catch (err) {
    // --json 下 stdout 必须是合法 JSON，而空 stdout 不是：抛到顶层的错误（源解析失败、
    // 目录不存在……）照样得给 agent 一个它 parse 得动的东西。不带 --json 时行为不变，
    // 错误继续往上抛，由入口打到 stderr。
    if (!json) throw err;
    return writeResult(io, json, runtimeError(first, err));
  }
}

function usage(): string {
  return [
    'Usage: scion <command> [options]',
    '',
    '  install <github|path|zip> --to codex,kimi   fetch → convert → install → write registry',
    '  install <plugin>@<marketplace> --to kimi    same, for one entry of a marketplace you have',
    '    [--dry-run]                               preview the actions only; change nothing',
    '  uninstall <name> [--to codex,kimi]          undo an install: deregister, drop files, forget',
    '  convert <dir> --to kimi [-o <dir>]          convert only, do not install',
    '  doctor <dir> [--to kimi]                    compatibility report',
    '  list                                        installed plugins',
    '  sync [<name>]                               re-convert and reinstall after upstream changes',
    '  repo <dir> --to codex,kimi [--check]        write target manifests into the plugin repo itself',
    '  market convert <dir> --to kimi|codex        convert a whole marketplace (registers nothing)',
    '  market show <dir>                           show a marketplace overview',
    '',
    '  --json  machine-readable output on doctor, install --dry-run, list and market',
    '',
  ].join('\n');
}

// argv[1] 要先解到真实路径再比：npm 安装出来的 `bin/scion` 是一个指向本文件的符号链接，
// 拿链接路径去比永远不相等，main 块不执行，CLI 静默退出 0 —— 装完就是个哑巴。
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  runCli(process.argv.slice(2), { write: (s) => process.stdout.write(s) })
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => {
      process.stderr.write(`scion: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
