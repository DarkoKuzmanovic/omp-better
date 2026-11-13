import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyHelperEvent,
	buildHelperTask,
	credentialInResult,
	HELPER_TOOLS,
	helperExitError,
	helperModelArgs,
	helperPrompt,
	helperToolBlock,
	newHelperState,
	parseEventLine,
	parseMarkedPrompt,
	pathRefusal,
	progressLines,
	replyProgress,
	withSecretExcludes,
} from "../better.ts";

const home = "/home/tester";
const scope = { cwd: "/work/repo", home };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("helper.md", () => {
	const markdown = readFileSync(new URL("../helper.md", import.meta.url), "utf8");
	const prompt = helperPrompt(markdown);

	test("the model gets pi-better's text without the attribution comment", () => {
		expect(markdown).toContain("509967c7dda0f8c68a927917b19adf4bd83853b8");
		expect(prompt.startsWith("First, without asking me anything, find and read the code")).toBe(true);
		expect(prompt).not.toContain("<!--");
		expect(prompt).not.toContain("pi-better");
		expect(prompt.endsWith("Don't edit files, start work, or launch anything; you only read and rewrite.")).toBe(true);
	});

	test("only the session path changed from Pi's to omp's", () => {
		expect(prompt).toContain("(`~/.omp/agent/sessions` alone can hold tens of gigabytes)");
		expect(prompt).not.toContain("~/.pi/");
	});
});

