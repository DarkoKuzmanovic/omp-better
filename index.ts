// /better for omp: deepen a prompt with a read-only helper in the background, then put the improved prompt in the
// input box for you to edit and send. A port of pi-better (https://github.com/nicobailon/pi-better, MIT).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildHelperTask,
	credentialInResult,
	HELPER_ENV,
	HELPER_TOOLS,
	helperModelArgs,
	helperPrompt,
	helperToolBlock,
	newHelperState,
	parseMarkedPrompt,
	progressLines,
	withSecretExcludes,
} from "./better.ts";
import { type CachePlan, cacheOutcome, cachePlan, captureHead, PINNED_SUFFIX, PREFIX_ENV, parseHead, pinRequest, type RequestHead } from "./cache.ts";
import { askHelper, Cancelled, sweepStaleTempDirs } from "./spawn.ts";

const WIDGET = "better";
const ENTRY = "better";
const SHUTDOWN = "session ended";

type TextPart = { type: string; text?: string };

/** Inside the helper process: refuse every tool call that isn't a read, and every read of a credential file. */
function guardHelper(pi: ExtensionAPI, marker: string): void {
	pi.on("tool_call", (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const scope = { cwd: ctx.cwd, home: homedir() };
		const verdict = helperToolBlock(event.toolName, input, scope);
		if (verdict) return verdict;
		if (event.toolName === "grep") return { input: { ...input, path: withSecretExcludes(input.path) } };
		return undefined;
	});
	pi.on("tool_result", (event, ctx) => {
		if (!["grep", "find", "ast_grep"].includes(event.toolName)) return undefined;
		const text = ((event.content ?? []) as TextPart[]).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
		const secret = credentialInResult(text, { cwd: ctx.cwd, home: homedir() });
		if (!secret) return undefined;
		return {
			content: [{ type: "text", text: `${event.toolName} found matches in ${secret}, which looks like a credential file, so /better's helper withheld the whole result. Narrow the path to leave it out.` }],
			// details carry the raw hits (find's snippets) for renderers; drop them along with the text.
			details: {},
			isError: true,
		};
	});
	pinToChat(pi);
	// askHelper refuses to go on without this file, so a helper whose guard failed to load never acts.
	writeFileSync(marker, String(process.pid));
}

/**
 * Inside the helper: send the chat's request head (system prompt and tool list; on OpenAI Codex also its developer
 * messages and cache key) instead of the helper's own, so the provider reads the chat's prompt cache. The wire then
 * lists the chat's tools, but only the read tools are registered here and the guard above still refuses the rest.
 */
function pinToChat(pi: ExtensionAPI): void {
	const path = process.env[PREFIX_ENV];
	if (!path) return;
	let head: RequestHead | undefined;
	try {
		head = parseHead(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (!head) return;
	const chatHead = head;
	let reported = false;
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return undefined;
		const pinned = pinRequest(event.payload, ctx.model, chatHead);
		if (pinned && !reported) {
			reported = true;
			// Tells askHelper that reuse was on; the file goes with the temp folder.
			try {
				writeFileSync(`${path}${PINNED_SUFFIX}`, "");
			} catch {}
		}
		return pinned;
	});
}

function failed(ctx: ExtensionContext, error: unknown): void {
	const message = `/better failed: ${error instanceof Error ? error.message : String(error)}`;
	if (!ctx.hasUI) throw new Error(message, { cause: error });
	ctx.ui.notify(message, "error");
}

