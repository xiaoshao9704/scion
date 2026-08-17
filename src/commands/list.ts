import { homedir } from 'node:os';
import type { CliIo } from '../cli.js';
import { readState, type InstallRecord } from '../install/state.js';
import { writeResult, type CommandResult } from '../output/result.js';

export async function runList(
  argv: string[],
  io: CliIo,
  deps: { home?: string } = {},
): Promise<number> {
  const records = await readState(deps.home ?? homedir());
  return writeResult(io, argv.includes('--json'), listResult(records));
}

/** 账本本来就是数据，JSON 一侧原样给出；人读一侧是它的排版。 */
function listResult(records: InstallRecord[]): CommandResult {
  const human =
    records.length === 0
      ? 'No plugins installed through scion yet.\n'
      : records
          .map(
            (r) =>
              `${r.name}${r.version ? `@${r.version}` : ''}  →  ${r.target}  ` +
              `[${r.registered ? 'registered' : 'not registered'}]\n` +
              `  source:  ${r.source} (${r.sourceKind})\n` +
              `  root:    ${r.pluginRoot}\n` +
              `  updated: ${r.updatedAt}\n`,
          )
          .join('');

  return { command: 'list', exitCode: 0, human, json: { plugins: records } };
}