describe("buildHelperTask", () => {
	test("names the given prompt and asks for the marked block", () => {
		const task = buildHelperTask("METHOD", "make hover nicer");
		expect(task.startsWith("METHOD")).toBe(true);
		expect(task).toContain("## Prompt to deepen\n\nmake hover nicer");
		expect(task).toMatch(/## Return\n\nGive answers \(1\) to \(4\)[\s\S]*\n<improved-prompt>\nthe rewritten prompt\n<\/improved-prompt>$/);
	});

	test("without a prompt it deepens the task in progress", () => {
		expect(buildHelperTask("METHOD", "")).toContain("## Prompt to deepen\n\nNone given: deepen the task in progress in the conversation so far");
	});
});

describe("parseMarkedPrompt", () => {
	test("the last block wins", () => {
		const reply = "(1) Draft:\n<improved-prompt>\nfirst try\n</improved-prompt>\n\n(4) Final:\n<improved-prompt>\nReply with exactly hi.\n</improved-prompt>\n";
		expect(parseMarkedPrompt(reply)).toBe("Reply with exactly hi.");
	});

	test("an inline tag mention inside or before the block doesn't confuse it", () => {
		const before = "(1) I'll end with <improved-prompt>x</improved-prompt>.\n\n<improved-prompt>\nReply with exactly hi.\n</improved-prompt>";
		expect(parseMarkedPrompt(before)).toBe("Reply with exactly hi.");
		const inside = "<improved-prompt>\nKeep the reply when there's no `<improved-prompt>` block.\n</improved-prompt>";
		expect(parseMarkedPrompt(inside)).toBe("Keep the reply when there's no `<improved-prompt>` block.");
	});

	test("a missing or empty block is an error", () => {
		expect(() => parseMarkedPrompt("(1) Read the code. No block.")).toThrow("The reply has no <improved-prompt> … </improved-prompt> block.");
		expect(() => parseMarkedPrompt("<improved-prompt>x</improved-prompt>")).toThrow(/has no <improved-prompt>/);
		expect(() => parseMarkedPrompt("<improved-prompt>\n \n</improved-prompt>")).toThrow("The reply's <improved-prompt> block is empty.");
	});
});

test("replyProgress counts answered questions and spots the prompt", () => {
	expect(replyProgress("Reading")).toEqual({ answered: 0, writingPrompt: false });
	expect(replyProgress("(1) a\n(2) b\n**(3)** c")).toEqual({ answered: 3, writingPrompt: false });
	expect(replyProgress("(4) d\n<improved-prompt>\nx")).toEqual({ answered: 4, writingPrompt: true });
});

describe("helperExitError", () => {
	test("names the signal when the code is null", () => {
		expect(helperExitError(null, "SIGKILL", "")).toBe("The helper was stopped by SIGKILL without printing an error");
		expect(helperExitError(null, null, "")).toBe("The helper was stopped by an unknown signal without printing an error");
	});

	test("empty stderr never leaves a bare colon", () => {
		expect(helperExitError(143, null, "  \n")).toBe("The helper exited with code 143 without printing an error");
	});

	test("quotes the last three stderr lines", () => {
		expect(helperExitError(1, null, "a\nb\nc\nError: unknown model\n")).toBe("The helper exited with code 1: b c Error: unknown model");
	});
});

describe("helperModelArgs", () => {
	test("uses the chat's model and thinking level", () => {
		expect(helperModelArgs({}, "anthropic/claude-sonnet-5-5", "high")).toEqual(["--model", "anthropic/claude-sonnet-5-5", "--thinking", "high"]);
		expect(helperModelArgs({}, "openai/gpt-6", undefined)).toEqual(["--model", "openai/gpt-6"]);
	});

	test("OMP_BETTER_MODEL and OMP_BETTER_THINKING pin either one", () => {
		expect(helperModelArgs({ model: "@smol", thinking: " low " }, "openai/gpt-6", "high")).toEqual(["--model", "@smol", "--thinking", "low"]);
		expect(helperModelArgs({ model: "", thinking: "" }, "openai/gpt-6", "medium")).toEqual(["--model", "openai/gpt-6", "--thinking", "medium"]);
	});

	test("rejects a missing model and an unknown thinking level", () => {
		expect(() => helperModelArgs({}, undefined, "high")).toThrow(/No model is selected/);
		expect(() => helperModelArgs({ thinking: "hihg" }, "openai/gpt-6", "low")).toThrow(/OMP_BETTER_THINKING must be one of off, minimal, low/);
	});
});

describe("helperToolBlock", () => {
	// Every tool omp 18.20.0 offered in a probe (built-ins, optional ones, xd:// devices, MCP), plus made-up names.
	const writeCapable = [
		"bash", "edit", "write", "eval", "task", "wait", "todo", "ask", "ast_edit", "debug", "ida", "github", "checkpoint", "rewind",
		"context_notes", "new_context", "retain", "recall", "reflect", "memory_edit", "learn", "manage_skill", "security_scan", "goal",
		"init_experiment", "log_experiment", "run_experiment", "update_notes", "browser", "ssh", "apply_patch", "notebook", "report_issue",
		"mcp__browse_execute", "mcp__figcraft_create_node", "mcp__odoo_mcp_odoo_search_read", "mcp__honcho_search",
	];

	test("every tool off the allow-list is blocked, and unknown tools fail closed", () => {
		for (const tool of [...writeCapable, "frobnicate", "", "READ", "Read"]) {
			const verdict = helperToolBlock(tool, {}, scope);
			expect(verdict?.block).toBe(true);
			expect(verdict?.reason).toContain(`so ${tool} is off. Use ${HELPER_TOOLS.join(", ")}.`);
		}
	});

	test("allow-listed tools pass with ordinary arguments", () => {
		expect(helperToolBlock("read", { path: "src/cli.ts:10-40" }, scope)).toBeUndefined();
		expect(helperToolBlock("grep", { pattern: "Error", path: "src;!**/*.test.ts" }, scope)).toBeUndefined();
		expect(helperToolBlock("glob", { path: "src/**/*.ts" }, scope)).toBeUndefined();
		expect(helperToolBlock("find", { query: "error messages", grep_keywords: [] }, scope)).toBeUndefined();
		expect(helperToolBlock("ast_grep", { pat: "throw new Error($A)", path: "src" }, scope)).toBeUndefined();
		expect(helperToolBlock("web_search", { query: "bun test docs" }, scope)).toBeUndefined();
		for (const action of ["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"]) {
			expect(helperToolBlock("lsp", { action, file: "src/cli.ts" }, scope)).toBeUndefined();
		}
	});

	test("lsp actions that change files or servers are blocked", () => {
		for (const action of ["rename", "rename_file", "code_actions", "reload", "request", undefined]) {
			expect(helperToolBlock("lsp", { action, file: "src/cli.ts" }, scope)?.block).toBe(true);
		}
		expect(helperToolBlock("lsp", { action: "diagnostics", apply: true }, scope)?.reason).toContain("lsp diagnostics with apply is off");
	});

	test("a credential path in any path argument is blocked", () => {
		expect(helperToolBlock("read", { path: ".env" }, scope)?.reason).toBe(".env looks like a credential file, and /better's helper doesn't read those. Leave it out.");
		expect(helperToolBlock("grep", { pattern: "KEY", path: "src;.env.local" }, scope)?.block).toBe(true);
		expect(helperToolBlock("lsp", { action: "hover", file: "~/.ssh/config" }, scope)?.block).toBe(true);
	});
});

describe("pathRefusal", () => {
	test("refuses the credential files named in the brief", () => {
		for (const path of [
			".env", ".env.production", "config/.envrc", "~/.hermes/.env", "/home/tester/.hermes/.env",
			"~/.omp/agent/agent.db", "~/.omp/agent/agent.db-wal", "~/.omp/agent/agent.db.bak-20261019T095117",
			"auth.json", "~/.pi/agent/auth.json", "~/.hermes/auth-tokens.json", "~/.ssh", "~/.ssh/id_ed25519", "/srv/keys/id_rsa",
			"~/.aws/credentials", "~/.config/gcloud/credentials.db", "~/.config/gh/x/credentials", "~/.netrc", "~/.git-credentials",
			"~/.omp/agent/models.yml", "~/.omp/agent/mcp.json", "~/.omp/agent/secrets/key",
			"~/.omp/profiles/work/agent/agent.db", "~/.omp/profiles/work/agent/agent.db-wal", "~/.omp/profiles/work/agent/models.yml",
			"~/.omp/profiles/work/agent/mcp.json", "~/.omp/profiles/work/agent/secrets/key", "/home/tester/.omp/profiles/p2/agent/secrets",
		]) {
			expect(pathRefusal(path, scope)).toMatch(/looks like a credential file/);
		}
	});

	test("checks relative paths against the working directory", () => {
		expect(pathRefusal(".ssh/config", { cwd: home, home })).toMatch(/~\/\.ssh\/config looks like a credential file/);
		expect(pathRefusal("../.aws/config", { cwd: `${home}/code`, home })).toMatch(/credential/);
	});

	test("checks selectors, archive members, lists and file URLs", () => {
		expect(pathRefusal(".env:1-5", scope)).toMatch(/credential/);
		expect(pathRefusal("backup.zip:app/.env", scope)).toMatch(/\.env looks like/);
		expect(pathRefusal("src; .env", scope)).toMatch(/credential/);
		expect(pathRefusal("file:///home/tester/.ssh/id_rsa", scope)).toMatch(/credential/);
		expect(pathRefusal("https://example.com/app/.env", scope)).toMatch(/credential/);
	});

	test("refuses internal URLs that reach other machines, vaults, processes or devices", () => {
		for (const url of ["ssh://host/etc/hostname", "vault://notes/x.md", "proc://bg_1/kill", "mcp://figcraft/doc", "xd://bash", "gopher://x"]) {
			expect(pathRefusal(url, scope)).toMatch(/:\/\/ is off for \/better's helper/);
		}
	});

	test("lets ordinary paths, exclusions and allowed URLs through", () => {
		for (const path of ["src/cli.ts", "README.md:1-20", "src;!**/.env*", "environment.ts", "docs/env.md", "src/author.ts", "https://example.com/docs", "skill://x", "artifact://3", "~/code/app/src"]) {
			expect(pathRefusal(path, scope)).toBeUndefined();
		}
	});

	test("follows symlinks to credential files", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
		try {
			writeFileSync(join(dir, ".env"), "TOKEN=fake\n");
			mkdirSync(join(dir, "src"));
			symlinkSync(join(dir, ".env"), join(dir, "src", "settings.txt"));
			expect(pathRefusal("src/settings.txt", { cwd: dir, home })).toMatch(/\.env looks like a credential file/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("grep gets the credential exclusions added to its path", () => {
	expect(withSecretExcludes(undefined).startsWith(".;!**/.env*;")).toBe(true);
	expect(withSecretExcludes("src; tests").startsWith("src; tests;!**/.env*;")).toBe(true);
	expect(withSecretExcludes("src")).toContain("!**/.ssh");
});

describe("credentialInResult", () => {
	test("finds a credential file in grep's nested headings", () => {
		const grep = "# /work/repo/\n## .env#5A99\n*1:SECRET_TOKEN=x\n\n## src/\n### app.ts#089A\n*1:const token = 1;";
		expect(credentialInResult(grep, scope)).toBe(".env");
		expect(credentialInResult("# /home/tester/.aws/\n## config#1234\n*1:x", scope)).toBe("~/.aws");
	});

	test("finds a symlinked credential file in find's output", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
		try {
			writeFileSync(join(dir, ".env"), "TOKEN=fake\n");
			mkdirSync(join(dir, "src"));
			symlinkSync(join(dir, ".env"), join(dir, "src", "settings.txt"));
			const find = '1 hit(s) for "API key value" (τ 0.20), strongest first\n\nsrc/settings.txt  0.72  1 lines judged\n  src/settings.txt:1  0.72  TOKEN=fake\n';
			expect(credentialInResult(find, { cwd: dir, home })).toBe(".env");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("code that only mentions .env passes", () => {
		const grep = "# /work/repo/src/\n## app.ts#089A\n*1:const token = process.env.SECRET_TOKEN; // from .env\n 2|// see .env.example";
		expect(credentialInResult(grep, scope)).toBeUndefined();
		expect(credentialInResult("No matches found", scope)).toBeUndefined();
	});
});

describe("the helper's JSON events (captured from omp 18.20.0)", () => {
	const replay = (name: string) => {
		const state = newHelperState();
		for (const line of fixture(name).split("\n")) {
			const event = parseEventLine(line);
			if (event) applyHelperEvent(state, event);
		}
		return state;
	};

	test("a real helper run yields its reply, tool count and a parseable prompt", () => {
		const lines = fixture("helper-run.jsonl").split("\n").filter(Boolean);
		expect(JSON.parse(lines[0]).type).toBe("session");
		const state = replay("helper-run.jsonl");
		expect(state.started).toBe(true);
		expect(state.modelError).toBeUndefined();
		expect(state.tools).toBe(lines.filter((line) => JSON.parse(line).type === "tool_execution_start").length);
		expect(state.tools).toBe(6);
		expect(state.failedTools).toBe(0);
		expect(state.lastTool).toContain("read /tmp/");
		expect(state.streaming).toBe(state.reply);
		const improved = parseMarkedPrompt(state.reply);
		expect(improved).toContain("src/cli.ts");
		expect(improved).toContain("src/config.ts");
		expect(improved).toContain("src/net.ts");
		expect(progressLines(state, 22_600)[0]).toBe("/better · Writing your improved prompt · 22s · /better-cancel stops it");
	});

	test("refused tool calls count as failed", () => {
		const state = replay("guard-refusals.jsonl");
		expect(state.tools).toBe(6);
		expect(state.failedTools).toBe(5);
		expect(progressLines(state, 61_000)[1]).toBe("  6 tools (5 refused or failed) · last: edit");
	});

	test("a failed or aborted model call is reported from message_end", () => {
		const state = newHelperState();
		applyHelperEvent(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" } });
		expect(state.modelError).toBe("429 rate limited");
		applyHelperEvent(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
		expect(state.modelError).toBe("request aborted");
		applyHelperEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
		expect(state.modelError).toBeUndefined();
		expect(state.reply).toBe("ok");
	});

	test("user and tool-result messages never become the reply; non-JSON lines are skipped", () => {
		const state = newHelperState();
		applyHelperEvent(state, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "task" }] } });
		applyHelperEvent(state, { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "file" }] } });
		expect(state.reply).toBe("");
		expect(parseEventLine("Warning: MCP server failed")).toBeUndefined();
		expect(parseEventLine("")).toBeUndefined();
		expect(parseEventLine("42")).toBeUndefined();
	});

	test("streamed text moves the stage along", () => {
		const state = newHelperState();
		applyHelperEvent(state, { type: "message_start", message: { role: "assistant" } });
		applyHelperEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "(1) a\n(2) b" } });
		expect(progressLines(state, 5_000)[0]).toBe("/better · Finding the rawest material (2 of 4) · 5s · /better-cancel stops it");
		expect(progressLines(newHelperState(), 65_000)).toEqual(["/better · Reading your code and files · 1m 05s · /better-cancel stops it", "  0 tools"]);
	});
});