export default function (pi: ExtensionAPI) {
	const marker = process.env[HELPER_ENV];
	if (marker) return guardHelper(pi, marker);

	const extensionPath = fileURLToPath(import.meta.url);
	const helperText = () => helperPrompt(readFileSync(new URL("./helper.md", import.meta.url), "utf8"));
	let helperRun: AbortController | undefined;
	// The head of the chat's last main-agent request, kept in memory for /better to pin the helper to.
	let lastRequest: RequestHead | undefined;
	// Where omp keeps markers for sessions stored outside its sessions folder, such as the helper's fork.
	const agentDir = typeof pi.pi?.getAgentDir === "function" ? pi.pi.getAgentDir() : undefined;
	sweepStaleTempDirs(tmpdir(), agentDir);

	// Passive: remembers the request and returns nothing, so the chat's request is sent unchanged.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.agent?.kind !== "main") return undefined;
		lastRequest = captureHead(event.payload, ctx.model, lastRequest) ?? lastRequest;
		return undefined;
	});

	const stopRun = (_event: unknown, ctx: ExtensionContext) => {
		// The next session has a cache key of its own.
		lastRequest = undefined;
		if (!helperRun) return;
		// After this the old session is gone, so the cancelled run must not touch its ctx (see the SHUTDOWN checks).
		helperRun.abort(SHUTDOWN);
		ctx.ui.setWidget(WIDGET, undefined);
	};
	pi.on("session_shutdown", stopRun);
	pi.on("session_switch", stopRun);

	pi.registerCommand("better", {
		description: "Deepen a prompt (or the task in progress) with a read-only helper in the background, then put the improved prompt in your input box",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			// A fork needs the session file, which omp writes once the conversation has a message.
			const sessionFile = ctx.sessionManager.getSessionFile();
			const fork = sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
			if (!prompt && !fork) {
				ctx.ui.notify("/better has no task to deepen yet; give it a prompt: /better <prompt>", "error");
				return;
			}
			if (helperRun) {
				ctx.ui.notify("/better is already running; /better-cancel stops it.", "error");
				return;
			}
			let modelArgs: string[];
			let plan: CachePlan;
			try {
				const chatModel = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
				modelArgs = helperModelArgs({ model: process.env.OMP_BETTER_MODEL, thinking: process.env.OMP_BETTER_THINKING }, chatModel, pi.getThinkingLevel());
				const overridden = Boolean(process.env.OMP_BETTER_MODEL?.trim() || process.env.OMP_BETTER_THINKING?.trim());
				plan = cachePlan({ setting: process.env.OMP_BETTER_CACHE, overridden, head: lastRequest, chatModel: ctx.model });
			} catch (error) {
				return failed(ctx, error);
			}
			const head = "head" in plan ? plan.head : undefined;

			const run = new AbortController();
			helperRun = run;
			const startedAt = Date.now();
			let progress = newHelperState();
			let shown = "";
			// Sent only when the text changes: the helper streams many events, and RPC clients get a frame per call.
			const showProgress = () => {
				const lines = progressLines(progress, Date.now() - startedAt);
				if (run.signal.aborted || lines.join("\n") === shown) return;
				shown = lines.join("\n");
				ctx.ui.setWidget(WIDGET, lines);
			};
			showProgress();
			// The clock ticks once a second whether or not the helper reports anything.
			const clock = ctx.setInterval(showProgress, 1000);

			const finished = (async () => {
				try {
					const result = await askHelper({
						cwd: ctx.cwd,
						sessionFile: fork,
						modelArgs,
						task: buildHelperTask(helperText(), prompt, head ? HELPER_TOOLS : undefined),
						signal: run.signal,
						extensionPath,
						agentDir,
						head,
						chatSessionId: ctx.sessionManager.getSessionId(),
						onProgress: (state) => {
							progress = state;
							showProgress();
						},
					});
					if (run.signal.aborted) throw new Cancelled("cancelled");
					const { reply, usage, pinned } = result;
					const skipped = "skipped" in plan ? plan.skipped : pinned ? undefined : "the helper's request didn't match the chat's model or shape";
					const cache = { pinned, ...usage, ...(skipped ? { skipped } : {}) };
					let improved: string;
					try {
						improved = parseMarkedPrompt(reply);
					} catch (error) {
						// Keep the reply, so the user can see what the helper said instead of the marked prompt.
						pi.appendEntry(ENTRY, { prompt, reply, cache });
						const file = join(tmpdir(), `omp-better-reply-${Date.now()}.md`);
						writeFileSync(file, reply);
						throw new Error(`${(error as Error).message} The helper's whole reply is in ${file}`);
					}
					pi.appendEntry(ENTRY, { prompt, improved, reply, cache });
					handOver(pi, ctx, improved, pinned && usage ? cacheOutcome(usage) : undefined);
				} catch (error) {
					if (run.signal.reason === SHUTDOWN) return;
					if (error instanceof Cancelled) ctx.ui.notify("/better cancelled; nothing was sent", "info");
					else failed(ctx, error);
				} finally {
					if (helperRun === run) helperRun = undefined;
					ctx.clearTimer(clock);
					if (run.signal.reason !== SHUTDOWN) ctx.ui.setWidget(WIDGET, undefined);
				}
			})();
			// Print and JSON mode exit once the command returns, so only the TUI and RPC run in the background.
			if (!ctx.hasUI) await finished;
		},
	});

	pi.registerCommand("better-cancel", {
		description: "Stop the /better helper that's running",
		handler: async (_args, ctx) => {
			if (!helperRun) {
				ctx.ui.notify("No /better is running.", "info");
				return;
			}
			helperRun.abort();
		},
	});
}

/**
 * The TUI gets the prompt in its input box; elsewhere there's no box to read back, so it's posted as a message.
 * `cacheNote` (how much of the chat's prompt cache the helper reused) goes into the TUI's notice.
 */
function handOver(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, cacheNote?: string): void {
	if (ctx.mode !== "tui") {
		// Never "steer" (the default while the agent works): that would feed the prompt to the running turn.
		pi.sendMessage({ customType: ENTRY, content: prompt, display: true }, ctx.isIdle() ? undefined : { deliverAs: "nextTurn" });
		return;
	}
	const draft = ctx.ui.getEditorText().trim();
	ctx.ui.setEditorText(draft ? `${prompt}\n\n${draft}` : prompt);
	ctx.ui.notify(`The improved prompt is in your input box${draft ? ", above the draft you'd typed" : ""}. Edit it, then press Enter to send.${cacheNote ? ` (${cacheNote})` : ""}`, "info");
}
