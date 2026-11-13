// Runs /better's helper: a separate `omp --mode json -p` process, read-only through this extension's guard,
// on a private copy of the chat. Everything it creates lives in one temp folder that is removed when it ends.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { applyHelperEvent, HELPER_ENV, HELPER_TIMEOUT_MS, HELPER_TOOLS, type HelperState, helperExitError, newHelperState, parseEventLine, rejectedCacheFlag } from "./better.ts";
import { type CacheUsage, helperCacheArgs, PINNED_SUFFIX, PREFIX_ENV, type RequestHead, serializeHead } from "./cache.ts";

export class Cancelled extends Error {}

const TEMP_PREFIX = "omp-better-";
const STDERR_LIMIT = 8192;
const KILL_GRACE_MS = 3000;
const GUARD_MARKER = "guard-ready";
/** Set in the helper's environment to the pid of the omp that started it. */
export const PARENT_ENV = "OMP_BETTER_PARENT_PID";
/** How often the helper checks that the omp that started it is still there. */
export const PARENT_POLL_MS = 2000;
// The helper's own terminal id would overwrite the chat's /continue breadcrumb with the temp session, which is
// deleted afterwards; without these (and without a TTY) omp has no terminal id to record.
const TERMINAL_ID_ENV = ["ZELLIJ_PANE_ID", "ZELLIJ_SESSION_NAME", "TMUX_PANE", "CMUX_SURFACE_ID", "KITTY_WINDOW_ID", "WEZTERM_PANE", "TERM_SESSION_ID", "WT_SESSION"];

export interface HelperOptions {
	cwd: string;
	/** The chat's session file; when given, the helper starts from a fork of a copy of it. */
	sessionFile?: string;
	modelArgs: string[];
	task: string;
	signal: AbortSignal;
	/** This extension's entry file, loaded into the helper so its guard runs there. */
	extensionPath: string;
	onProgress?: (state: HelperState) => void;
	/** How to start omp; defaults to the omp that is running this extension. */
	command?: string[];
	timeoutMs?: number;
	/** omp's agent directory. omp records a forked session kept outside its sessions folder in a marker file there; those markers are removed along with the temp folder. */
	agentDir?: string;
	/** The arguments omp itself was started with, to pass --profile on. */
	argv?: string[];
	/** The chat's last request head; when given, the helper pins its requests to it to reuse the chat's prompt cache. */
	head?: RequestHead;
	/** The chat's session id, passed on as the provider session id where that helps reuse (OpenAI Codex). */
	chatSessionId?: string;
}

export interface HelperResult {
	/** Text of the helper's last reply. */
	reply: string;
	/** Token usage of the helper's first request. */
	usage?: CacheUsage;
	/** Whether the helper swapped the chat's request head into its requests. */
	pinned: boolean;
	/** The stderr line with which omp refused the cache flags; the run was then repeated without reuse. */
	cacheFlagsRejected?: string;
}

/** The omp running this extension: a compiled omp is its own executable; from source it is bun plus the CLI script. */
export function ompCommand(): string[] {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script) && /\.(ts|js|mjs|cjs)$/.test(script)) return [process.execPath, script];
	return /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase()) ? ["omp"] : [process.execPath];
}

/**
 * omp lists sessions kept outside its sessions folder through small marker files in
 * `<agent dir>/custom-session-files/`, each holding a session path. Removes the ones whose path `matches`.
 */
export function removeSessionMarkers(agentDir: string | undefined, matches: (sessionPath: string) => boolean): void {
	if (!agentDir) return;
	const markers = join(agentDir, "custom-session-files");
	let names: string[];
	try {
		names = readdirSync(markers);
	} catch {
		return;
	}
	for (const name of names) {
		try {
			if (matches(readFileSync(join(markers, name), "utf8").trim())) rmSync(join(markers, name), { force: true });
		} catch {}
	}
}

/** Removes temp folders (and their session markers) left by an omp that died before it could clean up; the folder name carries its pid. */
export function sweepStaleTempDirs(root = tmpdir(), agentDir?: string): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	const pattern = new RegExp(`^${TEMP_PREFIX}(\\d+)-`);
	const dead = (pid: number) => {
		if (!pid || pid === process.pid) return false;
		try {
			process.kill(pid, 0);
			return false; // still running (or not ours to signal): leave it
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	};
	for (const name of names) {
		if (dead(Number(pattern.exec(name)?.[1]))) rmSync(join(root, name), { recursive: true, force: true });
	}
	removeSessionMarkers(agentDir, (path) => {
		const folder = path.startsWith(`${root}/`) ? path.slice(root.length + 1).split("/")[0] : undefined;
		return folder !== undefined && dead(Number(pattern.exec(folder)?.[1]));
	});
}

