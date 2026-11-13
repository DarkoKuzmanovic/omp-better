// Pure parts of /better: the task text, the reply parser, progress tracking, error wording, the helper's model
// flags and the read-only guard that runs inside the helper process. Nothing here spawns or talks to omp.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CacheUsage } from "./cache.ts";

const OPEN = "<improved-prompt>";
const CLOSE = "</improved-prompt>";
// The opening tag counts only on a line of its own; the prompt itself may mention the tag inline.
const OPEN_LINE = `\n${OPEN}\n`;

/** Set in the helper's environment to the path of a file the guard writes when it loads. */
export const HELPER_ENV = "OMP_BETTER_HELPER";
export const HELPER_TIMEOUT_MS = 20 * 60 * 1000;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** The only tools the helper may call. Everything else, including tools omp adds on its own, is refused. */
export const HELPER_TOOLS = ["read", "grep", "glob", "find", "ast_grep", "lsp", "web_search"];
/** lsp actions that only look; rename, code_actions, reload and raw requests can change files or servers. */
export const LSP_READ_ACTIONS = ["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"];
/** Internal URL schemes the helper may read. ssh://, vault://, proc://, mcp://, xd:// and unknown ones are refused. */
export const READ_SCHEMES = ["http", "https", "file", "skill", "omp", "rule", "artifact", "local", "memory", "history", "agent", "issue", "pr"];

// Under the home directory: whole trees, then single files (prefix match on the path relative to home).
const HOME_SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".password-store", ".docker", ".kube", ".omp/agent/secrets"];
const HOME_SECRET_FILES = [/^\.omp\/agent\/agent\.db/, /^\.omp\/agent\/models\.ya?ml$/, /^\.omp\/agent\/mcp\.json$/, /^\.config\/.+\/credentials[^/]*$/];
// Anywhere: any path component named like these.
const SECRET_NAMES = [/^\.env/, /^auth[^/]*\.json$/i, /^\.netrc$/, /^\.git-credentials$/, /^\.pgpass$/, /^\.npmrc$/, /^\.pypirc$/, /^id_(rsa|dsa|ecdsa|ed25519)/];
/** Appended to grep's path so a directory search skips files the guard would refuse to read. */
export const SECRET_EXCLUDES = ["!**/.env*", "!**/auth*.json", "!**/.netrc", "!**/.git-credentials", "!**/.pgpass", "!**/.npmrc", "!**/.pypirc", "!**/id_rsa*", "!**/id_dsa*", "!**/id_ecdsa*", "!**/id_ed25519*", "!**/.ssh", "!**/.aws", "!**/.gnupg", "!**/agent.db*", "!**/credentials*"];

const returnSection = `## Return

Give answers (1) to (4) in your reply, each starting a new line with its number, like "(1)". Then end it with the rewritten prompt, complete, between these two lines and nothing after them:

${OPEN}
the rewritten prompt
${CLOSE}`;

/** helper.md opens with an attribution comment for people; the model gets only what follows it. */
export function helperPrompt(markdown: string): string {
	return markdown.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

/**
 * The helper's task. `tools` names the tools that run when the helper is pinned to the chat's tool list, which
 * advertises tools the guard refuses.
 */
export function buildHelperTask(helper: string, prompt: string, tools?: string[]): string {
	return [
		helper.trim(),
		...(tools ? [`Only these tools work for you here, those of them you have: ${tools.join(", ")}. Every other tool is refused.`] : []),
		`## Prompt to deepen\n\n${prompt || "None given: deepen the task in progress in the conversation so far, including any feedback I gave on work already done."}`,
		returnSection,
	].join("\n\n");
}

export function parseMarkedPrompt(reply: string): string {
	const end = reply.lastIndexOf(CLOSE);
	const before = `\n${reply.slice(0, Math.max(end, 0))}`;
	const start = before.lastIndexOf(OPEN_LINE);
	if (end < 0 || start < 0) throw new Error(`The reply has no ${OPEN} … ${CLOSE} block.`);
	const prompt = before.slice(start + OPEN_LINE.length).trim();
	if (!prompt) throw new Error(`The reply's ${OPEN} block is empty.`);
	return prompt;
}

export function replyProgress(text: string): { answered: number; writingPrompt: boolean } {
	let answered = 0;
	for (const [, n] of text.matchAll(/^\W*\(([1-4])\)/gm)) answered = Math.max(answered, Number(n));
	return { answered, writingPrompt: `\n${text}`.includes(OPEN_LINE) };
}

export function helperExitError(code: number | null, signal: string | null, stderr: string): string {
	const how = code === null ? `was stopped by ${signal ?? "an unknown signal"}` : `exited with code ${code}`;
	const tail = stderr.trim().split("\n").slice(-3).join(" ");
	return tail ? `The helper ${how}: ${tail}` : `The helper ${how} without printing an error`;
}

/**
 * The helper runs on the chat's model and thinking level. OMP_BETTER_MODEL ("provider/id" or a role such as
 * "@smol") and OMP_BETTER_THINKING pin either one instead.
 */
export function helperModelArgs(env: { model?: string; thinking?: string }, chatModel: string | undefined, chatThinking: string | undefined): string[] {
	const model = env.model?.trim() || chatModel;
	const thinking = env.thinking?.trim() || chatThinking;
	if (!model) throw new Error("No model is selected; pick one with /model or set OMP_BETTER_MODEL.");
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
		throw new Error(`OMP_BETTER_THINKING must be one of ${THINKING_LEVELS.join(", ")}; it is "${thinking}".`);
	}
	return ["--model", model, ...(thinking ? ["--thinking", thinking] : [])];
}

