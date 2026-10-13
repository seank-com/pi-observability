import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	discoverCredentialReplacements,
	redactProviderPayload,
} from "../src/egress-redaction.ts";
import { createObservabilityExtension } from "../src/index.ts";

type Handler = (event: any, context: any) => any;

const CANARY_TOKEN = "canary-token-4821";
const CANARY_API_KEY = "canary-api-key-5932";
const CANARY_PASSWORD = "canary-password-6043";

function discovery(overrides: Record<string, string | undefined> = {}) {
	return discoverCredentialReplacements({
		readFile: () => [
			"IGNORED_VALUE=declared-but-not-sensitive",
			"SERVICE_TOKEN=not-read-from-file",
			"export SERVICE_API_KEY=also-not-read-from-file",
			"ARTSPACE_PASSWORD=still-not-read-from-file",
			"lower_token=case-sensitive-ignore",
		].join("\n"),
		environment: {
			IGNORED_VALUE: "ordinary-value",
			SERVICE_TOKEN: CANARY_TOKEN,
			SERVICE_API_KEY: CANARY_API_KEY,
			ARTSPACE_PASSWORD: CANARY_PASSWORD,
			lower_token: "lowercase-canary",
			...overrides,
		},
	});
}

function responsesPayload(secret: string): Record<string, unknown> {
	return {
		model: "gpt-5-codex",
		store: false,
		stream: true,
		instructions: `system ${secret}`,
		input: [{ type: "message", content: `history ${secret}` }],
		tools: [{
			type: "function",
			name: "read",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
		}],
	};
}

