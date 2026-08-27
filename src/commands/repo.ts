import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CliIo } from '../cli.js';
import type { EcosystemProfile } from '../profiles/types.js';
import type { PluginIR } from '../ir/types.js';
import { normalize } from '../normalize/index.js';
import { loadProfile, requireOperation } from '../profiles/loader.js';
import { project } from '../project/index.js';
import { isInsideRoot } from '../emit/write.js';
import { doctor, worstLevel } from '../doctor/index.js';
import { formatFindings } from '../doctor/report.js';
import { parseEcosystem } from './doctor.js';
import { writeResult, usageError, type CommandResult } from '../output/result.js';

const USAGE =
  'usage: scion repo <dir> --to codex,kimi [--check] [--from claude] [--json]\n' +
  '  writes the target manifests into the plugin repo itself (author mode);\n' +
  '  --check writes nothing and fails when the committed manifests drift from what scion would generate\n';

interface RepoFile {
  /** 相对插件根 */
  path: string;
  content: string;
}

/**
 * 仓库内翻译（作者视角）：把目标生态的清单和派生文件写进插件仓库本身，替代作者
 * 手工维护的多份清单。与 convert 的关键差别：
 *
 * - 正文（skills / commands / agents）是各生态**共享**的，不改写——单个文件装不下
 *   两套 frontmatter。正文层面的转换损耗照常出现在报告里，作者据此改源头一处，
 *   所有生态受益。
 * - 只写清单 + 派生文件（hooks/codex-hooks.json 这类），git 就是备份，直接覆盖。
 */
export async function runRepo(argv: string[], io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      from: { type: 'string', default: 'claude' },
      check: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const dir = positionals[0];
  if (!dir || !values.to) return writeResult(io, values.json, usageError('repo', USAGE));

  const source = loadProfile(parseEcosystem(values.from as string));
  const targets = (values.to as string).split(',').map((t) => loadProfile(parseEcosystem(t)));
  for (const target of targets) requireOperation(target, 'in-repo');

  const ir = await normalize(dir, source);
  const root = resolve(dir);

  let block = false;
  const perTarget: Array<{
    target: EcosystemProfile;
    files: RepoFile[];
    findingsText: string;
  }> = [];

  for (const target of targets) {
    // findings 用完整投影（含正文层面的损耗，作者要看的正是这些）；
    // 落盘只取清单投影的产物——正文共享，不写副本。
    const { findings } = await doctor(ir, target, {});
    const findingsText = `${ir.identity.name} · ${source.id} → ${target.id} (in-repo)\n${formatFindings(findings)}`;
    if (worstLevel(findings) === 'BLOCK') {
      block = true;
      perTarget.push({ target, files: [], findingsText });
      continue;
    }
    perTarget.push({ target, files: repoFiles(ir, target), findingsText });
  }

  const human: string[] = perTarget.map((t) => t.findingsText);
  if (block) {
    human.push('BLOCK findings present; nothing was written.\n');
    return writeResult(io, values.json, result(values.check, 2, human, { blocked: true }));
  }

  if (values.check) {
    const drifted: string[] = [];
    for (const { files } of perTarget) {
      for (const f of files) {
        const existing = await readTextOrNull(join(root, f.path));
        if (existing !== f.content) drifted.push(f.path);
      }
    }
    if (drifted.length > 0) {
      human.push(
        `Drift: ${drifted.length} ${drifted.length === 1 ? 'file differs' : 'files differ'} from what scion would generate:\n` +
          drifted.map((p) => `  · ${p}\n`).join('') +
          `Run scion repo ${dir} --to ${values.to} to regenerate.\n`,
      );
      return writeResult(io, values.json, result(true, 6, human, { drifted }));
    }
    human.push('In sync: every generated manifest matches the repo.\n');
    return writeResult(io, values.json, result(true, 0, human, { drifted: [] }));
  }

  const written: string[] = [];
  for (const { files } of perTarget) {
    for (const f of files) {
      const abs = join(root, f.path);
      if (!isInsideRoot(root, abs)) throw new Error(`refusing to write outside the repo: ${f.path}`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, 'utf8');
      written.push(f.path);
    }
  }
  human.push(
    `Wrote ${written.length} ${written.length === 1 ? 'file' : 'files'} into ${dir}:\n` +
      written.map((p) => `  · ${p}\n`).join('') +
      'Shared bodies (skills / commands / agents) are untouched; commit these files so every ecosystem reads the same repo.\n',
  );
  return writeResult(io, values.json, result(false, 0, human, { written }));
}

/** 一个目标要落进仓库的文件集：清单本体 + 清单投影的派生文件 */
function repoFiles(ir: PluginIR, target: EcosystemProfile): RepoFile[] {
  const projected = project(ir, target);
  const files: RepoFile[] = [
    {
      path: projected.manifestPath,
      content: `${JSON.stringify(projected.manifest, null, 2)}\n`,
    },
  ];
  for (const f of projected.files) files.push({ path: f.path, content: f.content });
  return files;
}

function result(
  check: boolean,
  exitCode: number,
  human: string[],
  json: Record<string, unknown>,
): CommandResult {
  return {
    command: check ? 'repo --check' : 'repo',
    exitCode,
    human: human.join(''),
    json,
  };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
