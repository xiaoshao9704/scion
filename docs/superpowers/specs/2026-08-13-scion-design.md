# Scion 设计文档

日期：2026-08-13
状态：待评审

## Context

Claude Code、Codex、Kimi Code 三个生态各有插件体系。同一个插件要在三边都能用，作者今天的做法是**在仓库里手工维护多份清单**。

superpowers 仓库里并存 9 套：`.claude-plugin/`、`.codex-plugin/`、`.kimi-plugin/`、`.cursor-plugin/`、`.devin-plugin/`、`.hermes-plugin/`、`.opencode/`、`.pi/`、`.agents/`，外加 `AGENTS.md` / `GEMINI.md` / `gemini-extension.json`。

手工维护的代价已经在真实仓库里显形。metrics-monitor 的三份清单：

| 字段 | Claude | Kimi | Codex |
|---|---|---|---|
| `name` | metrics-monitor | metrics-monitor | **metrics-mcp-server** |
| `version` | *(缺)* | 1.2.2 | **1.2.1** |
| `skills` | *(缺，靠默认约定)* | `./skills/` | `./skills/` |
| `mcpServers` | *(缺)* | 内联对象 | `./.mcp.json` 路径 |
| `interface` | — | 4 字段 | 9 字段 |

名字漂移、版本漂移，且没有任何机制能发现。

### 一个必须先澄清的事实

**"装不上"不是问题。** Codex 本地缓存里已有整个 `claude-plugins-official` 市场，抽查 6 个插件中 4 个（context7、commit-commands、skill-creator、code-simplifier）**只有 `.claude-plugin/`、没有 `.codex-plugin/`**，Codex 照样拉取并缓存了。Kimi 也直接从 GitHub 装了 superpowers 原仓库。

真正的问题是**装上之后行为不对，且静默降级**：skill 正文里硬编码了 Claude 专有的工具名和交互约定（`TodoWrite`、`Task(general-purpose)`、`AskUserQuestion`、`${CLAUDE_PLUGIN_ROOT}`），换生态后不报错，只是不生效。

这解释了 superpowers 为什么要手写一段 `skillInstructions` 做工具名重映射。而那段内容其实与 superpowers 无关——它是 *Claude→Kimi 的通用映射*，是**生态级常量，不是插件级变量**。

Scion 的价值即由此确定：把生态级常量写一次，让所有插件复用。

## 目标

- 用一条统一管线，在 Claude / Codex / Kimi 之间转换插件包，并安装到本机。
- 转换结果不仅"能装上"，还要在目标生态"行为正确"。
- 无法无损转换的部分，**显式报告**，绝不静默丢弃。
- 新增生态 = 新增一份声明式 profile，不改引擎。

## 非目标

- 不产出可提交回仓库的多生态清单（那是插件作者视角，本工具面向终端用户）。
- 不做镜像市场 / 批量搬运。
- 不生成运行时垫片代码（`.opencode/*.js`、`.pi/*.ts` 这类需要真写代码的目标，v1 不支持）。
- 不做 hooks 转换（见"v1 范围"）。

## 核心洞察：差异分三层

| 层 | 内容 | 自动化程度 |
|---|---|---|
| **L1 机械** | 清单路径改名（`.claude-plugin/plugin.json` ↔ `kimi.plugin.json`）、marketplace 条目 `name`↔`id`、省略字段补默认值 | 100%，无损 |
| **L2 表示法** | `mcpServers` 内联↔路径引用、hooks 事件名 casing、路径变量替换、`interface` 字段裁剪/补齐 | 规则化，可测 |
| **L3 语义** | 工具名与交互约定映射（`TodoWrite`→`TodoList`、`Task(general-purpose)`→`Agent(subagent_type:"coder")`、`AskUserQuestion` 可用性） | 需人工编写，**但每个生态对只写一次** |

L3 是整个设计成立的支点：它是生态级常量，不随插件变化。

## 架构

```
任一生态清单 ──┐
实际目录扫描 ──┼─→ 正规化 ─→ Plugin IR ─→ 投影 ─→ 目标清单 ─→ 安装 + 注册
隐式默认约定 ──┘                  ↑                    ↑
                          ecosystem profile      L3 工具映射表
```

### 两条原则

1. **不信清单，信文件系统。** Claude 的 `plugin.json` 连 `skills` 都可以不写，靠目录约定。正规化阶段扫描真实目录，把隐式约定显式化，同时发现"清单声明了但文件不存在"的情况。
2. **profile 是声明式数据，不是代码。** 一个生态一份 profile。加 Cursor / Gemini / OpenCode 只需加 profile。

### Plugin IR

三方字段的并集，分四组：