function requestHandler(options: Parameters<typeof createObservabilityExtension>[0]): Handler {
	const handlers = new Map<string, Handler[]>();
	const pi = {
        events: { on: () => () => {}, emit() {} },

		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	createObservabilityExtension(options)(pi);
	const handler = handlers.get("before_provider_request")?.[0];
	if (!handler) throw new Error("missing before_provider_request handler");
	return handler;
}

const context = { sessionManager: { getBranch: () => [] } };

test("credential discovery selects only matching declared keys and inherited nonempty values", () => {
	const replacements = discovery({ SERVICE_API_KEY: "", ARTSPACE_PASSWORD: undefined });
	assert.deepEqual(replacements, [{
		key: "SERVICE_TOKEN",
		value: CANARY_TOKEN,
		marker: "<REDACTED SERVICE_TOKEN VALUE>",
	}]);
});

test("duplicate credential values choose the stable lexicographically first key", () => {
	const replacements = discoverCredentialReplacements({
		readFile: () => "Z_TOKEN=x\nA_PASSWORD=x\nM_API_KEY=x\n",
		environment: { Z_TOKEN: CANARY_TOKEN, A_PASSWORD: CANARY_TOKEN, M_API_KEY: CANARY_TOKEN },
	});
	assert.deepEqual(replacements, [{
		key: "A_PASSWORD",
		value: CANARY_TOKEN,
		marker: "<REDACTED A_PASSWORD VALUE>",
	}]);
});

test("redaction covers nested strings, arrays, repetition, and JSON-encoded arguments", () => {
	const replacements = discovery();
	const encoded = JSON.stringify({ token: CANARY_TOKEN, password: CANARY_PASSWORD });
	const payload = {
		instructions: `${CANARY_TOKEN} then ${CANARY_TOKEN}`,
		input: [{ content: CANARY_API_KEY }, [encoded, CANARY_PASSWORD]],
		number: 7,
		boolean: true,
		nothing: null,
		missing: undefined,
	};
	const redacted: any = redactProviderPayload(payload, replacements);

	assert.equal(redacted.instructions, "<REDACTED SERVICE_TOKEN VALUE> then <REDACTED SERVICE_TOKEN VALUE>");
	assert.equal(redacted.input[0].content, "<REDACTED SERVICE_API_KEY VALUE>");
	assert.deepEqual(JSON.parse(redacted.input[1][0]), {
		token: "<REDACTED SERVICE_TOKEN VALUE>",
		password: "<REDACTED ARTSPACE_PASSWORD VALUE>",
	});
	assert.equal(redacted.input[1][1], "<REDACTED ARTSPACE_PASSWORD VALUE>");
	assert.equal(redacted.number, 7);
	assert.equal(redacted.boolean, true);
	assert.equal(redacted.nothing, null);
	assert.equal(redacted.missing, undefined);
	assert.equal(JSON.stringify(redacted).includes(CANARY_TOKEN), false);
	assert.equal(JSON.stringify(redacted).includes(CANARY_API_KEY), false);
	assert.equal(JSON.stringify(redacted).includes(CANARY_PASSWORD), false);
});

test("overlapping values match longest-first without reprocessing replacement markers", () => {
	const replacements = discoverCredentialReplacements({
		readFile: () => "LONG_TOKEN=x\nSHORT_PASSWORD=x\n",
		environment: { LONG_TOKEN: "prefix-short", SHORT_PASSWORD: "short" },
	});
	const redacted = redactProviderPayload("prefix-short|short", replacements);
	assert.equal(redacted, "<REDACTED LONG_TOKEN VALUE>|<REDACTED SHORT_PASSWORD VALUE>");
	assert.equal(String(redacted).includes("prefix-short"), false);
});

test("redaction returns a separate structure and leaves the local fixture unchanged", () => {
	const fixture = { message: { content: CANARY_TOKEN }, list: [CANARY_PASSWORD] };
	const snapshot = structuredClone(fixture);
	const redacted = redactProviderPayload(fixture, discovery());
	assert.deepEqual(fixture, snapshot);
	assert.notEqual(redacted, fixture);
	assert.notEqual((redacted as any).message, fixture.message);
});

test("cyclic and unsupported payload values reject instead of risking partial egress", () => {
	const cyclic: any = { content: CANARY_TOKEN };
	cyclic.self = cyclic;
	assert.throws(() => redactProviderPayload(cyclic, discovery()), /Cyclic provider payload/);
	assert.throws(() => redactProviderPayload({ date: new Date(0) }, discovery()), /Unsupported provider payload object/);
	assert.throws(
		() => redactProviderPayload({ toJSON: () => ({ content: CANARY_TOKEN }) }, discovery()),
		/Unsupported provider payload scalar/,
	);
});

test("final request hook redacts without changing local string fields", async () => {
	const handler = requestHandler({
		credentialDiscovery: {
			readFile: () => "SERVICE_TOKEN=registry-only\n",
			environment: { SERVICE_TOKEN: CANARY_TOKEN },
		},
	});
	const payload = responsesPayload(CANARY_TOKEN);
	(payload.input as any[]).push({
		type: "message",
		arguments: JSON.stringify({ value: CANARY_TOKEN }),
	});
	const finalPayload: any = await handler({ payload }, context);
	const serialized = JSON.stringify(finalPayload);

	assert.notEqual(finalPayload, null);
	assert.equal(serialized.includes(CANARY_TOKEN), false);
	assert.equal(serialized.includes("<REDACTED SERVICE_TOKEN VALUE>"), true);
	assert.equal((payload.instructions as string).includes(CANARY_TOKEN), true);
	assert.equal((finalPayload.tools[0].parameters as any).properties.intent, undefined, "egress hook no longer decorates provider schemas");
});

test("credential redaction remains provider-shape-independent", async () => {
	const handler = requestHandler({
		credentialDiscovery: {
			readFile: () => "SERVICE_API_KEY=registry-only\n",
			environment: { SERVICE_API_KEY: CANARY_API_KEY },
		},
	});
	const payload = { provider: "other", messages: [{ content: CANARY_API_KEY }] };
	const finalPayload: any = await handler({ payload }, context);
	assert.deepEqual(finalPayload, {
		provider: "other",
		messages: [{ content: "<REDACTED SERVICE_API_KEY VALUE>" }],
	});
});

test("discovery and traversal failures return a credential-free blocking payload", async () => {
	const discoveryFailure = requestHandler({
		credentialDiscovery: {
			readFile: () => { throw new Error("canary discovery failure"); },
			environment: { SERVICE_TOKEN: CANARY_TOKEN },
		},
	});
	assert.equal(await discoveryFailure({ payload: responsesPayload(CANARY_TOKEN) }, context), null);

	const traversalFailure = requestHandler({
		credentialDiscovery: {
			readFile: () => "SERVICE_TOKEN=registry-only\n",
			environment: { SERVICE_TOKEN: CANARY_TOKEN },
		},
	});
	const cyclic: any = responsesPayload(CANARY_TOKEN);
	cyclic.self = cyclic;
	assert.equal(await traversalFailure({ payload: cyclic }, context), null);
});