export interface ParentProbe {
	ppid: () => number;
	kill: (pid: number, signal: 0) => void;
}

const liveProbe: ParentProbe = { ppid: () => process.ppid, kill: (pid, signal) => process.kill(pid, signal) };

/**
 * Whether the omp that started the helper is gone. When it dies the helper is adopted by another process, so
 * its parent pid changes: a later process that reuses the old pid can't become its parent again. The parent's
 * pid is checked too, for an omp that started the helper through another process. EPERM counts as gone: the
 * parent runs as the same user, so a pid owned by someone else is a different process.
 */
export function parentGone(parentPid: number, startPpid: number, probe: ParentProbe = liveProbe): boolean {
	if (probe.ppid() !== startPpid) return true;
	try {
		probe.kill(parentPid, 0);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ESRCH" || code === "EPERM";
	}
}

/** Calls `onGone` once the parent is gone; checks every `intervalMs` on a timer that never keeps the process alive. Returns a stop function. */
export function watchParent(options: { parentPid: number; onGone: () => void; probe?: ParentProbe; intervalMs?: number }): () => void {
	const probe = options.probe ?? liveProbe;
	const startPpid = probe.ppid();
	const timer = setInterval(() => {
		if (!parentGone(options.parentPid, startPpid, probe)) return;
		clearInterval(timer);
		options.onGone();
	}, options.intervalMs ?? PARENT_POLL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** The helper's temp folder, from its guard marker path, if it is one askHelper made for `parentPid` directly in `root`. */
export function helperTempDir(marker: string, parentPid: number, root = tmpdir()): string | undefined {
	const dir = dirname(resolve(marker));
	if (basename(marker) !== GUARD_MARKER || dirname(dir) !== resolve(root) || !basename(dir).startsWith(`${TEMP_PREFIX}${parentPid}-`)) return undefined;
	return dir;
}

/** Removes a temp folder and the session markers omp keeps for sessions in it. */
export function removeTempDir(dir: string, agentDir: string | undefined): void {
	rmSync(dir, { recursive: true, force: true });
	removeSessionMarkers(agentDir, (path) => path.startsWith(`${dir}/`));
}

/** `--profile <name>` from omp's own arguments, so the helper uses the same auth, settings and sessions. */
export function profileArgs(argv: string[]): string[] {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) return ["--profile", argv[i + 1]];
		if (argv[i].startsWith("--profile=")) return ["--profile", argv[i].slice("--profile=".length)];
	}
	return [];
}

/** Copies the session file up to its last complete line, so a line the chat is writing right now can't be cut. */
function copySession(source: string, target: string): void {
	const data = readFileSync(source);
	const end = data.lastIndexOf(0x0a);
	if (end === data.length - 1) copyFileSync(source, target);
	else writeFileSync(target, data.subarray(0, end + 1));
}

export function helperArgs(options: { sourceCopy?: string; sessionDir: string; extensionPath: string; modelArgs: string[]; task: string; profile?: string[]; cacheArgs?: string[] }): string[] {
	return [
		"--mode", "json", "-p",
		...(options.profile ?? []),
		...(options.sourceCopy ? ["--fork", options.sourceCopy, "--session-dir", options.sessionDir] : ["--no-session"]),
		// Only this extension: its guard must load, and the user's other extensions shouldn't run once per helper.
		"--no-extensions", "-e", options.extensionPath,
		"--tools", HELPER_TOOLS.join(","),
		"--no-title",
		"--max-time", `${Math.ceil(HELPER_TIMEOUT_MS / 60_000)}m`,
		...(options.cacheArgs ?? []),
		...options.modelArgs,
		options.task,
	];
}

/** Thrown by one helper run when omp refused the cache flags before any reply. */
class CacheFlagsRejected extends Error {}

/**
 * Runs the helper and resolves with its last reply. Rejects with Cancelled when the signal aborts. If omp
 * refuses the cache flags (an omp that doesn't know them), the run is repeated once without cache reuse.
 */
export async function askHelper(options: HelperOptions): Promise<HelperResult> {
	try {
		return await runHelper(options);
	} catch (error) {
		if (!(error instanceof CacheFlagsRejected)) throw error;
		if (options.signal.aborted) throw new Cancelled("cancelled");
		const result = await runHelper({ ...options, head: undefined, chatSessionId: undefined });
		return { ...result, cacheFlagsRejected: error.message };
	}
}

