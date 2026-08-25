import type { EcosystemProfile } from './types.js';

export const claudeProfile: EcosystemProfile = {
  id: 'claude',
  manifestPaths: ['.claude-plugin/plugin.json'],
  conventions: { skills: 'skills/', commands: 'commands/', agents: 'agents/' },
  fieldDialect: {
    mcpServers: 'external-file',
    mcpServersFile: '.mcp.json',
    // 实测：Claude 在连接 MCP server 时展开配置里的 ${VAR}，所以它不需要（也没有）专用字段。
    mcpAuth: {
      expandsInlineVars: true,
      headersKey: 'headers',
      bearerTokenEnvField: null,
      envHeadersField: null,
    },
    presentationKey: null,
    presentationFields: [],
    runtimeFields: [],
  },
  frontmatterMap: {
    agents: {
      name: { to: 'name', lossy: false },
      description: { to: 'description', lossy: false },
      model: { to: 'model', lossy: false },
      tools: { to: 'tools', lossy: false },
    },
    commands: {
      description: { to: 'description', lossy: false },
      'argument-hint': { to: 'argument-hint', lossy: false },
      'allowed-tools': { to: 'allowed-tools', lossy: false },
    },
  },
  pathVar: '${CLAUDE_PLUGIN_ROOT}',
  pathVarStrategy: { kind: 'keep' },
  // 实测（Claude Code 2.1.232，bundle 内的 Kp()）：它用 Bun.YAML.parse，对同一段内容照样
  // 抛（已单独用 bun 复现）。但它 catch 之后只写一条 warn 级日志，返回 frontmatter = {}，
  // 文件照常加载、正文照跑。后果是作者写在 frontmatter 里的一切静默失效——包括
  // allowed-tools，也就是这条命令实际上不受工具白名单约束，而没有任何人看得见。
  unparsedFrontmatter: 'drops-the-metadata' as const,
  inlineBash: 'runs' as const,
  // Claude 是转换的源生态；反向（转入 Claude）不支持，无需声明它的 hooks 方言。
  hooksDialect: { kind: 'none' as const },
  limits: {},
  install: {
    strategy: {
      kind: 'unsupported',
      reason: 'v1 treats Claude only as a conversion source; installing back into Claude is not supported',
    },
  },
  marketplaceDialect: {
    catalogPaths: ['.claude-plugin/marketplace.json'],
    nameField: 'name',
    entryKeyField: 'name',
    entrySourceForm: 'string',
    ownerField: 'owner',
    entryFields: ['description'],
    catalogFields: [],
    // Claude 在 v1 里只作为源，从不是转换目标；声明成不限制，免得它被误当成"取不到"。
    remoteFetch: { hosts: ['*'], limitation: '' },
  },
};
