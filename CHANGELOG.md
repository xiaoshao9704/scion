# Changelog

## Unreleased

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
