import type { EcosystemProfile } from './types.js';

export const kimiProfile: EcosystemProfile = {
  id: 'kimi',
  // 文档明确：两者并存时 kimi.plugin.json 优先
  manifestPaths: ['kimi.plugin.json', '.kimi-plugin/plugin.json'],
  conventions: { skills: 'skills/', commands: 'commands/', agents: 'agents/' },
  fieldDialect: {
    mcpServers: 'inline',
    // 实测：Kimi 把 headers 里的 ${VAR} 原样当字面量发出去（探针收到的就是 "Bearer ${VAR}"），
    // 只有 bearerTokenEnvVar 这一条路能真的把令牌从环境里取出来。
    mcpAuth: {
      expandsInlineVars: false,
      headersKey: 'headers',
      bearerTokenEnvField: 'bearerTokenEnvVar',
      envHeadersField: null,
    },
    presentationKey: 'interface',
    presentationFields: ['displayName', 'shortDescription', 'longDescription', 'developerName'],
    runtimeFields: ['sessionStart', 'skillInstructions'],
  },
  frontmatterMap: {
    agents: {
      name: { to: 'name', lossy: false },
      description: { to: 'description', lossy: false },
      model: {
        to: 'model_preference',
        valueMap: { opus: 'primary', sonnet: 'primary', haiku: 'secondary' },
        lossy: true,
        note: 'Kimi has only primary/secondary tiers; specific model names have no equivalent',
      },
      tools: { to: 'tools', lossy: false },
    },
    commands: {
      description: { to: 'description', lossy: false },
      // spec 待确认 #4：Kimi commands 是否支持 argument-hint 未见于文档
      'argument-hint': {
        to: null,
        lossy: true,
        note: 'the Kimi docs do not mention argument-hint; dropped on conversion',
      },
      'allowed-tools': {
        to: null,
        lossy: true,
        note: 'the target has no permission-declaration field; permissions are silently widened after conversion',
      },
    },
  },
  pathVar: null,
  pathVarStrategy: { kind: 'relativize' },
  namePattern: '^[a-z0-9][a-z0-9_-]{0,63}$',
  limits: { fieldBytes: 32768, totalInstructionBytes: 65536 },
  install: {
    strategy: {
      kind: 'kimi-managed',
      rootTemplate: '.kimi-code/plugins/managed/<plugin>',
      registryPath: '.kimi-code/plugins/installed.json',
      marketplaceName: 'scion',
      marketplaceRoot: '.scion/markets/<market>/kimi',
    },
  },
  marketplaceDialect: {
    catalogPaths: ['marketplace.json'],
    nameField: null,
    entryKeyField: 'id',
    entrySourceForm: 'string',
    ownerField: null,
    entryFields: ['displayName', 'version', 'description', 'homepage', 'keywords', 'tier', 'type'],
    catalogFields: ['version'],
    // 实测：Kimi 的市场条目 source 只认 GitHub 仓库和内联的本地目录，别的主机（自建
    // GitLab、其他 git 服务）它解析不了，条目在 Kimi 里根本装不上。
    remoteFetch: {
      hosts: ['github.com'],
      limitation:
        'Kimi Code only resolves marketplace entry sources hosted on GitHub, or inline local directories',
    },
  },
};
