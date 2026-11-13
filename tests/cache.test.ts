import { describe, expect, test } from "bun:test";
import { applyHelperEvent, buildHelperTask, HELPER_TOOLS, newHelperState } from "../better.ts";
import { cacheOutcome, cachePlan, captureHead, headFields, helperCacheArgs, parseHead, pinRequest, type RequestHead, serializeHead } from "../cache.ts";

const anthropic = { provider: "anthropic", id: "claude-x", api: "anthropic-messages" };
const codex = { provider: "openai-codex", id: "gpt-x", api: "openai-codex-responses" };
// Shapes as omp 18.20.0 hands them to before_provider_request; the text is made up.
const anthropicPayload = () => ({
	model: "claude-x",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	system: [{ type: "text", text: "billing cch=00000;" }, { type: "text", text: "CHAT SYSTEM", cache_control: { type: "ephemeral" } }],
	tools: [{ name: "_read", description: "d", input_schema: {} }, { name: "_bash", description: "d", input_schema: {} }],
	max_tokens: 100,
	stream: true,
});
const DEVELOPER = [{ role: "developer", content: [{ type: "input_text", text: "CHAT CATALOG" }] }, { role: "developer", content: [{ type: "input_text", text: "CHAT EXTRA" }] }];
const codexPayload = () => ({
	type: "response.create",
	model: "gpt-x",
	input: [...DEVELOPER, { role: "user", content: [{ type: "input_text", text: "hi" }] }],
	instructions: "CHAT INSTRUCTIONS",
	tools: [{ type: "function", name: "read", parameters: {} }, { type: "function", name: "bash", parameters: {} }],
	prompt_cache_key: "chat-key",
	stream: true,
});
// A later turn on the same websocket: only the new input, after the previous response.
const chainedCodexPayload = () => ({ ...codexPayload(), input: [{ type: "function_call_output", call_id: "c", output: "x" }], previous_response_id: "resp_1" });

describe("captureHead", () => {
	test("keeps only the system prompt and tools of an Anthropic request", () => {
		const payload = anthropicPayload();
		expect(captureHead(payload, anthropic)).toEqual({ model: anthropic, fields: { system: payload.system, tools: payload.tools } });
	});

	test("keeps instructions, tools, the cache key and the leading developer messages of an OpenAI Codex request", () => {
		const payload = codexPayload();
		expect(captureHead(payload, { ...codex, extra: 1 })).toEqual({ model: codex, fields: { instructions: payload.instructions, tools: payload.tools, prompt_cache_key: "chat-key", developer: DEVELOPER } });
		expect(captureHead({ ...payload, input: payload.input.slice(2) }, codex)?.fields.developer).toEqual([]);
	});

	test("a chained Codex request keeps the developer messages of the head before it, of the same model only", () => {
		const first = captureHead(codexPayload(), codex) as RequestHead;
		const later = { ...chainedCodexPayload(), instructions: "CHAT INSTRUCTIONS 2" };
		expect(captureHead(later, codex, first)?.fields).toEqual({ ...first.fields, instructions: "CHAT INSTRUCTIONS 2" });
		expect(captureHead(later, codex)).toBeUndefined();
		expect(captureHead(later, codex, { ...first, model: { ...codex, id: "gpt-y" } })).toBeUndefined();
	});

	test("skips requests without tools, of other APIs, of unknown shape or without a model", () => {
		expect(captureHead({ ...anthropicPayload(), tools: [] }, anthropic)).toBeUndefined();
		expect(captureHead({ ...anthropicPayload(), tools: undefined }, anthropic)).toBeUndefined();
		expect(captureHead({ ...anthropicPayload(), system: "plain" }, anthropic)).toBeUndefined();
		expect(captureHead({ ...codexPayload(), prompt_cache_key: undefined }, codex)).toBeUndefined();
		expect(captureHead(codexPayload(), { ...codex, api: "openai-responses" })).toBeUndefined();
		expect(captureHead(anthropicPayload(), { ...anthropic, api: "google-generative-ai" })).toBeUndefined();
		expect(captureHead("text", anthropic)).toBeUndefined();
		expect(captureHead(anthropicPayload(), undefined)).toBeUndefined();
		expect(captureHead(anthropicPayload(), { provider: "anthropic", id: "claude-x" })).toBeUndefined();
	});
});

