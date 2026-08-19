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
  // 未实测：不知道宿主吞掉解析异常后是丢弃文件还是照常加载。不猜，报告里照实说不确定。
  unparsedFrontmatter: 'unverified' as const,
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
