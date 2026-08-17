/**
 * Claude → Kimi 的工具名与交互约定映射。生态级常量，与具体插件无关。
 * 依据：Kimi 侧实测存在 TodoList / Agent(subagent_type) / AskUserQuestion / Skill /
 * FetchURL 等工具，与 Claude 的 TodoWrite / Task(general-purpose) / WebFetch 不同名。
 */
export const CLAUDE_TO_KIMI_INSTRUCTIONS = [
  'Tool mapping for skills authored for Claude Code:',
  '',
  '- When a skill says to ask the user, ask clarifying questions, present multiple-choice options, or wait for a choice, call Kimi Code\'s `AskUserQuestion` tool. Do not render those choices as plain assistant text unless `AskUserQuestion` is unavailable or the session is in auto permission mode.',
  '- For `AskUserQuestion`, provide 1 question with 2-4 concrete options when possible. Put the recommended option first and suffix its label with `(Recommended)`.',
  '- When a skill refers to `TodoWrite`, use Kimi Code\'s `TodoList` tool.',
  '- When a skill says `Task tool (general-purpose)` or asks you to dispatch an implementer/reviewer subagent, use Kimi Code\'s `Agent` tool with a Kimi subagent type. Do not pass `general-purpose` as `subagent_type`.',
  '- For implementation, code review, spec review, and filled subagent prompt templates, call `Agent` with `subagent_type: "coder"`, paste the fully filled prompt into `prompt`, and provide a short `description`.',
  '- For read-only codebase exploration that would take several searches, use `Agent` with `subagent_type: "explore"`.',
  '- For read-only planning or architecture design, use `Agent` with `subagent_type: "plan"`.',
  '- Keep dependent subagent steps sequential. Use multiple `Agent` calls, or `run_in_background: true` only when the work is independent.',
  '- When a skill refers to the `Skill` tool, use Kimi Code\'s native `Skill` tool.',
  '- Use Kimi Code\'s `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `FetchURL`, `WebSearch`, and MCP tools by their actual exposed names.',
  '- When a skill asks to search file contents, use `Grep`; to find files by path or pattern, use `Glob`; to fetch a URL, use `FetchURL`; to search the web, use `WebSearch`.',
  '- `${CLAUDE_PLUGIN_ROOT}` in skill text refers to this plugin\'s installed root directory. Resolve paths relative to that directory.',
  '- If a skill references a Claude-only tool with no Kimi equivalent, say so explicitly instead of silently skipping the step.',
].join('\n');