describe("serializeHead and parseHead", () => {
	test("round-trip both shapes", () => {
		for (const head of [captureHead(anthropicPayload(), anthropic), captureHead(codexPayload(), codex)] as RequestHead[]) {
			expect(parseHead(serializeHead(head))).toEqual(head);
		}
	});

	test("reject anything else", () => {
		const good = JSON.parse(serializeHead(captureHead(anthropicPayload(), anthropic) as RequestHead));
		expect(parseHead("not json")).toBeUndefined();
		expect(parseHead("null")).toBeUndefined();
		expect(parseHead(JSON.stringify({ ...good, version: 2 }))).toBeUndefined();
		expect(parseHead(JSON.stringify({ ...good, model: { ...anthropic, api: "other" } }))).toBeUndefined();
		expect(parseHead(JSON.stringify({ ...good, model: "anthropic/claude-x" }))).toBeUndefined();
		expect(parseHead(JSON.stringify({ ...good, fields: { system: good.fields.system } }))).toBeUndefined();
		const codexGood = JSON.parse(serializeHead(captureHead(codexPayload(), codex) as RequestHead));
		expect(parseHead(JSON.stringify({ ...codexGood, fields: { ...codexGood.fields, developer: undefined } }))).toBeUndefined();
		expect(parseHead(JSON.stringify({ ...codexGood, fields: { ...codexGood.fields, prompt_cache_key: "" } }))).toBeUndefined();
	});
});

describe("cachePlan", () => {
	const head = captureHead(anthropicPayload(), anthropic) as RequestHead;

	test("pins when on (the default) and the chat's model is the captured one", () => {
		expect(cachePlan({ overridden: false, head, chatModel: anthropic })).toEqual({ head });
		expect(cachePlan({ setting: "on", overridden: false, head, chatModel: { ...anthropic, name: "x" } })).toEqual({ head });
		expect(cachePlan({ setting: " ON ", overridden: false, head, chatModel: anthropic })).toEqual({ head });
	});

	test("falls back, with the reason, when reuse can't apply", () => {
		expect(cachePlan({ setting: "off", overridden: false, head, chatModel: anthropic })).toEqual({ skipped: "OMP_BETTER_CACHE=off" });
		expect(cachePlan({ overridden: true, head, chatModel: anthropic })).toEqual({ skipped: "OMP_BETTER_MODEL or OMP_BETTER_THINKING is set" });
		expect(cachePlan({ overridden: false, chatModel: anthropic })).toEqual({ skipped: "no request from this chat to reuse yet" });
		expect(cachePlan({ overridden: false, head, chatModel: { ...anthropic, id: "claude-y" } })).toEqual({ skipped: "the chat's model changed since its last request" });
		expect(cachePlan({ overridden: false, head, chatModel: undefined })).toEqual({ skipped: "the chat's model changed since its last request" });
		const foreign = { model: { ...anthropic, api: "other" }, fields: head.fields };
		expect(cachePlan({ overridden: false, head: foreign, chatModel: foreign.model })).toEqual({ skipped: "not supported for other" });
	});

	test("rejects a setting other than on or off", () => {
		expect(() => cachePlan({ setting: "yes", overridden: false, head, chatModel: anthropic })).toThrow('OMP_BETTER_CACHE must be on or off; it is "yes".');
	});
});

