# 黄金样本差异归类

`tests/golden.test.ts` 把 Scion 从 `.claude-plugin/plugin.json`（+ 目录扫描）生成的清单，
与 `superpowers`、`metrics-monitor` 两个真实插件里人工维护的 `.kimi-plugin/plugin.json`、
`.codex-plugin/plugin.json` 做结构化 diff。fixture 拷自本机插件缓存：

- `tests/fixtures/golden/superpowers/` ← `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/`
- `tests/fixtures/golden/metrics-monitor/` ← `~/.claude/plugins/cache/metrics-mcp-server/metrics-monitor/923573c8d2b8/`（该缓存副本没有 `.kimi-plugin/`，只有 Claude + Codex 两份清单）

diff 分三类：`onlyGenerated`（只有 Scion 生成的清单有该字段）、`onlyHandWritten`（只有人工清单有）、
`differing`（两边都有但值不同）。每条差异归类为四种之一：

- **scion-bug** — Scion 的转换逻辑错了，需要修代码。
- **manual-rot** — 人工维护的清单里出现了与 Claude 源清单不一致的值（漂移/过期），不改 Scion 去迁就它。
- **hand-written-incomplete** — 人工维护的清单**省略**了 Claude 源清单明确携带的字段。这只是对"缺了这个字段"这一事实的中性描述，不对省略的原因下结论（可能是编辑时的疏漏，也可能是刻意省略——比如认为与另一字段重复——两种情况观察到的现象相同）；无论哪种，Scion 都按设计对所有目标生态一视同仁地携带身份字段，不会为了匹配人工清单的省略而砍掉自己生成的字段。
- **by-design** — 源清单（Claude 侧）根本没有携带这项内容，Scion 不应该、也不能凭空发明。

**结论：本任务未发现 scion-bug。** 下面每一条都归类为 manual-rot、hand-written-incomplete 或 by-design。

## superpowers: Claude → Kimi

| 字段 | 生成值 | 人工值 (`.kimi-plugin/plugin.json`) | 归类 | 结论 |
|---|---|---|---|---|
| `description` | Claude 源清单原文："Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques" | 人工重写："An agentic skills framework and software development methodology." | **by-design** | 人工为 Kimi 单独重写过文案，Claude 清单里没有这份文案的来源，Scion 不发明营销文案，原样沿用 Claude 源值。 |
| `keywords` | `["skills","tdd","debugging","collaboration","best-practices","workflows"]`（Claude 源清单原值） | `["brainstorming","subagent-driven-development","skills","planning","tdd","debugging","code-review","workflow"]`（人工为 Kimi 扩充过） | **by-design** | 同上，Kimi 清单的关键词是人工为该生态单独调优的，Claude 源里没有这份数据，Scion 沿用源值。 |
| `skillInstructions` | Scion 注入的 Claude→Kimi 生态级工具映射常量，`src/toolmap/claude-to-kimi.ts` 里的 `CLAUDE_TO_KIMI_INSTRUCTIONS` | 人工手写的等价说明，用词更贴合 "Superpowers" 品牌（如 "Kimi Code tool mapping for Superpowers skills" vs Scion 泛化的 "Tool mapping for skills authored for Claude Code"） | **by-design** | 两者共享同一套核心工具映射（`AskUserQuestion`/`TodoList`/`Agent(subagent_type)`/`Skill`/`Grep`/`Glob`/`FetchURL`/`WebSearch` 等），但**不是简单的措辞差异**——逐条比对后，Scion 生成的版本比人工版本多出两条人工文本完全没有对应内容的说明：(1) `${CLAUDE_PLUGIN_ROOT}` 指向插件安装后的根目录、路径应相对它解析；(2) 遇到 Claude 专有、Kimi 无对应的工具时要显式说明而不是默默跳过。生成版本是人工版本的**超集**，不是同义改写。分类仍是 by-design：Scion 刻意维护一份生态级常量供所有插件复用，不针对某个插件的手写措辞做匹配；这份常量比该插件的手写版本更完整这件事本身不构成需要修复的问题。 |
| `interface`（onlyHandWritten） | *(不存在，Scion 未生成)* | 4 个字段：`displayName`/`shortDescription`/`longDescription`/`developerName` 等 | **by-design** | Claude 源清单（`.claude-plugin/plugin.json`）完全没有展示层数据，`ir.presentation` 为空对象，Scion 无从推断，留空并各字段各报一条 `presentation.field-dropped` INFO。 |
| `sessionStart`（onlyHandWritten） | *(不存在，Scion 未生成)* | `{"skill": "using-superpowers"}` | **by-design，且是已知缺口** | Claude 清单没有对应字段能推断"安装后自动触发哪个 skill"，Scion 无从推断。记入 v2 待办：可考虑让用户在 CLI 用 `--session-start <skill>` 显式指定。 |
| `repository`（onlyGenerated） | `"https://github.com/obra/superpowers"`（与 Claude 源 `homepage` 相同 URL，随 `IDENTITY_ORDER` 原样带出） | *(未出现在人工 Kimi 清单里)* | **hand-written-incomplete** | `repository` 是 Claude 源清单里明确存在的身份字段，`src/project/manifest.ts` 的 `IDENTITY_ORDER` 对所有目标生态一视同仁地携带该字段（这是设计如此，不因生态而过滤身份字段）。人工维护的 Kimi 清单省略了它——是否因为与 `homepage` 重复而故意省略，还是单纯遗漏，从这一份 fixture 无法判断，也不影响结论：Scion 不会为了匹配这个省略而砍掉自己生成的字段。 |