export interface GuardScope {
	cwd: string;
	home: string;
}

function secretInPath(absolute: string, home: string): string | undefined {
	const named = absolute.split("/").find((part) => SECRET_NAMES.some((name) => name.test(part)));
	if (named) return named;
	const fromHome = relative(home, absolute);
	if (fromHome.startsWith("..") || isAbsolute(fromHome)) return undefined;
	// omp --profile <name> keeps the same files under ~/.omp/profiles/<name>/, so check them as ~/.omp/.
	const canonical = fromHome.replace(/^\.omp\/profiles\/[^/]+\//, ".omp/");
	if (HOME_SECRET_DIRS.some((dir) => canonical === dir || canonical.startsWith(`${dir}/`))) return `~/${fromHome}`;
	if (HOME_SECRET_FILES.some((file) => file.test(canonical))) return `~/${fromHome}`;
	return undefined;
}

/** The credential a local path names, checked as given (relative to cwd, "~" expanded) and, if it exists, after resolving symlinks. */
function credentialAt(path: string, { cwd, home }: GuardScope): string | undefined {
	const absolute = resolve(cwd, path.replace(/^~(?=\/|$)/, home));
	const direct = secretInPath(absolute, home);
	if (direct) return direct;
	try {
		return secretInPath(realpathSync(absolute), home);
	} catch {
		return undefined;
	}
}

/**
 * Why the helper may not touch this path argument, or undefined when it may. A value can list several paths
 * separated by ";" (grep, glob, ast_grep); "!glob" exclusions are skipped, and a ":selector" or archive member
 * after the path is checked too. Existing paths are also checked after resolving symlinks.
 */
export function pathRefusal(value: string, scope: GuardScope): string | undefined {
	for (const raw of value.split(";")) {
		const entry = raw.trim().replace(/^@(?=\/)/, "");
		if (!entry || entry.startsWith("!")) continue;
		const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(entry)?.[1]?.toLowerCase();
		if (scheme && !READ_SCHEMES.includes(scheme)) return `${scheme}:// is off for /better's helper`;
		const [head = "", ...rest] = scheme ? [entry] : entry.split(":");
		const local = scheme === "file" ? entry.slice("file://".length) : scheme ? undefined : head;
		const secret = local === undefined ? undefined : credentialAt(local, scope);
		if (secret) return `${secret} looks like a credential file, and /better's helper doesn't read those`;
		// URLs, internal URLs and archive members: only the name rules apply.
		for (const piece of scheme && scheme !== "file" ? [entry] : rest) {
			const named = piece.split("/").find((part) => SECRET_NAMES.some((name) => name.test(part)));
			if (named) return `${named} looks like a credential file, and /better's helper doesn't read those`;
		}
	}
	return undefined;
}

/** Path arguments per allowed tool. */
const PATH_ARGS: Record<string, string[]> = { read: ["path"], grep: ["path"], glob: ["path"], find: ["path"], ast_grep: ["path"], lsp: ["file"] };

/**
 * The helper's tool_call verdict: a block with the reason the model sees, or undefined to let the call run.
 * Unknown tools fail closed.
 */
export function helperToolBlock(toolName: string, input: Record<string, unknown>, scope: GuardScope): { block: true; reason: string } | undefined {
	if (!HELPER_TOOLS.includes(toolName)) {
		return { block: true, reason: `/better's helper only reads and rewrites, so ${toolName} is off. Use ${HELPER_TOOLS.join(", ")}.` };
	}
	if (toolName === "lsp" && (!LSP_READ_ACTIONS.includes(String(input.action)) || input.apply === true)) {
		return { block: true, reason: `/better's helper only reads, so lsp ${String(input.action)}${input.apply === true ? " with apply" : ""} is off. Use one of ${LSP_READ_ACTIONS.join(", ")}.` };
	}
	for (const key of PATH_ARGS[toolName] ?? []) {
		const value = input[key];
		if (typeof value !== "string") continue;
		const refusal = pathRefusal(value, scope);
		if (refusal) return { block: true, reason: `${refusal}. Leave it out.` };
	}
	return undefined;
}

/** grep's path with the credential exclusions added, so a search over a directory skips those files. */
export function withSecretExcludes(path: unknown): string {
	const base = typeof path === "string" && path.trim() ? path.trim() : ".";
	return [base, ...SECRET_EXCLUDES].join(";");
}

/**
 * The credential file a search result shows, if any. grep and ast_grep head each file with nested "# dir",
 * "## name#TAG" headings or "[path#TAG]"; find starts its lines with "path" or "path:start-end". Each such path is
 * checked like a path argument, symlinks resolved, so a link to a credential file is caught too. Line contents
 * aren't matched against the name rules, so code that merely mentions ".env" passes.
 */
export function credentialInResult(text: string, scope: GuardScope): string | undefined {
	const headings: string[] = [];
	for (const line of text.split("\n")) {
		const heading = /^(#+) (.+?)(?:#[0-9A-F]{4})?\s*$/.exec(line);
		let path: string | undefined;
		if (heading) {
			const depth = heading[1].length;
			headings.length = depth - 1;
			headings[depth - 1] = heading[2];
			path = join(...headings.filter(Boolean));
		} else {
			path = /^\[(.+?)(?:#[0-9A-F]{4})?\]/.exec(line)?.[1] ?? /^\s*([^\s|*:#][^\s:]*)(?::\d+(?:-\d+)?)?(?:\s|$)/.exec(line)?.[1];
		}
		const secret = path && credentialAt(path, scope);
		if (secret) return secret;
	}
	return undefined;
}

// --- The helper's JSON event stream (omp --mode json) ---

export interface HelperState {
	/** Text of the last assistant message that had any. */
	reply: string;
	/** Text streamed so far in the assistant message being written. */
	streaming: string;
	/** Set when the last assistant message ended in an error or abort. */
	modelError?: string;
	tools: number;
	failedTools: number;
	lastTool?: string;
	/** Whether the session header has arrived. */
	started: boolean;
	/** Token usage of the first assistant message, the one request that can read the chat's cache. */
	usage?: CacheUsage;
}

export function newHelperState(): HelperState {
	return { reply: "", streaming: "", tools: 0, failedTools: 0, started: false };
}

type ContentPart = { type?: string; text?: string };
type HelperEvent = {
	type?: string;
	message?: { role?: string; content?: ContentPart[] | string; stopReason?: string; errorMessage?: string; usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } };
	assistantMessageEvent?: { type?: string; delta?: string };
	toolName?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
};

/** One line of the helper's stdout as an event, or undefined for blank or non-JSON lines (an extension may print). */
export function parseEventLine(line: string): HelperEvent | undefined {
	if (!line.trim()) return undefined;
	try {
		const event: unknown = JSON.parse(line);
		return event && typeof event === "object" ? (event as HelperEvent) : undefined;
	} catch {
		return undefined;
	}
}

function toolLabel(name: string, args: Record<string, unknown> | undefined): string {
	const target = [args?.path, args?.file, args?.pat, args?.pattern, args?.query].find((value) => typeof value === "string");
	const label = typeof target === "string" ? `${name} ${target}` : name;
	// One row: a newline or tab in a pattern would make the widget taller.
	const flat = label.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
	return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

export function applyHelperEvent(state: HelperState, event: HelperEvent): void {
	switch (event.type) {
		case "session":
			state.started = true;
			break;
		case "message_start":
			if (event.message?.role === "assistant") state.streaming = "";
			break;
		case "message_update":
			if (event.assistantMessageEvent?.type === "text_delta") state.streaming += event.assistantMessageEvent.delta ?? "";
			break;
		case "message_end": {
			const message = event.message;
			if (message?.role !== "assistant") break;
			// --mode json can exit 0 after a failed model call, so the failure is read from the message.
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			state.modelError = failed ? message.errorMessage || `request ${message.stopReason}` : undefined;
			const usage = message.usage;
			if (!state.usage && usage && typeof usage.input === "number" && typeof usage.cacheRead === "number" && typeof usage.cacheWrite === "number") {
				state.usage = { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
			}
			const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
			const text = parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
			if (text.trim()) {
				state.reply = text;
				state.streaming = text;
			}
			break;
		}
		case "tool_execution_start":
			state.tools++;
			state.lastTool = toolLabel(event.toolName ?? "tool", event.args);
			break;
		case "tool_execution_end":
			if (event.isError) state.failedTools++;
			break;
	}
}

const ANSWERING = ["Working out what a pro would do", "Finding the rawest material", "Picking the methods and tools", "Deciding what would prove it right"];

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The progress widget's two lines. */
export function progressLines(state: HelperState, elapsedMs: number): string[] {
	const { answered, writingPrompt } = replyProgress(state.streaming);
	const stage = writingPrompt ? "Writing your improved prompt" : answered ? `${ANSWERING[answered - 1]} (${answered} of 4)` : "Reading your code and files";
	const tools = `${state.tools} tool${state.tools === 1 ? "" : "s"}${state.failedTools ? ` (${state.failedTools} refused or failed)` : ""}`;
	return [`/better · ${stage} · ${formatElapsed(elapsedMs)} · /better-cancel stops it`, `  ${tools}${state.lastTool ? ` · last: ${state.lastTool}` : ""}`];
}
