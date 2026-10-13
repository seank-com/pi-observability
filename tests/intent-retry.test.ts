import assert from "node:assert/strict";
import test from "node:test";
import { createObservabilityExtension } from "../src/index.ts";
const tool = { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const call = (args: any = { path: "fixture.txt" }, id = "original") => ({ type: "toolCall", id, name: "read", arguments: args });
const answer = (calls = [call({ path: "fixture.txt", intent: "Inspect the fixture source." }, "retry")]) => ({ role: "assistant", content: calls, stopReason: "toolUse", usage: { input: 3, output: 2 } });
function fixture(reply: any = answer(), options: any = {}) {
    const handlers = new Map<string, any>(), entries: any[] = [], requests: any[] = [];
    const controller = new AbortController();
    const model = { provider: options.provider ?? "openai-codex", id: "fixture" };
    const ctx: any = { model, signal: controller.signal, sessionManager: { getBranch: () => entries }, modelRegistry: {
        streamSimple(selected: any, context: any, opts: any) {
            assert.equal(selected, model);
            requests.push({ context, opts });
            return { result: async () => {
                if (!options.skipEgress) opts.onPayload(context);
                return typeof reply === "function" ? reply(opts) : reply;
            } };
        },
    } };
    createObservabilityExtension({ credentialDiscovery: { readFile: () => "", environment: {} }, intentRetry: options.retry ?? { requestTimeoutMs: 30, turnBudgetMs: 60 } })({
        on: (name: string, fn: any) => handlers.set(name, fn), events: { on: () => () => {}, emit() {} },
        appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    } as any);
    const invoke = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
    const prepare = () => { invoke("context_with_system", { messages: [{ role: "system", content: "Inspect", toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "Read the fixture", timestamp: 1 }] }); invoke("before_provider_request", { payload: {} }); };
    prepare();
    return { requests, entries, invoke, controller, prepare, finish: (calls = [call()]) => invoke("message_end", { message: { ...answer(calls), provider: model.provider, model: model.id } }), gate: (id = "original") => invoke("tool_call", { toolCallId: id, toolName: "read", input: { path: "fixture.txt" } }) };
}
for (const provider of ["ollama", "openai-codex"]) test(`${provider}: one native tool retry is audited and stripped under the original identity`, async () => {
    const f = fixture(answer(), { provider });
    const result = await f.finish();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].context.messages[0].toolsAdded[0].name, "read");
    assert.match(f.requests[0].context.messages[0].content, /Repeat exactly the same tool call once/);
    assert.deepEqual(result.message.content, [call()]);
    assert.equal(f.gate(), undefined);
    assert.equal(f.entries.filter(e => e.customType === "tool-intent").length, 1);
    assert.equal(f.entries.find(e => e.customType === "tool-intent-retry").data.outcome, "accepted");
});
for (const [label, reply] of Object.entries({
    absent: answer([call()]), invalid: answer([call({ path: "fixture.txt", intent: "Inspect /private/file." })]),
    changedArguments: answer([call({ path: "other", intent: "Inspect the fixture source." })]),
    changedTool: answer([{ ...call({ path: "fixture.txt", intent: "Inspect the fixture source." }), name: "bash" }]),
    multiple: answer([call(), call()]), prose: { content: [{ type: "text", text: "Inspect the fixture." }], stopReason: "stop" },
    truncated: { ...answer(), stopReason: "length" }, error: { ...answer(), stopReason: "error" },
})) test(`${label} retry blocks without a second attempt or an audit`, async () => {
    const f = fixture(reply); await f.finish();
    assert.equal(f.requests.length, 1); assert.equal(f.gate().block, true);
    assert.equal(f.entries.some(e => e.customType === "tool-intent"), false);
});
test("present invalid intent, undecorated and duplicate calls do not retry", async () => {
    for (const calls of [[call({ path: "fixture.txt", intent: "" })], [call(), call()]]) {
        const f = fixture(); await f.finish(calls); assert.equal(f.requests.length, 0); assert.equal(f.gate().block, true);
    }
    const f = fixture(); f.invoke("agent_settled"); await f.finish(); assert.equal(f.requests.length, 0); assert.equal(f.gate().block, true);
});
test("provider skipping egress verification cannot authorize a retry", async () => {
    const f = fixture(answer(), { skipEgress: true }); await f.finish(); assert.equal(f.gate().block, true);
});
test("timeout bounds an uncooperative completion and late success cannot authorize execution", async () => {
    let resolve: any;
    const f = fixture(() => new Promise(r => { resolve = r; }));
    await f.finish(); assert.equal(f.requests[0].opts.signal.aborted, true); assert.equal(f.gate().block, true);
    resolve(answer()); await Promise.resolve(); assert.equal(f.entries.some(e => e.customType === "tool-intent"), false);
});
for (const action of ["abort", "session_shutdown", "agent_settled"]) test(`${action} retires a held retry`, async () => {
    let resolve: any;
    const f = fixture(() => new Promise(r => { resolve = r; })); const pending = f.finish();
    await Promise.resolve(); if (action === "abort") f.controller.abort(); else f.invoke(action);
    await pending; resolve(answer()); await Promise.resolve();
    assert.equal(f.gate().block, true); assert.equal(f.entries.some(e => e.customType === "tool-intent"), false);
});
test("sibling calls retry serially within one budget and keep separate original IDs", async () => {
    const f = fixture(answer()); await f.finish([call(), call(undefined, "sibling")]);
    assert.equal(f.requests.length, 2); assert.equal(f.gate(), undefined); assert.equal(f.gate("sibling"), undefined);
    assert.equal(f.entries.filter(e => e.customType === "tool-intent").length, 2);
});
test("one shared deadline bounds sibling retries", async () => {
    const f = fixture(() => new Promise(() => {}), { retry: { requestTimeoutMs: 100, turnBudgetMs: 10 } });
    await f.finish([call(), call(undefined, "sibling")]);
    assert.equal(f.requests.length, 1); assert.equal(f.gate().block, true); assert.equal(f.gate("sibling").block, true);
});
test("disabled retry and already-valid intent do not create auxiliary requests", async () => {
    const disabled = fixture(answer(), { retry: false }); await disabled.finish(); assert.equal(disabled.requests.length, 0); assert.equal(disabled.gate().block, true);
    const valid = fixture(); await valid.finish([call({ path: "fixture.txt", intent: "Inspect the fixture source." })]); assert.equal(valid.requests.length, 0); assert.equal(valid.gate(), undefined);
});

