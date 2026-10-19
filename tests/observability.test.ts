import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createObservabilityExtension,
	MAX_PENDING_PROVIDER_REQUESTS,
} from "../src/index.ts";
import {
	findPersistedToolIntent,
	isToolIntentData,
	MAX_AUDIT_INTENT_LENGTH,
	sanitizeAuditIntentDetailed,
} from "../src/intent.ts";
import { rehydrateToolIntentHistory } from "../src/intent-history.ts";
import { TOOL_INTENT_GUIDANCE } from "../src/intent-context.ts";
import type { CredentialReplacement } from "../src/egress-redaction.ts";

import {
	TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE,
	TOOL_INTENT_ENTRY_TYPE,
} from "../src/contract.ts";

type Handler = (event: any, context: any) => any;

function mockExtension(options: Parameters<typeof createObservabilityExtension>[0] = {}) {
	const handlers = new Map<string, Handler[]>();
	const entries: any[] = [];
	const pi = {
        events: { on: () => () => {}, emit() {} },

		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	createObservabilityExtension({
		now: () => new Date("2026-09-16T00:00:00.000Z"),
		...options,
		credentialDiscovery: options.credentialDiscovery ?? {
			readFile: () => "",
			environment: {},
		},
	})(pi);
	const handler = (name: string) => {
		const found = handlers.get(name)?.[0];
		if (!found) throw new Error(`missing handler ${name}`);
		return found;
	};
	const context = { sessionManager: { getBranch: () => entries } };
	const request = async ({ messages }: any, ctx = context) => {
		const result = await handler("context_with_system")({ messages }, ctx);
		await handler("before_provider_request")({ payload: { synthetic: true } }, ctx);
		return result.messages;
	};
	return { handler, request, entries, context };
}

function schema(properties: Record<string, unknown> = {}) {
	return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function contextMessages(tools: unknown[], history: unknown[] = []): unknown[] {
 return [{role:"system",content:"Test",toolsAdded:tools,timestamp:0},...history];
}

function historicalAssistantEntry(toolCallId: string, toolName: string, args: Record<string, unknown>) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
		},
	};
}


test("finalized calls persist full safe audit intent and strip transport metadata", async () => {
	const mock = mockExtension();
	const messages: any = contextMessages([
		{ name: "read", parameters: schema({ path: { type: "string" } }) },
	]);
	await mock.request({ messages }, mock.context);
	const fullIntent = "Review the implementation carefully and summarize the relevant behavior without exposing private details";
	const replacement = await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "call|1", name: "read", arguments: { path: "private.txt", intent: fullIntent } }],
	} }, mock.context);
	assert.deepEqual(replacement.message.content[0].arguments, { path: "private.txt" });
	assert.equal(mock.entries.length, 1);
	assert.equal(mock.entries[0].customType, TOOL_INTENT_ENTRY_TYPE);
	assert.equal(mock.entries[0].data.intent, fullIntent);
	assert.equal(mock.entries[0].data.timestamp, "2026-09-16T00:00:00.000Z");
	assert.equal(findPersistedToolIntent(mock.entries, "call|1")?.intent, fullIntent);
	const executableInput = { path: "private.txt", intent: fullIntent };
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "call|1", toolName: "read", input: executableInput }, mock.context),
		undefined,
	);
	assert.deepEqual(executableInput, { path: "private.txt" });

	mock.entries.push({ type: "message", message: replacement.message });
	const nextPayload: any = contextMessages(
		[{ name: "read", parameters: schema({ path: { type: "string" } }) }],
		[historicalAssistantEntry("call|1", "read", { path: "private.txt" }).message],
	);
	const next = await mock.request({ messages: nextPayload }, mock.context);
	assert.equal(next[1].content[0].arguments.intent, fullIntent);
	assert.deepEqual(replacement.message.content[0].arguments, { path: "private.txt" });
});

