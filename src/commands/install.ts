import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import type { EcosystemId, Finding } from '../ir/types.js';
import type { Runner } from '../install/exec.js';
import { normalize, isSafePathSegment } from '../normalize/index.js';
import { loadProfile } from '../profiles/loader.js';
import { doctor, worstLevel } from '../doctor/index.js';
import { formatEnvVars, formatFindings } from '../doctor/report.js';
import {
  PinRejectedError,
  resolveSource,
  type GitPin,
  type ResolvedSource,
} from '../source/resolve.js';
import {
  entrySourceSpec,
  lookupMarketRef,
  parseMarketRef,
  type MarketRef,
  type MarketRefLookup,
} from '../source/market-ref.js';
import { isInsideRoot } from '../emit/write.js';
import { codexInstaller } from '../install/codex.js';
import { kimiInstaller } from '../install/kimi.js';
import { formatPlan, planToJson, type InstallPlan, type Installer } from '../install/plan.js';
import { InstallFailedError, formatInstallFailure } from '../install/rollback.js';
import { identityJson, parseEcosystem } from './doctor.js';
import { usageError, writeResult, type CommandResult } from '../output/result.js';
import { readState, recordInstall } from '../install/state.js';
import { EnvNameError, parseEnvNames } from '../mcp/env-flag.js';
import type { EnvVarUse } from '../mcp/env.js';

const USAGE =
  'usage: scion install <github|path|zip|<plugin>@<marketplace>> --to kimi[,codex] [--yes] [--write-registry] [--env-name OLD=NEW] [--dry-run [--json]]\n';

export interface InstallDeps {
  home?: string;
  run?: Runner;
}

/** 检查阶段的产物：每个目标一条，dry-run 时再挂上它的 plan */
interface TargetReport {
  target: EcosystemId;
  findings: Finding[];
  /** 这个插件要读哪些环境变量、各自被怎么处理了 */
  envVars: EnvVarUse[];
  plan?: InstallPlan;
}

/** 检查阶段在哪个目标上停下、为什么 */
interface Stop {
  target: EcosystemId;
  reason: 'block' | 'loss';
}

/** 源是 `<plugin>@<marketplace>` 时，这次安装到底从哪儿查到、拉了什么 */
interface MarketResolution {
  ref: string;
  plugin: string;
  market: string;
  catalog: string;
  source: string;
  sourceKind: ResolvedSource['kind'];
  notes: string[];
}

interface InstallReport {
  plugin: Record<string, unknown>;
  from: EcosystemId;
  dryRun: boolean;
  targets: TargetReport[];
  stoppedAt?: Stop;
  /** dry-run 专有：有 LOSS 但没给 --yes，预览照出，真装时还得补 --yes */
  needsYes: boolean;
  /** 这次没给 --env-name，沿用了账本里记着的映射（OLD=NEW 形态） */
  reusedEnvNames?: string[];
  via?: MarketResolution;
}

