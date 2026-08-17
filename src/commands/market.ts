import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { CliIo } from '../cli.js';
import type { EcosystemId, Finding } from '../ir/types.js';
import type { MarketplaceIR } from '../marketplace/types.js';
import { ENTRY_SCOPED_BLOCK_CODES } from '../marketplace/types.js';
import type { Runner } from '../install/exec.js';
import { execRunner, runOrThrow } from '../install/exec.js';
import { loadProfile } from '../profiles/loader.js';
import { normalizeMarketplace } from '../marketplace/normalize.js';
import { emitMarketplace, projectMarketplace } from '../marketplace/project.js';
import { isSafePathSegment } from '../normalize/index.js';
import { formatFindings } from '../doctor/report.js';
import { parseEcosystem } from './doctor.js';
import { EnvNameError, parseEnvNamesByPlugin } from '../mcp/env-flag.js';
import { assertSafeOutDir } from './convert.js';
import { usageError, writeResult, type CommandResult } from '../output/result.js';

const USAGE = [
  'usage:',
  '  scion market convert <dir|json> --to codex|kimi [--from claude] [--as <name>] [-o <dir>]',
  '                                  [--env-name <plugin>:OLD=NEW] [--json]',
  '  scion market show <dir|json> [--from claude] [--json]',
  '',
].join('\n');

export interface MarketDeps {
  home?: string;
  run?: Runner;
}

/**
 * 到这里为止能出现的 BLOCK finding 一律是条目级的——目录级 BLOCK（catalog 名不安全、
 * 没有 plugins 数组、codex 名字冲突）在更早的地方各自单独中止了整个 run，从不会流到这里。
 * 按 where 的第一段（entry.name，或没有 name 时 normalizeMarketplace 给的 plugins[i]
 * 占位符）分组：emitMarketplace() 里 doctor() 产生的 BLOCK 会把 where 前缀成
 * "entry.name:原 where"，同一个条目可能有不止一条，要合并成一次排除来报告，不能按
 * finding 计数误报排除了更多条目。
 */
function summarizeExcludedEntries(findings: Finding[]): ExcludedEntry[] {
  const excluded = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.level !== 'BLOCK') continue;
    const key = f.where ? f.where.split(':')[0] : '(unknown entry)';
    const reasons = excluded.get(key) ?? [];
    reasons.push(f);
    excluded.set(key, reasons);
  }
  return [...excluded].map(([entry, reasons]) => ({ entry, findings: reasons }));
}

/** 例子最多举几个；剩下的在上面的 INCOMPLETE OUTPUT 清单里逐条都有，不必重复一遍 */
const MAX_ALTERNATIVE_EXAMPLES = 3;

/**
 * 「目标生态拉不到」这一类排除是有解的：按需一个个装进 scion 自己的市场。报告失败而不
 * 给出路，用户只会以为这些插件在目标生态里彻底没戏——而这正是 scion 存在的理由的反面。
 * 只对这一类排除给提示：名字不安全、转换失败那些换个命令也一样过不去。
 */
function unfetchableAlternatives(
  findings: Finding[],
  sourceMarketName: string,
  target: EcosystemId,
): string[] {
  const names = findings
    .filter((f) => f.code === 'marketplace.remote-entry-unfetchable')
    .map((f) => f.where ?? '')
    .filter((n) => n.length > 0);
  if (names.length === 0) return [];

  const examples = names.slice(0, MAX_ALTERNATIVE_EXAMPLES);
  const lines = [
    `${target} cannot fetch ${names.length === 1 ? 'that entry' : 'those entries'} itself, but scion can. ` +
      `Fetch and convert them one at a time into scion's own marketplace instead:`,
    ...examples.map((n) => `  scion install ${n}@${sourceMarketName} --to ${target}`),
  ];
  if (names.length > examples.length) {
    lines.push(
      `  … and ${names.length - examples.length} more, listed under INCOMPLETE OUTPUT above`,
    );
  }
  return lines;
}

/** 被排除的条目：agent 靠它知道哪些插件没转过去、以及为什么（退出码 4 的细节） */
interface ExcludedEntry {
  entry: string;
  findings: Finding[];
}

/** codex plugin marketplace list 的输出是两列；第一列（市场名）不含空格，按首个空白切分取第一列 */
function parseMarketplaceNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\S+)/);
    if (match) names.add(match[1]);
  }
  return names;
}