## metrics-monitor: Claude → Codex

| 字段 | 生成值 | 人工值 (`.codex-plugin/plugin.json`) | 归类 | 结论 |
|---|---|---|---|---|
| `name` | `metrics-monitor`（Claude 源清单值） | `metrics-mcp-server` | **manual-rot** | 这正是设计文档开篇举的漂移案例：人工维护的 Codex 清单把插件名写成了仓库名 `metrics-mcp-server`，与 Claude 清单里的规范名 `metrics-monitor` 不一致。Scion 以 Claude 侧为唯一事实来源，保持 `metrics-monitor` 不变，不去追平这个漂移值。 |
| `version`（Claude 侧 `ir.identity.version` 为 `undefined`） | *(缺失，Scion 未生成 `version` 字段)* | `1.2.1` | **manual-rot** | Claude 源清单（`.claude-plugin/plugin.json`）根本没有 `version` 字段。Scion 忠实反映"源缺失"这一事实，不凭空发明版本号；理想情况下应该是 Claude 清单补上 `version`。当前行为：`version` 缺失，交给 `doctor` 报 INFO 级发现。 |
| `author` | `{"name": "example-org"}`（Claude 源清单值） | `{"name": "example-team"}` | **manual-rot** | 与 `name` 漂移同一性质：Codex 清单单独维护了一个不同的 author 身份，与 Claude 源不一致。Scion 以 Claude 侧为准，不追平。 |
| `description` | Claude 源清单原文："…collector configs, alert rules/events, log search, trace queries, metric series and dashboards, plus a usage guide skill" | 人工改写："…collector configs, alert rules and events, logs, traces, metric series and dashboards"（措辞更精简，且删去了"usage guide skill"） | **by-design** | 人工在维护 Codex 清单时顺手润色过文案，Claude 源里没有这份改写。Scion 不发明/改写文案，原样沿用源值。 |
| `keywords`（onlyHandWritten） | *(不存在，Claude 源清单没有 `keywords`)* | `["monitoring","alarm","logs","trace","mcp","codex"]` | **by-design** | 与 superpowers 的 `keywords` 同理：Claude 源清单完全没有关键词数据，Scion 不发明。 |
| `interface`（onlyHandWritten） | *(不存在)* | 9 个字段（`displayName`/`category`/`defaultPrompt`/… ） | **by-design** | Claude 源清单没有展示层数据，`ir.presentation` 为空，Scion 无从推断，各字段报 INFO。 |
| `license`（onlyGenerated） | `"UNLICENSED"`（Claude 源清单值，随 `IDENTITY_ORDER` 原样带出） | *(未出现在人工 Codex 清单里)* | **hand-written-incomplete** | Claude 源清单明确写了 `license: "UNLICENSED"`。Scion 按设计对所有目标生态一视同仁地携带身份字段。人工维护的 Codex 清单省略了它，观察到的是"缺了这个字段"，不需要改 Scion 去匹配这个省略。 |
| `repository`（onlyGenerated） | `"https://github.com/example-org/metrics-mcp-server.git"`（Claude 源清单值） | *(未出现在人工 Codex 清单里)* | **hand-written-incomplete** | 同上，Claude 源清单里有 `repository`，Scion 原样带出；人工 Codex 清单省略了它。 |

