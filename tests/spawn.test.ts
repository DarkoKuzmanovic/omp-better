import { afterEach, describe, expect, test, vi } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_TOOLS, parseMarkedPrompt } from "../better.ts";
import { parseHead, type RequestHead } from "../cache.ts";
import { askHelper, Cancelled, helperArgs, helperTempDir, PARENT_POLL_MS, type ParentProbe, parentGone, profileArgs, sweepStaleTempDirs, watchParent } from "../spawn.ts";

const fake = ["bun", new URL("./fake-omp.ts", import.meta.url).pathname];
const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const ours = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`omp-better-${process.pid}-`));
const FAKE_KEYS = ["FAKE_OMP_FIXTURE", "FAKE_OMP_GUARD", "FAKE_OMP_EXIT", "FAKE_OMP_STDERR", "FAKE_OMP_SIGNAL", "FAKE_OMP_HANG", "FAKE_OMP_REPORT", "FAKE_OMP_AGENT_DIR", "FAKE_OMP_PIN", "FAKE_OMP_CALLS", "FAKE_OMP_REJECT_CACHE_FLAGS"];
const codexHead: RequestHead = {
	model: { provider: "openai-codex", id: "gpt-x", api: "openai-codex-responses" },
	fields: { instructions: "SYSTEM", tools: [{ type: "function", name: "bash" }], prompt_cache_key: "chat-key", developer: [] },
};

function setFake(values: Record<string, string>): void {
	for (const key of FAKE_KEYS) delete process.env[key];
	Object.assign(process.env, values);
}

function run(signal = new AbortController().signal, extra: { sessionFile?: string; timeoutMs?: number; agentDir?: string; argv?: string[]; head?: RequestHead; chatSessionId?: string } = {}) {
	return askHelper({ cwd: tmpdir(), modelArgs: ["--model", "test/model"], task: "TASK", signal, extensionPath: "/ext/index.ts", command: fake, ...extra });
}

