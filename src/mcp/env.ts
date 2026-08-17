import type { EcosystemId, Finding, McpEnvRef, McpServerAuth, McpServerConfig } from '../ir/types.js';
import type { McpAuthDialect } from '../profiles/types.js';
import { ALL_PROFILE_IDS, loadProfile } from '../profiles/loader.js';

/** ${NAME}；NAME 按 POSIX 环境变量名的形状 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 路径变量（${CLAUDE_PLUGIN_ROOT} 之类）长得和环境变量引用一模一样，但它由宿主自己
 * 提供、也已经有 pathVarStrategy 在管，误当成鉴权用的环境变量会既改错名字又误报损耗。
 * 名单从各 profile 的声明里现算，不在引擎里另抄一份。
 */
function pathVarNames(): Set<string> {
  const out = new Set<string>();
  for (const id of ALL_PROFILE_IDS) {
    const profile = loadProfile(id);
    for (const raw of [profile.pathVar, profile.pathVarStrategy.kind === 'rename' ? profile.pathVarStrategy.to : null]) {
      const name = raw?.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
      if (name) out.add(name);
    }
  }
  return out;
}

const PATH_VARS = pathVarNames();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 字符串里引用到的环境变量名，按出现顺序、去重、排除路径变量 */
export function referencedVars(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (PATH_VARS.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 整个值就是一个 ${VAR}——可以整体交给目标生态的「头值取自 env」字段 */
function wholeValueVar(text: string): string | null {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text.trim());
  return m && !PATH_VARS.has(m[1]) ? m[1] : null;
}

/** Authorization: Bearer ${VAR} —— 三个生态都有专门字段接的那一形态 */
function bearerVar(text: string): string | null {
  const m = /^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(text.trim());
  return m && !PATH_VARS.has(m[1]) ? m[1] : null;
}

function isAuthorization(header: string): boolean {
  return header.toLowerCase() === 'authorization';
}

export interface ReadServerResult {
  /** 摘掉鉴权记法之后的配置 */
  config: McpServerConfig;
  /** 该 server 没有任何鉴权事实时为 null */
  auth: McpServerAuth | null;
}

/**
 * 把一个 server 条目里「值从环境变量来」的部分按 profile 声明的记法解出来。
 * 读与写共用同一份 dialect 声明（见 renderServer），三种记法互转只有这一条路径。
 */
export function readServerAuth(raw: McpServerConfig, dialect: McpAuthDialect): ReadServerResult {
  const config: McpServerConfig = { ...raw };
  const headers: Record<string, string> = {};
  const refs: McpEnvRef[] = [];
  let touched = false;

  const bearerField = dialect.bearerTokenEnvField;
  if (bearerField && typeof config[bearerField] === 'string') {
    refs.push({ kind: 'bearer', envVar: config[bearerField] as string });
    delete config[bearerField];
    touched = true;
  }

  const envHeadersField = dialect.envHeadersField;
  if (envHeadersField && isRecord(config[envHeadersField])) {
    for (const [header, envVar] of Object.entries(config[envHeadersField] as Record<string, unknown>)) {
      if (typeof envVar !== 'string') continue;
      // 刻意不把 Authorization 折叠成 bearer：这个字段的语义是「整个头值取自该变量」，
      // 变量里装的是完整头值；bearer 字段则由宿主自己补 "Bearer " 前缀。两者不等价。
      refs.push({ kind: 'header-value', header, envVar });
    }
    delete config[envHeadersField];
    touched = true;
  }

  const headersKey = dialect.headersKey;
  if (isRecord(config[headersKey])) {
    for (const [header, value] of Object.entries(config[headersKey] as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;

      const bearer = isAuthorization(header) ? bearerVar(value) : null;
      if (bearer) {
        refs.push({ kind: 'bearer', envVar: bearer });
        continue;
      }

      const whole = wholeValueVar(value);
      if (whole) {
        refs.push({ kind: 'header-value', header, envVar: whole });
        continue;
      }

      // 占位符嵌在更长的字符串里，没有哪个生态的专用字段接得住，只能原样留在头里
      for (const envVar of referencedVars(value)) {
        refs.push({ kind: 'inline', at: ['headers', header], envVar });
      }
      headers[header] = value;
    }
    delete config[headersKey];
    touched = true;
  }

  walkStrings(config, [], (at, text) => {
    for (const envVar of referencedVars(text)) refs.push({ kind: 'inline', at, envVar });
  });

  if (!touched && refs.length === 0) return { config, auth: null };
  return { config, auth: { headers, refs } };
}

/** 深度遍历剩余配置里的字符串，把字段路径一并交给回调 */
function walkStrings(
  value: unknown,
  at: string[],
  visit: (at: string[], text: string) => void,
): void {
  if (typeof value === 'string') {
    visit(at, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, [...at, String(i)], visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) walkStrings(child, [...at, key], visit);
  }
}

/**
 * 泛化到会在一台机器上跨插件撞车的变量名。**显式清单，不是启发式**——名字够不够泛化
 * 没有可靠的判据，猜错的代价是给一个本来就带命名空间的变量再套一层前缀（纯噪音）。
 * 清单是数据：要加名字就往这里加，引擎不变。
 *
 * 注意这份清单不属于任何生态的事实（三家宿主都不关心变量叫什么），所以它不进 profile。
 */
export const GENERIC_ENV_NAMES = [
  'MCP_TOKEN',
  'TOKEN',
  'API_KEY',
  'API_TOKEN',
  'AUTH_TOKEN',
  'SECRET',
  'KEY',
] as const;

/** 插件名 → 环境变量前缀：acme-toolkit → ACME_TOOLKIT */
export function envPrefix(pluginName: string): string {
  const upper = pluginName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  // 环境变量名不能以数字开头
  return /^[0-9]/.test(upper) ? `_${upper}` : upper;
}

/** 该改名则给出新名字，否则 null。同一插件重装两次必然得到同一个名字 */
export function disambiguate(envVar: string, pluginName: string): string | null {
  if (!(GENERIC_ENV_NAMES as readonly string[]).includes(envVar)) return null;
  const prefix = envPrefix(pluginName);
  return prefix ? `${prefix}_${envVar}` : null;
}

export interface RenderContext {
  targetId: EcosystemId;
  /** 这份 server 表在产物里落到哪个文件；finding 的 where 要精确到「文件#字段」 */
  file: string;
  serverName: string;
  /** 消歧改名用的命名空间 */
  pluginName: string;
  /** 插件自己的运行时代码可能就读着这个变量名，改名会断链——这是那条退路 */
  keepEnvNames: boolean;
  /** 用户点名的 旧名→新名。优先于自动消歧，也优先于 keepEnvNames */
  envNames?: Map<string, string>;
}

function substituteVars(text: string, renames: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (match, name: string) => {
    const next = renames.get(name);
    return next ? `\${${next}}` : match;
  });
}

function rewriteVars(value: unknown, renames: Map<string, string>): unknown {
  if (typeof value === 'string') return substituteVars(value, renames);
  if (Array.isArray(value)) return value.map((item) => rewriteVars(item, renames));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteVars(child, renames)]),
    );
  }
  return value;
}

