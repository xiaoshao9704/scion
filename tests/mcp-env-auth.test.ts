import { describe, it, expect } from 'vitest';
import { makePluginDir } from './helpers/tmp.js';
import { normalize } from '../src/normalize/index.js';
import { project } from '../src/project/index.js';
import { loadProfile } from '../src/profiles/loader.js';
import type { Finding } from '../src/ir/types.js';
import type { EcosystemProfile } from '../src/profiles/types.js';
import type { ProjectionOptions, ProjectionResult } from '../src/project/types.js';
import type { EnvVarUse } from '../src/mcp/env.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');
const codex = loadProfile('codex');

/** 变量名而已——fixture 里永远不出现真令牌的形状（C2） */
async function claudePlugin(servers: unknown): Promise<string> {
  return makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'acme-toolkit' }),
    '.mcp.json': JSON.stringify({ mcpServers: servers }),
  });
}

/** 产物里的 server 表：inline 的在清单里，path-ref / external-file 的在 .mcp.json 里 */
function serversOf(out: ProjectionResult): Record<string, Record<string, unknown>> {
  const file = out.files.find((f) => f.path === '.mcp.json');
  if (file) return JSON.parse(file.content).mcpServers;
  return out.manifest.mcpServers as Record<string, Record<string, unknown>>;
}

/** 单变量场景下那个变量落在哪个字段 */
function envVarWhere(out: ProjectionResult): string {
  return out.envVars[0].where;
}

function findingOf(findings: Finding[], code: string): Finding {
  const hit = findings.find((f) => f.code === code);
  if (!hit) throw new Error(`no finding ${code}; got: ${findings.map((f) => f.code).join(', ')}`);
  return hit;
}

async function convert(
  servers: unknown,
  target: EcosystemProfile,
  opts: ProjectionOptions = {},
): Promise<{
  servers: Record<string, Record<string, unknown>>;
  findings: Finding[];
  envVars: EnvVarUse[];
}> {
  const ir = await normalize(await claudePlugin(servers), claude);
  const out = project(ir, target, opts);
  return { servers: serversOf(out), findings: out.findings, envVars: out.envVars };
}

describe('profiles declare how each ecosystem spells "take this from an env var"', () => {
  it('claude expands inline placeholders and has no dedicated field', () => {
    const d = claude.fieldDialect.mcpAuth;
    expect(d.expandsInlineVars).toBe(true);
    expect(d.headersKey).toBe('headers');
    expect(d.bearerTokenEnvField).toBeNull();
    expect(d.envHeadersField).toBeNull();
  });

  it('kimi has a bearer field and does not expand placeholders', () => {
    const d = kimi.fieldDialect.mcpAuth;
    expect(d.expandsInlineVars).toBe(false);
    expect(d.headersKey).toBe('headers');
    expect(d.bearerTokenEnvField).toBe('bearerTokenEnvVar');
    expect(d.envHeadersField).toBeNull();
  });

  it('codex has both env fields and its own static-header key', () => {
    const d = codex.fieldDialect.mcpAuth;
    expect(d.expandsInlineVars).toBe(false);
    expect(d.headersKey).toBe('http_headers');
    expect(d.bearerTokenEnvField).toBe('bearer_token_env_var');
    expect(d.envHeadersField).toBe('env_http_headers');
  });
});