```
identity      name, version, description, author{name,email,url},
              homepage, repository, license, keywords[]
capabilities  skills[], commands[], agents[], hooks[], mcpServers{}
presentation  displayName, shortDescription, longDescription, developerName,
              category, capabilities[], defaultPrompt[], brandColor,
              icon, logo, screenshots[], websiteURL,
              privacyPolicyURL, termsOfServiceURL
runtime       sessionStart, skillInstructions, systemPrompt, systemPromptPath
```

每个 IR 字段附带 `provenance`：值来自清单显式声明、目录约定推断，还是 profile 默认。转换报告和 doctor 都依赖这个。

### Ecosystem Profile

每份 profile 声明：

- `manifestPaths`：候选清单路径及优先级。Kimi 为 `kimi.plugin.json` > `.kimi-plugin/plugin.json`（文档明确：两者并存时前者优先）。
- `conventions`：省略字段的默认目录（`skills/`、`commands/`、`agents/`）。
- `fieldDialect`：字段名映射与表示法（`mcpServers` 内联 vs 路径引用）。
- `frontmatterMap`：commands / agents 的 frontmatter 字段映射，含有损标记。
- `pathVars`：路径变量替换规则（`${CLAUDE_PLUGIN_ROOT}` → 目标变量或相对路径）。
- `naming`：命名空间处理。Codex 实测把 `/plugin:command` 扁平化为 `plugin-command.md`。
- `install`：安装目录与注册表写法。
- `toolMap`：L3 工具名映射表（按源→目标生态对）。

### 已确认的目标端落地位置

| 生态 | 插件根 | 注册表 |
|---|---|---|
| Claude | `~/.claude/plugins/cache/<market>/<plugin>/<version>/` | `known_marketplaces.json` / `installed_plugins.json` |
| Kimi | `~/.kimi-code/plugins/managed/<id>/` | `~/.kimi-code/plugins/installed.json`（`{id, root, source, enabled, installedAt, updatedAt, originalSource, github{...}}`） |
| Codex | `~/.codex/plugins/cache/<market>/<plugin>/<version>/` | 待补测（`~/.codex/skills/` 另有 `d-skills.lock.json`） |

## 字段映射

### plugin manifest

| IR | Claude | Kimi | Codex | 备注 |
|---|---|---|---|---|
| identity.* | 同名 | 同名 | 同名 | 直通 |
| name 约束 | — | `[a-z0-9][a-z0-9_-]{0,63}` | — | Kimi 有正则约束，需校验 |
| skills | 约定 `skills/` | `skills` | `skills` | 省略时补默认 |
| commands | 约定 `commands/` | `commands` | 待补测 | |
| agents | 约定 `agents/` | `agents`（默认 `agents/`） | 待补测 | |
| mcpServers | `.mcp.json` | 内联对象 | 路径引用 | 两种表示法互转 |
| presentation.* | — | `interface`（4 字段） | `interface`（9 字段） | Claude 侧无对应，转入时留空 |
| runtime.skillInstructions | — | `skillInstructions` | — | 由 L3 映射表生成 |
| runtime.sessionStart | — | `sessionStart.skill` | — | |

Kimi 单字段上限 32KB，全部启用插件的指令预算 64KB——生成 `skillInstructions` 时必须校验。

### agents frontmatter

| Claude | Kimi | 损耗 |
|---|---|---|
| `name` `description` | `name` `description` | 无 |
| `model: sonnet\|opus\|haiku` | `model_preference: primary\|secondary` | **有损**：具体模型名无对应，只能落档位 |
| `tools` | `tools` | 无（Kimi 另有 `disallowedTools`，转出时留空） |
| — | `whenToUse` `override` `subagents` | Kimi 独有 |

Kimi 工具匹配规则：内置/用户工具精确匹配（大小写敏感），MCP 工具支持 glob（`mcp__github__*`）。

### commands frontmatter

| Claude | Codex | Kimi | 损耗 |
|---|---|---|---|
| `description` | `description` | `description` | 无 |
| `argument-hint` | `argument-hint` | 未见于文档 | 转 Kimi 时待确认 |
| `allowed-tools` | **无对应** | **无对应** | **有损**：静默放宽权限，必须报告 |
| `$ARGUMENTS` | 支持 | 支持 | 无 |
| `` !`cmd` `` 内联 bash | **待验证** | **待验证** | 未确认前按有损处理 |

## scion doctor

转换前后都可运行，输出三级：

- **BLOCK**：目标端结构上无法承载（如 name 不符合 Kimi 正则、字段超 32KB）。
- **LOSS**：能转但有损，逐项列出——`allowed-tools` 丢失、`model` 降为档位、hooks 未转换、内联 bash 未验证。
- **INFO**：目标端独有字段留空、provenance 为推断而非显式声明的字段。

**LOSS 是本工具的主要产出之一**，不是附属信息。今天这些损耗全部是静默的。

