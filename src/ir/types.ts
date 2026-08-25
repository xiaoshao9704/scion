export type EcosystemId = 'claude' | 'kimi' | 'codex';

export type ProvenanceSource = 'manifest' | 'convention' | 'profile-default';

export interface Provenance {
  /** 点分 IR 路径，如 "capabilities.skills" */
  field: string;
  source: ProvenanceSource;
  detail?: string;
}

export type FindingLevel = 'BLOCK' | 'LOSS' | 'INFO';

export interface Finding {
  level: FindingLevel;
  /** 稳定短码，便于测试断言，如 "kimi.name.pattern" */
  code: string;
  message: string;
  /** 相关文件或字段位置 */
  where?: string;
}

export interface PluginIdentity {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

/** 一类能力的目录：既保留清单里的路径写法，也保留扫描到的真实条目 */
export interface CapabilityDir {
  /** 相对插件根，统一为不带 "./"、带结尾 "/" 的形式，如 "skills/" */
  path: string;
  /** 扫描到的条目名（目录名或文件名），已排序 */
  entries: string[];
}

export type McpServerConfig = Record<string, unknown>;

/**
 * 一处「值从环境变量来」的事实，已从各生态的记法里解出来。调用方拿到的是
 * 「哪个变量、用在哪」，不是一个还要自己再解析一遍的字符串。
 */
export type McpEnvRef =
  /** Authorization: Bearer <令牌>，令牌取自该变量。三个生态都有专门字段接它，可无损互转 */
  | { kind: 'bearer'; envVar: string }
  /** 整个头值取自该变量 */
  | { kind: 'header-value'; header: string; envVar: string }
  /**
   * 其他任何位置的 ${VAR}（stdio 的 env 块、url、args…）。at 是规范化后的字段路径：
   * 头里的嵌入式占位符统一记作 ['headers', <头名>]，写出时再换成目标生态的头键名。
   */
  | { kind: 'inline'; at: string[]; envVar: string };

/** 某个 MCP server 的鉴权事实。记法归一到这里，各生态怎么写由 profile 决定 */
export interface McpServerAuth {
  /** 静态 HTTP 头：键名已归一，值里可能仍有嵌入式占位符（对应 kind: 'inline' 的 ref） */
  headers: Record<string, string>;
  refs: McpEnvRef[];
}

export interface PluginCapabilities {
  skills: CapabilityDir | null;
  commands: CapabilityDir | null;
  agents: CapabilityDir | null;
  /** hooks/ 下的文件，相对插件根的路径 */
  hooks: string[];
  /**
   * hooks/hooks.json 解析后的内容；文件不存在或不是合法 JSON 时为 undefined。
   * 两种情况靠 hooks 里有没有 'hooks/hooks.json' 区分——列表里有而这里没有，就是解析失败。
   */
  hooksConfig?: unknown;
  /** 已摘掉鉴权记法的 server 配置，其余字段原样保留 */
  mcpServers: Record<string, McpServerConfig>;
  /** 与 mcpServers 同键；没有任何鉴权事实的 server 不出现在这里 */
  mcpAuth: Record<string, McpServerAuth>;
}

export interface PluginPresentation {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  defaultPrompt?: string[];
  brandColor?: string;
  icon?: string;
  logo?: string;
  screenshots?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
}

export interface PluginRuntime {
  sessionStart?: { skill: string };
  skillInstructions?: string;
  systemPrompt?: string;
  systemPromptPath?: string;
}

export interface PluginIR {
  /** 插件源目录绝对路径 */
  root: string;
  sourceEcosystem: EcosystemId;
  identity: PluginIdentity;
  capabilities: PluginCapabilities;
  presentation: PluginPresentation;
  runtime: PluginRuntime;
  provenance: Provenance[];
  /** 正规化阶段发现的问题（如声明了但文件不存在） */
  issues: Finding[];
}
