// Prompt-cache reuse for /better's helper. The chat remembers the head of its last request (system prompt and
// tool list; on OpenAI Codex also the leading developer messages and the cache key); the helper swaps that head
// into its own requests, so the provider sees the chat's prefix and reads it from cache. Nothing here spawns or
// talks to omp.

/** Set in the helper's environment to the private file holding the chat's request head. */
export const PREFIX_ENV = "OMP_BETTER_PREFIX";
/** The helper writes this file next to the prefix once it has pinned a request. */
export const PINNED_SUFFIX = ".pinned";

const ANTHROPIC = "anthropic-messages";
const CODEX = "openai-codex-responses";
/**
 * Provider APIs whose request head the helper can pin. Each is on by default only because a live run showed
 * the helper reading the chat's cache on it (numbers in the README).
 */
export const PINNABLE_APIS = [ANTHROPIC, CODEX];

export interface RequestModel {
	provider: string;
	id: string;
	api: string;
}

/** The parts of a provider request that come before the conversation, with the model they were sent to. */
export interface RequestHead {
	model: RequestModel;
	fields: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** On OpenAI Codex omp sends parts of the system prompt as developer messages at the start of `input`. */
function leadingDeveloper(input: unknown[]): unknown[] {
	const end = input.findIndex((item) => !isRecord(item) || item.role !== "developer");
	return end < 0 ? input : input.slice(0, end);
}

/** Whether `fields` is a complete head for `api`. */
function isHeadFields(api: string, fields: unknown): fields is Record<string, unknown> {
	if (!isRecord(fields) || !Array.isArray(fields.tools) || fields.tools.length === 0) return false;
	if (api === ANTHROPIC) return Array.isArray(fields.system) && fields.system.length > 0;
	if (api === CODEX) return typeof fields.instructions === "string" && typeof fields.prompt_cache_key === "string" && fields.prompt_cache_key !== "" && Array.isArray(fields.developer);
	return false;
}

/** Whether a Codex request continues an earlier response and so sends only the new input. */
const isChained = (payload: Record<string, unknown>) => typeof payload.previous_response_id === "string" && payload.previous_response_id !== "";

/**
 * The cache-relevant head of a request payload, or undefined when the API isn't pinnable or the payload doesn't
 * have the expected shape. A request without tools (a title, a summary) is no main-turn request, so it's skipped.
 * A chained Codex request carries no developer messages; they come from `previous`, the head of an earlier one.
 */
export function headFields(api: string, payload: unknown, previous?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!isRecord(payload)) return undefined;
	const { system, tools, instructions, prompt_cache_key, input } = payload;
	let fields: Record<string, unknown> | undefined;
	if (api === ANTHROPIC) fields = { system, tools };
	if (api === CODEX) {
		const developer = isChained(payload) ? previous?.developer : Array.isArray(input) ? leadingDeveloper(input) : undefined;
		fields = { instructions, tools, prompt_cache_key, developer };
	}
	return isHeadFields(api, fields) ? fields : undefined;
}

function isModel(value: unknown): value is RequestModel {
	return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string" && typeof value.api === "string";
}

const sameModel = (a: RequestModel, b: RequestModel) => a.provider === b.provider && a.id === b.id && a.api === b.api;

/** The head of a request the chat is about to send, if it is worth remembering. `previous` is the last one kept. */
export function captureHead(payload: unknown, model: unknown, previous?: RequestHead): RequestHead | undefined {
	if (!isModel(model)) return undefined;
	const fields = headFields(model.api, payload, previous && sameModel(previous.model, model) ? previous.fields : undefined);
	return fields && { model: { provider: model.provider, id: model.id, api: model.api }, fields };
}

export function serializeHead(head: RequestHead): string {
	return JSON.stringify({ version: 1, model: head.model, fields: head.fields });
}

/** The head written by serializeHead, or undefined for anything else (another version, a damaged or foreign file). */
export function parseHead(text: string): RequestHead | undefined {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(data) || data.version !== 1 || !isModel(data.model) || !isHeadFields(data.model.api, data.fields)) return undefined;
	return { model: data.model, fields: data.fields };
}

/** Whether a /better run pins the helper to the chat's request head: the head to use, or why not. */
export type CachePlan = { head: RequestHead } | { skipped: string };

