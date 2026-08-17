# scion

Convert an agent plugin package between Claude Code, Codex and Kimi Code — and
say out loud what the move costs.

```bash
npx @crowley/scion install owner/repo --to kimi
```

## The problem this solves

"It won't install" is not the problem. Codex and Kimi will happily pull a plugin
that only ships `.claude-plugin/`, and it will look fine.

The problem is what happens next. Skill bodies hard-code tool names and
interaction conventions that only exist in one ecosystem — `TodoWrite`,
`Task(general-purpose)`, `AskUserQuestion`, `${CLAUDE_PLUGIN_ROOT}`. On another
host none of that errors. It just quietly does nothing.

So plugin authors hand-maintain a manifest per ecosystem, and the copies rot.
One real package carried three manifests that disagreed on its own name and
version, with nothing to catch it.

scion normalizes any of the three manifest formats into one intermediate
representation, projects it onto the target's dialect, and installs it — while
reporting every field that could not survive the trip intact.

## Install

```bash
npm install -g @crowley/scion
```

Node 20+. Or run it without installing: `npx @crowley/scion <command>`.

## Commands

```
scion install <github|path|zip> --to codex,kimi   fetch → convert → install → write registry
scion install <plugin>@<marketplace> --to kimi    same, for one entry of a marketplace you have
  [--dry-run]                                     preview the actions only; change nothing
scion convert <dir> --to kimi [-o <dir>]          convert only, do not install
scion doctor <dir> [--to kimi]                    compatibility report
scion list                                        installed plugins
scion sync [<name>]                               re-convert and reinstall after upstream changes
scion market convert <dir> --to kimi|codex        convert a whole marketplace (registers nothing)
scion market show <dir>                           show a marketplace overview

--json  machine-readable output on doctor, install --dry-run, list and market
```

## The report is the point

Every conversion prints findings at three levels:

- **BLOCK** — the target cannot structurally carry this. The run aborts before
  anything is written.
- **LOSS** — it converts, but something is dropped or changes meaning. A real
  install needs `--yes` to accept it.
- **INFO** — target-only fields left empty, values arrived at by directory
  convention rather than declared in the manifest.

Today those losses are all silent. Making them loud is most of what this tool
is for.

`install` and `doctor` also print an **ENV** section listing every environment
variable the plugin reads, and what happened to each one:

```
ENV    environment variables this plugin reads (1)
  · HUB_TOKEN  — used by tracker, builds
      bearer token — kimi reads it from bearerTokenEnvVar when it connects
      name kept exactly as the plugin author wrote it
      export HUB_TOKEN=…   # before starting kimi
  Rename any of these with --env-name OLD=NEW.
```

That section prints even when nothing is wrong. "What do I still have to
export?" is a checklist, not an issue.

## Environment variable names are never changed on their own

scion writes the name the plugin author wrote. It does not namespace, prefix or
otherwise improve it.

Renaming is a real operation with a real cost: the plugin's own docs, its
runtime code and the `export` line in your shell profile all refer to the
author's name. A tool that silently renames leaves you exporting a variable that
exists nowhere upstream — and the plugin does not complain, it just fails to
connect.

If two plugins on one machine genuinely collide, only you know that, so you say
it:

```bash
scion install ./my-plugin --to kimi --env-name MCP_TOKEN=ACME_HUB_TOKEN
```

The mapping is a per-plugin fact, so it is recorded in the ledger. `scion sync`
and later `install` runs replay it and print that they did; without that, a
re-install would quietly revert to the author's name and break the export you
already set up. `--env-name OLD=OLD` goes back to the author's name.

`scion market convert` covers many plugins at once, so it requires the scope:
`--env-name <plugin>:OLD=NEW`. The same variable name in two plugins is not
necessarily the same secret.

## What v1 converts

Metadata, `interface` / presentation fields, skills, commands, agents and MCP
servers, from Claude to Kimi and Claude to Codex.

**Reported but not converted: hooks.** Hooks run shell commands. Getting one
wrong does not mean it stops working — it means it runs the wrong thing. The
three event models do not map one-to-one, and a missing event on the target
either never fires or fires at the wrong moment. `doctor` surfaces them; a
conversion waits for measured evidence.

Not supported: runtime shims, and the reverse direction (Kimi or Codex back to
Claude).

## Exit codes

`0` success, `1` usage error, `2` BLOCK, `3` LOSS needing `--yes`, `4` a
marketplace converted with entries excluded, `5` an install that failed and was
rolled back. They are per command, and `4` and `5` are close to opposites — see
[docs/exit-codes.md](docs/exit-codes.md) before branching on them.

## Adding an ecosystem

An ecosystem is a declarative profile: manifest paths, directory conventions,
field dialect, frontmatter map, path variables, naming rules, install location,
and the tool-name mapping table. Adding one means adding a profile, not changing
the engine.

## License

MIT