test("tool-call ID policy accepts observed structure and rejects over-bound IDs", async () => {
	const mock = mockExtension();
	const acceptedId = `${"a".repeat(63)}|${"b".repeat(64)}`;
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: acceptedId, name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: acceptedId, toolName: "read", input: {} }, mock.context),
		undefined,
	);

	const overBoundId = "a".repeat(129);
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: overBoundId, name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	const blocked = await mock.handler("tool_call")(
		{ toolCallId: overBoundId, toolName: "read", input: {} },
		mock.context,
	);
	assert.match(blocked.reason, /tool_call_id_invalid/);
	assert.equal(mock.entries.at(-1).data.reason, "tool_call_id_invalid");
});

test("intent sanitization keeps plain prose and redacts only exact credential values", () => {
	const none: readonly CredentialReplacement[] = [];
	// Plain text passes through unchanged: apostrophes, quotes, URLs,
	// backticks, Markdown, options, and paths are formatting, not a rejection
	// class. The account is the boundary; there is no PII/argument filtering.
	for (const purpose of [
		"Check Alice's and Bob's notes before review.",
		"Review the teams' shared backlog notes.",
		"Compare the 2020's release notes with the 2030's draft.",
		"Summarize Élodie's findings for l'équipe.",
		"Check Élodie\u2019s notes before the review.",
		"Inspect https://alice:password@example.test/private?q=secret for the changelog",
		"Run `cat private.txt` in the sandbox",
		"Run grep --fixed-strings over the logs",
		"Inspect /private/file and summarize it",
		"Summarize 'quoted detail' beside Alice's notes.",
		"Review \"alpha\" then 'beta' for Bob's team.",
	]) {
		assert.deepEqual(sanitizeAuditIntentDetailed(purpose, true, none), { ok: true, value: purpose });
	}
	const secret = "abc123SECRETtoken";
	const gateway = "gateway-9988776655";
	const replacements = [
		{ key: "DEMO_TOKEN", value: secret, marker: "<REDACTED DEMO_TOKEN VALUE>" },
		{ key: "GATEWAY_API_KEY", value: gateway, marker: "<REDACTED GATEWAY_API_KEY VALUE>" },
	];
	const sanitized = (value: string) => sanitizeAuditIntentDetailed(value, true, replacements);
	assert.deepEqual(sanitized(`Export token=${secret} for the gateway`),
		{ ok: true, value: "Export token=<REDACTED DEMO_TOKEN VALUE> for the gateway" });
	assert.deepEqual(sanitized(`Summarize 'the secret is ${secret} in detail' beside Alice's notes.`),
		{ ok: true, value: "Summarize 'the secret is <REDACTED DEMO_TOKEN VALUE> in detail' beside Alice's notes." });
	assert.deepEqual(sanitized(`Check ${secret} again and note ${gateway} twice ${secret}`),
		{ ok: true, value: "Check <REDACTED DEMO_TOKEN VALUE> again and note <REDACTED GATEWAY_API_KEY VALUE> twice <REDACTED DEMO_TOKEN VALUE>" });
	// Longest match first when one credential value contains another.
	assert.deepEqual(sanitized(`${secret}X and ${secret}`),
		{ ok: true, value: "<REDACTED DEMO_TOKEN VALUE>X and <REDACTED DEMO_TOKEN VALUE>" });
	const nested = "nested-" + secret;
	assert.deepEqual(
		sanitizeAuditIntentDetailed(`Use ${nested} today`, true, [
			...replacements,
			{ key: "NESTED_TOKEN", value: nested, marker: "<REDACTED NESTED_TOKEN VALUE>" },
		]),
		{ ok: true, value: "Use <REDACTED NESTED_TOKEN VALUE> today" });
	assert.equal(sanitizeAuditIntentDetailed(undefined, false, none).reason, "missing");
	assert.equal(sanitizeAuditIntentDetailed({ purpose: "Read safely" }, true, none).reason, "invalid_type");
	assert.equal(sanitizeAuditIntentDetailed("x".repeat(4_001), true, none).reason, "too_long");
	assert.equal(sanitizeAuditIntentDetailed("   ", true, none).reason, "empty");
	assert.equal(sanitizeAuditIntentDetailed("\u200b\u200e\x07", true, none).reason, "empty");
	assert.equal(sanitizeAuditIntentDetailed("x".repeat(1001), true, none).reason, "sanitized_too_long");
	// Whitespace normalization and control/BiDi stripping are retained.
	assert.deepEqual(sanitizeAuditIntentDetailed("Review  the\tplan\nnow.", true, none),
		{ ok: true, value: "Review the plan now." });
	assert.deepEqual(sanitizeAuditIntentDetailed("Review\u200b the plan now.", true, none),
		{ ok: true, value: "Review the plan now." });
	// A re-sanitization is stable for ordinary stored values.
	const once = sanitized(`Export token=${secret} for the gateway`).value as string;
	assert.equal(sanitizeAuditIntentDetailed(once, true, replacements).value, once);
});

