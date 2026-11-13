# omp-better

[![CI](https://github.com/DarkoKuzmanovic/omp-better/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkoKuzmanovic/omp-better/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`/better` for [omp](https://omp.sh) (Oh My Pi): a read-only helper agent reads your code and rewrites your prompt into a deeper one, for you to edit and send. It is a port of [pi-better](https://github.com/nicobailon/pi-better) (Nico Bailon, MIT, v0.2.0, commit `509967c`). Unofficial: it is not affiliated with or endorsed by pi-better's author or the omp project. See [NOTICE.md](NOTICE.md).

```
/better make the error messages clearer
```

The helper runs in the background. It:

1. Reads the code and files your prompt touches.
2. Answers Felix Rieseberg's four ["Depth" questions](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth): what a top professional would do, the rawest material, the methods and tools, and what would show the result is right.
3. Rewrites your prompt with the concrete facts it found.

The rewrite goes into your input box. You edit it and press Enter yourself. Nothing is sent for you.

## Install

```sh
git clone https://github.com/DarkoKuzmanovic/omp-better ~/.omp/agent/extensions/omp-better
```

omp loads a folder in `extensions/` through its `index.ts`; there is nothing to build. With `omp --profile <name>` the folder is `~/.omp/profiles/<name>/agent/extensions/`. Start a new omp session after installing or updating. Built and tested against omp 18.20.0; other versions are untested.

## Usage

| Command | What it does |
|---|---|
| `/better <prompt>` | Deepens `<prompt>`. |
| `/better` | Deepens the task in progress in this chat, including feedback you gave on earlier work. Needs a saved session, which omp writes once the chat has a message. |
| `/better-cancel` | Stops a running helper. Nothing is sent. |

While it runs you can keep chatting, and a two-line widget shows progress:

```
/better · Picking the methods and tools (3 of 4) · 41s · /better-cancel stops it
  7 tools · last: read src/net.ts
```

Only one `/better` runs at a time. A run stops on `/better-cancel`, after 20 minutes, when the session switches (`/resume` or `/fork`, for example) and when omp shuts down.

When it finishes:

- **Terminal UI.** The improved prompt goes into your input box, above anything you typed meanwhile.
- **RPC, print and JSON modes.** There is no input box to read back, so the improved prompt is posted as a `better` custom message. That starts no turn, and while the agent is busy it waits for the next turn. In print and JSON mode the command waits for the helper to finish.

The helper's whole reply, with the four answers, is saved as a `better` session entry, along with the prompt-cache result of its first request (see [Prompt cache](#prompt-cache)).

The helper uses the chat's model and thinking level. To pin either one, set these in the environment omp starts with:

- `OMP_BETTER_MODEL`: anything `omp --model` accepts, such as `anthropic/claude-sonnet-5-5` or `@smol`. The helper runs without your other extensions, so a model that only an extension provides won't work.
- `OMP_BETTER_THINKING`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`.

Setting either one gives the helper a request of its own, so it can't reuse the chat's prompt cache. `OMP_BETTER_CACHE=off` turns cache reuse off; `on`, the default, leaves it on.

## Read-only: what is and is not guaranteed

The helper is a separate `omp` process that loads this extension as a guard. The guard checks every tool call before it runs.

Enforced:

- **Tool allow-list.** Only `read`, `grep`, `glob`, `find`, `ast_grep`, `lsp` and `web_search` run. Every other call is refused: `bash`, `eval`, `edit`, `write`, `task`, MCP tools, and any tool name the guard doesn't know. There is no shell and no option to turn one on.
- **lsp read actions only.** `diagnostics`, `definition`, `references`, `hover`, `symbols`, `type_definition`, `implementation`, `status` and `capabilities`. Other actions (`rename`, `code_actions`, raw `request`, …) and anything with `apply: true` are refused.
- **Fails closed.** The guard writes a marker file when it loads. If the helper's session starts and the marker is missing, the helper is stopped at once and `/better` fails. The helper is never given `--auto-approve`.
- **Credential paths.** The `path` argument of `read`, `grep`, `glob`, `find` and `ast_grep` and the `file` argument of `lsp` are checked as given and again after resolving symlinks, including `;`-separated lists, `:selectors`, archive members and `file://` URLs. Refused:
  - any path component named `.env*`, `auth*.json`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `.pypirc`, `id_rsa*`, `id_dsa*`, `id_ecdsa*` or `id_ed25519*`;
  - under your home directory: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.password-store`, `~/.docker`, `~/.kube`, `~/.omp/agent/secrets`, `~/.omp/agent/agent.db*`, `~/.omp/agent/models.yml`, `~/.omp/agent/mcp.json` and `~/.config/**/credentials*`. The same `~/.omp/agent/…` files under `~/.omp/profiles/<name>/agent/` are refused too;
  - URLs with a scheme other than `http(s)`, `file`, `skill`, `omp`, `rule`, `artifact`, `local`, `memory`, `history`, `agent`, `issue` and `pr`. That rules out `ssh://`, `vault://`, `proc://`, `mcp://` and `xd://`.
- **Searches.** `grep` gets exclusions such as `!**/.env*` and `!**/.ssh` added to its path. If a `grep`, `find` or `ast_grep` result still names a credential file, the whole result is withheld from the model.

`bun test` covers these rules, and `tests/fixtures/guard-refusals.jsonl` is a captured omp 18.20.0 helper run in which `write`, `bash`, `eval`, `task` and `edit` calls were all refused.

When the helper reuses the chat's prompt cache, the model sees the chat's tool list, `bash` and `edit` included, but the helper process still registers only the read tools and the guard is unchanged. In live runs on both Anthropic and OpenAI Codex, `bash` and `edit` calls came back `Tool … not found`, and `write` (to a path or to `xd://bash`) was refused by the guard. No file changed.

Not guaranteed:

- **This is not a sandbox.** The allowed tools are trusted to be read-only. `read` fetches URLs over the network, `web_search` sends queries to a search provider, and `lsp` starts language servers, which can run project code (rust-analyzer runs `build.rs` and proc macros, for example).
- **Everything the helper reads goes to the model provider**, as in any chat.
- **The credential guard works on names and paths, not contents.** A key hard-coded in `config.ts` or `settings.json` is readable. The guard also blocks some harmless files, such as `.env.example` and `authors.json`.
- **MCP servers are not switched off in the helper.** Only their tools are refused.
- **A killed omp leaves its helper running.** After a SIGKILL of omp, the helper goes on until its own `--max-time 20m`.

## How it works

```
omp --mode json -p [--profile <yours>] (--fork <copy> --session-dir <temp>/sessions | --no-session)
    --no-extensions -e <this index.ts> --tools read,grep,glob,find,ast_grep,lsp,web_search
    --no-title --max-time 20m [--prompt-cache-key <key> --provider-session-id <id>]
    --model <model> [--thinking <level>] <task>
```

- The helper runs in the chat's working directory with `OMP_BETTER_HELPER` set, which makes `index.ts` act as the guard there.
- The task is `helper.md`, then your prompt, then a request to end with the rewrite between `<improved-prompt>` and `</improved-prompt>` lines. When the cache is reused, a line naming the tools that work comes after `helper.md`.
- If the session is saved, its file is copied into a private temp folder, cut at the last complete line, and the helper forks that copy. Your session file is only read. Nothing else is copied, so `artifact://` links from the chat may not resolve for the helper, and messages you send after starting `/better` don't reach it.
- To reuse the cache, the chat's request head goes into `prefix.json` in the same temp folder (mode 0600), and `OMP_BETTER_PREFIX` points the helper at it. On OpenAI Codex the chat's prompt-cache key and session id are passed too.
- The temp folder is deleted when the helper ends and when omp exits. If omp was killed, the next omp that loads the extension deletes it.

## Prompt cache

A `/better` on a long chat would pay again for the whole history, because the helper is a separate process with its own system prompt and tool list. To avoid that, the chat remembers the head of its last request in memory: the system prompt and tool list, and on OpenAI Codex also the leading developer messages and the cache key. The helper sends that head instead of its own, so the provider finds the chat's prefix in its cache. The head is written only to the private temp folder above, never to the session or a log.

Measured on omp 18.20.0 with the first helper request ("Reply with ok2") right after a parent chat turn. The parent loaded a test extension that adds a tool and system-prompt lines, so a plain helper's request differs from it, as a terminal chat's does. Tokens are input / cache read / cache write:

| Provider, model | Chat's last request | Helper without reuse (0.1.1) | Helper with reuse |
|---|---|---|---|
| `anthropic`, claude-sonnet-5-5 | 2 / 23,285 / 133 | 2,237 / 8,735 / 6,137 | 4 / 23,418 / 17 |
| `openai-codex`, gpt-6.1-terra | 214 / 13,696 / 0 | 10,314 / 0 / 0 | 361 / 13,568 / 0 |

The 8,735 tokens the 0.1.1 helper read are its own prefix, cached by earlier helper runs. A real `/better` in the terminal UI on Anthropic read 28,329 of the chat's 28,331 tokens; one over RPC on OpenAI Codex read 13,312 of 13,448.

Limits:

- Supported: Anthropic Messages (`anthropic`) and OpenAI Codex Responses (`openai-codex`). Other providers, including `openai`, run as in 0.1.1.
- Reuse needs the chat's model, an earlier request in this session, and a warm cache. Anthropic keeps it 5 minutes or an hour, as omp asks (these runs got an hour); OpenAI decides on its own.
- OpenAI Codex caching is best effort, for the chat too: in 12 of 12 runs the helper read the chat's cache, but without the chat's session id it did in only 6 of 9.
- On Anthropic the helper loses `ast_grep` and `lsp` when the chat offers them only behind `xd://`: listing them changed the cached prefix (the helper then read 10.9k of 23.4k tokens).
- Anything the chat changed only in memory (another extension's `context` hook, pruned tool output) can still make the forked history differ.

## Differences from pi-better

| | pi-better | omp-better |
|---|---|---|
| Read-only | The helper keeps the shell; only the prompt stops a shell command from writing | No shell. Non-read tools and credential paths are refused; the guard fails closed |
| Extensions and tools | Loads your extensions and keeps the chat's tool list, to reuse the prompt cache | Loads only itself, with only the read tools, and sends the chat's system prompt and tool list to reuse the prompt cache (Anthropic, OpenAI Codex) |
| Copy of the chat | `--fork` of the live session file | `--fork` of a temp copy |
| Model setting | `"better"` in `settings.json` | Environment variables |
| Cancel and progress | Esc or `/better-cancel`; a six-cell meter | `/better-cancel`; a two-line text widget |
| RPC, print and JSON modes | Post the whole reply | Post the improved prompt |
| `/better-boomerang`, subagent brief checks | Yes | Not ported |

## Errors

A failed run reports `/better failed: <reason>`: as an error notice in the terminal UI and RPC, and as a thrown error in print and JSON mode. The reasons you are most likely to meet:

- `The helper timed out after 20 minutes; try a narrower prompt`
- `The helper's model call failed: …`, for a rate limit or a sign-in problem.
- `The helper exited with code N: <last stderr lines>`, for example with an unknown model.
- `The reply has no <improved-prompt> … </improved-prompt> block. The helper's whole reply is in <file>`. The file is `omp-better-reply-<time>.md` in your temp folder, and nothing deletes it for you.

## Files and tests

- `index.ts`: the extension (commands, progress widget, hand-over, remembering the chat's last request). In the helper process it is the read-only guard and swaps in the chat's request head.
- `better.ts`: the pure parts (task text, reply parser, tool and credential guard, progress, error wording, model flags).
- `cache.ts`: the pure parts of cache reuse (which request fields to keep, the prefix file, the swap).
- `spawn.ts`: starts, watches, stops and cleans up the helper process.
- `helper.md`: the prompt. It is pi-better's text with one path changed to omp's, under an attribution comment that is stripped before sending.
- `tests/`: four suites, a fake `omp` and two captured `omp --mode json` event streams. `bun test` in the repo folder runs them; it needs no omp install and no login.

## Licence and attribution

MIT. `LICENSE` carries the copyright lines of Darko Kuzmanovic (omp-better) and Nico Bailon (pi-better, from which it is derived). The idea, the prompt in `helper.md` and the structure of the code come from pi-better. The four "Depth" questions are Felix Rieseberg's, from ["How to be more ambitious: A tutorial for humans with models"](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth). The licence covers this code only. Details in [NOTICE.md](NOTICE.md).