/** Runs `body` with a fresh folder for reports, removed afterwards. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
	try {
		await body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(() => {
	setFake({});
	expect(ours()).toEqual([]);
});

describe("helperArgs", () => {
	test("forks the copy into the temp session dir, loads only this extension, and never auto-approves", () => {
		const args = helperArgs({ sourceCopy: "/t/source.jsonl", sessionDir: "/t/sessions", extensionPath: "/ext/index.ts", modelArgs: ["--model", "a/b", "--thinking", "high"], task: "TASK" });
		expect(args).toEqual([
			"--mode", "json", "-p", "--fork", "/t/source.jsonl", "--session-dir", "/t/sessions", "--no-extensions", "-e", "/ext/index.ts",
			"--tools", HELPER_TOOLS.join(","), "--no-title", "--max-time", "20m", "--model", "a/b", "--thinking", "high", "TASK",
		]);
		expect(args.some((arg) => /auto-approve|yolo|approval/.test(arg))).toBe(false);
	});

	test("without a session file the helper keeps no session", () => {
		const args = helperArgs({ sessionDir: "/t/sessions", extensionPath: "/e.ts", modelArgs: [], task: "T" });
		expect(args.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(args).not.toContain("--fork");
	});

	test("passes omp's --profile on, in either spelling", () => {
		expect(profileArgs(["bun", "/$bunfs/root/omp", "--profile", "work", "-c"])).toEqual(["--profile", "work"]);
		expect(profileArgs(["omp", "--profile=home"])).toEqual(["--profile", "home"]);
		expect(profileArgs(["omp", "--no-session"])).toEqual([]);
		expect(helperArgs({ sessionDir: "/t", extensionPath: "/e.ts", modelArgs: [], task: "T", profile: ["--profile", "work"] }).slice(0, 5)).toEqual(["--mode", "json", "-p", "--profile", "work"]);
	});

	test("puts the cache flags before the model flags, and keeps the restricted tool list and the guard", () => {
		const cacheArgs = ["--prompt-cache-key", "chat-key", "--provider-session-id", "chat-id"];
		const args = helperArgs({ sourceCopy: "/t/s.jsonl", sessionDir: "/t/sessions", extensionPath: "/e.ts", modelArgs: ["--model", "a/b"], task: "T", cacheArgs });
		expect(args.slice(args.indexOf("--prompt-cache-key"), args.indexOf("--prompt-cache-key") + 6)).toEqual([...cacheArgs, "--model", "a/b"]);
		expect(args).toContain("--no-extensions");
		expect(args[args.indexOf("--tools") + 1]).toBe(HELPER_TOOLS.join(","));
		expect(helperArgs({ sessionDir: "/t", extensionPath: "/e.ts", modelArgs: [], task: "T" })).not.toContain("--prompt-cache-key");
	});
});

describe("askHelper", () => {
	test("returns the last reply and the first request's usage of a captured helper run, and cleans up", async () => {
		setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl") });
		const result = await run();
		expect(parseMarkedPrompt(result.reply)).toContain("src/cli.ts");
		expect(result.usage).toEqual({ input: 4, cacheRead: 0, cacheWrite: 17873 });
		expect(result.pinned).toBe(false);
	});

	test("hands a pinned helper the chat's request head in a private file and its cache key, then removes the file", async () => {
		await withDir(async (dir) => {
			const report = join(dir, "report.json");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REPORT: report, FAKE_OMP_PIN: "1" });
			const result = await run(undefined, { head: codexHead, chatSessionId: "chat-id" });
			const seen = JSON.parse(readFileSync(report, "utf8"));
			expect(seen.prefix).toMatch(new RegExp(`/omp-better-${process.pid}-[^/]+/prefix\\.json$`));
			expect(seen.prefixMode).toBe(0o600);
			expect(parseHead(seen.prefixContent)).toEqual(codexHead);
			expect(seen.args[seen.args.indexOf("--prompt-cache-key") + 1]).toBe("chat-key");
			expect(seen.args[seen.args.indexOf("--provider-session-id") + 1]).toBe("chat-id");
			expect(result.pinned).toBe(true);
			expect(existsSync(seen.prefix)).toBe(false);
		});
	});

	test("without a head the helper gets no prefix and no cache key, even if omp's environment had one", async () => {
		await withDir(async (dir) => {
			const report = join(dir, "report.json");
			process.env.OMP_BETTER_PREFIX = "/somewhere/prefix.json";
			try {
				setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REPORT: report, FAKE_OMP_PIN: "1" });
				const result = await run();
				const seen = JSON.parse(readFileSync(report, "utf8"));
				expect(seen.envKeys).not.toContain("OMP_BETTER_PREFIX");
				expect(seen.args).not.toContain("--prompt-cache-key");
				expect(result.pinned).toBe(false);
			} finally {
				delete process.env.OMP_BETTER_PREFIX;
			}
		});
	});

	test("an Anthropic head has no cache key to pass", async () => {
		await withDir(async (dir) => {
			const report = join(dir, "report.json");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REPORT: report });
			const head: RequestHead = { model: { provider: "anthropic", id: "c", api: "anthropic-messages" }, fields: { system: [{ type: "text", text: "S" }], tools: [{ name: "read" }] } };
			const result = await run(undefined, { head, chatSessionId: "chat-id" });
			const seen = JSON.parse(readFileSync(report, "utf8"));
			expect(parseHead(seen.prefixContent)).toEqual(head);
			expect(seen.args).not.toContain("--prompt-cache-key");
			expect(seen.args).not.toContain("--provider-session-id");
			// The fake didn't pin, like a helper whose model or request shape didn't match.
			expect(result.pinned).toBe(false);
		});
	});

	test("hands the helper a copy of the session cut at its last complete line, passes --profile on, withholds the terminal id and removes omp's marker for the fork", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
		try {
			const session = join(dir, "chat.jsonl");
			const original = '{"type":"session","id":"x"}\n{"type":"message"}\n{"type":"mess';
			writeFileSync(session, original);
			const report = join(dir, "report.json");
			const agentDir = join(dir, "agent");
			mkdirSync(join(agentDir, "custom-session-files"), { recursive: true });
			writeFileSync(join(agentDir, "custom-session-files", "keep123"), "/home/me/elsewhere/s.jsonl\n");
			process.env.KITTY_WINDOW_ID = "13";
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REPORT: report, FAKE_OMP_AGENT_DIR: agentDir });
			await run(undefined, { sessionFile: session, agentDir, argv: ["omp", "--profile", "work"] });
			const seen = JSON.parse(readFileSync(report, "utf8"));
			expect(seen.fork).toMatch(new RegExp(`/omp-better-${process.pid}-[^/]+/source\\.jsonl$`));
			expect(seen.forkContent).toBe('{"type":"session","id":"x"}\n{"type":"message"}\n');
			expect(seen.args[seen.args.indexOf("--session-dir") + 1]).toBe(join(seen.fork, "..", "sessions"));
			expect(seen.args.slice(0, 5)).toEqual(["--mode", "json", "-p", "--profile", "work"]);
			expect(seen.envKeys).toContain("OMP_BETTER_HELPER");
			expect(seen.envKeys).not.toContain("KITTY_WINDOW_ID");
			expect(readFileSync(session, "utf8")).toBe(original);
			expect(readdirSync(join(agentDir, "custom-session-files"))).toEqual(["keep123"]);
		} finally {
			delete process.env.KITTY_WINDOW_ID;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tells the helper which omp started it", async () => {
		await withDir(async (dir) => {
			const report = join(dir, "report.json");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REPORT: report });
			await run();
			expect(JSON.parse(readFileSync(report, "utf8")).parentPid).toBe(String(process.pid));
		});
	});

	test("stops a helper whose guard didn't load", async () => {
		setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_GUARD: "missing", FAKE_OMP_HANG: "1" });
		await expect(run()).rejects.toThrow(/read-only guard didn't load, so it was stopped before it could act/);
	});

	test("reports an exit code with the end of stderr", async () => {
		setFake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: "boot\nError: Model not found: test/model\n" });
		await expect(run()).rejects.toThrow("The helper exited with code 1: boot Error: Model not found: test/model");
	});

	test("reports a helper killed by a signal", async () => {
		setFake({ FAKE_OMP_SIGNAL: "SIGKILL" });
		await expect(run()).rejects.toThrow("The helper was stopped by SIGKILL without printing an error");
	});

	test("reports a failed model call even when the helper exits 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
		try {
			const events = [{ type: "session" }, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid x-api-key" } }];
			writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
			setFake({ FAKE_OMP_FIXTURE: join(dir, "events.jsonl") });
			await expect(run()).rejects.toThrow("The helper's model call failed: 401 invalid x-api-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports a helper that finished without replying", async () => {
		setFake({});
		await expect(run()).rejects.toThrow("The helper finished without replying; run /better again");
	});

	test("abort kills a pinned helper, removes the temp folder with the prefix and rejects with Cancelled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
		try {
			const report = join(dir, "report.json");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_HANG: "1", FAKE_OMP_REPORT: report });
			const controller = new AbortController();
			const pending = run(controller.signal, { head: codexHead });
			// A real child process writes this file; poll for it rather than guess how long its start takes.
			while (!existsSync(report)) await Bun.sleep(20);
			const { pid, prefix } = JSON.parse(readFileSync(report, "utf8"));
			expect(existsSync(prefix)).toBe(true);
			controller.abort();
			await expect(pending).rejects.toBeInstanceOf(Cancelled);
			expect(() => process.kill(pid, 0)).toThrow();
			expect(existsSync(prefix)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a helper over its time limit is stopped", async () => {
		setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_HANG: "1" });
		// The limit is a real timer racing a real (hanging) child process, so fake timers can't drive it.
		await expect(run(undefined, { timeoutMs: 400, head: codexHead })).rejects.toThrow(/The helper timed out after/);
	});

	test("a command that can't start is reported", async () => {
		await expect(askHelper({ cwd: tmpdir(), modelArgs: [], task: "T", signal: new AbortController().signal, extensionPath: "/e.ts", command: ["/nonexistent/omp-binary"] })).rejects.toThrow(/Couldn't start omp for the helper/);
	});
});

describe("an omp that rejects the cache flags", () => {
	const calls = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; prefix?: string });

	test("gets the run again without the flags and without the chat's head", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "calls.jsonl");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_REJECT_CACHE_FLAGS: "1", FAKE_OMP_CALLS: log, FAKE_OMP_PIN: "1" });
			const result = await run(undefined, { head: codexHead, chatSessionId: "chat-id" });
			expect(parseMarkedPrompt(result.reply)).toContain("src/cli.ts");
			expect(result.cacheFlagsRejected).toBe("Error: unknown flag: --prompt-cache-key");
			expect(result.pinned).toBe(false);
			const [first, retry, ...more] = calls(log);
			expect(more).toEqual([]);
			expect(first.args).toContain("--prompt-cache-key");
			expect(first.prefix).toBeDefined();
			expect(retry.args).not.toContain("--prompt-cache-key");
			expect(retry.args).not.toContain("--provider-session-id");
			expect(retry.prefix).toBeUndefined();
		});
	});

	test("surfaces a rejection on the retry instead of trying again", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "calls.jsonl");
			setFake({ FAKE_OMP_REJECT_CACHE_FLAGS: "always", FAKE_OMP_CALLS: log });
			await expect(run(undefined, { head: codexHead, chatSessionId: "chat-id" })).rejects.toThrow("The helper exited with code 2: Error: unknown flag: --prompt-cache-key Run `omp --help` for available flags.");
			expect(calls(log)).toHaveLength(2);
		});
	});

	test("any other failure is not retried, even with the cache flags passed", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "calls.jsonl");
			setFake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: "Error: Model not found: test/model\n", FAKE_OMP_CALLS: log });
			await expect(run(undefined, { head: codexHead, chatSessionId: "chat-id" })).rejects.toThrow("The helper exited with code 1: Error: Model not found: test/model");
			expect(calls(log)).toHaveLength(1);
		});
	});

	test("a run that already replied is not retried", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "calls.jsonl");
			setFake({ FAKE_OMP_FIXTURE: join(fixtures, "helper-run.jsonl"), FAKE_OMP_EXIT: "2", FAKE_OMP_STDERR: "Error: unknown flag: --prompt-cache-key\n", FAKE_OMP_CALLS: log });
			await expect(run(undefined, { head: codexHead, chatSessionId: "chat-id" })).rejects.toThrow(/exited with code 2/);
			expect(calls(log)).toHaveLength(1);
		});
	});

	test("an Anthropic run passes no cache flags, so it is never retried", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "calls.jsonl");
			setFake({ FAKE_OMP_REJECT_CACHE_FLAGS: "always", FAKE_OMP_CALLS: log });
			const head: RequestHead = { model: { provider: "anthropic", id: "c", api: "anthropic-messages" }, fields: { system: [{ type: "text", text: "S" }], tools: [{ name: "read" }] } };
			await expect(run(undefined, { head, chatSessionId: "chat-id" })).rejects.toThrow(/exited with code 2/);
			expect(calls(log)).toHaveLength(1);
		});
	});
});

describe("watching the omp that started the helper", () => {
	const probe = (ppid: () => number, kill: ParentProbe["kill"] = () => {}): ParentProbe => ({ ppid, kill });
	const failing = (code: string) => () => {
		throw Object.assign(new Error(code), { code });
	};

	test("the parent is there while the helper keeps its parent and the pid answers", () => {
		expect(parentGone(100, 100, probe(() => 100))).toBe(false);
		// An omp that started the helper through another process: that process is the helper's parent.
		expect(parentGone(100, 150, probe(() => 150))).toBe(false);
	});

	test("the parent is gone once the helper was adopted, even if a new process took the old pid", () => {
		expect(parentGone(100, 100, probe(() => 1))).toBe(true);
		expect(parentGone(100, 100, probe(() => 1075))).toBe(true);
	});

	test("the parent is gone when its pid is free or belongs to another user; other errors don't count", () => {
		expect(parentGone(100, 150, probe(() => 150, failing("ESRCH")))).toBe(true);
		expect(parentGone(100, 150, probe(() => 150, failing("EPERM")))).toBe(true);
		expect(parentGone(100, 150, probe(() => 150, failing("EINVAL")))).toBe(false);
	});

	test("watchParent checks on its interval and calls onGone once, after the parent goes", () => {
		vi.useFakeTimers();
		try {
			let ppid = 100;
			let gone = 0;
			watchParent({ parentPid: 100, onGone: () => gone++, probe: probe(() => ppid) });
			vi.advanceTimersByTime(PARENT_POLL_MS * 3);
			expect(gone).toBe(0);
			ppid = 1;
			vi.advanceTimersByTime(PARENT_POLL_MS - 1);
			expect(gone).toBe(0);
			vi.advanceTimersByTime(PARENT_POLL_MS * 3);
			expect(gone).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("stopping the watch ends the checks", () => {
		vi.useFakeTimers();
		try {
			let ppid = 100;
			let gone = 0;
			const stop = watchParent({ parentPid: 100, onGone: () => gone++, probe: probe(() => ppid) });
			stop();
			ppid = 1;
			vi.advanceTimersByTime(PARENT_POLL_MS * 3);
			expect(gone).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the watch never keeps a process alive on its own", () => {
		// A real process: only its exit shows that the timer is unref'd. A ref'd one would run into the timeout.
		const spawnUrl = new URL("../spawn.ts", import.meta.url).pathname;
		const script = `import { watchParent } from ${JSON.stringify(spawnUrl)}; watchParent({ parentPid: process.ppid, onGone: () => process.exit(3) });`;
		expect(spawnSync("bun", ["-e", script], { timeout: 10_000 }).status).toBe(0);
	});

	test("helperTempDir accepts only a folder askHelper made for that parent", () => {
		const root = "/tmp";
		expect(helperTempDir("/tmp/omp-better-123-AbC/guard-ready", 123, root)).toBe("/tmp/omp-better-123-AbC");
		expect(helperTempDir("/tmp/omp-better-1234-AbC/guard-ready", 123, root)).toBeUndefined();
		expect(helperTempDir("/tmp/omp-better-123-AbC/other", 123, root)).toBeUndefined();
		expect(helperTempDir("/tmp/x/omp-better-123-AbC/guard-ready", 123, root)).toBeUndefined();
		expect(helperTempDir("/home/me/omp-better-123-AbC/guard-ready", 123, root)).toBeUndefined();
	});
});

test("sweepStaleTempDirs removes folders and session markers of dead omp processes only", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-better-sweep-"));
	try {
		// pid 2^22+1 is above Linux's pid_max, so no process has it.
		mkdirSync(join(root, "omp-better-4194305-abc"));
		mkdirSync(join(root, `omp-better-${process.ppid}-def`));
		mkdirSync(join(root, "unrelated"));
		const markers = join(root, "unrelated", "custom-session-files");
		mkdirSync(markers);
		writeFileSync(join(markers, "dead111"), `${root}/omp-better-4194305-abc/sessions/s.jsonl\n`);
		writeFileSync(join(markers, "live222"), `${root}/omp-better-${process.ppid}-def/sessions/s.jsonl\n`);
		writeFileSync(join(markers, "user333"), "/home/me/project-sessions/s.jsonl\n");
		sweepStaleTempDirs(root, join(root, "unrelated"));
		expect(readdirSync(root).sort()).toEqual([`omp-better-${process.ppid}-def`, "unrelated"]);
		expect(readdirSync(markers).sort()).toEqual(["live222", "user333"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