test("unavailable credential redaction fails closed instead of defaulting to no filtering", async () => {
	// Unit level: the sanitizer rejects before any other text check when the
	// discovered replacement set is unavailable; it never treats that as an
	// empty set.
	assert.equal(sanitizeAuditIntentDetailed("Read config.ts", true, undefined).reason, "redaction_unavailable");
	assert.equal(sanitizeAuditIntentDetailed("  ", true, undefined).reason, "redaction_unavailable");

	// Extension level: a failed discovery makes context decoration fail, so the
	// call is blocked and a specific diagnostic is recorded; no audit entry is
	// persisted.
	const mock = mockExtension({
		credentialDiscovery: { readFile: () => { throw new Error("registry unreadable"); }, environment: {} },
	});
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "unavailable-1", name: "read", arguments: { intent: "Read config.ts" } }],
	}, stopReason: "toolUse" as const }, mock.context);
	const blocked = await mock.handler("tool_call")({ toolCallId: "unavailable-1", toolName: "read", input: {} }, mock.context);
	assert.equal(blocked.block, true);
	assert.equal(
		mock.entries.some((entry) => entry.customType === TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE && entry.data.reason === "provider_intent_redaction_unavailable"),
		true,
	);
	assert.equal(mock.entries.some((entry) => entry.customType === TOOL_INTENT_ENTRY_TYPE), false);
});

test("marker-bearing persisted intent stays valid when the credential set rotates", async () => {
	const mock = mockExtension({
		credentialDiscovery: { readFile: () => "TEST_TOKEN=VALUE", environment: { TEST_TOKEN: "VALUE" } },
	});
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	// A redaction marker can itself contain a registered credential value, so a
	// second redaction would change the stored text. Stored evidence validity
	// must not depend on surviving today's replacement set.
	const intent = "Note that the code is VALUE here";
	const replacement = await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "call|marker", name: "read", arguments: { path: "private.txt", intent } }],
	}, stopReason: "toolUse" as const }, mock.context);
	const stored = "Note that the code is <REDACTED TEST_TOKEN VALUE> here";
	assert.equal(replacement.message.content[0].arguments.intent, undefined);
	assert.equal(mock.entries[0].data.intent, stored);
	// The stored marker still contains the registered value, so re-running the
	// current pipeline would change it. That must not invalidate the evidence.
	assert.equal(
		sanitizeAuditIntentDetailed(stored, true, [{ key: "TEST_TOKEN", value: "VALUE", marker: "<REDACTED TEST_TOKEN VALUE>" }]).value,
		"Note that the code is <REDACTED TEST_TOKEN <REDACTED TEST_TOKEN VALUE>> here",
	);
	assert.equal(isToolIntentData(mock.entries[0].data), true);
	assert.equal(findPersistedToolIntent(mock.entries, "call|marker")?.intent, stored);

	// Rotation: a fresh session with a different (empty) replacement set must
	// still treat the stored entry as valid evidence.
	const rotated = mockExtension();
	rotated.entries.push(...mock.entries);
	assert.equal(findPersistedToolIntent(rotated.entries, "call|marker")?.intent, mock.entries[0].data.intent);
	mock.entries.push({ type: "message", message: replacement.message });
	rotated.entries.push({ type: "message", message: replacement.message });
	const next = await rotated.request({
		messages: contextMessages(
			[{ name: "read", parameters: schema({ path: { type: "string" } }) }],
			[historicalAssistantEntry("call|marker", "read", { path: "private.txt" }).message],
		),
	}, rotated.context);
	assert.equal(next[1].content[0].arguments.intent, mock.entries[0].data.intent);
});