describe('normalize reads env references as structured facts', () => {
  it('recognises an inline bearer header on the claude side', async () => {
    const ir = await normalize(
      await claudePlugin({
        tracker: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
      }),
      claude,
    );
    expect(ir.capabilities.mcpAuth.tracker.refs).toEqual([{ kind: 'bearer', envVar: 'MCP_TOKEN' }]);
    // 记法从 config 里被摘走，剩下的字段原样保留
    expect(ir.capabilities.mcpServers.tracker).toEqual({ type: 'http', url: 'https://mcp.example.com/' });
    expect(ir.capabilities.mcpAuth.tracker.headers).toEqual({});
  });

  it('keeps static headers that carry no variable', async () => {
    const ir = await normalize(
      await claudePlugin({
        tracker: { url: 'https://mcp.example.com/', headers: { 'X-Tenant': 'acme', Authorization: 'Bearer ${MCP_TOKEN}' } },
      }),
      claude,
    );
    expect(ir.capabilities.mcpAuth.tracker.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(ir.capabilities.mcpAuth.tracker.refs).toEqual([{ kind: 'bearer', envVar: 'MCP_TOKEN' }]);
  });

  it('reads the kimi dedicated field', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({
        name: 'acme-toolkit',
        mcpServers: { tracker: { url: 'https://mcp.example.com/', bearerTokenEnvVar: 'MCP_TOKEN' } },
      }),
    });
    const ir = await normalize(root, kimi);
    expect(ir.capabilities.mcpAuth.tracker.refs).toEqual([{ kind: 'bearer', envVar: 'MCP_TOKEN' }]);
    expect(ir.capabilities.mcpServers.tracker).toEqual({ url: 'https://mcp.example.com/' });
  });

  it('reads both codex env fields', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'acme-toolkit', mcpServers: './.mcp.json' }),
      '.mcp.json': JSON.stringify({
        mcpServers: {
          tracker: { url: 'https://mcp.example.com/', bearer_token_env_var: 'MCP_TOKEN' },
          other: { url: 'https://other.example.com/', env_http_headers: { 'X-Api-Key': 'TRACKER_MCP_TOKEN' } },
        },
      }),
    });
    const ir = await normalize(root, codex);
    expect(ir.capabilities.mcpAuth.tracker.refs).toEqual([{ kind: 'bearer', envVar: 'MCP_TOKEN' }]);
    expect(ir.capabilities.mcpAuth.other.refs).toEqual([
      { kind: 'header-value', header: 'X-Api-Key', envVar: 'TRACKER_MCP_TOKEN' },
    ]);
  });

  it('records placeholders elsewhere with the field path they sit in', async () => {
    const ir = await normalize(
      await claudePlugin({
        local: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'],
          env: { TRACKER_TOKEN: '${MCP_TOKEN}', REGION: 'cn' },
        },
        remote: { url: 'https://${MCP_HOST}/sse', headers: { 'X-Api-Key': 'key-${API_KEY}' } },
      }),
      claude,
    );
    expect(ir.capabilities.mcpAuth.local.refs).toEqual([
      { kind: 'inline', at: ['env', 'TRACKER_TOKEN'], envVar: 'MCP_TOKEN' },
    ]);
    expect(ir.capabilities.mcpAuth.remote.refs).toEqual([
      { kind: 'inline', at: ['headers', 'X-Api-Key'], envVar: 'API_KEY' },
      { kind: 'inline', at: ['url'], envVar: 'MCP_HOST' },
    ]);
  });

  it('leaves servers without any env reference untouched', async () => {
    const ir = await normalize(
      await claudePlugin({ observe: { command: 'npx', args: ['-y', '@example-org/x@^1'] } }),
      claude,
    );
    expect(ir.capabilities.mcpAuth).toEqual({});
    expect(ir.capabilities.mcpServers.observe).toEqual({ command: 'npx', args: ['-y', '@example-org/x@^1'] });
  });
});

