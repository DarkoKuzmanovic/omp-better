# omp-better

[![CI](https://github.com/DarkoKuzmanovic/omp-better/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkoKuzmanovic/omp-better/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`/better` for [omp](https://omp.sh) (Oh My Pi). It is a port of [pi-better](https://github.com/nicobailon/pi-better) (Nico Bailon, MIT, v0.2.0, commit `509967c`). Unofficial: it is not affiliated with or endorsed by pi-better's author or the omp project. See [NOTICE.md](NOTICE.md).

`/better <prompt>` starts a read-only helper agent in the background. The helper:

1. Reads the code and files your prompt touches.
2. Answers Felix Rieseberg's four ["Depth" questions](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth): what a top professional would do, the rawest material, the methods and tools, and what would show the result is right.
3. Rewrites your prompt with the concrete facts it found.

The rewrite goes into your input box. You read it, edit it, and press Enter yourself. Nothing is ever sent for you.

## Install

Clone it into omp's extensions folder:

```sh
git clone https://github.com/DarkoKuzmanovic/omp-better ~/.omp/agent/extensions/omp-better
```

omp finds it there on its own: a folder in `extensions/` loads through its `index.ts`. Start a new omp session after installing or updating it. It was built and tested against omp 18.20.0; other versions are untested.

| File | What it is |
|---|---|
| `index.ts` | The extension: the `/better` and `/better-cancel` commands, the progress widget and the hand-over. In the helper process it is the read-only guard. |
| `better.ts` | Pure parts: the task text, the reply parser, the tool and credential guard, progress, error wording and model flags. |
| `spawn.ts` | Starts, watches, stops and cleans up the helper process. |
| `helper.md` | The prompt. It is pi-better's text with an attribution comment on top, which is stripped before sending. |
| `tests/` | `bun test` suites, a fake `omp`, and two captured `omp --mode json` event streams. |
| `LICENSE`, `NOTICE.md` | The MIT licence with both authors' copyright lines, and the attribution. |

## Usage

| Command | What it does |
|---|---|
| `/better <prompt>` | Deepens `<prompt>`. |
| `/better` | With no prompt, deepens the task in progress in this chat, including feedback you gave on earlier work. This needs a saved session, which omp writes once the chat has a message. |
| `/better-cancel` | Stops a running helper. Nothing is sent. |

While it runs:

- You can keep chatting.
- Only one `/better` runs at a time.
- A helper that runs past 20 minutes is stopped.
- Starting, switching or closing the session stops it too.
- Two lines above the input box show progress:

```
/better · Picking the methods and tools (3 of 4) · 41s · /better-cancel stops it
  7 tools · last: read src/net.ts
```

When it finishes, what happens depends on where omp is running:

- **Terminal UI.** The improved prompt goes into your input box, above anything you typed meanwhile. A notice says: "The improved prompt is in your input box. Edit it, then press Enter to send."
- **RPC, print and JSON modes.** These have no input box omp can read back, so the improved prompt is posted as a `better` custom message instead. If the agent is busy, the message is queued for the next turn rather than steering the running one. In print and JSON mode the command waits for the helper, because omp would otherwise exit first.

The helper's whole reply is saved as a hidden `better` session entry: `{ prompt, improved, reply }`. The four answers live there. If the reply has no `<improved-prompt>` block, or an empty one, the reply is also written to `/tmp/omp-better-reply-<time>.md`, and the error message names that file.

### Model

By default the helper uses the chat's model and thinking level. To pin either one, set these in the environment omp starts with:

| Variable | Example | Meaning |
|---|---|---|
| `OMP_BETTER_MODEL` | `anthropic/claude-sonnet-5-5`, `@smol` | Any value `omp --model` accepts |
| `OMP_BETTER_THINKING` | `medium` | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` |

These are environment variables, not a `config.yml` key, because omp gives extensions no clean way to read a custom settings key. Its settings registry only knows the settings omp defines.

## How it works

`/better` starts a separate `omp` process:

```
omp --mode json -p [--profile <yours>] [--fork <copy> --session-dir <temp>/sessions | --no-session]
    --no-extensions -e <this index.ts> --tools read,grep,glob,find,ast_grep,lsp,web_search
    --no-title --max-time 20m --model <chat model> [--thinking <level>] <task>
```

The process is the same omp that runs the extension. If omp was started with `--profile`, the helper gets the same profile, so it uses the same logins and settings. It runs in the chat's working directory, and its environment has `OMP_BETTER_HELPER` set. It is never given `--auto-approve`.

The task is `helper.md`, then the prompt to deepen, then a request to end with the rewrite between `<improved-prompt>` and `</improved-prompt>` lines. The parser takes the **last** closing tag and the last opening tag that sits on its own line before it. That way a rewrite that mentions the tag inline doesn't confuse it.

The extension reads the helper's JSON events as they arrive:

| Event | Used for |
|---|---|
| `message_update` text deltas | The stage shown in the widget |
| `tool_execution_start` / `tool_execution_end` | The tool count and the last tool |
| `message_end` | The final reply, and model errors (`stopReason` `error` or `aborted`, which can come with exit code 0) |

### The copy of your chat

pi-better forks the live session file with Pi's `--fork`. omp 18.20.0 also has `--fork <path>`. It is missing from `omp --help` but is documented in omp's session docs, and it works.

omp-better doesn't fork the live file, though:

1. It copies the session file into a private temp folder, `$TMPDIR/omp-better-<omp pid>-XXXXXX/source.jsonl`. The copy stops at the last complete line, so a line omp is writing at that moment can't be cut in half.
2. It runs the helper with `--fork <copy> --session-dir <temp folder>/sessions`.

Your real session file is only ever read once, by the copy. omp's fork gets a new session id, records your session as its parent, and writes only inside the temp folder. Artifacts from your session are not copied, so `artifact://` links in the chat don't resolve for the helper. Messages you send after starting `/better` don't reach the helper.

omp records a session stored outside its sessions folder in a marker file under `~/.omp/agent/custom-session-files/`, and the helper's fork is such a session. omp-better deletes that marker together with the temp folder.

The temp folder and the marker are deleted when the helper finishes, fails, is cancelled or times out, and when omp exits. If omp is killed hard (SIGKILL), the next omp that loads this extension deletes the folders and markers whose omp pid is gone.

The helper is started without a terminal and without the terminal-id variables omp uses for `--continue` breadcrumbs: `KITTY_WINDOW_ID`, `TMUX_PANE`, `ZELLIJ_*`, `WEZTERM_PANE`, `CMUX_SURFACE_ID`, `TERM_SESSION_ID` and `WT_SESSION`. Without this, the helper would point your terminal's breadcrumb at its temp session, and that session is then deleted. In testing, a plain `omp -p` started with `KITTY_WINDOW_ID` set did rewrite `~/.omp/agent/terminal-sessions/kitty-<n>`. The helper didn't.

## What "read-only" means here

pi-better keeps the shell in its helper and only asks the model not to write. omp-better enforces read-only in several layers:

1. **Allow-list.** The helper can call only `read`, `grep`, `glob`, `find`, `ast_grep`, `lsp` and `web_search`. Its `tool_call` handler refuses every other call before it runs, and that includes tool names it doesn't know. Refused calls include `bash`, `eval`, `edit`, `write`, `ast_edit`, `task`, `todo`, `debug`, `github`, `checkpoint`, memory and skill tools (`learn`, `manage_skill`, `retain`, …) and every MCP tool. This matters because `--tools` is not enough on its own: in a probe, omp still enabled `write`, `learn`, `manage_skill` and all MCP tools despite it.
2. **lsp actions.** Only `diagnostics`, `definition`, `references`, `hover`, `symbols`, `type_definition`, `implementation`, `status` and `capabilities` are allowed. `rename`, `rename_file`, `code_actions`, `reload`, raw `request` and anything with `apply: true` are refused.
3. **The guard fails closed.** The guard writes a marker file when it loads. If the helper's session starts and the marker is missing, the helper is killed before its first model request, and `/better` fails with "read-only guard didn't load". The guard always loads, because it is passed with `-e` while all other extensions are switched off with `--no-extensions`.
4. **Credential paths.** Every path argument is checked:

   - Lists separated by `;`, `:selectors`, archive members and `file://` URLs are all checked.
   - Symlinks are resolved.
   - The helper refuses any path component named `.env*`, `auth*.json`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `.pypirc` or `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519*`.
   - Under your home directory it also refuses `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.password-store`, `~/.docker`, `~/.kube`, `~/.omp/agent/secrets`, `~/.omp/agent/agent.db*`, `~/.omp/agent/models.yml`, `~/.omp/agent/mcp.json` and `~/.config/**/credentials*`.
   - These rules cover `~/.hermes/.env` and `~/.pi/agent/auth.json`.
   - Internal URLs other than `http(s)`, `file`, `skill`, `omp`, `rule`, `artifact`, `local`, `memory`, `history`, `agent`, `issue` and `pr` are refused. That rules out `ssh://`, `vault://`, `proc://`, `mcp://` and `xd://`.
5. **Searches.** Each `grep` path gets exclusions added, such as `!**/.env*` and `!**/.ssh`, so a directory search skips those files. If a `grep`, `find` or `ast_grep` result still names a credential file, symlinks included, the whole result is replaced with an error before the model sees it, details too.

Tested live against omp 18.20.0 with the helper's own guard:

- With the full default tool list, the model was told to use `write`, `bash`, `eval`, `edit` and `task`. Each call was refused, and no file appeared.
- `read .env`, `read` of a symlink to `.env`, `read ~/.ssh` and `read ssh://…` were refused.
- `find` hit `.env` through a symlink. Its result was withheld, and the fake key appeared nowhere in the helper's output stream.

Limits, plainly:

- **This is not a sandbox.** The allowed tools are trusted to be read-only:
  - `read` fetches URLs over the network.
  - `web_search` sends queries to a search provider.
  - `lsp` starts language servers, which can run project code; rust-analyzer runs `build.rs` and proc macros, for example.
- **Everything the helper reads goes to the model provider**, as in any chat.
- **The credential guard works on names and paths, not contents.** A key hard-coded in `config.ts` or `settings.json` is readable. The guard also blocks some harmless files: a committed `.npmrc` without a token, `authors.json`, `.env.example`.
- **MCP servers still start in the helper.** omp's print mode waits for them before the first turn, but their tools are refused.
- **Models added by an extension aren't available.** The helper runs with `--no-extensions`, so a model that only exists through an extension's `registerProvider` can't be its model. Set `OMP_BETTER_MODEL` to a model from `models.yml` or a built-in provider instead.
- **A killed omp leaves its helper running.** If omp is killed with SIGKILL during a run, the helper keeps running until its own `--max-time 20m` and then exits. The temp folder is removed the next time the extension loads.
- **There is no shell, not even as an option.** In the live runs the helper wrote concrete, file-level rewrites from `read`/`grep`/`glob`/`find` alone, so it doesn't need `bash`, and there is no opt-in.

## Differences from pi-better

| pi-better | omp-better |
|---|---|
| The helper keeps `bash`; read-only is a sentence in the prompt | `bash` and all other non-read tools are refused at call time; credential files are refused; the guard fails closed |
| The helper loads all your extensions and keeps the chat's tool list, to reuse the prompt cache | `--no-extensions -e <self>` and `--tools <allow-list>`: your other extensions don't run once per helper, but the prompt cache isn't reused |
| `--fork` of the live session file | `--fork` of a temp copy, cut at its last complete line; the terminal breadcrumb is protected |
| `"better": {model, thinking}` in `settings.json` | `OMP_BETTER_MODEL` / `OMP_BETTER_THINKING` environment variables |
| Esc cancels; six-cell meter with tool chips | `/better-cancel` cancels; a two-line text widget |
| RPC, print and JSON modes post the whole reply | They post the improved prompt; the whole reply is in the `better` session entry. While the agent is busy, the post waits for the next turn |
| `/better-boomerang`, `/better` subagent brief checks (`brief.md`) | Not ported |

## Errors

Every failure starts with `/better failed:` and says what to do next. In the terminal UI and RPC it shows as an error notice. In print and JSON mode the command throws it, and omp prints `Extension error (command:better): /better failed: …`.

| Message | Meaning |
|---|---|
| `/better has no task to deepen yet; give it a prompt: /better <prompt>` | Nothing has been saved in this session yet |
| `/better is already running; /better-cancel stops it.` | One run at a time |
| `/better cancelled; nothing was sent` | `/better-cancel` stopped it |
| `… No model is selected; pick one with /model or set OMP_BETTER_MODEL.` | The chat has no model |
| `… OMP_BETTER_THINKING must be one of …` | Unknown thinking level |
| `… Couldn't start omp for the helper: …` | The omp executable couldn't be launched |
| `… The helper's read-only guard didn't load, so it was stopped before it could act. …` | The extension failed to load inside the helper; the rest is the helper's stderr |
| `… The helper timed out after 20 minutes; try a narrower prompt` | Time limit reached |
| `… The helper's model call failed: …` | The model returned an error, such as a rate limit or a sign-in problem |
| `… The helper exited with code N: <last stderr lines>` / `… without printing an error` | omp failed, for example with an unknown model |
| `… The helper was stopped by SIGKILL …` | Something outside omp-better killed it |
| `… The helper finished without replying; run /better again` | It exited cleanly with no reply text |
| `… The reply has no <improved-prompt> … </improved-prompt> block. The helper's whole reply is in /tmp/omp-better-reply-….md` | Open that file to see what it wrote |

## Tests

```sh
cd omp-better && bun test
```

- `tests/better.test.ts` covers:
  - the parser (last block wins, inline tag, missing, empty)
  - the task text with and without a prompt
  - `helper.md` being pi-better's text
  - the tool guard: every tool name omp offered in a probe is blocked, unknown names fail closed, allowed tools and lsp read actions pass
  - the credential guard, including symlinks, selectors, archive members and URL schemes
  - search-result withholding
  - exit-error wording
  - model flags
  - event parsing against the two captured streams in `tests/fixtures/`
- `tests/spawn.test.ts` runs `askHelper` against `tests/fake-omp.ts`. It checks:
  - the exact helper arguments, including the `--profile` pass-through
  - that the session copy is cut at its last line and the original is untouched
  - that the terminal id is not passed on
  - that omp's marker for the fork is removed and other markers are kept
  - the guard-missing stop
  - exit code, signal, model-error and no-reply failures
  - abort, which kills the child, removes the temp folder and rejects with `Cancelled`
  - the time limit
  - the stale-folder and stale-marker sweep

## Licence and attribution

MIT. `LICENSE` carries the copyright lines of Darko Kuzmanovic (omp-better) and Nico Bailon (pi-better, from which it is derived). The idea, the prompt in `helper.md` and the structure of the code come from pi-better. The four "Depth" questions are Felix Rieseberg's, from ["How to be more ambitious: A tutorial for humans with models"](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth). The licence covers this code only. Details in [NOTICE.md](NOTICE.md).