export async function runInstall(
  argv: string[],
  io: CliIo,
  deps: InstallDeps = {},
): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      from: { type: 'string', default: 'claude' },
      yes: { type: 'boolean', default: false },
      'write-registry': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'env-name': { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const dryRun = values['dry-run'] as boolean;
  const json = values.json as boolean;

  const spec = positionals[0];
  if (!spec || !values.to) return writeResult(io, json, usageError('install', USAGE));

  // 真装的过程是流式的（一个目标一个目标地落盘、注册、报告），塞进单个 JSON 会逼出
  // 「全跑完再一次性吐」的设计，与将来的进度输出打架。所以只有 --dry-run 支持 --json，
  // 而不是让 --json 悄悄退化成散文——那才是 agent 最难查的那种坏。
  if (json && !dryRun) {
    return writeResult(
      io,
      json,
      usageError(
        'install',
        `--json is only supported together with --dry-run; a real install streams its progress\n${USAGE}`,
      ),
    );
  }

  const home = deps.home ?? homedir();
  const targets = (values.to as string).split(',').map((t) => parseEcosystem(t.trim()));
  const source = loadProfile(parseEcosystem(values.from as string));

  // `<plugin>@<marketplace>` 只多做一步：从市场里把这个条目的 source 查出来，之后原样
  // 交给 resolveSource——它早就支持 path / zip / git，这里不另写一套拉取。
  const ref = parseMarketRef(spec);
  let resolveSpec = spec;
  let subdir: string | undefined;
  let pin: GitPin | undefined;
  let notes: string[] = [];
  let catalogPath: string | undefined;

  // 装市场里的条目就继续挂在那个市场名下；只有不来自市场的源才收编进 scion 自己的市场。
  let marketName: string | undefined;

  if (ref) {
    const lookup = await lookupMarketRef(ref, { home, profile: source });
    if (lookup.kind !== 'ok') return writeResult(io, json, marketRefError(ref, lookup, targets));

    // 市场名来自下载来的 catalog，会被直接拼进输出路径，和 market convert 那边同一个
    // 风险、同一条校验。名字不安全时不"清洗"也不悄悄换成 scion——换了名字装出来的东西
    // 就不再是用户要的那个市场里的插件了。
    marketName = lookup.marketplace.name ?? undefined;
    if (marketName !== undefined && !isSafePathSegment(marketName)) {
      return writeResult(io, json, unsafeMarketNameResult(marketName));
    }

    const entrySpec = entrySourceSpec(lookup.entry, lookup.marketplace);
    resolveSpec = entrySpec.spec;
    subdir = entrySpec.subdir;
    pin = entrySpec.pin;
    notes = entrySpec.notes;
    catalogPath = lookup.marketplace.catalogPath;
  }

  let resolved: ResolvedSource;
  try {
    resolved = await resolveSource(resolveSpec, { home, run: deps.run, pin });
  } catch (err) {
    // 拒绝一个 pin 是一条检查结论，不是一次崩溃：走 findings 那条通路报出去，agent 才能
    // 按 level/code 分支，而不是去解析异常堆栈。
    if (!(err instanceof PinRejectedError)) throw err;
    return writeResult(io, json, pinRejectedResult(err.finding));
  }

  // 拉取过程里的说明（例如浅取被拒、退成完整克隆）与 catalog 侧的说明同源同渲染，
  // 不另开一条输出路径。
  notes = [...notes, ...resolved.notes];

  // git-subdir 的子目录：仓库拉下来之后再往下走一层。子目录同样来自未经信任的 catalog，
  // 走出克隆目录就是拿别处的文件当插件装，先拦住。
  let pluginDir = resolved.dir;
  if (subdir) {
    pluginDir = join(resolved.dir, subdir.replace(/^\.\//, ''));
    if (!isInsideRoot(resolved.dir, pluginDir)) {
      throw new Error(
        `the catalog entry points at subdirectory "${subdir}", which resolves outside the fetched source ${resolved.dir}; refusing to read it`,
      );
    }
  }

  const ir = await normalize(pluginDir, source);

  const report: InstallReport = {
    plugin: identityJson(ir.identity),
    from: source.id,
    dryRun,
    targets: [],
    needsYes: false,
    ...(ref && catalogPath
      ? {
          via: {
            ref: spec,
            plugin: ref.plugin,
            market: ref.market,
            catalog: catalogPath,
            source: resolved.original,
            sourceKind: resolved.kind,
            notes,
          },
        }
      : {}),
  };

  // dry-run 遇到 LOSS 不停：什么都不做的预览没有需要用户承诺的损耗，把预览挡在
  // --yes 后面等于让用户为了看一眼先盲目同意。真正安装时仍然要 --yes，末尾补一行提醒。
  let envNames: Map<string, string>;
  try {
    envNames = parseEnvNames(values['env-name'] as string[] | undefined, ir.identity.name);
  } catch (err) {
    if (!(err instanceof EnvNameError)) throw err;
    return writeResult(io, json, usageError('install', `${err.message}\n${USAGE}`));
  }

  // 没点名就沿用这个插件上次装成时的映射。改名是插件维度的长期事实：用户照新名字写了
  // export，重装时若退回作者原名，那行 export 就再也没人读，而插件只会静默连不上。
  if (envNames.size === 0) {
    const recorded = await recordedEnvNames(home, ir.identity.name, targets);
    if (recorded.size > 0) {
      envNames = recorded;
      report.reusedEnvNames = [...recorded].map(([previous, next]) => `${previous}=${next}`);
    }
  }

  for (const target of targets) {
    const { findings, envVars } = await doctor(ir, loadProfile(target), { envNames });
    report.targets.push({ target, findings, envVars });

    const worst = worstLevel(findings);
    if (worst === 'BLOCK') {
      // 装不了就没有 plan 可言，dry-run 也一样不打印。
      report.stoppedAt = { target, reason: 'block' };
      break;
    }
    if (worst === 'LOSS' && !values.yes) {
      if (!dryRun) {
        report.stoppedAt = { target, reason: 'loss' };
        break;
      }
      report.needsYes = true;
    }
  }

  if (report.stoppedAt) return writeResult(io, json, installResult(report));

  const opts = {
    home,
    run: deps.run,
    writeRegistry: values['write-registry'] as boolean,
    envNames,
    marketName,
  };

  if (dryRun) {
    for (const t of report.targets) {
      t.plan = await installerFor(t.target).preview(ir, opts);
    }
    return writeResult(io, json, installResult(report));
  }

  // 真装：过程是流式的，收不进一个结果对象里。但检查阶段那段报告仍然从同一个结果对象
  // 渲染出来，免得「install 里的 findings 段」和「dry-run 里的 findings 段」各写一份。
  io.write(installResult(report).human);

  for (const target of targets) {
    const plan = await installerFor(target).preview(ir, opts);

    let outcome;
    try {
      outcome = await installerFor(target).execute(plan, opts);
    } catch (err) {
      if (!(err instanceof InstallFailedError)) throw err;
      // 失败的目标不进账本：账本记的是「装了什么」，回滚之后这个目标什么都没装。
      // 前面已经装成的目标是各自独立的完整安装，既不撤销，也不影响。
      // 重跑指引直接回放用户原本敲的那串参数——回滚已经把状态清干净了，原样重跑即可。
      io.write(`\n${formatInstallFailure(err, `scion install ${argv.join(' ')}`)}`);
      // 5 而不是 4：4 已经是 market convert 的「转换完成但排除了若干条目」，语义几乎相反，
      // 同一个码在两个子命令里一个表示基本成功一个表示彻底失败，正是最坑自动化的那种陷阱。
      // 也不复用 2：2 是「有 BLOCK，压根做不了」，而这里是「这次没成，但重跑可能成」——
      // 可重试性是调用方（尤其是 agent）最需要分辨的那一位信息。见 docs/exit-codes.md。
      return 5;
    }
    await recordInstall(home, {
      name: ir.identity.name,
      version: ir.identity.version,
      target,
      source: resolved.original,
      sourceKind: resolved.kind,
      pluginRoot: outcome.pluginRoot,
      registered: outcome.registered,
      ...(envNames.size > 0 ? { envNames: Object.fromEntries(envNames) } : {}),
    });
    io.write(
      `\n[${target}] ${outcome.registered ? 'installed' : 'converted'} → ${outcome.pluginRoot}\n`,
    );
    if (outcome.note) io.write(`${outcome.note}\n`);
    // 装成了但现场没收拾干净，也要说：宁可多一句，也不让用户以为一切都归位了
    for (const warning of outcome.warnings) io.write(`Note: ${warning}\n`);
  }

  return 0;
}

/**
 * 检查结果、预览 plan、以及「还差什么才能真装」这三件事的唯一措辞来源。
 * 人读文案与 JSON 在这里并排产出，谁也别想只在其中一边悄悄多说一句。
 */
function installResult(report: InstallReport): CommandResult {
  const lines: string[] = [];

  if (report.via) {
    lines.push(`\n${report.via.ref} → ${report.via.source} [${report.via.sourceKind}]\n`);
    lines.push(`  found in ${report.via.catalog}\n`);
    for (const note of report.via.notes) lines.push(`  Note: ${note}\n`);
    // dry-run 并不是"完全没碰网络"：算得出文件数就说明源真的被查过、拉过了。
    // 不说清楚，用户会以为预览是纯离线的。
    if (report.dryRun) {
      const got =
        report.via.sourceKind === 'path'
          ? 'read the source straight off disk'
          : `fetched the source (${report.via.sourceKind})`;
      lines.push(
        `  --dry-run still looked the entry up and ${got} for real — a preview needs the actual files.\n` +
          '  Only the writes are skipped: nothing was installed and no catalog was changed.\n',
      );
    }
  }

  if (report.reusedEnvNames) {
    lines.push(
      `\nReusing the environment-variable names recorded for ${report.plugin.name} at its last install: ` +
        `${report.reusedEnvNames.join(', ')}\n` +
        '  Pass --env-name to change them, or --env-name OLD=OLD to go back to the author\'s name.\n',
    );
  }

  for (const t of report.targets) {
    lines.push(`\n${report.plugin.name} · ${report.from} → ${t.target}\n`);
    lines.push(formatFindings(t.findings));
    lines.push(formatEnvVars(t.envVars, t.target));
  }

  if (report.stoppedAt?.reason === 'block') {
    lines.push(`BLOCK findings present; nothing installed to ${report.stoppedAt.target}.\n`);
  }
  if (report.stoppedAt?.reason === 'loss') {
    lines.push('LOSS findings present. Re-run with --yes to accept them.\n');
  }

  for (const t of report.targets) {
    if (t.plan) lines.push(`\n${formatPlan(t.plan)}`);
  }

  if (report.needsYes) {
    lines.push('\nLOSS findings above. A real install needs --yes to accept them.\n');
  }

  return {
    command: 'install',
    exitCode: report.stoppedAt ? (report.stoppedAt.reason === 'block' ? 2 : 3) : 0,
    human: lines.join(''),
    json: {
      dryRun: report.dryRun,
      plugin: report.plugin,
      from: report.from,
      ...(report.via ? { via: report.via } : {}),
      ...(report.stoppedAt ? { stoppedAt: report.stoppedAt } : {}),
      needsYes: report.needsYes,
      ...(report.reusedEnvNames ? { reusedEnvNames: report.reusedEnvNames } : {}),
      targets: report.targets.map((t) => ({
        target: t.target,
        worst: worstLevel(t.findings),
        findings: t.findings,
        envVars: t.envVars,
        ...(t.plan ? { plan: planToJson(t.plan) } : {}),
      })),
    },
  };
}

/** 市场名不能当路径段用：与 `market convert` 的 marketplace.name-unsafe 同一条判断、同一个 code。 */
function unsafeMarketNameResult(name: string): CommandResult {
  const finding: Finding = {
    level: 'BLOCK',
    code: 'marketplace.name-unsafe',
    message:
      `the catalog marketplace name "${name}" is not safe to use as a single path segment ` +
      '(it must not contain "/", "\\" or NUL, and must not be exactly "." or ".."); aborted',
    where: 'marketplace.name',
  };
  return {
    command: 'install',
    exitCode: 2,
    human: `${formatFindings([finding])}\nBLOCK findings present; nothing installed.\n`,
    json: { findings: [finding], worst: 'BLOCK' },
  };
}

/**
 * pin 不可用：退出码 2，与其他 BLOCK 一致——装不了就是装不了，来源是"这个条目的 pin 我
 * 不敢用"还是"这个插件转不过去"，对调用方没有区别。人类文案与 JSON 都从这一条 finding
 * 渲染，不各写一份。
 */
function pinRejectedResult(finding: Finding): CommandResult {
  return {
    command: 'install',
    exitCode: 2,
    human: `${formatFindings([finding])}\nBLOCK findings present; nothing was fetched and nothing installed.\n`,
    json: { findings: [finding], worst: 'BLOCK' },
  };
}

/**
 * 查不到市场 / 查不到条目：都是用法错误（退出码 1），什么都没读也没写。
 * 两种都必须说出"我实际查了哪里 / 这个市场里有什么"——只说一句"找不到"，用户既不知道
 * 该把市场放到哪，也不知道自己是不是把名字打错了。
 */
function marketRefError(
  ref: MarketRef,
  lookup: Exclude<MarketRefLookup, { kind: 'ok' }>,
  targets: EcosystemId[],
): CommandResult {
  if (lookup.kind === 'market-not-found') {
    const lines = [
      `scion: no marketplace named "${ref.market}" (from "${ref.plugin}@${ref.market}"). Looked in, in order:\n`,
      ...lookup.probes.map((p) => `  · ${p.path} — ${p.problem}\n`),
      `Add it to Claude first, or run: scion market convert <dir> --to ${targets[0]} --as ${ref.market}\n`,
    ];
    return {
      command: 'install',
      exitCode: 1,
      human: lines.join(''),
      json: {
        error: {
          code: 'market-not-found',
          message: `no marketplace named "${ref.market}"`,
          market: ref.market,
          plugin: ref.plugin,
          searched: lookup.probes,
        },
      },
    };
  }

  const lines = [
    `scion: marketplace "${ref.market}" has no entry named "${ref.plugin}" ` +
      `(${lookup.entryCount} ${lookup.entryCount === 1 ? 'entry' : 'entries'} in ${lookup.catalogPath}).\n`,
  ];
  if (lookup.candidates.length > 0) {
    lines.push('Did you mean:\n', ...lookup.candidates.map((c) => `  · ${c}\n`));
  }
  lines.push(`Run \`scion market show ${lookup.catalogPath}\` to list every entry.\n`);

  return {
    command: 'install',
    exitCode: 1,
    human: lines.join(''),
    json: {
      error: {
        code: 'entry-not-found',
        message: `marketplace "${ref.market}" has no entry named "${ref.plugin}"`,
        market: ref.market,
        plugin: ref.plugin,
        catalog: lookup.catalogPath,
        candidates: lookup.candidates,
        entryCount: lookup.entryCount,
      },
    },
  };
}

/**
 * 账本里这个插件记着的改名映射。按 (插件, 目标) 存，但读的时候要求所有目标一致——
 * 变量是从**同一个 shell 环境**读的，同一个插件在 kimi 和 codex 下要用两个不同的名字
 * 意味着用户得 export 两遍同一个值。真出现分歧就不猜，交回给用户显式指定。
 */
async function recordedEnvNames(
  home: string,
  plugin: string,
  targets: EcosystemId[],
): Promise<Map<string, string>> {
  const records = (await readState(home)).filter(
    (r) => r.name === plugin && targets.includes(r.target) && r.envNames,
  );
  const merged = new Map<string, string>();
  for (const record of records) {
    for (const [previous, next] of Object.entries(record.envNames ?? {})) {
      const seen = merged.get(previous);
      if (seen !== undefined && seen !== next) {
        throw new Error(
          `the install ledger records two different names for ${plugin}'s ${previous} ("${seen}" and "${next}"); ` +
            `re-run with --env-name ${previous}=<NAME> to say which one you want`,
        );
      }
      merged.set(previous, next);
    }
  }
  return merged;
}

function installerFor(target: EcosystemId): Installer {
  switch (target) {
    case 'codex':
      return codexInstaller;
    case 'kimi':
      return kimiInstaller;
    case 'claude': {
      const strategy = loadProfile('claude').install.strategy;
      if (strategy.kind !== 'unsupported') {
        throw new Error('claude profile must use the unsupported strategy');
      }
      throw new Error(strategy.reason);
    }
  }
}