import { retryIntent } from "../src/intent-retry.ts";
const retryMessages = [{ role: "system", toolsAdded: [tool] }];
test("redaction failure and synchronous transport failure settle without unhandled abort rejection", async () => {
    for (const fail of [false, true]) {
        let sends = 0;
        const ctx = { model: {}, modelRegistry: { streamSimple: (_m: any, _c: any, options: any) => {
            if (fail) throw Error("fixture");
            return { result: async () => { options.onPayload({}); sends++; return answer(); } };
        } } };
        const result = await retryIntent(call(), retryMessages, ctx, new AbortController().signal, () => null, 20);
        assert.equal(result.intent, undefined); assert.equal(sends, 0);
    }
    await new Promise(resolve => setImmediate(resolve));
});
test("oversized partial response aborts its transport before a final answer", async () => {
    let signal: AbortSignal;
    const ctx = { model: {}, modelRegistry: { streamSimple: (_m: any, _c: any, options: any) => {
        signal = options.signal; options.onPayload({});
        return { async *[Symbol.asyncIterator]() { yield { partial: { content: "x".repeat(1024 * 1024) } }; }, result: async () => answer() };
    } } };
    const result = await retryIntent(call(), retryMessages, ctx, new AbortController().signal, x => x, 20);
    assert.equal(result.reason, "too_large"); assert.equal(signal!.aborted, true);
});
