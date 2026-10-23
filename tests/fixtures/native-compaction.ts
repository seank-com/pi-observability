import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = resolve(process.env.PI_CODING_AGENT_PACKAGE ?? "node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(host, "package.json")))!);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const entry = process.env.OBSERVABILITY_TEST_ENTRY ?? new URL("../../src/index.ts", import.meta.url).href;
const { createObservabilityExtension } = await import(entry.startsWith("file:") ? entry : pathToFileURL(resolve(entry)).href);
export const summaryCallbacks = process.env.EXPECTED_SUMMARY_CALLBACKS ?? "absent";
assert.ok(["absent", "forwarded"].includes(summaryCallbacks), "explicit supported summary callback expectation");
const secret = "synthetic-compaction-secret";
const usage = (input = 10) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export interface Scenario {
    outcome?: "success" | "failure" | "cancel" | "redaction" | "custom" | "early-cancel";
    split?: boolean;
    threshold?: boolean;
    overflow?: boolean;
    retry?: boolean;
}
export async function nativeFixture(scenario: Scenario = {}) {
    const root = await mkdtemp(join(tmpdir(), "observability-native-compaction-"));
    const cwd = join(root, "project"), agentDir = join(root, "agent");
    await mkdir(cwd); await mkdir(agentDir);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    const sessionManager = sdk.SessionManager.inMemory(cwd);
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: scenario.split ? 1 : 0 }, retry: { enabled: !!scenario.retry, maxRetries: 1, baseDelayMs: 0 }, cacheWarming: "off" });
    const events: any[] = [], payloads: any[] = [], errors: any[] = [];
    let inCompaction = false, summaryCalls = 0, ordinaryCalls = 0, executed = 0, onPayloadCalls = 0;
    let session: any;
    const provider = "observability-native-fixture";
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider, baseUrl: "http://fixture.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
    const message = (content: any[], stopReason = "stop", errorMessage?: string) => ({ role: "assistant", content, api: model.api, provider, model: model.id, usage: usage(), stopReason, errorMessage, timestamp: Date.now() });
    const seed = () => {
        // Persist the normal leading prompt/tool declaration as a real saved
        // session would; an arbitrary user-only history is not a valid fixture.
        sessionManager.appendMessage({ role: "system", content: "Synthetic offline fixture", timestamp: 0, toolsAdded: [{ name: "inspect", description: "Inspect a synthetic fixture", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }] });
        sessionManager.appendMessage({ role: "user", content: `Old synthetic request ${secret} ` + "history ".repeat(100), timestamp: 0 });
        sessionManager.appendMessage(message([{ type: "text", text: "Old synthetic answer " + "history ".repeat(100) }]));
        sessionManager.appendMessage({ role: "user", content: `Current synthetic request ${secret}`, timestamp: 1 });
        sessionManager.appendMessage(message([{ type: "text", text: "Current first answer " + "context ".repeat(100) }]));
        if (scenario.split) sessionManager.appendMessage(message([{ type: "text", text: "Current last answer " + "tail ".repeat(50) }]));
    };
    seed();
    modelRuntime.registerProvider(provider, {
        api: model.api, apiKey: "synthetic-only", baseUrl: model.baseUrl,
        models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }],
        streamSimple: (_model: any, context: any, options: any) => {
            const stream = createAssistantMessageEventStream();
            void (async () => {
                const summary = inCompaction;
                if (summary) summaryCalls++; else ordinaryCalls++;
                assert.ok(ordinaryCalls <= 4 && summaryCalls <= 4, 'scripted fixture exceeded its expected request sequence');
                let payload: any = { messages: context.messages };
                if (summary && scenario.outcome === "redaction") { payload = {}; payload.self = payload; }
                if (options.onPayload) { onPayloadCalls++; const transformed = await options.onPayload(payload, _model); if (transformed !== undefined) payload = transformed; }
                payloads.push({ summary, payload, callback: typeof options.onPayload === 'function' });
                let answer: any;
                if (payload === null) answer = message([], "error", "Synthetic blocked payload");
                else if (summary) {
                    if (scenario.outcome === "cancel") session.abortCompaction();
                    if (options.signal?.aborted) answer = message([], "aborted", "Synthetic cancellation");
                    else if (scenario.outcome === "failure") answer = message([], "error", "Synthetic deterministic summary failure");
                    else if (scenario.retry && summaryCalls === 1) answer = message([], "error", "terminated");
                    else answer = message([{ type: "text", text: "Synthetic summary with no credentials." }]);
                } else if (scenario.overflow && ordinaryCalls === 1) answer = message([], "error", "maximum context length exceeded");
                else if (executed < 2) answer = message([{ type: "toolCall", id: `native_${ordinaryCalls}`, name: "inspect", arguments: { intent: "Inspect the synthetic fixture." } }], "toolUse");
                else answer = message([{ type: "text", text: "Synthetic assignment complete." }]);
                if (answer.stopReason === "error" || answer.stopReason === "aborted") stream.push({ type: "error", reason: answer.stopReason, error: answer });
                else stream.push({ type: "done", reason: answer.stopReason, message: answer });
                stream.end();
            })().catch(error => { errors.push(error); const answer = message([], "error", String(error)); stream.push({ type: "error", reason: "error", error: answer }); stream.end(); });
            return stream;
        },
    });
    const observe = (pi: any) => {
        pi.on("session_before_compact", (event: any) => { inCompaction = true; events.push({ type: event.type, reason: event.reason, split: event.preparation.isSplitTurn }); if (scenario.outcome === "early-cancel") return { cancel: true }; });
        for (const type of ["session_compact", "session_compact_failed"]) pi.on(type, (event: any) => { events.push(event); inCompaction = false; settings.applyOverrides({ compaction: { enabled: false } }); });
        for (const type of ["agent_start", "agent_settled", "tool_call", "tool_result"]) pi.on(type, (event: any) => { events.push(event); });
    };
    const customize = (pi: any) => {
        if (scenario.outcome === "custom") pi.on("session_before_compact", (event: any) => ({ compaction: { summary: "Synthetic custom summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
    };
    try {
        const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), systemPrompt: "Synthetic offline fixture. Use inspect twice.", extensionFactories: [observe, createObservabilityExtension({ intentRetry: false, credentialDiscovery: { readFile: () => "DEMO_TOKEN=registry", environment: { DEMO_TOKEN: secret } } }), customize] });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader: loader, sessionManager, settingsManager: settings, thinkingLevel: "off", tools: ["inspect"], customTools: [{ name: "inspect", label: "Inspect", description: "Inspect a synthetic fixture", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() {
            executed++;
            if (scenario.threshold && executed === 1) settings.applyOverrides({ compaction: { enabled: true } });
            return { content: [{ type: "text", text: scenario.threshold && executed === 1 ? "fixture ".repeat(5000) : "Synthetic tool result" }], details: {} };
        } }] }));
        await session.bindExtensions({ onError: (error: any) => errors.push(error) });
        if (scenario.overflow) settings.applyOverrides({ compaction: { enabled: true } });
        return {
            session, settings, sessionManager, events, payloads, errors,
            counts: () => ({ summaryCalls, ordinaryCalls, executed, onPayloadCalls }),
            assertPayloads() {
                assert.deepEqual(errors, []);
                const summaries = payloads.filter(p => p.summary);
                const normals = payloads.filter(p => !p.summary);
                for (const { payload, callback } of normals) {
                    assert.equal(callback, true, 'normal request has a payload callback');
                    assert.ok(!JSON.stringify(payload).includes(secret), "normal payload redacted");
                }
                if (summaries.length) {
                    for (const attempt of summaries) assert.equal(attempt.callback, summaryCallbacks === 'forwarded', 'each summary attempt has the expected callback coverage');
                    if (summaryCallbacks === "forwarded") for (const { payload } of summaries) assert.ok(!JSON.stringify(payload).includes(secret), "summary payload redacted");
                    else assert.ok(summaries.some(p => JSON.stringify(p.payload).includes(secret)), "stock summary callback bypass remains explicit");
                }
            },
            async close() { await session.abort(); session.dispose(); modelRuntime.unregisterProvider(provider); await rm(root, { recursive: true, force: true }); },
        };
    } catch (error) { session?.dispose(); modelRuntime.unregisterProvider(provider); await rm(root, { recursive: true, force: true }); throw error; }
}