export async function runMarket(
  argv: string[],
  io: CliIo,
  deps: MarketDeps = {},
): Promise<number> {
  // 子命令的合法性在 parseArgs 之前就要判，那时 --json 还没被解析——所以直接看原始
  // argv。后面 options 里仍然登记 json，只是为了让 parseArgs 的严格模式放它过去。
  const json = argv.includes('--json');

  const [sub, ...rest] = argv;
  if (sub !== 'convert' && sub !== 'show') {
    return writeResult(io, json, usageError('market', USAGE));
  }

  const { positionals, values } = parseArgs({
    args: rest,
    options: {
      to: { type: 'string' },
      from: { type: 'string', default: 'claude' },
      as: { type: 'string' },
      out: { type: 'string', short: 'o' },
      'env-name': { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const target0 = positionals[0];
  if (!target0) return writeResult(io, json, usageError(`market ${sub}`, USAGE));

  const home = deps.home ?? homedir();
  const source = loadProfile(parseEcosystem(values.from as string));
  const mp = await normalizeMarketplace(target0, source);
  const marketName = mp.name ?? basename(resolve(mp.root));

  if (sub === 'show') return writeResult(io, json, showResult(mp, marketName, source.id));

  if (!values.to) return writeResult(io, json, usageError('market convert', USAGE));
  const targetProfile = loadProfile(parseEcosystem(values.to));

  // 改名只发生在转换时：不传 --as 时产物保持原名（模式 B，写回市场自己的仓库要求原名不变）；
  // 传 --as 时把新名字写进产物（模式 A，安装到消费者自己的注册表）。两种用法在同一件产物上互斥，
  // 所以只能在这里二选一，不能延后到注册时才决定。
  const requestedName = typeof values.as === 'string' ? values.as : undefined;

  // --as 是用户在命令行上直接给的值，不是清单里的数据——不满足约束是用法错误，不是产物问题。
  if (requestedName !== undefined && !isSafePathSegment(requestedName)) {
    return writeResult(
      io,
      json,
      usageError(
        'market convert',
        `--as value "${requestedName}" is not safe to use as a single path segment` +
          ' (it must not contain "/", "\\" or NUL, and must not be exactly "." or "..")',
      ),
    );
  }

  const effectiveName = requestedName ?? marketName;

  // marketName 在没有 --as 时会被直接拼进输出路径（见下面的 outDir）。它可能来自
  // catalog 里的 mp.name——一个从下载的 marketplace.json 里读出的、未经信任的字符串，
  // 不像 ir.identity.name 那样经过 normalize() 的 isSafePathSegment 校验。basename(mp.root)
  // 这条兜底路径始终安全，只有 mp.name truthy 时才需要查。
  if (!requestedName && mp.name && !isSafePathSegment(mp.name)) {
    const blockFinding: Finding = {
      level: 'BLOCK',
      code: 'marketplace.name-unsafe',
      message:
        `the catalog marketplace name "${mp.name}" is not safe to use as a single path segment (contains "/", "\\" or NUL, ` +
        'or is exactly "." / ".."); aborted. Pass --as <name> to supply a safe name',
      where: 'marketplace.name',
    };
    return writeResult(io, json, abortedResult([blockFinding]));
  }

  const mpForTarget: MarketplaceIR = requestedName ? { ...mp, name: requestedName } : mp;

  const preview = projectMarketplace(mpForTarget, targetProfile);
  // 只有作用域覆盖整个 catalog 的 BLOCK（如 catalog 里没有 plugins 数组）才中止整个 run。
  // 条目级的 BLOCK（ENTRY_SCOPED_BLOCK_CODES）只影响它自己那一个条目——已经在产生时被排除
  // 出 mp.entries，不该拖累其余能正常转换的条目。放行后，emitMarketplace() 照常产出，
  // 这些 BLOCK 连同其余 findings 会在下面完整报告出来。
  const catalogScopedBlock = preview.findings.some(
    (f) => f.level === 'BLOCK' && !ENTRY_SCOPED_BLOCK_CODES.has(f.code),
  );
  if (catalogScopedBlock) return writeResult(io, json, abortedResult(preview.findings));

  // 核对冲突的对象是「即将实际写进产物的那个名字」——不管它是源市场自带的名字还是 --as
  // 指定的新名字。检查的是目的地那个名字是否已被占用，--as 只是换了要检查哪个名字，
  // 不是免检的理由：用户往往正是因为撞了名才想到用 --as，这时候更不能跳过检查。
  let conflictFinding: Finding | null = null;
  if (targetProfile.id === 'codex') {
    const run = deps.run ?? execRunner;
    try {
      const stdout = await runOrThrow(run, 'codex', ['plugin', 'marketplace', 'list']);
      const registered = parseMarketplaceNames(stdout);
      if (registered.has(effectiveName)) {
        const blockFinding: Finding = {
          level: 'BLOCK',
          code: 'marketplace.name-conflict',
          message:
            `Codex already has a marketplace registered as "${effectiveName}". Codex keys config.toml by name, so ` +
            'registering the same name overwrites the existing entry. Convert under a name that is still free ' +
            '(pass --as <name>), or remove the existing registration first.',
          where: 'marketplace.name',
        };
        return writeResult(io, json, abortedResult([blockFinding]));
      }
    } catch (err) {
      // market convert 只产文件、不注册，核对不了冲突不该拦下转换——降级为 LOSS，照常产出。
      conflictFinding = {
        level: 'LOSS',
        code: 'marketplace.name-conflict-unchecked',
        message:
          `Cannot check which marketplace names Codex has registered (${(err as Error).message.split('\n')[0]}); ` +
          'skipped the conflict check and produced the files anyway.',
        where: 'marketplace.name',
      };
    }
  }

  const outDir = values.out ?? join(home, '.scion', 'markets', effectiveName, targetProfile.id);
  await assertSafeOutDir(outDir);
  let envNamesByPlugin: Map<string, Map<string, string>>;
  try {
    envNamesByPlugin = parseEnvNamesByPlugin(values['env-name'] as string[] | undefined);
  } catch (err) {
    if (!(err instanceof EnvNameError)) throw err;
    return writeResult(io, json, usageError('market', `${err.message}\n${USAGE}`));
  }

  const result = await emitMarketplace(mpForTarget, targetProfile, outDir, envNamesByPlugin);

  const findings = conflictFinding ? [conflictFinding, ...result.findings] : result.findings;
  const catalogAbs = join(outDir, result.catalogPath);
  const excluded = summarizeExcludedEntries(findings);

  return writeResult(
    io,
    json,
    convertResult({
      name: effectiveName,
      from: source.id,
      to: targetProfile.id,
      outDir,
      catalog: catalogAbs,
      converted: result.converted,
      excluded,
      findings,
      alternatives: unfetchableAlternatives(findings, marketName, targetProfile.id),
      next:
        targetProfile.id === 'codex'
          ? [
              `codex plugin marketplace add ${outDir}`,
              `Note: Codex keys config.toml by name. If a marketplace named "${effectiveName}" already exists, this command overwrites it.`,
            ]
          : [
              `KIMI_CODE_PLUGIN_MARKETPLACE_URL=${catalogAbs} kimi`,
              'or run /plugins <that path> inside Kimi',
            ],
    }),
  );
}

/** 整个 run 都没跑成的中止结果 */
function abortedResult(findings: Finding[]): CommandResult {
  return {
    command: 'market convert',
    exitCode: 2,
    human: `${formatFindings(findings)}BLOCK findings present; aborted.\n`,
    json: { aborted: true, findings },
  };
}

function showResult(mp: MarketplaceIR, name: string, from: EcosystemId): CommandResult {
  const lines = [
    `marketplace: ${name} (${from})\n`,
    `catalog: ${mp.catalogPath}\n`,
    `entries (${mp.entries.length}):\n`,
  ];
  for (const e of mp.entries) {
    const loc = e.source.kind === 'local' ? e.source.path : e.source.url;
    lines.push(`  · ${e.name}  [${e.source.kind}]  ${loc}\n`);
  }
  if (mp.issues.length > 0) lines.push(`\n${formatFindings(mp.issues)}`);

  return {
    command: 'market show',
    exitCode: 0,
    human: lines.join(''),
    json: {
      marketplace: { name, from, catalog: mp.catalogPath },
      entries: mp.entries,
      findings: mp.issues,
    },
  };
}

interface ConvertReport {
  name: string;
  from: EcosystemId;
  to: EcosystemId;
  outDir: string;
  catalog: string;
  converted: string[];
  excluded: ExcludedEntry[];
  findings: Finding[];
  /** 排除的条目里有出路的那一类，给出可行的替代命令；没有时是空数组 */
  alternatives: string[];
  next: string[];
}

function convertResult(r: ConvertReport): CommandResult {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const lines = [formatFindings(r.findings)];

  if (r.excluded.length > 0) {
    // 单靠上面的 BLOCK 分组不够醒目——用户很容易只扫最后一行摘要。这里单独起一段，
    // 明确写出"不完整"，逐条点名被排除的条目及原因，不能让人以为转换是完整成功的。
    lines.push(
      `INCOMPLETE OUTPUT: excluded ${count(r.excluded.length, 'entry', 'entries')}, not written to the catalog:\n`,
    );
    for (const e of r.excluded) {
      lines.push(`  · ${e.entry}: ${e.findings.map((f) => `[${f.code}] ${f.message}`).join('; ')}\n`);
    }
    lines.push('\n');
  }

  if (r.alternatives.length > 0) {
    lines.push(...r.alternatives.map((a) => `${a}\n`));
    lines.push('\n');
  }

  lines.push(
    `\n${r.name}: converted ${count(r.converted.length, 'plugin', 'plugins')}` +
      (r.excluded.length > 0
        ? `, excluded ${count(r.excluded.length, 'entry', 'entries')}`
        : '') +
      ` → ${r.outDir}\n` +
      `catalog: ${r.catalog}\n\n`,
  );
  lines.push('Next (scion does not register it for you):\n');
  lines.push(...r.next.map((n) => `  ${n}\n`));

  return {
    command: 'market convert',
    // 4：本次转换排除了至少一个条目——不是用法错误（1），没有中止（2 专指"整个 run 没跑"），
    // 也不是需要 --yes 确认才能继续的有损转换（3，market convert 根本没有 --yes 语义）。
    // 现有四个码里没有一个能表达"完成了，但不完整"；如果这里悄悄复用 0，就正是"静默降级"。
    exitCode: r.excluded.length > 0 ? 4 : 0,
    human: lines.join(''),
    json: {
      marketplace: { name: r.name, from: r.from, to: r.to, outDir: r.outDir, catalog: r.catalog },
      converted: r.converted,
      excluded: r.excluded,
      alternatives: r.alternatives,
      findings: r.findings,
      next: r.next,
    },
  };
}
