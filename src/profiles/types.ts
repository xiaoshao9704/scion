import type { EcosystemId } from '../ir/types.js';

export type McpNotation = 'external-file' | 'inline' | 'path-ref';

/**
 * 「这个值从环境变量来」在该生态的 MCP 配置里怎么写。同一个含义三种记法，是教科书式的
 * L2 差异——记法本身是各生态的事实，所以整份声明住在 profile 里；引擎只按这份声明读写，
 * 加第四个生态时引擎一行不动。每一格都由「记录实收 Authorization 头的探针 server + 各宿主
 * 非交互模式」实测过，不是查文档推演的。
 */
export interface McpAuthDialect {
  /** 宿主是否在连接时展开配置里的 ${VAR}；否则占位符原样发出（或整个头被丢弃） */
  expandsInlineVars: boolean;
  /** 静态（不含变量）HTTP 头的键名 */
  headersKey: string;
  /** 承载「bearer 令牌取自该环境变量」的专用字段名；null 表示该生态没有 */
  bearerTokenEnvField: string | null;
  /** 承载「整个头值取自该环境变量」的字段名；null 表示该生态没有 */
  envHeadersField: string | null;
}

export interface FieldDialect {
  mcpServers: McpNotation;
  /** external-file / path-ref 时的文件名，相对插件根 */
  mcpServersFile?: string;
  mcpAuth: McpAuthDialect;
  /** 清单里 presentation 块的键名；null 表示该生态没有此块 */
  presentationKey: string | null;
  /** presentation 允许出现的字段白名单，超出的字段转出时丢弃并报 INFO */
  presentationFields: string[];
  /** 清单里 runtime 块允许的字段 */
  runtimeFields: string[];
}

export interface ConventionDirs {
  skills: string;
  commands: string;
  agents: string;
}

/** 单个 frontmatter 字段的映射规则 */
export interface FrontmatterRule {
  /** 目标字段名；null 表示目标端无对应字段 */
  to: string | null;
  /** 值映射表；缺省表示值直通 */
  valueMap?: Record<string, string>;
  lossy: boolean;
  /** lossy 为 true 时用于生成 Finding 的说明 */
  note?: string;
}

export interface FrontmatterMap {
  agents: Record<string, FrontmatterRule>;
  commands: Record<string, FrontmatterRule>;
}

export type PathVarStrategy =
  | { kind: 'keep' }
  | { kind: 'rename'; to: string }
  /** 去掉变量前缀，改为相对插件根的路径；有损，因为依赖运行时 cwd */
  | { kind: 'relativize' };

/**
 * 安装策略。原则：能用目标生态自己的 CLI 就用 CLI，绝不代替它改配置文件。
 * - codex-cli：scion 只在自己的目录下摆一个本地 marketplace，其余交给 `codex plugin`。
 * - kimi-managed：Kimi 没有 plugin CLI（只有 TUI 的 /plugins）。默认落到 scion 维护的本地
 *   marketplace（与 codex-cli 同一形状，只是 catalog 是 Kimi 格式），用户只需指向该 catalog
 *   一次；--write-registry 时额外落盘到托管目录并代写 Kimi 自己的注册表。
 * - unsupported：v1 不支持往该生态安装（Claude 只作为源）。
 */
export type InstallStrategy =
  | {
      kind: 'codex-cli';
      /**
       * 插件不来自任何市场时（git URL / 本地目录 / zip）用的兜底市场名。
       * 来自市场的插件一律沿用它**官方的市场名**，见 InstallOpts.marketName。
       */
      marketplaceName: string;
      /** 相对 $HOME，marketplace 根目录，支持 <market> 占位符 */
      marketplaceRoot: string;
    }
  | {
      kind: 'kimi-managed';
      /** 相对 $HOME，支持 <plugin> 占位符；仅 --write-registry 时使用 */
      rootTemplate: string;
      /** 相对 $HOME 的注册表路径；默认不写，需 --write-registry */
      registryPath: string;
      /**
       * 插件不来自任何市场时用的兜底市场名；默认（无 --write-registry）走这条路径。
       * 来自市场的插件一律沿用它**官方的市场名**，见 InstallOpts.marketName。
       */
      marketplaceName: string;
      /** 相对 $HOME，marketplace 根目录，支持 <market> 占位符 */
      marketplaceRoot: string;
    }
  | { kind: 'unsupported'; reason: string };