test("legacy persisted intents validate structurally and are redacted only at egress", async () => {
	const setA = { readFile: () => "LEGACY_TOKEN=alpha123", environment: { LEGACY_TOKEN: "alpha123" } };
	const legacyPlain = "Review the gateway notes before release";
	const legacyEntry = {
		version: 1,
		toolCallId: "legacy-1",
		toolName: "read",
		// Stored under an older sanitizer that left the then-unknown value in place.
		intent: legacyPlain + " with alpha123 appended",
		timestamp: "2026-09-16T00:00:00.000Z",
	};
	const mock = mockExtension({ credentialDiscovery: setA });
	mock.entries.push({ type: "custom", customType: TOOL_INTENT_ENTRY_TYPE, data: legacyEntry });
	mock.entries.push(historicalAssistantEntry("legacy-1", "read", { path: "file" }));
	// The stored value no longer survives today's pipeline, but it is still
	// valid evidence: structure and basic bounds decide, not re-sanitization.
	assert.equal(isToolIntentData(legacyEntry), true);
	assert.equal(findPersistedToolIntent(mock.entries, "legacy-1")?.intent, legacyEntry.intent);
	const restored = await mock.request({
		messages: contextMessages(
			[{ name: "read", parameters: schema({ path: { type: "string" } }) }],
			[historicalAssistantEntry("legacy-1", "read", { path: "file" }).message],
		),
	}, mock.context);
	assert.equal(restored[1].content[0].arguments.intent, legacyEntry.intent);

	// Oversized or malformed stored entries are still rejected.
	assert.equal(isToolIntentData({ ...legacyEntry, intent: "x".repeat(MAX_AUDIT_INTENT_LENGTH + 1) }), false);
	assert.equal(isToolIntentData({ ...legacyEntry, intent: "" }), false);
	assert.equal(isToolIntentData({ ...legacyEntry, version: 2 }), false);
	assert.equal(isToolIntentData({ ...legacyEntry, timestamp: 123 }), false);
	const history = rehydrateToolIntentHistory(
		[{ role: "assistant", content: [{ type: "toolCall", id: "legacy-1", name: "read", arguments: { path: "file" } }] }],
		mock.entries,
	);
	assert.equal(history.rehydrated, 1);
});

test("possessive intent persists and is found again by tool-call ID", async () => {
	const mock = mockExtension();
	const messages: any = contextMessages([
		{ name: "read", parameters: schema({ path: { type: "string" } }) },
	]);
	await mock.request({ messages }, mock.context);
	const intent = "Check Alice's and Bob's notes before review.";
	const replacement = await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "call|possessive", name: "read", arguments: { path: "private.txt", intent } }],
	} }, mock.context);
	assert.equal(replacement.message.content[0].arguments.intent, undefined);
	assert.equal(mock.entries[0].data.intent, intent);
	assert.equal(findPersistedToolIntent(mock.entries, "call|possessive")?.intent, intent);
	mock.entries.push({ type: "message", message: replacement.message });
	const nextPayload: any = contextMessages(
		[{ name: "read", parameters: schema({ path: { type: "string" } }) }],
		[historicalAssistantEntry("call|possessive", "read", { path: "private.txt" }).message],
	);
	const next = await mock.request({ messages: nextPayload }, mock.context);
	assert.equal(next[1].content[0].arguments.intent, intent);
});

test("missing intent shows only sanitized fallback before the later execution gate blocks", async () => {
	const mock = mockExtension();
	await mock.request({
		messages: contextMessages([
			{ name: "bash", parameters: schema({ command: { type: "string" } }) },
		]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "missing-1", name: "bash", arguments: { command: "secret command" } }],
	} }, mock.context);

	const blocked = await mock.handler("tool_call")({
		toolCallId: "missing-1",
		toolName: "bash",
		input: { command: "secret command" },
	}, mock.context);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /provider_intent_missing/);
	assert.equal(mock.entries.length, 1);
	assert.equal(mock.entries[0].customType, TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE);
	assert.equal(mock.entries[0].data.reason, "provider_intent_missing");
	assert.equal(JSON.stringify(mock.entries).includes("secret command"), false);
});

