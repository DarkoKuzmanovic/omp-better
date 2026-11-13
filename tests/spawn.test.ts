import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_TOOLS, parseMarkedPrompt } from "../better.ts";
import { parseHead, type RequestHead } from "../cache.ts";
import { askHelper, Cancelled, helperArgs, profileArgs, sweepStaleTempDirs } from "../spawn.ts";

const fake = ["bun", new URL("./fake-omp.ts", import.meta.url).pathname];
const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const ours = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`omp-better-${process.pid}-`));
const FAKE_KEYS = ["FAKE_OMP_FIXTURE", "FAKE_OMP_GUARD", "FAKE_OMP_EXIT", "FAKE_OMP_STDERR", "FAKE_OMP_SIGNAL", "FAKE_OMP_HANG", "FAKE_OMP_REPORT", "FAKE_OMP_AGENT_DIR", "FAKE_OMP_PIN"];
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