function runHelper(options: HelperOptions): Promise<HelperResult> {
	const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
	const temp = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
	const cleanUp = () => removeTempDir(temp, options.agentDir);
	let child: ChildProcessByStdio<null, Readable, Readable>;
	const marker = join(temp, GUARD_MARKER);
	const prefix = join(temp, "prefix.json");
	const cacheArgs = helperCacheArgs(options.head, options.chatSessionId);
	try {
		let sourceCopy: string | undefined;
		if (options.sessionFile) {
			sourceCopy = join(temp, "source.jsonl");
			copySession(options.sessionFile, sourceCopy);
			mkdirSync(join(temp, "sessions"));
		}
		const env: NodeJS.ProcessEnv = { ...process.env, [HELPER_ENV]: marker, [PARENT_ENV]: String(process.pid), PI_NO_TITLE: "1" };
		for (const key of TERMINAL_ID_ENV) delete env[key];
		delete env[PREFIX_ENV];
		// The chat's system prompt and tool list: private to this folder (0700), and removed with it.
		if (options.head) {
			env[PREFIX_ENV] = prefix;
			writeFileSync(prefix, serializeHead(options.head), { mode: 0o600 });
		}
		const [command, ...prefixArgs] = options.command ?? ompCommand();
		const args = helperArgs({ sourceCopy, sessionDir: join(temp, "sessions"), extensionPath: options.extensionPath, modelArgs: options.modelArgs, task: options.task, profile: profileArgs(options.argv ?? process.argv), cacheArgs });
		child = spawn(command, [...prefixArgs, ...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env });
	} catch (error) {
		cleanUp();
		return Promise.reject(error);
	}

	const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<HelperResult>();
	const state = newHelperState();
	let stderr = "";
	let buffered = "";
	let timedOut = false;
	let guardMissing = false;
	let settled = false;
	let killTimer: NodeJS.Timeout | undefined;
	const stop = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		killTimer.unref?.();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, timeoutMs);
	const onAbort = () => {
		stop();
		// The helper may still be writing as it exits; if this fails, settle() removes the folder once it has.
		try {
			cleanUp();
		} catch {}
	};
	// When omp exits mid-run it doesn't wait for the helper's close event.
	const onExit = () => {
		child.kill("SIGKILL");
		try {
			cleanUp();
		} catch {}
	};
	options.signal.addEventListener("abort", onAbort, { once: true });
	process.once("exit", onExit);
	if (options.signal.aborted) onAbort();

	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		const lines = (buffered + chunk).split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const event = parseEventLine(line);
			if (!event) continue;
			// The guard writes its marker when the extension loads, before omp starts the session; without it the
			// helper would run unguarded, so it is stopped before its first model request.
			if (event.type === "session" && !existsSync(marker)) {
				guardMissing = true;
				stop();
				return;
			}
			applyHelperEvent(state, event);
			options.onProgress?.(state);
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_LIMIT);
	});

	const settle = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		clearTimeout(killTimer);
		options.signal.removeEventListener("abort", onAbort);
		process.removeListener("exit", onExit);
		const pinned = existsSync(`${prefix}${PINNED_SUFFIX}`);
		cleanUp();
		if (error) reject(error);
		else resolvePromise({ reply: state.reply, usage: state.usage, pinned });
	};
	child.on("error", (error) => settle(new Error(`Couldn't start omp for the helper: ${error.message}`)));
	child.on("close", (code, exitSignal) => {
		if (options.signal.aborted) return settle(new Cancelled("cancelled"));
		if (guardMissing) return settle(new Error(`The helper's read-only guard didn't load, so it was stopped before it could act. ${helperExitError(code, exitSignal, stderr)}`));
		if (timedOut) return settle(new Error(`The helper timed out after ${Math.round(timeoutMs / 60_000)} minutes; try a narrower prompt`));
		if (state.modelError) return settle(new Error(`The helper's model call failed: ${state.modelError}`));
		// An omp that doesn't know the cache flags exits before any reply; every other failure is reported as is.
		const rejected = cacheArgs.length > 0 && code !== 0 && !state.reply.trim() && !state.usage ? rejectedCacheFlag(stderr) : undefined;
		if (rejected) return settle(new CacheFlagsRejected(rejected));
		if (code !== 0) return settle(new Error(helperExitError(code, exitSignal, stderr)));
		if (!state.reply.trim()) return settle(new Error("The helper finished without replying; run /better again"));
		settle();
	});
	return promise;
}