补充：`mcpServers` 字段在 Codex 侧生成为 `"./.mcp.json"`（路径引用），与人工 Codex 清单的写法一致（见
`tests/golden.test.ts` 中 `carries mcpServers across as a path reference` 用例），未出现在上表中。

### 修订：Codex `.mcp.json` 里 server 条目的形状已变（MCP 鉴权任务）

上面那句「路径引用」仍然成立，但**被引用文件里每个 server 条目的写法这次改了**，因此本节的结论
需要一条补记：

实测（记录实收 `Authorization` 头的探针 server + `codex exec` 非交互模式）确认，Codex **完全忽略**插件
`.mcp.json` 里的 `headers` 键——探针收到的是 `authorization=null`。也就是说此前任何带鉴权 MCP server
的插件转到 Codex 之后，鉴权头会整个消失，且没有任何 finding 提示。这是一条 **scion-bug**（本仓库第一条），
不属于上面三类「不改 scion 去迁就」的差异。修复后的写法：

| 源（Claude）写法 | Codex 产出 | 依据 |
|---|---|---|
| `headers.Authorization: "Bearer ${VAR}"` | `bearer_token_env_var: "VAR"` | 实测有效 |
| `headers.X: "${VAR}"`（整个值就是一个变量） | `env_http_headers: { "X": "VAR" }` | 实测有效，且对任意头名有效 |
| `headers.X: "acme"`（静态值） | `http_headers: { "X": "acme" }` | 实测有效 |

三格都在**插件 `.mcp.json`** 里用同一套探针验过（不是只在全局 `config.toml` 里验的）：静态头经
`http_headers` 原样到达；`env_http_headers` 在自定义头 `X-Probe-Custom` 上收到了环境变量的值，说明它是
「头名→变量名」的通用映射表，不限 Authorization。依据写在 `src/profiles/codex.ts` 的注释里，省得下一个人
重新怀疑一遍。

两个黄金样本的 diff 结论**不受影响**：`superpowers` 没有 mcpServers，`metrics-monitor` 的 `.mcp.json`
只有一个 stdio server（`npx` + args），不含任何头或环境变量引用，转换后逐字节不变。也就是说这次形状变更
在现有黄金样本上没有可观察差异，回归守卫改由 `tests/mcp-env-auth.test.ts` 承担（`claude → codex` 产出里
断言 `headers` 键不存在）。

## 结论汇总

- **未发现 scion-bug。** 所有差异要么是人工清单相对 Claude 源清单出现了不一致的值（manual-rot：`name`/
  `version`/`author`），要么是人工清单省略了 Claude 源清单明确携带的身份字段（hand-written-incomplete：
  `repository`/`license`），要么是 Claude 源清单本就没有携带、Scion 不应凭空发明的内容（by-design）。
- **manual-rot 与 hand-written-incomplete 两类差异都不改 Scion 去迁就。** 这恰恰是本工具存在的意义——
  `doctor`/`convert` 应该以 Claude 侧（或未来支持多向转换时的"当前操作生态"）为唯一事实来源，Scion 按设计对
  所有目标生态一视同仁地携带身份字段，不因某个手工维护的目标清单漂移或省略了什么就跟着改变自己的输出。
- **by-design 类差异中，`superpowers.sessionStart` 是一个已知产品缺口**，记入 v2 待办：让用户能显式指定
  `--session-start <skill>`，而不是完全放弃这个字段。

## Task 24: `scion market convert` — team-skills marketplace（Claude → Codex）

`tests/market-command.test.ts` 之外的黄金样本验证：把 `team-skills` 仓库自己的
`.claude-plugin/marketplace.json`（源）转换到 Codex，与该仓库里**人工维护**的
`.agents/plugins/marketplace.json` 结构化对比。