/**
 * 把归一后的鉴权事实按目标 profile 的记法写回去。与 readServerAuth 共用同一份 dialect
 * 声明——三种记法之间的互转只有这一条路径，不是每个 target 各写一遍。
 */
export function renderServer(
  config: McpServerConfig,
  auth: McpServerAuth | undefined,
  dialect: McpAuthDialect,
  ctx: RenderContext,
): RenderResult {
  const findings: Finding[] = [];
  if (!auth) return { server: { ...config }, findings, renames: [] };

  // 改名先算齐，之后无论落到哪种记法、还是留在原地当占位符，用的都是同一个新名字
  const renames = new Map<string, string>();
  for (const ref of auth.refs) {
    // 用户点名指定的优先于一切：自动消歧只知道「插件叫什么」，而一个变量真正的归属
    // 未必是插件。典型情形是多个插件共用一台本地 MCP hub，令牌属于 hub 而不属于其中
    // 任何一个插件——按插件名加前缀会让每个插件各要一份同样的令牌。这种事只有用户
    // 知道，所以给了名字就照用，连 --keep-env-names 也不该反悔（两者矛盾时，
    // 明确点名的那个更具体）。
    const chosen = ctx.envNames?.get(ref.envVar);
    if (chosen) {
      if (chosen !== ref.envVar) renames.set(ref.envVar, chosen);
      continue;
    }
    if (ctx.keepEnvNames) continue;
    const next = disambiguate(ref.envVar, ctx.pluginName);
    if (next) renames.set(ref.envVar, next);
  }
  const named = (envVar: string): string => renames.get(envVar) ?? envVar;
  /** 每个被改名的变量第一次出现在哪个字段——改名 finding 就指那儿 */
  const firstUse = new Map<string, string>();
  const noteUse = (envVar: string, where: string): string => {
    if (!firstUse.has(envVar)) firstUse.set(envVar, where);
    return where;
  };

  const server = rewriteVars(config, renames) as McpServerConfig;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(auth.headers).map(([key, value]) => [key, substituteVars(value, renames)]),
  );
  const envHeaders: Record<string, string> = {};

  for (const ref of auth.refs) {
    switch (ref.kind) {
      case 'bearer': {
        if (dialect.bearerTokenEnvField) {
          const where = noteUse(ref.envVar, at(ctx, dialect.bearerTokenEnvField));
          server[dialect.bearerTokenEnvField] = named(ref.envVar);
          findings.push({
            level: 'INFO',
            code: 'mcp.auth.bearer-field',
            message: `${ctx.targetId} takes the bearer token from ${dialect.bearerTokenEnvField} rather than an inline Authorization header; export ${named(ref.envVar)} in the environment that starts ${ctx.targetId}`,
            where,
          });
          break;
        }
        const where = noteUse(ref.envVar, at(ctx, dialect.headersKey, 'Authorization'));
        headers.Authorization = `Bearer \${${named(ref.envVar)}}`;
        findings.push(
          dialect.expandsInlineVars
            ? {
                level: 'INFO',
                code: 'mcp.auth.bearer-inline',
                message: `${ctx.targetId} expands \${...} in the MCP config when it connects, so the bearer token goes back into an inline Authorization header; export ${named(ref.envVar)} in the environment that starts ${ctx.targetId}`,
                where,
              }
            : notExpanded(ctx, named(ref.envVar), where),
        );
        break;
      }

      case 'header-value': {
        if (dialect.envHeadersField) {
          const where = noteUse(ref.envVar, at(ctx, dialect.envHeadersField, ref.header));
          envHeaders[ref.header] = named(ref.envVar);
          findings.push({
            level: 'INFO',
            code: 'mcp.env.header-field',
            message: `the ${ref.header} header value is taken from ${dialect.envHeadersField} rather than an inline placeholder; export ${named(ref.envVar)} in the environment that starts ${ctx.targetId}`,
            where,
          });
          break;
        }
        const where = noteUse(ref.envVar, at(ctx, dialect.headersKey, ref.header));
        headers[ref.header] = `\${${named(ref.envVar)}}`;
        findings.push(
          dialect.expandsInlineVars
            ? {
                level: 'INFO',
                code: 'mcp.env.header-inline',
                message: `${ctx.targetId} expands \${...} in the MCP config when it connects, so the ${ref.header} header value goes back into an inline placeholder; export ${named(ref.envVar)} in the environment that starts ${ctx.targetId}`,
                where,
              }
            : notExpanded(ctx, named(ref.envVar), where),
        );
        break;
      }

      case 'inline': {
        // at 是规范路径，头里的占位符记作 ['headers', …]；写出时换成目标生态的头键名
        const path = ref.at[0] === 'headers' ? [dialect.headersKey, ...ref.at.slice(1)] : ref.at;
        const where = noteUse(ref.envVar, at(ctx, ...path));
        if (dialect.expandsInlineVars) break;
        findings.push(notExpanded(ctx, named(ref.envVar), where));
        break;
      }
    }
  }

  if (Object.keys(headers).length > 0) {
    server[dialect.headersKey] = headers;
  }

  if (dialect.envHeadersField && Object.keys(envHeaders).length > 0) {
    server[dialect.envHeadersField] = envHeaders;
  }

  return {
    server,
    findings,
    // 改名是插件级的一件事（同一个变量可能被多个 server 引用），所以只交出数据，
    // 由调用方跨 server 汇总成一条 finding——否则同一句话会重复出现好几遍。
    renames: [...renames].map(([previous, next]) => ({
      previous,
      next,
      where: firstUse.get(previous) ?? '',
      chosenByUser: ctx.envNames?.get(previous) === next,
    })),
  };
}