test("invalid intent is stripped, never audited, and blocks execution", async () => {
	const mock = mockExtension();
	for (const [id, intent] of [["empty", "  "], ["long", "x".repeat(2000)], ["typed", { text: "Read safely" }]]) {
		await mock.request({
			messages: contextMessages([{ name: "read", parameters: schema() }]),
		}, mock.context);
		const replacement = await mock.handler("message_end")({ message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { intent } }],
		} }, mock.context);
		assert.deepEqual(replacement.message.content[0].arguments, {});
		const blocked = await mock.handler("tool_call")({ toolCallId: id, toolName: "read", input: {} }, mock.context);
		assert.equal(blocked.block, true);
	}
	assert.deepEqual(
		mock.entries.map((entry) => entry.data.reason),
		["provider_intent_empty", "provider_intent_sanitized_too_long", "provider_intent_invalid_type"],
	);
	assert.equal(mock.entries.every((entry) => entry.customType === TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE), true);
});

test("request-scoped decoration snapshots do not lose correlation when requests overlap", async () => {
	const mock = mockExtension();
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.request({
		messages: contextMessages([{ name: "bash", parameters: schema() }]),
	}, mock.context);

	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "overlap-read", name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "overlap-read", toolName: "read", input: {} }, mock.context),
		undefined,
	);

	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "overlap-bash", name: "bash", arguments: { intent: "Run an echo smoke test" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "overlap-bash", toolName: "bash", input: {} }, mock.context),
		undefined,
	);
	assert.equal(mock.entries.filter((entry) => entry.customType === TOOL_INTENT_ENTRY_TYPE).length, 2);
});

test("provider transport retry reuses one request snapshot", async () => {
	const mock = mockExtension();
	// Pi's provider retry happens below onPayload, so before_provider_request fires
	// once even if the HTTP request itself is attempted more than once.
	await mock.request({
		messages: contextMessages([{ name: "bash", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "transport-retry", name: "bash", arguments: { intent: "Run an echo smoke test" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "transport-retry", toolName: "bash", input: {} }, mock.context),
		undefined,
	);
});

test("error and abort message_end events retire snapshots before agent retries", async () => {
	const mock = mockExtension();
	for (const stopReason of ["error", "aborted"]) {
		await mock.request({
			messages: contextMessages([{ name: "bash", parameters: schema() }]),
		}, mock.context);
		await mock.handler("message_end")({ message: { role: "assistant", content: [], stopReason } }, mock.context);
		await mock.request({
			messages: contextMessages([{ name: "bash", parameters: schema() }]),
		}, mock.context);
		await mock.handler("message_end")({ message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `after-${stopReason}`, name: "bash", arguments: { intent: "Run an echo smoke test" } }],
		} }, mock.context);
		assert.equal(
			await mock.handler("tool_call")({ toolCallId: `after-${stopReason}`, toolName: "bash", input: {} }, mock.context),
			undefined,
		);
	}
});

test("agent lifecycle clears an abandoned provider snapshot", async () => {
	const mock = mockExtension();
	await mock.request({
		messages: contextMessages([{ name: "bash", parameters: schema() }]),
	}, mock.context);
	// Simulate an exceptional provider implementation that rejects before agent-core
	// can synthesize its terminal assistant message.
	await mock.handler("agent_settled")({}, mock.context);
	await mock.handler("agent_start")({}, mock.context);
	await mock.request({
		messages: contextMessages([{ name: "bash", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "after-abandon", name: "bash", arguments: { intent: "Run an echo smoke test" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "after-abandon", toolName: "bash", input: {} }, mock.context),
		undefined,
	);
});

test("ambiguous overlapping request correlation fails closed until agent settlement", async () => {
	const mock = mockExtension();
	for (let index = 0; index < 2; index += 1) {
		await mock.request({
			messages: contextMessages([{ name: "read", parameters: schema() }]),
		}, mock.context);
	}
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "ambiguous", name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	const blocked = await mock.handler("tool_call")(
		{ toolCallId: "ambiguous", toolName: "read", input: {} },
		mock.context,
	);
	assert.match(blocked.reason, /request_correlation_ambiguous/);
	assert.equal(mock.entries[0].data.reason, "request_correlation_ambiguous");

	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "still-poisoned", name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	const stillBlocked = await mock.handler("tool_call")(
		{ toolCallId: "still-poisoned", toolName: "read", input: {} },
		mock.context,
	);
	assert.match(stillBlocked.reason, /request_correlation_ambiguous/);

	await mock.handler("agent_settled")({}, mock.context);
	await mock.handler("agent_start")({}, mock.context);
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "after-settle", name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "after-settle", toolName: "read", input: {} }, mock.context),
		undefined,
	);
});