describe('the bearer notation converts losslessly in both directions', () => {
  it('claude → kimi: inline header becomes bearerTokenEnvVar', async () => {
    const { servers, envVars } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${TRACKER_MCP_TOKEN}' } } },
      kimi,
    );
    expect(servers.tracker.bearerTokenEnvVar).toBe('TRACKER_MCP_TOKEN');
    expect(servers.tracker.headers).toBeUndefined();

    // 「这个值怎么来的」不再是一条 finding，而是环境变量那一列里的一行
    expect(envVars).toEqual([
      expect.objectContaining({
        name: 'TRACKER_MCP_TOKEN',
        handling: ['bearer-field'],
        where: 'kimi.plugin.json#mcpServers.tracker.bearerTokenEnvVar',
      }),
    ]);
  });

  it('claude → codex: inline header becomes bearer_token_env_var, never a headers key', async () => {
    const { servers, envVars } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${TRACKER_MCP_TOKEN}' } } },
      codex,
    );
    expect(servers.tracker.bearer_token_env_var).toBe('TRACKER_MCP_TOKEN');
    // 实测：codex 插件 .mcp.json 里的 headers 键被整个丢弃 —— 缺陷回归守卫
    expect(servers.tracker.headers).toBeUndefined();
    expect(envVars[0].where).toBe('.mcp.json#mcpServers.tracker.bearer_token_env_var');
    expect(envVars[0].handling).toEqual(['bearer-field']);
  });

  it('kimi → claude: the dedicated field becomes an inline placeholder again', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({
        name: 'acme-toolkit',
        mcpServers: { tracker: { url: 'https://mcp.example.com/', bearerTokenEnvVar: 'TRACKER_MCP_TOKEN' } },
      }),
    });
    const out = project(await normalize(root, kimi), claude);
    expect(serversOf(out).tracker.headers).toEqual({ Authorization: 'Bearer ${TRACKER_MCP_TOKEN}' });
    expect(envVarWhere(out)).toBe(
      '.mcp.json#mcpServers.tracker.headers.Authorization',
    );
  });

  it('codex → claude: both env fields become inline placeholders', async () => {
    const root = await makePluginDir({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'acme-toolkit', mcpServers: './.mcp.json' }),
      '.mcp.json': JSON.stringify({
        mcpServers: {
          tracker: {
            url: 'https://mcp.example.com/',
            bearer_token_env_var: 'TRACKER_MCP_TOKEN',
            env_http_headers: { 'X-Api-Key': 'TRACKER_API_KEY' },
          },
        },
      }),
    });
    const servers = serversOf(project(await normalize(root, codex), claude));
    expect(servers.tracker.headers).toEqual({
      'X-Api-Key': '${TRACKER_API_KEY}',
      Authorization: 'Bearer ${TRACKER_MCP_TOKEN}',
    });
  });

  it('claude → codex: a whole-value header lands in env_http_headers', async () => {
    const { servers } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { 'X-Api-Key': '${TRACKER_API_KEY}' } } },
      codex,
    );
    expect(servers.tracker.env_http_headers).toEqual({ 'X-Api-Key': 'TRACKER_API_KEY' });
    expect(servers.tracker.headers).toBeUndefined();
  });
});