**修正记录**：本节最初的验证用 `--as team-skills` 绕开真实 `codex` 调用，依据的是当时代码里
「传了 `--as` 就跳过冲突核对」的逻辑。评审发现这条逻辑本身是错的（`--as` 换的是要核对哪个名字，不是要不
要核对），而这台机器上 `team-skills` 恰好已经注册在真实 Codex 里，所以那次验证在无意中精确复现了这个
漏洞——冲突真实存在，却因为用了 `--as` 而完全没被检测到。已修复 `src/commands/market.ts`：核对冲突的条件
从 `targetProfile.id === 'codex' && !requestedName` 改为单纯 `targetProfile.id === 'codex'`，检查的名字
始终是 `effectiveName`（即将实际写进产物的那个名字，无论来自源清单还是 `--as`）。修复后用注入的假 runner
重跑了下面两条场景，不再依赖 `--as` 来规避真实调用，也没有触发任何真实 `codex` 进程：

```bash
# 场景一：假 runner 报告 team-skills 已注册（复现本机的真实状态）→ 期望冲突 BLOCK
node <script that calls runMarket(['convert', '/Users/you/code/team-skills', '--to', 'codex'], io,
  { home: homedir(), run: fakeRunnerReturning('team-skills  /Users/you/code/team-skills\n...') })>
# → BLOCK marketplace.name-conflict，退出码 2，~/.scion/markets/ 下未写出任何文件

# 场景二：假 runner 报告没有同名市场 → 期望正常转换
node <同上，但 fakeRunner 返回不含 team-skills 的列表>
# → 正常产出，退出码 0

diff <(python3 -m json.tool ~/.scion/markets/team-skills/codex/.agents/plugins/marketplace.json) \
     <(python3 -m json.tool /Users/you/code/team-skills/.agents/plugins/marketplace.json)
```

场景一确认了修复生效：同样的"team-skills 已注册"事实，这次被正确拦下，产出目录在拦截前保持空。场景二
产出的 catalog 用于下面的结构化对比，内容与修复前那次（错误地跳过检查但产出内容相同）逐字节一致——问题
出在漏掉了检查这一步，不在转换逻辑本身，所以下表的差异分类不受影响。

`show` 正确列出 team-skills 的 2 个条目（`team-api-docs`、`team-dev-env`），转换产出的 catalog 与人工
维护版本只有一处差异：

| 字段 | 生成值 | 人工值 (`.agents/plugins/marketplace.json`) | 归类 | 结论 |
|---|---|---|---|---|
| `interface.displayName` | `"team-skills"`（`src/marketplace/project.ts` 的 `catalog.interface = { displayName: mp.displayName ?? mp.name ?? 'Marketplace' }`，Claude 源 catalog 没有 `displayName`，`mp.displayName` 为 `undefined`，退化取 `mp.name`） | `"Team Skills"`（更友好的展示名，首字母大写、加空格） | **by-design** | 源清单 `.claude-plugin/marketplace.json` 只有 `name`/`owner.name`（"Team Skills Owners"），完全没有携带任何形式的展示名；`owner.name` 是团队名，不能当作 `displayName` 的候选值（语义不同，硬套是错误推断，不是"转换"）。Scion 不能凭空发明这份文案，按设计退化为复用 `name` 字段。人工维护的 Codex 清单额外做了措辞打磨，这份打磨在源清单里没有依据，Scion 不追平。 |

其余字段（`name`、每个条目的 `source`/`policy`/`category`）逐字节一致，两个本地条目均正确转换、`source` 都
被改写为指向输出目录下的 `./plugins/<name>`。

**结论：未发现 scion-bug。** 唯一差异是 `interface.displayName` 的 by-design 缺口——与 Task 17 里
`superpowers`/`metrics-monitor` 的 `interface` 展示层字段缺口同一性质：源清单不携带展示层数据时，Scion 不
发明。若要在 v2 里补上，需要要么让 `owner.name` 有条件地当作展示名回退（有语义风险，团队名不适合直接当
`displayName`），要么在 marketplace 转换里也支持类似 `--session-start` 那样的显式 CLI 覆盖参数（例如
`--display-name <text>`）。本任务不为此加新参数——不在 spec 范围内，且只有这一个样本，不足以判断这是普遍
需求还是这个仓库的个例。
