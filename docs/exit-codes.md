# Exit codes

Every `scion` command exits `0` on success and non-zero otherwise. The codes are
**per command**: the same number can mean different things under different
subcommands, so branch on the command *and* the code, never on the code alone.

The one pair worth memorising is `market convert`'s `4` and `install`'s `5` —
see [Codes that are easy to confuse](#codes-that-are-easy-to-confuse).

## All codes at a glance

| Code | Meaning | Emitted by |
|---|---|---|
| `0` | Success. | every command |
| `1` | Usage error — bad or missing arguments, unknown command, unknown plugin name. Nothing was read or written. | every command |
| `2` | BLOCK findings; the run was aborted before anything was written. | `doctor`, `convert`, `install`, `market convert` |
| `3` | LOSS findings that need explicit acceptance; re-run with `--yes`. Nothing was written. | `install` |
| `4` | Finished, but the output is **incomplete**: some catalog entries were excluded. | `market convert` |
| `5` | An install failed and was **rolled back**; the target is back in its pre-install state. | `install` |

## Per command

### `scion install`

| Code | Meaning |
|---|---|
| `0` | Every requested target was installed (or converted, for targets scion does not register). |
| `1` | Usage error: no plugin spec, no `--to`, `--json` without `--dry-run`, or a `<plugin>@<marketplace>` spec whose marketplace or entry could not be found. Nothing was fetched or written; the output names every path that was searched, and near-miss entry names when the marketplace was found but the entry was not. |
| `2` | A target reported BLOCK findings. Nothing was installed for any target. |
| `3` | A target reported LOSS findings and `--yes` was not given. Nothing was installed. `--dry-run` does not return this — a preview changes nothing, so there is nothing to accept. |
| `5` | One target's install failed partway through and was rolled back. Retryable: re-run the printed command. |

Notes on `5`:

- The failed target is back to exactly what it was before the run — a fresh
  install leaves nothing behind, and an upgrade over an existing install keeps
  the old version, byte for byte.
- The failed target is **not** written to the scion ledger, so `scion list` and
  `scion sync` never see a half-installed plugin.
- Targets that already completed in the same run are untouched and stay
  installed; they are separate, finished installs.
- Steps that cannot be undone (external commands that already succeeded) are
  named explicitly in the error output under `NOT undone:`.
- The error output ends with the exact command to re-run.
- If the rollback itself also failed, the output says so in its first line and
  points at the files that need manual attention. The exit code is still `5`.

### `scion market convert`

| Code | Meaning |
|---|---|
| `0` | The whole catalog was converted. |
| `1` | Usage error: unknown subcommand, missing directory, missing `--to`, or an unsafe `--as` value. |
| `2` | A catalog-scoped BLOCK (unreadable catalog, unsafe marketplace name, or a Codex marketplace name conflict). Aborted; nothing was written. |
| `4` | Converted and written, but at least one entry was excluded from the catalog. The output is usable but incomplete; the excluded entries and the reason for each are listed under `INCOMPLETE OUTPUT`. Entries excluded because the target ecosystem cannot fetch their remote source (`marketplace.remote-entry-unfetchable`) come with the `scion install <plugin>@<marketplace>` command that installs them one at a time instead. |

### `scion market show`

| Code | Meaning |
|---|---|
| `0` | Overview printed. |
| `1` | Usage error. |

### `scion convert`

| Code | Meaning |
|---|---|
| `0` | Files written. |
| `1` | Usage error: missing directory or missing `--to`. |
| `2` | BLOCK findings; conversion aborted, nothing written. |

`convert` has no `--yes` gate: it only produces files and registers nothing, so
LOSS findings are reported and the conversion proceeds.

### `scion doctor`

| Code | Meaning |
|---|---|
| `0` | Report printed; no BLOCK findings. LOSS and INFO findings still exit `0`. |
| `1` | Usage error: no directory given. |
| `2` | At least one BLOCK finding. |

### `scion sync`

`sync` re-runs `install` for each recorded source and **propagates that
command's exit code unchanged** — including `5`. It stops at the first group
that fails.

| Code | Meaning |
|---|---|
| `0` | Everything synced, or the ledger is empty (`sync` with no argument). |
| `1` | `sync <name>` was given a name that is not in the ledger. |
| `2` / `3` / `5` | Propagated from the underlying `install`. |

### `scion list`

| Code | Meaning |
|---|---|
| `0` | The ledger was printed, including when nothing is installed. |

`list` has no failure mode of its own: a corrupt ledger throws and surfaces as a
top-level error (`1`), not as a `list` exit code.

### `scion` itself

| Code | Meaning |
|---|---|
| `0` | `--version`, `--help`. |
| `1` | No arguments, or an unknown command; also any error that reaches the top level (the message goes to stderr, prefixed `scion:`). |

## `--json` and exit codes

`doctor`, `install --dry-run`, `list` and `market` accept `--json`. The JSON
envelope carries an `exitCode` field, but **the process exit code stays
authoritative** — the field is there for logs and archives, and it always equals
the code the process exits with. The codes themselves are the same with and
without `--json`.

The intended split for a caller: branch coarsely on the exit code, then branch
finely on the JSON (`findings[].level` / `findings[].code`, `stoppedAt`,
`excluded`). A usage error still produces valid JSON on stdout, so a caller can
always `JSON.parse` what it got.

This document is checked against the source by `tests/exit-codes-doc.test.ts`:
the codes each command returns are extracted from `src/commands/*.ts` and
compared with the tables above, so a code that changes in the code and not here
fails the suite.

## Codes that are easy to confuse

**`market convert` exits `4`, `install` exits `5`, and they are close to
opposites.**

- `4` (`market convert`) means **it mostly worked**: files were written, the
  catalog exists and is usable, but some entries were left out. Something is
  there to inspect and use.
- `5` (`install`) means **it did not work and nothing remains**: the target was
  restored to its pre-install state, and the same command can simply be run
  again.

They are deliberately different numbers so that a caller branching on the exit
code cannot mistake one for the other.

**`2` versus `5` under `install`.** `2` means the plugin cannot be installed as
it stands — re-running changes nothing until the source or the target changes.
`5` means this particular attempt failed (a command errored, a disk write
failed) and a re-run may well succeed. If you automate retries, retry `5`, and
never retry `2` or `3` without changing something first.
