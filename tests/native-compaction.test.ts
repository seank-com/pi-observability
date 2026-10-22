import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, summaryCallbacks } from "./fixtures/native-compaction.ts";

for (const scenario of [{}, { split: true }, { retry: true }, { outcome: "failure" }, { outcome: "cancel" }, { outcome: "early-cancel" }, { outcome: "custom" }] as const) {
    test(`native manual compaction ${JSON.stringify(scenario)} then audited tool execution (${summaryCallbacks})`, async () => {
        const f = await nativeFixture(scenario);
        try {
            const prior = f.sessionManager.getEntries().map((entry: any) => structuredClone(entry));
            if (scenario.outcome === "failure" || scenario.outcome === "cancel" || scenario.outcome === "early-cancel") await assert.rejects(f.session.compact());
            else await f.session.compact();
            const terminal = f.events.find(e => e.type === "session_compact" || e.type === "session_compact_failed");
            assert.ok(terminal);
            if (scenario.outcome === "cancel" || scenario.outcome === "early-cancel") assert.equal(terminal.aborted, true);
            if (scenario.split) { assert.equal(f.events.find(e => e.type === "session_before_compact").split, true); assert.equal(f.counts().summaryCalls, 2); }
            if (scenario.retry) assert.equal(f.counts().summaryCalls, 3, 'two split-turn summaries plus one transient retry');
            if (scenario.outcome === "early-cancel" || scenario.outcome === "custom") assert.equal(f.counts().summaryCalls, 0);
            await f.session.prompt("Inspect the synthetic fixture twice.");
            assert.equal(f.counts().executed, 2);
            assert.equal(f.sessionManager.getBranch().filter((e: any) => e.customType === "tool-intent").length, 2);
            assert.ok(!f.sessionManager.getBranch().some((e: any) => e.customType === "tool-intent-diagnostic"));
            assert.deepEqual(f.sessionManager.getEntries().slice(0, prior.length), prior, "prior source entries unchanged");
            f.assertPayloads();
        } finally { await f.close(); }
    });
}
for (const scenario of [{ threshold: true }, { threshold: true, outcome: 'failure' }, { threshold: true, outcome: 'cancel' }, { overflow: true }] as const) {
    test(`native automatic compaction ${JSON.stringify(scenario)} continues audited execution (${summaryCallbacks})`, async () => {
        const f = await nativeFixture(scenario);
        try {
            await f.session.prompt("Inspect the synthetic fixture twice.");
            assert.equal(f.counts().executed, 2, JSON.stringify(f.sessionManager.getBranch().filter((e: any) => e.customType === 'tool-intent-diagnostic')));
            assert.ok(f.counts().summaryCalls > 0);
            const before = f.events.findIndex(e => e.type === "session_before_compact");
            const after = f.events.findIndex(e => e.type === "session_compact" || e.type === "session_compact_failed");
            assert.ok(before >= 0 && after > before);
            assert.equal(f.events[before].reason, scenario.threshold ? "threshold" : "overflow");
            if ('outcome' in scenario) {
                assert.equal(f.events[after].type, 'session_compact_failed');
                assert.equal(f.events[after].aborted, scenario.outcome === 'cancel');
            }
            const laterTool = f.events.findIndex((e, i) => i > after && e.type === "tool_call");
            assert.ok(laterTool > after, "normal tool execution follows compaction");
            assert.ok(!f.events.slice(before, laterTool).some(e => e.type === "agent_settled"), "no settlement used to clear correlation");
            if (scenario.threshold) assert.ok(!f.events.slice(before, laterTool).some(e => e.type === 'agent_start'), 'threshold compaction stays in the same agent run');
            assert.equal(f.sessionManager.getBranch().filter((e: any) => e.customType === "tool-intent").length, 2);
            assert.ok(!f.sessionManager.getBranch().some((e: any) => e.customType === "tool-intent-diagnostic"));
            f.assertPayloads();
        } finally { await f.close(); }
    });
}
if (summaryCallbacks === "forwarded") {
    test("native failed summary redaction blocks egress but leaves later audited requests executable", async () => {
        const f = await nativeFixture({ outcome: "redaction" });
        try {
            await assert.rejects(f.session.compact());
            assert.ok(f.payloads.some(p => p.summary && p.payload === null));
            await f.session.prompt("Inspect the synthetic fixture twice.");
            assert.equal(f.counts().executed, 2);
            f.assertPayloads();
        } finally { await f.close(); }
    });
}
