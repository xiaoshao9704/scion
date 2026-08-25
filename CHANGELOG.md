# Changelog

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