/** 一次改名：旧名、新名、以及它第一次出现在哪个字段 */
export interface EnvRename {
  previous: string;
  next: string;
  where: string;
  /** 用户用 --env-name 点名的，而不是 scion 自动消歧出来的 */
  chosenByUser: boolean;
}

export interface RenderResult {
  server: McpServerConfig;
  findings: Finding[];
  renames: EnvRename[];
}

/** 跨 server 汇总后的改名 finding：一个变量一条 */
export function renameFinding(rename: EnvRename, targetId: EcosystemId): Finding {
  const { previous, next, chosenByUser } = rename;
  // 为什么改的名，两种情况差别很大：用户点名的不该再被劝「用 --keep-env-names 改回去」，
  // 那等于把他刚下的决定说成一个待纠正的默认行为。共通的部分只有那条 export 语句。
  const why = chosenByUser
    ? `renamed the environment variable ${previous} → ${next}, as requested with --env-name.`
    : `renamed the environment variable ${previous} → ${next}: "${previous}" is generic enough that two plugins on one machine would fight over it, so scion namespaces it to this plugin.`;
  const escape = chosenByUser
    ? ''
    : ` Re-run with --keep-env-names to keep ${previous}, or --env-name ${previous}=<NAME> to choose the name yourself (do that if the plugin's own code reads a particular name).`;
  return {
    level: 'INFO',
    code: 'mcp.env.renamed',
    // 旧名、新名、以及一条可以直接粘进 shell 的语句：搬运的是名字，值全程留在用户的环境里
    message: `${why} Before starting ${targetId}, run: export ${next}="$${previous}" — the plugin's own docs will still call it ${previous}.${escape}`,
    where: rename.where,
  };
}

/** finding 的 where：文件 + 字段，精确到 agent 该去改的那一处 */
function at(ctx: RenderContext, ...path: string[]): string {
  return `${ctx.file}#mcpServers.${[ctx.serverName, ...path].join('.')}`;
}

function notExpanded(ctx: RenderContext, envVar: string, where: string): Finding {
  return {
    level: 'LOSS',
    code: 'mcp.env.not-expanded',
    message: `${ctx.targetId} neither expands \${${envVar}} in the MCP config nor has a field for taking this value from the environment; the placeholder is written out literally and nothing expands it at run time — put the real value in this field by hand`,
    where,
  };
}
