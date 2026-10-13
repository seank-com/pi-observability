import { zstdDecompressSync } from "node:zlib";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createObservabilityExtension } from "../src/index.ts";
import { TOOL_INTENT_INSTRUCTIONS } from "../src/intent-context.ts";
const root = realpathSync(process.env.PI_CODING_AGENT_PACKAGE ?? new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname);
const load = (p: string) => import(pathToFileURL(p).href);
const dependency = (name: string) => dirname(findPackageJSON(name, pathToFileURL(join(root, "package.json")))!);
const ai = dependency("@earendil-works/pi-ai");
const { ExtensionRunner } = await load(join(root, "dist/core/extensions/runner.js"));
const { AgentSession } = await load(join(root, "dist/core/agent-session.js"));
const { SessionManager } = await load(join(root, "dist/core/session-manager.js"));
const { convertToLlm } = await load(join(root, "dist/core/messages.js"));
const { getCurrentTools } = await load(join(ai, "dist/utils/transcript.js"));
const { runAgentLoop } = await load(join(dependency("@earendil-works/pi-agent-core"), "dist/agent-loop.js"));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const parameters = () => ({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false });
const model = { id: "synthetic", provider: "synthetic", api: "synthetic" };
function fixture(enabled = true) {
    const handlers = new Map<string, any[]>();
    const sessionManager = SessionManager.inMemory("/synthetic");
    if (enabled)
        createObservabilityExtension({ credentialDiscovery: { readFile: () => "FIXTURE_TOKEN=registry", environment: { FIXTURE_TOKEN: "fixture-secret" } } })({
            on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), events: { on: () => () => { }, emit() { } }, appendEntry: (name: string, data: any) => sessionManager.appendCustomEntry(name, data),
        } as any);
    const runner: any = Object.create(ExtensionRunner.prototype);
    runner.extensions = [{ path: "synthetic", handlers }];
    runner.createContext = () => ({ sessionManager });
    runner.emitError = (error: any) => { throw Error(JSON.stringify(error)); };
    const session: any = Object.create(AgentSession.prototype);
    session._extensionRunner = runner;
    return { runner, session, sessionManager };
}
for (const mode of ["valid", "missing", "invalid", "no instrumentation"]) {
    test(`real host loop: ${mode} intent, strict validation, audit ordering and next-request history`, async () => {
        const { runner, session, sessionManager } = fixture(mode !== "no instrumentation");
        let requests = 0, executed = 0, gateCalls = 0;
        const original = parameters();
        const tool = { name: "read", description: "Read synthetic fixture", parameters: original, execute: async (_id: string, args: any) => {
                assert.deepEqual(args, { path: "fixture-secret" });
                assert.ok(sessionManager.getBranch().some((entry: any) => entry.customType === "tool-intent"));
                executed++;
                return { content: [{ type: "text", text: "fixture-secret" }], details: {} };
            } };
        const messages = await runAgentLoop([{ role: "user", content: "Read the fixture", timestamp: 0 }], { messages: [], tools: [tool] }, {
            model, convertToLlm, transformContext: (messages: any) => runner.emitContext(messages), beforeToolCall: async (event: any) => {
                gateCalls++;
                return runner.emitToolCall({ type: "tool_call", toolName: event.toolCall.name, toolCallId: event.toolCall.id, input: event.args });
            }
        }, async (event: any) => {
            if (event.type === "message_end") {
                await session._emitExtensionEvent(event);
                sessionManager.appendMessage(event.message);
            }
        }, undefined, async (_model: any, context: any) => {
            requests++;
            assert.ok(requests <= 2, "bounded synthetic turn");
            assert.deepEqual(original, parameters());
            if (mode !== "no instrumentation")
                assert.ok(getCurrentTools(context.messages)[0].parameters.required.includes("intent"));
            if (requests === 2 && mode === "valid") {
                const prior = context.messages.find((m: any) => m.role === "assistant");
                assert.equal(prior.content[0].arguments.intent, "Inspect the fixture.");
                const stored = sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "assistant");
                assert.equal(stored.message.content[0].arguments.intent, undefined);
            }
            const redacted = await runner.emitBeforeProviderRequest({ messages: context.messages });
            if (mode !== "no instrumentation")
                assert.ok(!JSON.stringify(redacted).includes("fixture-secret"));
            const args: any = { path: "fixture-secret" };
            if (mode !== "missing")
                args.intent = mode === "invalid" ? "Run --bad" : "Inspect the fixture.";
            const message = { role: "assistant", content: requests === 1 ? [{ type: "toolCall", id: "call_1", name: "read", arguments: args }] : [{ type: "text", text: "done" }], ...model, model: model.id, stopReason: requests === 1 ? "toolUse" : "stop", usage, timestamp: 0 };
            return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message };
        });
        assert.equal(requests, 2);
        assert.equal(executed, mode === "valid" ? 1 : 0);
        assert.equal(gateCalls, mode === "no instrumentation" ? 0 : 1);
        assert.equal(messages.find((m: any) => m.role === "toolResult").isError, mode !== "valid");
        const audits = sessionManager.getBranch().filter((e: any) => e.customType === "tool-intent");
        assert.equal(audits.length, mode === "valid" ? 1 : 0);
        if (mode === "no instrumentation")
            assert.match(messages.find((m: any) => m.role === "toolResult").content[0].text, /additional properties/);
    });
}
for (const api of ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"]) {
    test(`real ${api} serializer preserves normalized intent and history; request suppressed before HTTP`, async () => {
        const { runner, sessionManager } = fixture();
        const prior: any = { role: "assistant", content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "fixture-secret" } }], ...model, model: model.id, usage, stopReason: "toolUse", timestamp: 1 };
        sessionManager.appendCustomEntry("tool-intent", { version: 1, toolCallId: "call_1|fc_1", toolName: "read", intent: "Inspect the fixture.", timestamp: "2026-10-12T00:00:00Z" });
        sessionManager.appendMessage(prior);
        const source = [{ role: "system", content: "System", toolsAdded: [{ name: "read", description: "Read fixture", parameters: parameters() }], timestamp: 0 }, { role: "user", content: "Read the fixture", timestamp: 0 }, prior, { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "fixture-secret" }], isError: false, timestamp: 2 }];
        const context = { messages: convertToLlm(await runner.emitContext(source)) };
        const mod = await load(join(ai, "dist/api", api + ".js"));
        const providerModel = { id: "test-model", name: "test", api, provider: api === "openai-codex-responses" ? "openai-codex" : "x", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 1024 };
        const token = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url") + ".x";
        let payload: any;
        const result = await mod.streamSimple(providerModel, context, { apiKey: api === "openai-codex-responses" ? token : "placeholder", onPayload: async (p: any) => { payload = await runner.emitBeforeProviderRequest(p); throw Error("captured; suppress HTTP"); } }).result();
        assert.equal(result.stopReason, "error");
        assert.ok(payload, api);
        let found = false;
        function inspect(value: any) { if (!value || typeof value !== "object")
            return; if (value.properties?.intent && value.required?.includes("intent"))
            found = true; for (const child of Object.values(value))
            inspect(child); }
        inspect(payload);
        assert.ok(found, "required intent survived serialization");
        const json = JSON.stringify(payload);
        assert.ok(json.includes("Inspect the fixture."));
        assert.ok(json.includes("Understand the project setup instructions."));
        assert.ok(json.includes("Check for uncommitted changes before editing."));
        assert.ok(!json.includes("fixture-secret"));
        assert.equal(prior.content[0].arguments.intent, undefined);
        assert.equal(source[0].content, "System");
    });
}
test("host forced-prompt projection preserves decorated schemas but replaces shared guidance", async () => {
    const { runner, session } = fixture();
    session.agent = { transformContext: (messages: any) => runner.emitContext(messages) };
    session._runSystemPromptOptions = { forceSystemPrompt: "Explicit forced prompt" };
    session._installAgentForcedPromptProjection();
    const messages = await session.agent.transformContext([{ role: "system", content: "Base", toolsAdded: [{ name: "read", description: "Read", parameters: parameters() }], timestamp: 0 }]);
    assert.ok(getCurrentTools(messages)[0].parameters.required.includes("intent"));
    assert.equal(messages[0].content, "Explicit forced prompt");
    assert.ok(!JSON.stringify(messages).includes(TOOL_INTENT_INSTRUCTIONS), "document the host's post-hook forced-prompt limitation");
});

