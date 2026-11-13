# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-11-13

### Changed

- README checked against the 0.2.0 code and shortened. Corrections:
  - Cache reuse is gated on the model's API (`anthropic-messages`, `openai-codex-responses`), not the
    provider name; it was measured on `anthropic` and `openai-codex` only.
  - The helper loses `ast_grep` and `lsp` on OpenAI Codex too, not only on Anthropic (the 0.2.0
    entry below says Anthropic only), whenever the chat's request lists them only behind `xd://`.
    `OMP_BETTER_CACHE=off` brings them back.
  - Any `OMP_BETTER_CACHE` value other than `on` or `off` makes `/better` fail; setting
    `OMP_BETTER_MODEL` or `OMP_BETTER_THINKING` turns reuse off even when it equals the chat's value.
  - The README now states that the `--tools` list and the guard stay the same under reuse, and marks
    the live-run tool outcomes and cache numbers as the author's measurements.

## [0.2.0] - 2026-11-13

### Added

- The helper reuses the chat's prompt cache on Anthropic (`anthropic`) and OpenAI Codex
  (`openai-codex`). The chat remembers the head of its last request in memory (system prompt, tool
  list; on Codex also the leading developer messages and the cache key); `/better` writes it to a
  0600 `prefix.json` in the helper's private temp folder, and the helper sends it in place of its own.
  On Codex the helper also gets `--prompt-cache-key` and `--provider-session-id` from the chat.
  The helper still registers only the read tools and the guard is unchanged.
- `OMP_BETTER_CACHE=off` turns reuse off. `OMP_BETTER_MODEL` or `OMP_BETTER_THINKING` also turn it
  off for that run, since another model or level gets a request of its own.
- The `better` session entry gets `cache`: whether reuse was on (or why not), and the input,
  cache-read and cache-write tokens of the helper's first request. The terminal UI's completion
  notice ends with a short "prompt cache: 23k of 23k tokens reused" when reuse was on.

### Changed

- With reuse on, the helper's task names the tools that work, because the model sees the chat's
  full tool list. On Anthropic the helper loses `ast_grep` and `lsp` when the chat offers them only
  behind `xd://`.

## [0.1.1] - 2026-11-13

### Fixed

- With `omp --profile <name>`, the credential guard did not protect that profile's `agent.db*`,
  `models.yml`, `mcp.json` and `secrets/` under `~/.omp/profiles/<name>/agent/`; only the default
  `~/.omp/agent/` paths were refused. Both locations are now refused.

### Changed

- README rewritten and shortened, and corrected where it disagreed with the code: not every failure
  carries the `/better failed:` prefix, the reply file for a failed parse is not cleaned up,
  and pi-better refuses non-read tools too (only its shell relies on the prompt).

## [0.1.0] - 2026-11-13

First release: a port of pi-better v0.2.0 (commit `509967c`) to omp 18.20.0.

### Added

- `/better <prompt>`: a background, read-only helper reads the code and files your prompt touches,
  answers Felix Rieseberg's four "Depth" questions, and puts the rewritten prompt in your input box.
  Nothing is sent for you.
- `/better` with no prompt deepens the task in progress, using a copy of the session file.
- `/better-cancel`, a 20-minute limit, one run at a time, and cancellation when the session changes.
- A two-line progress widget: stage, elapsed time, tool count and last tool.
- RPC, print and JSON modes post the improved prompt as a `better` custom message.
- The helper's whole reply is saved as a `better` session entry; a reply with no usable
  `<improved-prompt>` block is written to a temp file named in the error.
- `OMP_BETTER_MODEL` and `OMP_BETTER_THINKING` pin the helper's model and thinking level.

### Differences from pi-better

- Read-only is enforced, not requested: only `read`, `grep`, `glob`, `find`, `ast_grep`, `lsp` (read
  actions) and `web_search` are allowed; all other tools are refused at call time, credential files
  are refused, and the guard fails closed.
- The helper runs with `--no-extensions` plus this extension, and gets the chat through a temp copy of
  the session file, cut at its last complete line.
- Not ported: `/better-boomerang`, subagent brief checks, Esc to cancel.
