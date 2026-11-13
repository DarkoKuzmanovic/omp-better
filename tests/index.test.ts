import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_TOOLS } from "../better.ts";
import { type RequestHead, serializeHead } from "../cache.ts";
import extension from "../index.ts";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

/** Loads the extension against a stand-in for omp's API and returns its event handlers by name. */
function load(): Record<string, Handler[]> {
	const handlers: Record<string, Handler[]> = {};
	const pi = { on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler), registerCommand: () => {} };
	extension(pi as never);
	return handlers;
}

const codex = { provider: "openai-codex", id: "gpt-x", api: "openai-codex-responses" };
// Every tool a chat may advertise once the helper is pinned to its tool list, by plain and by wire name.
const CHAT_TOOLS = ["bash", "edit", "write", "eval", "task", "todo", "wait", "learn", "manage_skill", "ask", "browser", "mcp__github_create_issue", "_bash", "_write", "_edit"];
const head: RequestHead = {
	model: codex,
	fields: { instructions: "CHAT", tools: [...HELPER_TOOLS, ...CHAT_TOOLS].map((name) => ({ type: "function", name })), prompt_cache_key: "chat-key", developer: [] },
};
const ctx = { cwd: tmpdir(), model: codex, agent: { kind: "main" } };
const request = () => ({ type: "response.create", model: "gpt-x", input: [], instructions: "HELPER", tools: [{ type: "function", name: "read" }], prompt_cache_key: "helper-key" });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-better-test-"));
});
afterEach(() => {
	delete process.env.OMP_BETTER_HELPER;
	delete process.env.OMP_BETTER_PREFIX;
	rmSync(dir, { recursive: true, force: true });
});

describe("the helper, pinned to the chat's request head", () => {
	beforeEach(() => {
		process.env.OMP_BETTER_HELPER = join(dir, "guard-ready");
		process.env.OMP_BETTER_PREFIX = join(dir, "prefix.json");
		writeFileSync(process.env.OMP_BETTER_PREFIX, serializeHead(head));
	});

	test("still refuses every tool the chat advertises that isn't a read", () => {
		const [guard] = load().tool_call;
		for (const toolName of CHAT_TOOLS) {
			expect(guard({ toolName, input: { path: join(dir, "x"), command: "touch x" } }, ctx)).toMatchObject({ block: true });
		}
		expect(guard({ toolName: "read", input: { path: "README.md" } }, ctx)).toBeUndefined();
		expect(guard({ toolName: "read", input: { path: "~/.ssh/id_ed25519" } }, ctx)).toMatchObject({ block: true });
		expect(guard({ toolName: "lsp", input: { action: "rename", file: "a.ts" } }, ctx)).toMatchObject({ block: true });
		expect(existsSync(join(dir, "guard-ready"))).toBe(true);
	});

	test("swaps the chat's head into its main requests and records that it did", () => {
		const [pin] = load().before_provider_request;
		expect(pin({ payload: request() }, { ...ctx, agent: { kind: "sub" } })).toBeUndefined();
		expect(pin({ payload: request() }, { ...ctx, model: { ...codex, id: "gpt-y" } })).toBeUndefined();
		expect(existsSync(join(dir, "prefix.json.pinned"))).toBe(false);
		const { developer, ...rest } = head.fields;
		expect(pin({ payload: request() }, ctx)).toEqual({ ...request(), ...rest, input: developer });
		expect(existsSync(join(dir, "prefix.json.pinned"))).toBe(true);
	});

	test("a damaged or missing prefix only turns pinning off", () => {
		writeFileSync(join(dir, "prefix.json"), "{oops");
		let handlers = load();
		expect(handlers.before_provider_request).toBeUndefined();
		expect(handlers.tool_call).toHaveLength(1);
		rmSync(join(dir, "prefix.json"));
		handlers = load();
		expect(handlers.before_provider_request).toBeUndefined();
		expect(existsSync(join(dir, "guard-ready"))).toBe(true);
	});
});

test("an unpinned helper has the guard and no request hook", () => {
	process.env.OMP_BETTER_HELPER = join(dir, "guard-ready");
	const handlers = load();
	expect(handlers.tool_call).toHaveLength(1);
	expect(handlers.before_provider_request).toBeUndefined();
});

test("in the chat the request hook only watches: it returns nothing", () => {
	const [watch] = load().before_provider_request;
	expect(watch({ payload: request() }, ctx)).toBeUndefined();
	expect(watch({ payload: request() }, { ...ctx, agent: { kind: "sub" } })).toBeUndefined();
});
