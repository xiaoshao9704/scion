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

export interface RenderContext {
  targetId: EcosystemId;
  /** 这份 server 表在产物里落到哪个文件；finding 的 where 要精确到「文件#字段」 */
  file: string;
  serverName: string;
  /** 用户点名的 旧名→新名。这是改名的**唯一**来源 */
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
  if (!auth) return { server: { ...config }, findings, uses: [] };

  // 改名先算齐，之后无论落到哪种记法、还是留在原地当占位符，用的都是同一个新名字。
  // 唯一来源是用户的 --env-name：一个变量真正归谁，只有用户知道（典型情形是多个插件
  // 共用一台本地 MCP hub，令牌属于 hub 而不属于其中任何一个插件）。scion 不猜。
  const renames = new Map<string, string>();
  for (const ref of auth.refs) {
    const chosen = ctx.envNames?.get(ref.envVar);
    if (chosen && chosen !== ref.envVar) renames.set(ref.envVar, chosen);
  }
  const named = (envVar: string): string => renames.get(envVar) ?? envVar;

  /** 每个变量的落法与首次出现位置。报告按变量成行，所以这里就按变量攒 */
  const uses = new Map<string, EnvVarUse>();
  const noteUse = (envVar: string, where: string, handling: EnvHandling): string => {
    const existing = uses.get(envVar);
    if (existing) {
      if (!existing.handling.includes(handling)) existing.handling.push(handling);
      return where;
    }
    const previous = renames.has(envVar) ? envVar : undefined;
    uses.set(envVar, {
      name: named(envVar),
      ...(previous ? { previous } : {}),
      handling: [handling],
      servers: [ctx.serverName],
      where,
    });
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
          const where = noteUse(ref.envVar, at(ctx, dialect.bearerTokenEnvField), 'bearer-field');
          server[dialect.bearerTokenEnvField] = named(ref.envVar);
          break;
        }
        const where = noteUse(
          ref.envVar,
          at(ctx, dialect.headersKey, 'Authorization'),
          dialect.expandsInlineVars ? 'bearer-inline' : 'inline-literal',
        );
        headers.Authorization = `Bearer \${${named(ref.envVar)}}`;
        if (!dialect.expandsInlineVars) findings.push(notExpanded(ctx, named(ref.envVar), where));
        break;
      }

      case 'header-value': {
        if (dialect.envHeadersField) {
          const where = noteUse(
            ref.envVar,
            at(ctx, dialect.envHeadersField, ref.header),
            'header-field',
          );
          envHeaders[ref.header] = named(ref.envVar);
          break;
        }
        const where = noteUse(
          ref.envVar,
          at(ctx, dialect.headersKey, ref.header),
          dialect.expandsInlineVars ? 'header-inline' : 'inline-literal',
        );
        headers[ref.header] = `\${${named(ref.envVar)}}`;
        if (!dialect.expandsInlineVars) findings.push(notExpanded(ctx, named(ref.envVar), where));
        break;
      }

      case 'inline': {
        // at 是规范路径，头里的占位符记作 ['headers', …]；写出时换成目标生态的头键名
        const path = ref.at[0] === 'headers' ? [dialect.headersKey, ...ref.at.slice(1)] : ref.at;
        const where = noteUse(
          ref.envVar,
          at(ctx, ...path),
          dialect.expandsInlineVars ? 'inline-expanded' : 'inline-literal',
        );
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

  return { server, findings, uses: [...uses.values()] };
}

/**
 * 一个环境变量在产物里的落法。报告要回答的就是这一列：这个值 scion 是当 token 交给了
 * 目标生态的专用字段，还是留成占位符等目标连接时展开，还是根本没人展开、得用户手填。
 */
export type EnvHandling =
  /** 目标生态有专门接 bearer token 的字段，值由宿主在连接时从环境里取 */
  | 'bearer-field'
  /** 没有专用字段，写回 Authorization 头里的占位符，宿主连接时按值展开 */
  | 'bearer-inline'
  /** 目标生态有专门接「整个头值取自某变量」的字段 */
  | 'header-field'
  /** 没有专用字段，写回头里的占位符，宿主连接时按值展开 */
  | 'header-inline'
  /** 占位符留在配置的其他字段里，宿主连接时按值展开 */
  | 'inline-expanded'
  /** 占位符原样写出，而宿主不展开它——没人替用户填这个值 */
  | 'inline-literal';

/** 一个环境变量这次被怎么处理了。报告按变量成行，所以跨 server 先合并到这一条 */
export interface EnvVarUse {
  /** 产物里最终写下的名字 */
  name: string;
  /** 改名前的名字。只有 --env-name 点过名才有 */
  previous?: string;
  /** 它在产物里的每一种落法，按首次出现顺序 */
  handling: EnvHandling[];
  /** 引用它的 server */
  servers: string[];
  /** 第一次出现在哪个字段 */
  where: string;
}

export interface RenderResult {
  server: McpServerConfig;
  findings: Finding[];
  uses: EnvVarUse[];
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