/**
 * The cache plan for one /better run. OMP_BETTER_CACHE=off turns reuse off; a pinned model or thinking level
 * gets a request (and cache) of its own.
 */
export function cachePlan(options: { setting?: string; overridden: boolean; head?: RequestHead; chatModel?: unknown }): CachePlan {
	const setting = options.setting?.trim().toLowerCase() || "on";
	if (setting !== "on" && setting !== "off") throw new Error(`OMP_BETTER_CACHE must be on or off; it is "${options.setting}".`);
	if (setting === "off") return { skipped: "OMP_BETTER_CACHE=off" };
	if (options.overridden) return { skipped: "OMP_BETTER_MODEL or OMP_BETTER_THINKING is set" };
	if (!options.head) return { skipped: "no request from this chat to reuse yet" };
	if (!isModel(options.chatModel) || !sameModel(options.head.model, options.chatModel)) return { skipped: "the chat's model changed since its last request" };
	if (!PINNABLE_APIS.includes(options.head.model.api)) return { skipped: `not supported for ${options.head.model.api}` };
	return { head: options.head };
}

/**
 * The helper's flags for reuse. On OpenAI Codex: the chat's prompt-cache key, and the chat's session id as the
 * provider session id, which omp uses for routing headers and to pick the same account. In live runs the helper
 * read the chat's cache in 6 of 9 tries without the session id and in 12 of 12 with it.
 */
export function helperCacheArgs(head: RequestHead | undefined, chatSessionId: string | undefined): string[] {
	if (head?.model.api !== CODEX) return [];
	return ["--prompt-cache-key", String(head.fields.prompt_cache_key), ...(chatSessionId ? ["--provider-session-id", chatSessionId] : [])];
}

const TOOL_CHANGES = ["tool_addition", "tool_removal"];

/** Whether a content block announces a change to a tool not in `listed`. */
function unlistedToolChange(block: unknown, listed: Set<unknown>): boolean {
	if (!isRecord(block) || !TOOL_CHANGES.includes(String(block.type))) return false;
	return !(isRecord(block.tool) && listed.has(block.tool.name));
}

/**
 * Inside the helper: its request with the chat's head swapped in, or undefined to send it unchanged.
 *
 * On Anthropic, omp sends the tools that the forked chat's tool set lacks (ast_grep and lsp, which the chat may
 * only offer behind `xd://`) after the others with `defer_loading: true`, and announces them in a `tool_addition`
 * block that must name a listed tool. Listing them after the chat's tools still changed the cached prefix (in a
 * live run the helper then read 10.9k of the chat's 23.4k cached tokens), so they are left out along with their
 * announcement: the helper keeps the read tools the chat lists.
 *
 * On OpenAI Codex the chat's developer messages replace the helper's at the start of a full `input`; a chained
 * request continues from the helper's own pinned first one.
 */
export function pinRequest(payload: unknown, model: unknown, head: RequestHead): Record<string, unknown> | undefined {
	if (!isModel(model) || !sameModel(model, head.model) || !isRecord(payload) || !headFields(model.api, payload, head.fields)) return undefined;
	if (model.api === CODEX) {
		const { developer, ...rest } = head.fields;
		const pinned: Record<string, unknown> = { ...payload, ...rest };
		if (!isChained(payload) && Array.isArray(payload.input)) pinned.input = [...(developer as unknown[]), ...payload.input.slice(leadingDeveloper(payload.input).length)];
		return pinned;
	}
	if (!Array.isArray(payload.messages)) return { ...payload, ...head.fields };
	const listed = new Set((head.fields.tools as unknown[]).map((tool) => (isRecord(tool) ? tool.name : undefined)));
	const messages = payload.messages.map((message: unknown) => {
		if (!isRecord(message) || !Array.isArray(message.content) || !message.content.some((block) => unlistedToolChange(block, listed))) return message;
		return { ...message, content: message.content.filter((block) => !unlistedToolChange(block, listed)) };
	});
	return { ...payload, ...head.fields, messages: messages.filter((message) => !isRecord(message) || !Array.isArray(message.content) || message.content.length > 0) };
}

export interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** "prompt cache: 24k of 26k tokens reused" for the helper's first request. */
export function cacheOutcome(usage: CacheUsage): string {
	const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
	return `prompt cache: ${k(usage.cacheRead)} of ${k(usage.input + usage.cacheRead + usage.cacheWrite)} tokens reused`;
}
