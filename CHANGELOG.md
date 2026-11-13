# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
