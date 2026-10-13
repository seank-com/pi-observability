import assert from "node:assert/strict";
import test from "node:test";
import { createObservabilityExtension } from "../src/index.ts";
test("pre-serialization intent decorates request copies and strips before strict execution", () => {
    const handlers = new Map<string, any>();
    const entries: any[] = [];
    createObservabilityExtension({ credentialDiscovery: { readFile: () => "", environment: {} } })({
        on: (name: string, fn: any) => handlers.set(name, fn), events: { on: () => () => { }, emit() { } },
        appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    } as any);
    const ctx = { sessionManager: { getBranch: () => entries } };
    const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
    const source = [{ role: "system", content: "System", toolsAdded: [{ name: "read", description: "Read", parameters }], timestamp: 0 }];
    assert.ok(handlers.has("context_with_system"), "normalized context hook is required");
    const request = handlers.get("context_with_system")({ messages: source }, ctx);
    assert.ok(request.messages[0].toolsAdded[0].parameters.required.includes("intent"));
    assert.deepEqual(parameters.required, ["path"]);
    assert.match(request.messages[0].content, /Understand the project setup instructions/);
    assert.match(request.messages[0].content, /Check for uncommitted changes before editing/);
    handlers.get("before_provider_request")({ payload: { anyProvider: true } }, ctx);
    const result = handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "toolCall", id: "one", name: "read", arguments: { path: "README.md", intent: "Understand the project setup instructions." } }] } }, ctx);
    assert.deepEqual(result.message.content[0].arguments, { path: "README.md" });
    assert.equal(handlers.get("tool_call")({ toolCallId: "one", toolName: "read", input: { path: "README.md" } }, ctx), undefined);
});
import { instrumentIntentContext, TOOL_INTENT_GUIDANCE, TOOL_INTENT_INSTRUCTIONS } from "../src/intent-context.ts";
import { TOOL_INTENT_ENTRY_TYPE } from "../src/contract.ts";
const schema = () => ({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false });
const tool = (name = "read") => ({ name, description: "Fixture", parameters: schema() });
const context = () => [{ role: "system", content: "System", toolsAdded: [tool()], timestamp: 0 }];
const call = (id = "one", name = "read", args: any = { path: "fixture" }) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const audit = (id = "one", name = "read", intent = "Inspect the fixture.") => ({ type: "custom", customType: TOOL_INTENT_ENTRY_TYPE, data: { version: 1, toolCallId: id, toolName: name, intent, timestamp: "2026-10-12T00:00:00Z" } });
function fixture(options: any = {}) {
    const handlers = new Map<string, any[]>(), entries: any[] = [];
    createObservabilityExtension({ credentialDiscovery: { readFile: () => "", environment: {} }, ...options })({
        on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        events: { on: () => () => { }, emit() { } }, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    } as any);
    const ctx = { sessionManager: { getBranch: () => entries } };
    const invoke = (name: string, event: any) => { let result; for (const fn of handlers.get(name) ?? [])
        result = fn(event, ctx); return result; };
    return { entries, invoke, prepare: (messages: any = context()) => invoke("context_with_system", { messages }), egress: (payload: any = { arbitrary: "provider" }) => invoke("before_provider_request", { payload }),
        finish: (id = "one", name = "read") => { invoke("message_end", { message: call(id, name, { intent: "Inspect the fixture." }) }); return invoke("tool_call", { toolCallId: id, toolName: name, input: {} }); } };
}
test("all declarations are decorated, active removals/redefinitions are respected, structured prompt is preserved", () => {
    const input: any = [...context(), { role: "system", content: [{ type: "text", text: "Delta" }], sections: { memory: "Keep" }, toolsRemoved: [{ name: "read" }], toolsAdded: [tool("bash")], timestamp: 1 }, { role: "system", content: "", toolsAdded: [tool("bash")], timestamp: 2 }];
    input[0].content = [{ type: "text", text: "Head" }];
    input[0].sections = { memory: "Base" };
    const original = structuredClone(input), result = instrumentIntentContext(input, []);
    assert.deepEqual(input, original);
    assert.deepEqual([...result.activeNames], ["bash"]);
    for (const message of result.messages as any[])
        assert.equal(message.toolsAdded[0].parameters.properties.intent.description, TOOL_INTENT_GUIDANCE);
    assert.deepEqual(result.messages[0].sections, { memory: "Base" });
    assert.deepEqual(result.messages[1].sections, { memory: "Keep" });
    assert.equal((result.messages[0].content as any[]).at(-1).text, TOOL_INTENT_INSTRUCTIONS);
    const f = fixture();
    f.prepare(input);
    f.egress();
    assert.match(f.finish("removed", "read").reason, /response_tool_not_decorated/);
});
test("schema failures are atomic and reject reserved intent, unsupported forms, and grammar tools", () => {
    for (const parameters of [{ type: "string" }, { type: "object", properties: [] }, { type: "object", required: [1] }, { ...schema(), properties: { intent: { type: "string", description: TOOL_INTENT_GUIDANCE } } }]) {
        const input: any = context();
        input[0].toolsAdded.push({ ...tool("bad"), parameters });
        const original = structuredClone(input);
        assert.throws(() => instrumentIntentContext(input, []));
        assert.deepEqual(input, original);
        const f = fixture();
        assert.deepEqual(f.prepare(input).messages, input);
        f.egress();
        assert.match(f.finish().reason, /response_undecorated/);
    }
    const grammar: any = context();
    grammar[0].toolsAdded[0].constrainedSampling = { type: "grammar" };
    assert.throws(() => instrumentIntentContext(grammar, []));
    assert.throws(() => instrumentIntentContext([{ role: "user", content: "hello" }], []));
});
test("each new request has one shared guidance block without mutating its source", () => {
    const input = context();
    for (let i = 0; i < 2; i++) {
        const result = instrumentIntentContext(input, []);
        assert.equal((result.messages[0].content as string).split(TOOL_INTENT_INSTRUCTIONS).length, 2);
    }
    assert.equal(input[0].content, "System");
});
test("history restores only unique audited calls, preserves source, and counts rejected evidence", () => {
    const messages: any = [...context(), call("valid"), call("missing"), call("invalid"), call("duplicate"), call("mismatch"), call("unsafe", "read", { intent: "existing" }), call("unknown"), { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] }];
    const entries: any = messages.slice(1, -1).map((message: any) => ({ type: "message", message }));
    entries.pop();
    entries.push(audit("valid"), audit("invalid", "read", "Run --bad"), audit("duplicate"), audit("duplicate"), audit("mismatch", "bash"), audit("unsafe"));
    const original = structuredClone(messages), result = instrumentIntentContext(messages, entries);
    assert.deepEqual(result.history, { functionCalls: 8, rehydrated: 1, missingAudit: 1, invalidAudit: 1, ambiguousAudit: 3, unsafeShape: 2 });
    assert.equal((result.messages[1].content as any[])[0].arguments.intent, "Inspect the fixture.");
    assert.deepEqual(messages, original);
    // A restart rebuilds from durable branch evidence, not an in-memory audit cache.
    assert.deepEqual(instrumentIntentContext(messages, structuredClone(entries)).messages, result.messages);
});
test("duplicate persisted calls and mixed valid/invalid audits cannot rehydrate", () => {
    for (const entries of [[{ type: "message", message: call() }, { type: "message", message: call() }, audit()], [{ type: "message", message: call() }, audit(), audit("one", "read", "Run --bad")]]) {
        const result = instrumentIntentContext([...context(), call()], entries);
        assert.equal(result.history.rehydrated, 0);
        assert.equal(result.history.ambiguousAudit, 1);
    }
});
for (const mode of ["context missing", "egress missing", "redaction failed", "probe failed", "shutdown"]) {
    test(`${mode} never grants execution`, () => {
        const f = fixture(mode === "probe failed" ? { onProviderRequestDecorated: () => { throw Error("probe"); } } : {});
        if (mode !== "context missing")
            f.prepare();
        if (mode === "shutdown")
            f.invoke("session_shutdown", {});
        if (mode !== "egress missing") {
            const payload: any = {};
            if (mode === "redaction failed")
                payload.cycle = payload;
            const result = f.egress(payload);
            if (mode === "redaction failed" || mode === "shutdown")
                assert.equal(result, null);
        }
        assert.equal(f.finish().block, true);
        assert.ok(f.entries.every(e => e.customType !== TOOL_INTENT_ENTRY_TYPE));
    });
}
test("ambiguous context-to-egress pairing poisons trust until settlement", () => {
    const f = fixture();
    f.prepare();
    f.prepare();
    f.egress();
    assert.match(f.finish().reason, /request_correlation_ambiguous/);
    f.invoke("agent_settled", {});
    f.prepare();
    f.egress();
    assert.equal(f.finish("fresh"), undefined);
});
test("a second provider request cannot reuse a confirmed context snapshot", () => {
    const f = fixture();
    f.prepare();
    f.egress();
    f.egress();
    assert.match(f.finish().reason, /request_correlation_ambiguous/);
});
test("errors before egress retire failed attempts before the next context", () => {
    const f = fixture();
    f.prepare();
    f.invoke("message_end", { message: { role: "assistant", content: [], stopReason: "error" } });
    f.prepare();
    f.egress();
    assert.equal(f.finish(), undefined);
});
test("redaction failure during overlap cannot hide an older response behind a new request", () => {
    const f = fixture();
    f.prepare();
    f.egress();
    f.prepare();
    const cyclic: any = {};
    cyclic.self = cyclic;
    assert.equal(f.egress(cyclic), null);
    f.prepare();
    f.egress();
    assert.match(f.finish().reason, /request_correlation_ambiguous/);
});

test("JSON-schema constrained sampling preserves intent auditing for built-in tools", () => {
    for (const constrainedSampling of [false, { type: "json_schema", strict: "prefer" }, { type: "json_schema", strict: "require" }]) {
        const input: any = context();
        input[0].toolsAdded[0].constrainedSampling = constrainedSampling;
        const original = structuredClone(input);
        const f = fixture();
        const prepared = f.prepare(input);
        assert.ok(prepared.messages[0].toolsAdded[0].parameters.required.includes("intent"));
        assert.deepEqual(prepared.messages[0].toolsAdded[0].constrainedSampling, constrainedSampling);
        assert.deepEqual(input, original);
        f.egress();
        assert.equal(f.finish(), undefined);
        assert.ok(f.entries.some((entry: any) => entry.customType === TOOL_INTENT_ENTRY_TYPE));
    }
});
