# Changelog

## Unreleased

- **Hooks now convert from Claude to Kimi.** Measured against the Kimi binary:
  its hook event set is a strict superset of Claude's with identical names, and
  plugin hooks run with the plugin root as cwd. `hooks/hooks.json` flattens
  into the `hooks` array of `kimi.plugin.json`; `${CLAUDE_PLUGIN_ROOT}` becomes
  a relative path (INFO), timeouts clamp to Kimi's 1–600s range and dropped
  `async` / `shell` fields are each reported as a LOSS. Codex hooks stay
  report-only until its plugin-level declaration is verified.
- **New command: `scion uninstall <name> [--to codex,kimi]`** — deregisters on
  the target (`codex plugin remove` / the Kimi registry, with backup), removes
  the catalog entry and converted files, and forgets the ledger record. A
  target already cleaned up by hand is reported and does not fail the run.
- **`scion list` now detects drift**: a record the ledger says is registered
  but the target no longer has (removed behind scion's back) is flagged, with
  `missingOnTarget: true` in `--json`.

## 0.1.1 — 2026-08-25

Verified two ecosystem facts against the real binaries (codex-cli 0.133.0,
Kimi 0.36.1) and corrected what scion asserts:

- Kimi does support `argument-hint` (rendered as ghost text in the TUI), so it
  is now carried over losslessly instead of being dropped with a LOSS finding.
- Inline bash in command bodies (`` !`cmd` ``) is now judged per target via a
  new `inlineBash` profile fact: Kimi never runs it — the text reaches the
  model verbatim, reported as a LOSS that says so; Codex shows strong evidence
  of support but is unverified at runtime, downgraded to INFO (no `--yes`
  needed anymore); with no target given the conservative untested LOSS remains.

## 0.1.0 — 2026-08-25

Initial public release.

- `scion install <github|path|zip> --to codex,kimi` — fetch, convert, install
  and write the registry, with `--dry-run` preview.
- `scion install <plugin>@<marketplace> --to …` — install one entry of a
  marketplace you have.
- `scion convert` / `scion doctor` — convert without installing; compatibility
  report.
- `scion list` / `scion sync` — installed-plugin ledger and re-conversion after
  upstream changes.
- `scion market convert` / `scion market show` — whole-marketplace conversion
  and overview.
- Findings at three levels (BLOCK / LOSS / INFO), an ENV section listing every
  environment variable the plugin reads, `--env-name OLD=NEW` renames recorded
  in the ledger, `--json` machine-readable output, and per-command exit codes
  (see docs/exit-codes.md).
- Converts metadata, presentation fields, skills, commands, agents and MCP
  servers, Claude → Kimi and Claude → Codex. Hooks are reported but not
  converted; the reverse direction is not supported.