for (const changed of [false, true]) test(`real Codex SSE retry ${changed ? "rejects changed arguments" : "accepts an identical corrected call"}`, async () => {
    const { runner, sessionManager } = fixture();
    const codex = await load(join(ai, "dist/api/openai-codex-responses.js"));
    const selected = { id: "fixture", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "http://fixture.invalid", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 1024 };
    const token = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url") + ".x";
    let requests = 0;
    runner.createContext = () => ({ sessionManager, model: selected, modelRegistry: { streamSimple: (m: any, context: any, options: any) => codex.streamSimple(m, context, { ...options, apiKey: token, transport: "sse", fetch: async (_url: any, init: any) => {
        requests++;
        const wire = typeof init.body === "string" ? init.body : zstdDecompressSync(init.body).toString();
        const body = JSON.parse(wire);
        assert.equal(body.tools.length, 1); assert.ok(body.tools[0].parameters.required.includes("intent"));
        assert.ok(!wire.includes("fixture-secret"));
        const item = { type: "function_call", id: "fc_retry", call_id: "retry", name: "read", arguments: JSON.stringify({ path: changed ? "other" : "fixture.txt", intent: "Inspect the fixture source." }) };
        const events = [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "response_fixture", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }];
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } }) } });
    await runner.emitContext([{ role: "system", content: "Inspect", toolsAdded: [{ name: "read", description: "Read", parameters: parameters() }], timestamp: 0 }, { role: "user", content: "Inspect fixture-secret", timestamp: 1 }]);
    await runner.emitBeforeProviderRequest({});
    const original = { role: "assistant", content: [{ type: "toolCall", id: "original|fc_original", name: "read", arguments: { path: "fixture.txt" } }], ...selected, model: selected.id, stopReason: "toolUse", usage, timestamp: 2 };
    await runner.emitMessageEnd({ type: "message_end", message: original });
    const gate = await runner.emitToolCall({ type: "tool_call", toolCallId: "original|fc_original", toolName: "read", input: { path: "fixture.txt" } });
    assert.equal(requests, 1);
    assert.equal(gate?.block ?? false, changed, JSON.stringify(sessionManager.getBranch()));
    assert.equal(sessionManager.getBranch().filter((e: any) => e.customType === "tool-intent").length, changed ? 0 : 1);
});