## CLI

```
scion install <github|path|zip> --to codex,kimi   # 拉取 → 转换 → 安装 → 写注册表
scion convert <dir> --to kimi [-o <dir>]          # 只转换，不安装
scion doctor <dir> [--to kimi]                    # 兼容性报告
scion list                                        # 已装：来源、目标生态、是否过期
scion sync [<name>]                               # 上游更新后重新转换安装
```

`install` 默认先跑 doctor，有 BLOCK 则中止，有 LOSS 则打印并要求确认（`--yes` 跳过）。

## 验证策略

**黄金样本测试是主要手段。** superpowers 和 metrics-monitor 仓库里已有人工维护的三方清单，直接作为 fixture：

- 以 `.claude-plugin/plugin.json` + 目录扫描为输入，转换到 Kimi / Codex；
- 输出与仓库中人工维护的 `.kimi-plugin/plugin.json`、`.codex-plugin/plugin.json` 做结构化 diff；
- 差异要么是 Scion 的 bug，要么是人工清单的腐烂（如 metrics-monitor 的 name/version 漂移）。两者都有价值，需逐条归类而非盲目对齐。

补充：

- profile 加载与 IR 正规化的单元测试（重点覆盖隐式默认值推断）。
- 端到端：转换 → 安装到本机 Kimi → `kimi` 启动确认插件被识别、skill 可触发。Codex 侧同理。
- doctor 的 LOSS 检测用构造样例（含 `allowed-tools` 的 command、含 `model:` 的 agent）。

## v1 范围

**做：** 元数据 / `interface` / skills / mcpServers / commands / agents 的转换与安装；doctor；Claude → Kimi、Claude → Codex 两个方向。

**只报告不转换：** hooks。理由——hooks 实际执行 shell 命令，转错不是失效而是跑错东西；且三方事件模型未必一一对应，目标端缺失事件会静默不触发或在错误时机触发。先用 doctor 暴露，积累实测后再做。

**不做：** 运行时垫片（`.opencode/*.js`、`.pi/*.ts`）；反向（Kimi/Codex → Claude）；marketplace 批量转换。

## 技术栈

TypeScript + Node，通过 npm 分发（`npx @scion/cli`）。

理由：目标用户本机必然已有 Claude Code / Codex / Kimi，Node 环境几乎确定存在；`npx` 可零安装试用；与插件生态（多为 JS/TS）同构，后续若要生成 `.opencode/*.js`、`.pi/*.ts` 垫片是顺手的。

- `zod` — IR 与 profile 的 schema 校验
- `gray-matter` — commands / agents 的 frontmatter 解析与回写
- `vitest` — 单元测试与黄金样本 diff

## 待确认事项

实现期需要补测的事实（不阻塞设计）。**2026-08-25 实测已全部核对**（codex-cli 0.133.0、Kimi 0.36.1，二进制与本机安装状态取证）：

1. Codex 的 commands / agents 目录约定与安装位置——本机只观察到 `~/.codex/prompts/`（frontmatter 为 `description` + `argument-hint`）和 `~/.codex/rules/`，未见 `agents/`。
   **结论**：目标端确无 `agents/` 目录约定；但官方 marketplace 原样安装带 `agents/` 的插件（cache 里 code-simplifier、didi-ee-toolkit），二进制有 subagent 机制（SubagentStart/Stop hook 事件）。commands 支持 `$ARGUMENTS` / `$ARGUMENTS[N]` / `$N` 与 `argument-hint`（二进制帮助文本原文）。agents 是否真被加载仍未验证——维持直通 + doctor INFO。
2. Codex 插件注册表的写法（`~/.codex/plugins/cache/` 之外是否有 lock 文件）。
   **结论**：没有 lock 文件。注册状态全在 `config.toml` 的 `[plugins."<name>@<marketplace>"]` 与 `[marketplaces.<name>]`（source 支持本地路径 / git URL / sparse_paths），缓存为 `plugins/cache/<market>/<plugin>/<version|local>/`。scion 走 `codex plugin marketplace add` CLI 的策略正确，无需自己写注册表。