test("pending request correlation is bounded and recovers after settlement", async () => {
	const mock = mockExtension();
	for (let index = 0; index <= MAX_PENDING_PROVIDER_REQUESTS; index += 1) {
		await mock.request({
			messages: contextMessages([{ name: "bash", parameters: schema() }]),
		}, mock.context);
	}
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "overflow", name: "bash", arguments: { intent: "Run an echo smoke test" } }],
	} }, mock.context);
	const overflow = await mock.handler("tool_call")(
		{ toolCallId: "overflow", toolName: "bash", input: {} },
		mock.context,
	);
	assert.match(overflow.reason, /request_correlation_overflow/);
	assert.equal(mock.entries[0].data.reason, "request_correlation_overflow");

	await mock.handler("agent_settled")({}, mock.context);
	await mock.handler("agent_start")({}, mock.context);
	await mock.request({
		messages: contextMessages([{ name: "bash", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "after-overflow", name: "bash", arguments: { intent: "Run an echo smoke test" } }],
	} }, mock.context);
	assert.equal(
		await mock.handler("tool_call")({ toolCallId: "after-overflow", toolName: "bash", input: {} }, mock.context),
		undefined,
	);
});

test("gate diagnostics distinguish append visibility and tool-call correlation failures", async () => {
	const mock = mockExtension();
	await mock.request({
		messages: contextMessages([{ name: "read", parameters: schema() }]),
	}, mock.context);
	await mock.handler("message_end")({ message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "visibility", name: "read", arguments: { intent: "Read config.ts" } }],
	} }, mock.context);
	const invisible = await mock.handler("tool_call")(
		{ toolCallId: "visibility", toolName: "read", input: {} },
		{ sessionManager: { getBranch: () => [] } },
	);
	assert.match(invisible.reason, /audit_not_visible/);

	const mismatched = await mock.handler("tool_call")(
		{ toolCallId: "different-call", toolName: "read", input: {} },
		mock.context,
	);
	assert.match(mismatched.reason, /tool_call_id_mismatch/);
	assert.deepEqual(
		mock.entries.slice(-2).map((entry) => entry.data.reason),
		["audit_not_visible", "tool_call_id_mismatch"],
	);
});

test("real SessionManager exposes message_end appendEntry before tool_call", {
	skip: !process.env.PI_CODING_AGENT_PACKAGE,
}, async () => {
	const packageRoot = process.env.PI_CODING_AGENT_PACKAGE as string;
	const { SessionManager } = await import(pathToFileURL(join(packageRoot, "dist/core/session-manager.js")).href);
	const handlers = new Map<string, Handler[]>();
	const sessionManager = SessionManager.inMemory(process.cwd());
	const pi = {
        events: { on: () => () => {}, emit() {} },

		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		appendEntry(customType: string, data: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
	} as unknown as ExtensionAPI;
	createObservabilityExtension({
		now: () => new Date("2026-09-16T00:00:00.000Z"),
		credentialDiscovery: { readFile: () => "", environment: {} },
	})(pi);
	const handler = (name: string) => handlers.get(name)?.[0] as Handler;
	const context = { sessionManager };
	await handler("context_with_system")({messages: contextMessages([{name:"read",parameters:schema()}])}, context);
	await handler("before_provider_request")({payload:{synthetic:true}}, context);
	const message: any = {
		role: "assistant",
		content: [{ type: "toolCall", id: "real-order", name: "read", arguments: { intent: "Read config.ts" } }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const replacement = await handler("message_end")({ message }, context);
	sessionManager.appendMessage(replacement.message);
	assert.deepEqual(sessionManager.getBranch().map((entry) => entry.type), ["custom", "message"]);
	assert.equal(
		await handler("tool_call")({ toolCallId: "real-order", toolName: "read", input: {} }, context),
		undefined,
	);
});
