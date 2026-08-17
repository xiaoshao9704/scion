import { parseArgs } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdtemp, readdir } from 'node:fs/promises';
import type { CliIo } from '../cli.js';
import { normalize } from '../normalize/index.js';
import { loadProfile } from '../profiles/loader.js';
import { projectAll } from '../project/index.js';
import { emit } from '../emit/write.js';
import { doctor, worstLevel } from '../doctor/index.js';
import { formatFindings } from '../doctor/report.js';
import { parseEcosystem } from './doctor.js';
import { parseEnvNames } from '../mcp/env-flag.js';

export async function assertSafeOutDir(dir: string): Promise<void> {
  const scionRoot = join(homedir(), '.scion');
  const resolved = resolve(dir);
  if (resolved === scionRoot || resolved.startsWith(scionRoot + sep)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // 不存在 → 安全
    throw err;
  }
  if (entries.length > 0) {
    throw new Error(
      `refusing to overwrite non-empty directory ${dir}; pass an empty path or omit -o to write to a fresh temp directory`,
    );
  }
}

export async function runConvert(argv: string[], io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      from: { type: 'string', default: 'claude' },
      out: { type: 'string', short: 'o' },
      'keep-env-names': { type: 'boolean', default: false },
      'env-name': { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });

  const dir = positionals[0];
  if (!dir || !values.to) {
    io.write(
      'usage: scion convert <dir> --to kimi|codex [-o <dir>] [--from claude] [--keep-env-names] [--env-name OLD=NEW]\n',
    );
    return 1;
  }

  const source = loadProfile(parseEcosystem(values.from as string));
  const target = loadProfile(parseEcosystem(values.to));
  const ir = await normalize(dir, source);

  const projection = {
    keepEnvNames: values['keep-env-names'] as boolean,
    envNames: parseEnvNames(values['env-name'] as string[] | undefined),
  };
  const findings = await doctor(ir, target, projection);
  io.write(formatFindings(findings));
  if (worstLevel(findings) === 'BLOCK') {
    io.write('BLOCK findings present; conversion aborted.\n');
    return 2;
  }

  let outDir: string;
  let ephemeral = false;
  if (values.out) {
    outDir = values.out;
    await assertSafeOutDir(outDir);
  } else {
    // 不给 -o 时，产物只写到一个全新的 OS 临时目录——scion 自己不再维护任何"输出仓库"目录。
    // 用完即弃的预览就该长在系统真正管理临时文件的地方，而不是某个没人清理、也没人知道
    // 它存在的角落。mkdtemp 保证目录全新且唯一，不需要再查是否安全。
    outDir = await mkdtemp(join(tmpdir(), 'scion-convert-'));
    ephemeral = true;
  }

  const written = await emit(ir, await projectAll(ir, target, projection), outDir, outDir);

  if (ephemeral) {
    io.write(
      `Wrote ${written.length} ${written.length === 1 ? 'file' : 'files'} to a temp directory: ${outDir}\n` +
        'This is the operating system temp directory: it cleans it up on its own, so the output will not stick around. ' +
        'To keep this output, re-run with -o <dir>.\n',
    );
  } else {
    io.write(
      `Wrote ${written.length} ${written.length === 1 ? 'file' : 'files'} to ${outDir}\n`,
    );
  }
  return 0;
}