describe('a placeholder the target cannot expand is a LOSS, located to the field', () => {
  it('kimi has no field for a non-Authorization header', async () => {
    const { servers, findings } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { 'X-Api-Key': '${TRACKER_API_KEY}' } } },
      kimi,
    );
    const finding = findingOf(findings, 'mcp.env.not-expanded');
    expect(finding.level).toBe('LOSS');
    expect(finding.where).toBe('kimi.plugin.json#mcpServers.tracker.headers.X-Api-Key');
    expect(finding.message).toContain('TRACKER_API_KEY');
    // 占位符原样留着——凭空发明一个值比留下一个看得见的占位符更坏
    expect(servers.tracker.headers).toEqual({ 'X-Api-Key': '${TRACKER_API_KEY}' });
  });

  it('neither kimi nor codex can express a placeholder embedded in a longer value', async () => {
    for (const target of [kimi, codex]) {
      const { findings } = await convert(
        { tracker: { url: 'https://mcp.example.com/', headers: { 'X-Api-Key': 'key-${TRACKER_API_KEY}' } } },
        target,
      );
      const finding = findingOf(findings, 'mcp.env.not-expanded');
      expect(finding.level).toBe('LOSS');
      expect(finding.where).toBe(
        target.id === 'kimi'
          ? 'kimi.plugin.json#mcpServers.tracker.headers.X-Api-Key'
          : '.mcp.json#mcpServers.tracker.http_headers.X-Api-Key',
      );
    }
  });

  it('locates a placeholder inside a stdio env block', async () => {
    const { servers, findings } = await convert(
      { local: { command: 'node', env: { TRACKER_TOKEN: '${TRACKER_MCP_TOKEN}' } } },
      codex,
    );
    const finding = findingOf(findings, 'mcp.env.not-expanded');
    expect(finding.level).toBe('LOSS');
    expect(finding.where).toBe('.mcp.json#mcpServers.local.env.TRACKER_TOKEN');
    expect(servers.local.env).toEqual({ TRACKER_TOKEN: '${TRACKER_MCP_TOKEN}' });
  });

  it('says nothing about placeholders claude expands on its own', async () => {
    const root = await makePluginDir({
      'kimi.plugin.json': JSON.stringify({
        name: 'acme-toolkit',
        mcpServers: { local: { command: 'node', env: { TRACKER_TOKEN: '${TRACKER_MCP_TOKEN}' } } },
      }),
    });
    const out = project(await normalize(root, kimi), claude);
    expect(out.findings.filter((f) => f.code === 'mcp.env.not-expanded')).toEqual([]);
  });
});

describe('static headers use the key the target profile declares', () => {
  it('codex gets http_headers, never the headers key it ignores', async () => {
    const { servers } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { 'X-Tenant': 'acme' } } },
      codex,
    );
    expect(servers.tracker.http_headers).toEqual({ 'X-Tenant': 'acme' });
    expect(servers.tracker.headers).toBeUndefined();
  });

  it('kimi keeps the headers key', async () => {
    const { servers } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { 'X-Tenant': 'acme' } } },
      kimi,
    );
    expect(servers.tracker.headers).toEqual({ 'X-Tenant': 'acme' });
  });
});

describe('the notation lives in the profile, not the engine', () => {
  it('follows a made-up profile that spells the fields differently', async () => {
    const invented: EcosystemProfile = {
      ...codex,
      fieldDialect: {
        ...codex.fieldDialect,
        mcpAuth: {
          expandsInlineVars: false,
          headersKey: 'static_headers',
          bearerTokenEnvField: 'token_from_env',
          envHeadersField: null,
        },
      },
    };
    const { servers, envVars } = await convert(
      {
        tracker: {
          url: 'https://mcp.example.com/',
          headers: { Authorization: 'Bearer ${TRACKER_MCP_TOKEN}', 'X-Tenant': 'acme' },
        },
      },
      invented,
    );
    expect(servers.tracker.token_from_env).toBe('TRACKER_MCP_TOKEN');
    expect(servers.tracker.static_headers).toEqual({ 'X-Tenant': 'acme' });
    expect(envVars[0].where).toBe('.mcp.json#mcpServers.tracker.token_from_env');
  });
});

