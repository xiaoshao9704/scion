import { describe, it, expect } from 'vitest';
import { normalize } from '../src/normalize/index.js';
import { loadProfile } from '../src/profiles/loader.js';
import { project } from '../src/project/index.js';
import { makePluginDir } from './helpers/tmp.js';

const claude = loadProfile('claude');
const kimi = loadProfile('kimi');
const codex = loadProfile('codex');

const HOOKS_JSON = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|clear|compact',
        hooks: [
          {
            type: 'command',
            command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
            shell: 'bash',
            async: false,
          },
        ],
      },
    ],
  },
});

async function pluginWithHooks(hooksJson: string) {
  const root = await makePluginDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
    'hooks/hooks.json': hooksJson,
    'hooks/run-hook.cmd': '#!/bin/bash\n',
  });
  return normalize(root, claude);
}

describe('hooks conversion claude → kimi', () => {
  it('converts hooks.json into the flat kimi manifest array', async () => {
    const ir = await pluginWithHooks(HOOKS_JSON);
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toEqual([
      {
        event: 'SessionStart',
        matcher: 'startup|clear|compact',
        command: '"./hooks/run-hook.cmd" session-start',
      },
    ]);
    // 转换成功后不再报 not-converted
    expect(out.findings.some((f) => f.code === 'hooks.not-converted')).toBe(false);
  });

  it('rewrites the plugin-root variable as a relative path without a LOSS', async () => {
    // Kimi 给 hook 进程 cwd=插件根（enabledHooks 实测），相对路径是保真的——INFO 即可
    const ir = await pluginWithHooks(HOOKS_JSON);
    const out = project(ir, kimi);
    const f = out.findings.find((n) => n.code === 'hooks.pathvar-relativized');
    expect(f?.level).toBe('INFO');
  });

  it('drops an event kimi does not have and reports the loss', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: {
          MadeUpEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'y' }] }],
        },
      }),
    );
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toEqual([{ event: 'Stop', command: 'y' }]);
    const f = out.findings.find((n) => n.code === 'hooks.event-unsupported');
    expect(f?.level).toBe('LOSS');
    expect(f?.message).toContain('MadeUpEvent');
  });

  it('clamps timeout into kimi range and reports the change', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 5000 }] }] },
      }),
    );
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toEqual([{ event: 'Stop', command: 'x', timeout: 600 }]);
    expect(out.findings.find((n) => n.code === 'hooks.timeout-clamped')?.level).toBe('LOSS');
  });

  it('keeps an in-range timeout as-is', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 30 }] }] },
      }),
    );
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toEqual([{ event: 'Stop', command: 'x', timeout: 30 }]);
    expect(out.findings.some((n) => n.code === 'hooks.timeout-clamped')).toBe(false);
  });

  it('skips a non-command hook type and reports the loss', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'x' }] }] },
      }),
    );
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toBeUndefined();
    expect(out.findings.find((n) => n.code === 'hooks.type-unsupported')?.level).toBe('LOSS');
  });

  it('reports dropped async/shell fields', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'x', async: true, shell: 'zsh' }] }],
        },
      }),
    );
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toEqual([{ event: 'Stop', command: 'x' }]);
    const dropped = out.findings.filter((n) => n.code === 'hooks.field-dropped');
    expect(dropped.map((n) => n.message).join(' ')).toMatch(/async/);
    expect(dropped.map((n) => n.message).join(' ')).toMatch(/shell/);
  });

  it('falls back to not-converted when hooks.json is not parseable', async () => {
    const ir = await pluginWithHooks('{ not json');
    const out = project(ir, kimi);
    expect(out.manifest.hooks).toBeUndefined();
    const f = out.findings.find((n) => n.code === 'hooks.not-converted');
    expect(f?.level).toBe('LOSS');
    expect(f?.message).toMatch(/parse/);
  });

  it('reports nothing when the plugin has no hooks (kimi)', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
    });
    const out = project(await normalize(root, claude), kimi);
    expect(out.manifest.hooks).toBeUndefined();
    expect(out.findings.some((n) => n.code.startsWith('hooks.'))).toBe(false);
  });
});

describe('hooks conversion claude → codex', () => {
  it('keeps the Claude envelope, written as a codex-hooks.json path reference', async () => {
    const ir = await pluginWithHooks(HOOKS_JSON);
    const out = project(ir, codex);
    expect(out.manifest.hooks).toBe('./hooks/codex-hooks.json');
    const file = out.files.find((f) => f.path === 'hooks/codex-hooks.json');
    const parsed = JSON.parse(file!.content);
    expect(parsed.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|clear|compact',
        hooks: [
          {
            type: 'command',
            command: '"./hooks/run-hook.cmd" session-start',
            shell: 'bash',
            async: false,
          },
        ],
      },
    ]);
    expect(out.findings.some((f) => f.code === 'hooks.not-converted')).toBe(false);
  });

  it('drops the events codex does not have and reports each loss', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: 'x' }] }],
          Notification: [{ hooks: [{ type: 'command', command: 'y' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'z' }] }],
        },
      }),
    );
    const out = project(ir, codex);
    const parsed = JSON.parse(out.files.find((f) => f.path === 'hooks/codex-hooks.json')!.content);
    expect(Object.keys(parsed.hooks)).toEqual(['Stop']);
    const dropped = out.findings.filter((f) => f.code === 'hooks.event-unsupported');
    expect(dropped.map((f) => f.message).join(' ')).toMatch(/SessionEnd/);
    expect(dropped.map((f) => f.message).join(' ')).toMatch(/Notification/);
  });

  it('emits nothing when every event is unsupported', async () => {
    const ir = await pluginWithHooks(
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
    );
    const out = project(ir, codex);
    expect(out.manifest.hooks).toBeUndefined();
    expect(out.files.some((f) => f.path === 'hooks/codex-hooks.json')).toBe(false);
  });

  it('mentions the plugin_hooks feature gate as an INFO', async () => {
    const ir = await pluginWithHooks(HOOKS_JSON);
    const out = project(ir, codex);
    const f = out.findings.find((n) => n.code === 'hooks.converted');
    expect(f?.level).toBe('INFO');
    expect(f?.message).toContain('plugin_hooks');
  });

  it('reports nothing when the plugin has no hooks', async () => {
    const root = await makePluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
    });
    const out = project(await normalize(root, claude), kimi);
    expect(out.manifest.hooks).toBeUndefined();
    expect(out.findings.some((n) => n.code.startsWith('hooks.'))).toBe(false);
  });
});