3. Claude command 的 `` !`cmd` `` 内联 bash 在 Codex / Kimi 是否支持。
   **结论**：**Kimi 不支持**——二进制内 `expandCommandArguments` 只做 `$ARGUMENTS` 字符串替换，`` !`cmd` `` 原文进入模型上下文、命令不执行（profile `inlineBash: 'literal'`，doctor 报 LOSS）。**Codex 强证据支持但未运行时验证**——命令模板 token 表里 `$ARGUMENTS`、`{{}}` 与 `` !` `` 并列，且官方 marketplace 原样安装带内联 bash 的 commit-commands（profile `inlineBash: 'unverified'`，doctor 报 INFO）。
4. Kimi commands 是否支持 `argument-hint`。
   **结论**：**支持**——TUI 将其渲染为补全时的灰色提示文本（"Splice a dimmed argument-hint ghost string…"）。profile 改为无损照搬。

## hooks 实测证据（2026-08-25 dogfood）

v1 推迟 hooks 转换时说"积累实测后再做"。用 superpowers 6.3.0 完整 dogfood
`install --to codex,kimi` 后取到的证据（codex-cli 0.133.0、Kimi 0.36.1）：

**三方事件模型（均取自二进制）：**

- Claude：`{hooks: {事件名: [{matcher, hooks: [{type:"command", command, timeout, async?, shell?}]}]}}`，
  事件名 PascalCase，`${CLAUDE_PLUGIN_ROOT}` 由宿主在执行前展开。
- Kimi：**事件枚举是 Claude 的严格超集**（20 个：PreToolUse、PostToolUse、
  PostToolUseFailure、PermissionRequest、PermissionResult、UserPromptSubmit、
  UserPromptQueued、TurnStarted、Stop、StopFailure、Interrupt、SessionStart、
  SessionEnd、SessionHeartbeat、SubagentStart、SubagentStop、TaskStarted、
  PreCompact、PostCompact、Notification），Claude 的每个事件都在其中、同名同
  casing。插件 hooks 声明在 `kimi.plugin.json` 的 `hooks` 字段，**扁平数组**
  `[{event, matcher?, command, timeout?}]`，timeout 为秒、int、1–600。运行时
  `enabledHooks()` 给每条 hook 附 `cwd: 插件根` 和 env `KIMI_PLUGIN_ROOT` /
  `KIMI_CODE_HOME`。二进制内**没有** `CLAUDE_PLUGIN_ROOT` 字符串——不展开
  Claude 的路径变量；`$KIMI_PLUGIN_ROOT` 靠 shell env 在运行时解析，或直接用
  相对路径（cwd 已是插件根）。
- Codex：`~/.codex/hooks.json` 用的就是 Claude 的信封结构（实机配置可证：
  `{hooks: {UserPromptSubmit: [{hooks: [{type:"command", command, timeout}]}]}}`），
  事件集（二进制）：PreToolUse、PermissionRequest、PostToolUse、PreCompact、
  PostCompact、SessionStart、SubagentStart、SubagentStop，另在实机配置中见
  UserPromptSubmit。插件级 hooks 如何声明未确认。

**对 hooks 转换的含义：** Claude → Kimi 是结构改写而非语义猜测——事件名照搬
（超集保证全部命中）、嵌套转扁平、`${CLAUDE_PLUGIN_ROOT}` → `$KIMI_PLUGIN_ROOT`
（或依赖 cwd 转相对路径）、timeout 需换算并夹到 1–600 秒、Claude 的 `async` /
`shell` 字段 Kimi 无对应（丢弃需报 LOSS）。当年"三方事件模型未必一一对应"的
担忧对 Kimi 不成立，对 Codex 部分成立（缺 Stop / SessionEnd 等，且插件级声明
方式未知）。

**dogfood 发现的产品缺口：** 在目标端用宿主自己的手段卸载（`codex plugin
remove superpowers@scion`）后，scion 台账仍显示 `[registered]`——没有
`scion uninstall`，`list` 对 codex 端也不做漂移检测（kimi 端会显示
not registered）。

### 补充（同日晚些时候）：Codex 插件级 hooks 已确认，转换已实现

上文"插件级 hooks 如何声明未确认"已解决。实测（codex-cli 0.133.0 二进制 +
本机真实插件 member-skills）：

- 插件在 `.codex-plugin/plugin.json` 里用路径引用声明：`"hooks": "./hooks/codex-hooks.json"`，
  与 mcpServers 的路径引用风格一致；文件内容就是 Claude 的信封格式，逐字段相同。
- 事件枚举（二进制 ManagedHooksRequirements，两处一致）：PreToolUse、PermissionRequest、
  PostToolUse、PreCompact、PostCompact、SessionStart、UserPromptSubmit、SubagentStart、
  SubagentStop、Stop——比 Claude 少 SessionEnd 和 Notification。
- hooks 真实执行：core/src/hook_runtime.rs，"Command blocked by PreToolUse hook"。
- 注意：plugin_hooks 在实验特性开关列表里，可能需要用户启用。
- 真实插件同时手工维护 hooks.json（Claude）与 codex-hooks.json（内容雷同）——
  又一个 scion 要消灭的手工多份清单案例。

因此 Claude → Codex 的 hooks 转换是**过滤加透传**：滤掉两个目标没有的事件（LOSS）、
改写路径变量，其余原样写成 hooks/codex-hooks.json，清单指过去。三个生态的 hooks
至此全部打通，v1 当年最大的推迟项关闭。