describe('scion never renames an environment variable on its own', () => {
  it('keeps a generic name exactly as the author wrote it', async () => {
    const { servers, envVars } = await convert(
      {
        tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
        builds: { url: 'https://builds.example.com/', headers: { Authorization: 'Bearer ${TRACKER_MCP_TOKEN}' } },
      },
      kimi,
    );
    // 作者写 MCP_TOKEN，产物里就是 MCP_TOKEN——用户 export 的名字与上游文档一致
    expect(servers.tracker.bearerTokenEnvVar).toBe('MCP_TOKEN');
    expect(servers.builds.bearerTokenEnvVar).toBe('TRACKER_MCP_TOKEN');
    expect(envVars.map((u) => u.name).sort()).toEqual(['MCP_TOKEN', 'TRACKER_MCP_TOKEN']);
    expect(envVars.every((u) => u.previous === undefined)).toBe(true);
  });

  // scion 曾经拿一份写死的「泛化名清单」去判断哪个名字该加前缀。这类命名枚举不全，
  // 而猜错的代价是产物里出现一个上游文档里根本不存在的变量名。任何名字一律照抄。
  it('treats every name the same, generic-looking or not', async () => {
    for (const name of ['MCP_TOKEN', 'TOKEN', 'API_KEY', 'SECRET', 'TRACKER_TOKEN', 'GH_PAT']) {
      const { servers, envVars } = await convert(
        { tracker: { url: 'https://mcp.example.com/', headers: { Authorization: `Bearer \${${name}}` } } },
        kimi,
      );
      expect(servers.tracker.bearerTokenEnvVar).toBe(name);
      expect(envVars[0].name).toBe(name);
      expect(envVars[0].previous).toBeUndefined();
    }
  });

  it('reports a variable once even when several servers reference it', async () => {
    const { envVars } = await convert(
      {
        tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
        observe: { command: 'node', env: { METRICS_TOKEN: '${MCP_TOKEN}' } },
      },
      codex,
    );
    expect(envVars).toHaveLength(1);
    expect(envVars[0].servers).toEqual(['tracker', 'observe']);
    // where 指向它第一次出现的字段，而不是最后一个
    expect(envVars[0].where).toBe('.mcp.json#mcpServers.tracker.bearer_token_env_var');
    // 同一个变量在两个 server 上落法不同，两种都要说
    expect(envVars[0].handling).toEqual(['bearer-field', 'inline-literal']);
  });

  it('leaves inline placeholders untouched as well', async () => {
    const { servers, envVars } = await convert(
      { local: { command: 'node', env: { TRACKER_TOKEN: '${MCP_TOKEN}' }, args: ['--key=${API_KEY}'] } },
      claude,
    );
    expect(servers.local.env).toEqual({ TRACKER_TOKEN: '${MCP_TOKEN}' });
    expect(servers.local.args).toEqual(['--key=${API_KEY}']);
    expect(envVars.map((u) => u.handling)).toEqual([['inline-expanded'], ['inline-expanded']]);
  });

  it('renames only what --env-name names, and records what it renamed from', async () => {
    const { servers, envVars } = await convert(
      { tracker: { url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } } },
      kimi,
      { envNames: new Map([['MCP_TOKEN', 'ACME_HUB_TOKEN']]) },
    );
    expect(servers.tracker.bearerTokenEnvVar).toBe('ACME_HUB_TOKEN');
    expect(envVars[0]).toMatchObject({ name: 'ACME_HUB_TOKEN', previous: 'MCP_TOKEN' });
  });
});

describe('scion carries variable names, never values', () => {
  it('no test file or fixture contains anything shaped like a real credential', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // 形似真令牌的串。占位符 ${VAR} 一个都不会命中：$ 和 { 不在任何一个字符类里。
    const shapes: Array<{ label: string; shape: RegExp; exempt?: RegExp }> = [
      { label: 'openai-style key', shape: /\bsk-[A-Za-z0-9]{12,}/ },
      { label: 'github token', shape: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
      { label: 'literal bearer token', shape: /\bBearer[ \t]+[A-Za-z0-9._~+/-]{12,}/ },
      // git 的 commit sha 也是一长串十六进制，但它不是凭据，市场条目里本来就要写
      { label: 'long hex secret', shape: /\b[A-Fa-f0-9]{32,}\b/, exempt: /\bsha\b/i },
      { label: 'jwt', shape: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    ];

    const root = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        const lines = (await readFile(abs, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          for (const { label, shape, exempt } of shapes) {
            if (exempt?.test(line)) continue;
            const hit = shape.exec(line);
            if (hit) offenders.push(`${abs}:${i + 1}: ${label} (${hit[0].slice(0, 12)}\u2026)`);
          }
        });
      }
    }

    await walk(root);
    expect(offenders).toEqual([]);
  });
});
