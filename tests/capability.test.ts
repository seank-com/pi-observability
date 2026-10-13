import assert from "node:assert/strict";
import test from "node:test";
import { createObservabilityExtension } from "../src/index.ts";
import { OBSERVABILITY_CAPABILITY_REQUEST, OBSERVABILITY_CAPABILITY_REPLY, queryObservabilityCapability } from "../src/contract.ts";

function fixture(failDiscovery = false) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const handlers = new Map<string, Array<() => void>>();
  const events = {
    on(channel: string, handler: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler); listeners.set(channel, set);
      return () => { set.delete(handler); };
    },
    emit(channel: string, data: unknown) { for (const handler of listeners.get(channel) ?? []) handler(data); },
  };
  const initialize = () => createObservabilityExtension({ credentialDiscovery: {
    readFile: () => { if (failDiscovery) throw new Error("fixture"); return "SERVICE_TOKEN=x"; },
    environment: { SERVICE_TOKEN: "synthetic-secret" },
  } })({ events, on(name: string, handler: () => void) {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
  }, appendEntry() {} } as any);
  const lifecycle = (name: string) => { for (const handler of handlers.get(name) ?? []) handler(); };
  return { events, listeners, initialize, lifecycle };
}

test("absent capability returns immediately and cleans up the reply listener", () => {
  const f = fixture();
  assert.equal(queryObservabilityCapability(f.events), undefined);
  assert.equal(f.listeners.get(OBSERVABILITY_CAPABILITY_REPLY)?.size, 0);
});
test("capability resolves in either initialization order and invalidates on teardown/restart", () => {
  for (const consumerFirst of [true, false]) {
    const f = fixture();
    if (consumerFirst) assert.equal(queryObservabilityCapability(f.events), undefined);
    f.initialize();
    assert.equal(queryObservabilityCapability(f.events)?.ready, true);
    f.lifecycle("session_start");
    const policy = queryObservabilityCapability(f.events)!;
    assert.equal(policy.ready, true);
    assert.equal(policy.sanitizeIntent("Inspect the source.").ok, true);
    assert.deepEqual(policy.redactRecovery({ text: "synthetic-secret" }), { text: "<REDACTED SERVICE_TOKEN VALUE>" });
    const cyclic: any = {}; cyclic.self = cyclic;
    assert.equal(policy.redactRecovery(cyclic), null);
    f.lifecycle("session_shutdown");
    assert.equal(policy.ready, false);
    assert.equal(policy.redactRecovery({ text: "synthetic-secret" }), null);
    assert.equal(queryObservabilityCapability(f.events), undefined);
    assert.equal(f.listeners.get(OBSERVABILITY_CAPABILITY_REQUEST)?.size, 0);
    f.lifecycle("session_start");
    assert.equal(queryObservabilityCapability(f.events)?.ready, true);
    assert.equal(policy.ready, false);
    assert.equal(policy.redactRecovery({ text: "synthetic-secret" }), null);
    assert.equal(f.listeners.get(OBSERVABILITY_CAPABILITY_REQUEST)?.size, 1);
  }
});
test("failed credential discovery reports unready and cannot redact recovery", () => {
  const f = fixture(true); f.initialize(); f.lifecycle("session_start");
  const policy = queryObservabilityCapability(f.events)!;
  assert.equal(policy.ready, false);
  assert.equal(policy.redactRecovery({ text: "synthetic-secret" }), null);
});
test("incompatible and malformed requests/replies do not grant capabilities; duplicates fail closed", () => {
  const f = fixture(); f.initialize(); f.lifecycle("session_start");
  let replies = 0;
  f.events.on(OBSERVABILITY_CAPABILITY_REPLY, () => { replies++; });
  for (const data of [null, {}, { version: 2, requestId: "x" }, { version: 1, requestId: 3 }]) {
    f.events.emit(OBSERVABILITY_CAPABILITY_REQUEST, data);
  }
  assert.equal(replies, 0);
  f.initialize(); f.lifecycle("session_start");
  assert.equal(queryObservabilityCapability(f.events), undefined);
  const absent = fixture();
  absent.events.on(OBSERVABILITY_CAPABILITY_REQUEST, (data: any) => {
    absent.events.emit(OBSERVABILITY_CAPABILITY_REPLY, { version: 2, requestId: data.requestId });
    absent.events.emit(OBSERVABILITY_CAPABILITY_REPLY, { version: 1, requestId: data.requestId, capability: {} });
  });
  assert.equal(queryObservabilityCapability(absent.events), undefined);
});
