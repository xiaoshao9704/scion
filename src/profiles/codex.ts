import type { EcosystemProfile } from './types.js';

export const codexProfile: EcosystemProfile = {
  id: 'codex',
  manifestPaths: ['.codex-plugin/plugin.json'],
  conventions: { skills: 'skills/', commands: 'commands/', agents: 'agents/' },
  fieldDialect: {
    mcpServers: 'path-ref',
    mcpServersFile: '.mcp.json',
    // 三格都在插件 .mcp.json 里用探针实测过，不必再怀疑：
    // - headers：被 Codex 完全忽略，探针收到 authorization=null。所以这个键一个字都不能写出去，
    //   否则鉴权头静默消失、还没有任何提示——这正是本条声明存在的起因。
    // - http_headers：静态头原样到达。它同时也是全局 config.toml 用的键名。
    // - env_http_headers：头值取自环境变量，对任意头名有效（不限 Authorization），
    //   探针在自定义头 X-Probe-Custom 上收到了变量的值。
    mcpAuth: {
      expandsInlineVars: false,
      headersKey: 'http_headers',
      bearerTokenEnvField: 'bearer_token_env_var',
      envHeadersField: 'env_http_headers',
    },
    presentationKey: 'interface',
    presentationFields: [
      'displayName',
      'shortDescription',
      'longDescription',
      'developerName',
      'category',
      'capabilities',
      'defaultPrompt',
      'brandColor',
      'screenshots',
      'websiteURL',
    ],
    runtimeFields: [],
  },
  frontmatterMap: {
    agents: {
      name: { to: 'name', lossy: false },
      description: { to: 'description', lossy: false },
      // spec 待确认 #1：Codex 侧未观察到 agents/ 目录，先按直通处理并由 doctor 报 INFO
      model: { to: 'model', lossy: false },
      tools: { to: 'tools', lossy: false },
    },
    commands: {
      description: { to: 'description', lossy: false },
      'argument-hint': { to: 'argument-hint', lossy: false },
      'allowed-tools': {
        to: null,
        lossy: true,
        note: 'the target has no permission-declaration field; permissions are silently widened after conversion',
      },
    },
  },
  pathVar: null,
  pathVarStrategy: { kind: 'relativize' },
  limits: {},
  install: {
    strategy: {
      kind: 'codex-cli',
      marketplaceName: 'scion',
      marketplaceRoot: '.scion/markets/<market>/codex',
    },
  },
  marketplaceDialect: {
    catalogPaths: ['.agents/plugins/marketplace.json'],
    nameField: 'name',
    entryKeyField: 'name',
    entrySourceForm: 'object',
    ownerField: 'interface',
    entryFields: ['category', 'policy'],
    catalogFields: [],
    // 「任何主机都能自取」是**假设**，不是实测结论——探测过，没能测定，所以按不限制处理。
    //
    // 探测做法：本地市场里声明一条指向非 GitHub git URL 的条目，三种形态都试了
    // （{source:"git",url} / {source:"git-subdir",url,path:"."} / {source:"git-subdir",url}），
    // Codex 三种都不接受，`codex plugin list --marketplace` 一律 `No plugins found`。
    // 这不足以断定"Codex 取不到非 GitHub 主机"——同样可能是这三种写法本身它就不认。
    // 「我没试成功」不等于「它不支持」，所以这里不把探测失败写成事实。
    //
    // 探测掉出来的一条事实，比上面那个未决问题更要紧：**Codex 对解析不了的 catalog 条目
    // 是静默丢弃的**——不报错、不警告，只是 `No plugins found`。这与它静默忽略 .mcp.json
    // 里的 headers 键（见上面 mcpAuth 那段）是同一种性质。含义：scion 一旦产出 Codex 不认的
    // 条目形态，那些插件会凭空消失，用户和 scion 都收不到任何提示——所以条目形态的正确性
    // 只能靠这份 profile 与 golden 用例守住，指望运行时报错是指望不上的。
    //
    // 另记一条线索（未验证）：真实 catalog（claude-plugins-official）里的 git-subdir 条目
    // 一律同时带 path + ref + sha，怀疑 Codex 只支持"仓库的某个子目录是一个插件"，而不支持
    // "整个仓库就是一个插件"。若属实，上面那三种写法失败的原因就在这儿，与主机无关。
    //
    // 一旦有人测定了主机限制，改这一行即可，转换引擎不动。
    remoteFetch: { hosts: ['*'], limitation: '' },
  },
};
