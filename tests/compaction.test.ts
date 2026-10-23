import assert from "node:assert/strict";
import test from "node:test";
import { createObservabilityExtension } from "../src/index.ts";

function fixture(unavailable = false) {
    const handlers = new Map<string, any[]>(), entries: any[] = [];
    let retries = 0;
    createObservabilityExtension({ credentialDiscovery: { readFile: () => { if (unavailable) throw new Error('Synthetic unavailable registry'); return "DEMO_TOKEN=registry"; }, environment: { DEMO_TOKEN: "synthetic-secret" } } })({
        on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
        events: { on: () => () => {}, emit() {} },
        appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    } as any);
    const ctx = { sessionManager: { getBranch: () => entries }, model: { provider: 'synthetic', id: 'fixture' }, modelRegistry: { streamSimple() { retries++; throw new Error('Unexpected corrective retry'); } } };
    const emit = (name: string, event: any = {}) => { let result; for (const fn of handlers.get(name) ?? []) result = fn(event, ctx); return result; };
    const source = [{ role: "system", content: "Fixture", timestamp: 0, toolsAdded: [{ name: "inspect", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }] }];
    const prepare = () => emit("context_with_system", { messages: structuredClone(source) });
    const egress = (payload: any = { text: "synthetic-secret" }) => emit("before_provider_request", { payload });
    const response = (id: string) => emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "inspect", arguments: { intent: "Inspect the fixture." } }] } });
    const gate = (id: string) => emit("tool_call", { toolCallId: id, toolName: "inspect", input: {} });
    const finish = (id: string) => { response(id); return gate(id); };
    return { entries, emit, source, prepare, egress, response, gate, finish, retries: () => retries };
}
for (const outcome of ["session_compact", "session_compact_failed"]) {
    test(`${outcome}: multiple redacted summary requests leave the next normal request executable`, () => {
        const f = fixture();
        f.emit("session_before_compact");
        const payload = { text: "synthetic-secret" };
        for (let i = 0; i < 3; i++) assert.deepEqual(f.egress(payload), { text: "<REDACTED DEMO_TOKEN VALUE>" });
        assert.equal(payload.text, "synthetic-secret");
        f.emit(outcome, { aborted: outcome === "session_compact_failed" });
        f.prepare(); f.egress();
        assert.equal(f.finish("after-summary"), undefined);
        assert.equal(f.entries.filter(e => e.customType === "tool-intent").length, 1);
    });
}
test("unavailable discovery never grants summary egress or later normal execution", () => {
    const f = fixture(true); f.emit('session_before_compact');
    assert.equal(f.egress(), null);
    f.emit('session_compact_failed'); f.prepare(); assert.equal(f.egress(), null);
    assert.equal(f.finish('unready').block, true);
    assert.equal(f.entries.some(e => e.customType === 'tool-intent'), false);
});
test("summary traversal failure blocks its payload without poisoning later normal correlation", () => {
    const f = fixture(); f.emit("session_before_compact");
    const cycle: any = {}; cycle.self = cycle;
    assert.equal(f.egress(cycle), null);
    f.emit("session_compact_failed"); f.prepare(); f.egress();
    assert.equal(f.finish("after-failure"), undefined);
});
test("summary contexts and unexpected responses cannot create executable authority or corrective retries", () => {
    const f = fixture(); f.emit("session_before_compact");
    assert.deepEqual(f.prepare().messages, f.source);
    f.egress();
    assert.equal(f.finish("summary-tool").block, true);
    f.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'missing-intent', name: 'inspect', arguments: {} }] } });
    assert.equal(f.gate('missing-intent').block, true);
    assert.equal(f.retries(), 0);
    assert.equal(f.entries.some(e => e.customType === "tool-intent" || e.customType === "tool-intent-retry"), false);
    f.emit("session_compact");
    assert.equal(f.gate("summary-tool").block, true);
    f.prepare(); f.egress(); assert.equal(f.finish("normal-tool"), undefined);
});
for (const kind of ["pending", "confirmed", "finalized", "ambiguous", "overflow"] as const) {
    test(`compaction cannot discharge ${kind} normal authorization state`, () => {
        const f = fixture();
        if (kind === "overflow") for (let i = 0; i < 33; i++) f.prepare();
        else {
            f.prepare();
            if (kind === "confirmed" || kind === "finalized") f.egress();
            if (kind === "finalized") f.response("held");
            if (kind === "ambiguous") { f.prepare(); f.egress(); }
        }
        f.emit("session_before_compact"); f.egress(); f.emit("session_compact");
        if (kind === "finalized") assert.equal(f.gate("held").block, true);
        f.prepare(); f.egress();
        assert.match(f.finish("unverified").reason, /request_correlation_(ambiguous|overflow)/);
    });
}
test("terminal events without local start do not clear genuine ambiguity", () => {
    const f = fixture(); f.prepare(); f.prepare(); f.egress();
    f.emit("session_compact_failed"); f.emit("session_compact");
    f.prepare(); f.egress(); assert.match(f.finish("still-blocked").reason, /request_correlation_ambiguous/);
});
test("a missing compaction terminal boundary never grants normal tool authority", () => {
    const f = fixture(); f.emit("session_before_compact");
    f.prepare(); f.egress(); assert.equal(f.finish("not-yet-normal").block, true);
    f.emit("session_compact_failed"); f.prepare(); f.egress(); assert.equal(f.finish("now-normal"), undefined);
});
for (const boundary of ["agent_start", "agent_settled", "session_shutdown"]) {
    test(`${boundary} retires abandoned compaction scope without preserving tool authority`, () => {
        const f = fixture(); f.emit("session_before_compact"); f.egress(); f.emit(boundary);
        if (boundary === "session_shutdown") f.emit("session_start");
        assert.equal(f.gate("late-summary").block, true);
        f.prepare(); f.egress(); assert.equal(f.finish("fresh"), undefined);
    });
}