export interface InstallSpec {
  strategy: InstallStrategy;
}

/**
 * 目标生态能自行获取哪些远程条目源。
 *
 * 转换时，远端条目（url / git-subdir）是原样留在 catalog 里、等目标生态自己去拉的。
 * 这只在目标真的拉得动时才成立：Kimi 除 GitHub 外只认内联目录，自建 GitLab 的 URL 它
 * 解析不了，原样留下等于给用户一个永远装不上的条目。这是每个生态各自的事实，所以写在
 * profile 里由转换引擎读取——加第四个生态时只写一份声明，引擎一行不动。
 */
export interface RemoteFetchSpec {
  /**
   * 能自行获取的远程主机名白名单，'*' 表示不限制。匹配主机名本身及其子域。
   * 未列出（或 URL 里根本解析不出主机）即视为该生态取不到。
   */
  hosts: string[];
  /** hosts 不是 '*' 时，向用户解释这个生态的限制；进 finding 文案，引擎不自造措辞 */
  limitation: string;
}

export interface MarketplaceDialect {
  /** 候选 catalog 路径（相对 marketplace 根），优先级从高到低 */
  catalogPaths: string[];
  /** 承载市场名的字段；null 表示该生态没有市场名 */
  nameField: string | null;
  /** 条目主键字段名 */
  entryKeyField: 'name' | 'id';
  /**
   * 投影/写出条目时偏好的 source 写法。
   * 不是读入约束——真实 catalog 里字符串形态和对象形态混用是常态（同一份
   * claude-plugins-official 里两种都有），读取时必须按每个条目 source 的运行时
   * 类型分派，不能假设整份 catalog 只用这一种写法。
   */
  entrySourceForm: 'string' | 'object';
  /** 归属信息字段 */
  ownerField: 'owner' | 'interface' | null;
  /** 条目允许出现的可选字段白名单，仅在投影写出时用作过滤依据；读取端从不查它 */
  entryFields: string[];
  /** catalog 顶层允许出现的字段白名单（与 entryFields 是不同的轴：这里是 catalog 级，不是条目级） */
  catalogFields: string[];
  /** 该生态自己能拉到哪些远程条目源 */
  remoteFetch: RemoteFetchSpec;
}

export interface EcosystemProfile {
  id: EcosystemId;
  /** 候选清单路径，按优先级从高到低 */
  manifestPaths: string[];
  conventions: ConventionDirs;
  fieldDialect: FieldDialect;
  frontmatterMap: FrontmatterMap;
  /** 该生态自己的路径变量；null 表示没有 */
  pathVar: string | null;
  /** 从其他生态转入时如何处理对方的路径变量 */
  pathVarStrategy: PathVarStrategy;
  /**
   * 宿主自己解析 commands / agents 的 frontmatter 失败时会怎样。scion 转不动这种文件
   * 时会原样复制，而"原样复制"的后果完全取决于目标端——所以它是生态事实，不是引擎行为。
   *
   * - 'drops-the-file'：宿主吞掉解析异常并丢弃这个文件，该命令/agent 在目标端根本不存在
   * - 'drops-the-metadata'：宿主保留文件并照常加载，但把 frontmatter 当成空的——作者
   *   在那里声明的一切（描述、权限白名单）静默失效，而正文照跑
   * - 'unverified'：没实测过。不猜，照实说不确定
   */
  unparsedFrontmatter: 'drops-the-file' | 'drops-the-metadata' | 'unverified';
  /**
   * 目标端如何处置 command 正文里的 !`cmd` 内联 bash。scion 原样保留正文，后果取决于
   * 宿主——所以同 unparsedFrontmatter 一样是生态事实，不是引擎行为。
   *
   * - 'runs'：宿主先执行命令、把输出注入正文（Claude Code 的行为）
   * - 'literal'：宿主不识别，!`cmd` 作为字面文本进入模型上下文——命令不执行，语义静默改变
   * - 'unverified'：有间接证据但未运行时实测。不猜，照实说不确定
   */
  inlineBash: 'runs' | 'literal' | 'unverified';
  /** name 的正则约束（源字符串）；undefined 表示无约束 */
  namePattern?: string;
  limits: { fieldBytes?: number; totalInstructionBytes?: number };
  install: InstallSpec;
  marketplaceDialect: MarketplaceDialect;
}
