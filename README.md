# scion

Convert an agent plugin package between Claude Code, Codex and Kimi Code — and
say out loud what the move costs.

```bash
npx @xiaoshao9704/scion install owner/repo --to kimi
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
npm install -g @xiaoshao9704/scion
```

Node 20+. Or run it without installing: `npx @xiaoshao9704/scion <command>`.

## Commands

```
scion install <github|path|zip> --to codex,kimi   fetch → convert → install → write registry
scion install <plugin>@<marketplace> --to kimi    same, for one entry of a marketplace you have
  [--dry-run]                                     preview the actions only; change nothing
scion uninstall <name> [--to codex,kimi]          undo an install: deregister, drop files, forget
scion convert <dir> --to kimi [-o <dir>]          convert only, do not install
scion doctor <dir> [--to kimi]                    compatibility report
scion list                                        installed plugins
scion sync [<name>]                               re-convert and reinstall after upstream changes
scion repo <dir> --to codex,kimi [--check]        write target manifests into the plugin repo itself
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

## What scion converts

Metadata, `interface` / presentation fields, skills, commands, agents, MCP
servers and hooks, from Claude to Kimi and from Claude to Codex.

**Hooks convert because the mappings are measured, not guessed.** Kimi's hook
event set is a strict superset of Claude's with identical names, so the
nested `hooks/hooks.json` flattens into the manifest's `hooks` array, with
every dropped detail (`async`, `shell`, an out-of-range timeout) reported as
a LOSS. Codex reads Claude's own envelope format through a `"hooks"` path
reference in the plugin manifest, so the conversion filters out the two
events Codex lacks (`SessionEnd`, `Notification`) and passes the rest
through byte-faithful. A hook that fires at the wrong moment does not fail,
it runs the wrong thing — which is why unsupported events are dropped loudly
instead of remapped speculatively.

Not supported: runtime shims, and the reverse direction (Kimi or Codex back to
Claude).

## Exit codes

`0` success, `1` usage error, `2` BLOCK, `3` LOSS needing `--yes`, `4` a
marketplace converted with entries excluded, `5` an install that failed and was
rolled back. They are per command, and `4` and `5` are close to opposites — see
[docs/exit-codes.md](docs/exit-codes.md) before branching on them.

## Author mode: `scion repo`

`scion repo <dir> --to codex,kimi` is for plugin *authors*: instead of
converting a copy, it writes the target manifests (and derivative files like
`hooks/codex-hooks.json`) into the plugin's own git repository — the files
authors hand-maintain today. Shared bodies (skills, commands, agents) are
never rewritten; body-level losses show up in the report so you fix the
source once for every ecosystem. `--check` regenerates in memory and exits
`6` when the committed manifests drift — put it in CI and manifest rot
becomes a failing build instead of a silent lie.

## Adding an ecosystem

An ecosystem is a declarative profile: manifest paths, directory conventions,
field dialect, frontmatter map, path variables, naming rules, install location,
and the tool-name mapping table. Adding one means adding a profile, not changing
the engine.

The three operations are opt-in per profile: declaring `install` enables
`scion install / sync / uninstall`, declaring `marketplaceDialect` enables
`scion market`, and `manifestPaths` alone enables `scion repo`. A profile that
implements only what its ecosystem actually supports gets a clear error for
the rest, not a broken conversion.

## License

MIT