describe("pinRequest", () => {
	test("swaps the chat's system prompt and tools into an Anthropic request and keeps its messages", () => {
		const head = { model: anthropic, fields: { system: [{ type: "text", text: "CHAT" }], tools: [{ name: "_bash" }] } };
		const payload = anthropicPayload();
		expect(pinRequest(payload, anthropic, head)).toEqual({ ...payload, system: head.fields.system, tools: head.fields.tools });
	});

	test("drops the helper's own deferred tools and their announcement, keeps announcements of listed tools", () => {
		const head = { model: anthropic, fields: { system: [{ type: "text", text: "CHAT" }], tools: [{ name: "_read" }, { name: "_grep" }] } };
		const announce = (name: string, type = "tool_addition") => ({ type, tool: { type: "tool_reference", name } });
		const payload = {
			...anthropicPayload(),
			tools: [{ name: "_read" }, { name: "_ast_grep", defer_loading: true }, { name: "_lsp", defer_loading: true }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "system", content: [announce("_ast_grep"), announce("_lsp")] },
				{ role: "system", content: [announce("_grep"), announce("_lsp", "tool_removal")] },
			],
		};
		expect(pinRequest(payload, anthropic, head)).toEqual({
			...payload,
			...head.fields,
			messages: [payload.messages[0], { role: "system", content: [announce("_grep")] }],
		});
	});

	test("swaps instructions, tools, the cache key and the leading developer messages into a full OpenAI Codex request", () => {
		const chatDeveloper = [{ role: "developer", content: [{ type: "input_text", text: "A" }] }, { role: "developer", content: [{ type: "input_text", text: "B" }] }];
		const head = { model: codex, fields: { instructions: "CHAT", tools: [{ type: "function", name: "write" }], prompt_cache_key: "chat-key", developer: chatDeveloper } };
		const payload = { ...codexPayload(), input: [DEVELOPER[0], { role: "user", content: "hi" }], prompt_cache_key: "helper-key" };
		expect(pinRequest(payload, codex, head)).toEqual({ ...payload, instructions: "CHAT", tools: head.fields.tools, prompt_cache_key: "chat-key", input: [...chatDeveloper, { role: "user", content: "hi" }] });
	});

	test("leaves the input of a chained OpenAI Codex request alone", () => {
		const head = captureHead(codexPayload(), codex) as RequestHead;
		const payload = { ...chainedCodexPayload(), instructions: "HELPER", prompt_cache_key: "helper-key" };
		expect(pinRequest(payload, codex, head)).toEqual({ ...payload, instructions: "CHAT INSTRUCTIONS", prompt_cache_key: "chat-key" });
	});

	test("leaves a request alone when the model, the API or its shape differs", () => {
		const head = captureHead(anthropicPayload(), anthropic) as RequestHead;
		expect(pinRequest(anthropicPayload(), { ...anthropic, id: "claude-y" }, head)).toBeUndefined();
		expect(pinRequest(anthropicPayload(), { ...anthropic, provider: "other" }, head)).toBeUndefined();
		expect(pinRequest(codexPayload(), codex, head)).toBeUndefined();
		expect(pinRequest({ ...anthropicPayload(), system: undefined }, anthropic, head)).toBeUndefined();
		expect(pinRequest({ messages: [] }, anthropic, head)).toBeUndefined();
		expect(pinRequest(anthropicPayload(), undefined, head)).toBeUndefined();
		const codexHead = captureHead(codexPayload(), codex) as RequestHead;
		expect(pinRequest({ ...codexPayload(), input: undefined }, codex, codexHead)).toBeUndefined();
		expect(pinRequest({ ...codexPayload(), instructions: 7 }, codex, codexHead)).toBeUndefined();
	});
});

test("headFields reads the same shape in the chat and in the helper", () => {
	expect(Object.keys(headFields("anthropic-messages", anthropicPayload()) ?? {})).toEqual(["system", "tools"]);
	expect(Object.keys(headFields("openai-codex-responses", codexPayload()) ?? {})).toEqual(["instructions", "tools", "prompt_cache_key", "developer"]);
});

test("only OpenAI Codex gets cache flags: the chat's key and, when known, its session id", () => {
	const codexHead = captureHead(codexPayload(), codex) as RequestHead;
	expect(helperCacheArgs(codexHead, "chat-id")).toEqual(["--prompt-cache-key", "chat-key", "--provider-session-id", "chat-id"]);
	expect(helperCacheArgs(codexHead, undefined)).toEqual(["--prompt-cache-key", "chat-key"]);
	expect(helperCacheArgs(captureHead(anthropicPayload(), anthropic), "chat-id")).toEqual([]);
	expect(helperCacheArgs(undefined, "chat-id")).toEqual([]);
});

test("cacheOutcome is one short line", () => {
	expect(cacheOutcome({ input: 6, cacheRead: 24_400, cacheWrite: 1_300 })).toBe("prompt cache: 24k of 26k tokens reused");
	expect(cacheOutcome({ input: 900, cacheRead: 0, cacheWrite: 0 })).toBe("prompt cache: 0 of 900 tokens reused");
});

test("the helper's usage is that of its first request", () => {
	const state = newHelperState();
	const end = (usage: unknown) => ({ type: "message_end", message: { role: "assistant", content: [], usage } }) as Parameters<typeof applyHelperEvent>[1];
	applyHelperEvent(state, { type: "message_end", message: { role: "user", content: "x" } });
	applyHelperEvent(state, end({ input: "?", cacheRead: 1, cacheWrite: 2 }));
	expect(state.usage).toBeUndefined();
	applyHelperEvent(state, end({ input: 3, output: 9, cacheRead: 24_000, cacheWrite: 500, cost: {} }));
	applyHelperEvent(state, end({ input: 1, cacheRead: 25_000, cacheWrite: 100 }));
	expect(state.usage).toEqual({ input: 3, cacheRead: 24_000, cacheWrite: 500 });
});

test("a pinned helper's task names the tools that work; an unpinned one is unchanged", () => {
	expect(buildHelperTask("H", "P", HELPER_TOOLS)).toContain(`Only these tools work for you here, those of them you have: ${HELPER_TOOLS.join(", ")}.`);
	expect(buildHelperTask("H", "P")).not.toContain("Only these tools");
});
