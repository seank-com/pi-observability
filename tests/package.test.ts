import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(root, "node_modules/@earendil-works/pi-coding-agent");

test("actual tarball installs and loads alone through native ESM and the selected real Pi loader", { timeout: 60_000 }, async t => {
  const consumer = await mkdtemp(join(tmpdir(), "pi-observability-consumer-"));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const npmEnv = { ...process.env, npm_config_cache: join(consumer, "npm-cache") };
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], { cwd: root, env: npmEnv, encoding: "utf8", timeout: 30_000 }))[0];
  const paths = packed.files.map((file: { path: string }) => file.path);
  assert.ok(paths.includes("dist/index.js"));
  assert.ok(paths.includes("dist/contract.d.ts"));
  assert.ok(paths.every((path: string) => !path.includes("provider-adapter") && !path.includes("provider-history") && !path.includes("provider-tools")), "obsolete adapters must not ship");
  assert.ok(paths.every((path: string) => /^(dist\/[^/]+\.(js|d\.ts)|docs\/[^/]+\.md|README\.md|LICENSE|package\.json)$/.test(path)), paths.join("\n"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(consumer, packed.filename)], { cwd: consumer, env: npmEnv, stdio: "pipe", timeout: 30_000 });
  const manifest = JSON.parse(await readFile(join(consumer, "node_modules/@seank/pi-observability/package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  await writeFile(join(consumer, "types.ts"), `
import { queryObservabilityCapability, type ObservabilityPolicyCapability } from "@seank/pi-observability/contract";
import { sanitizeAuditIntentDetailed } from "@seank/pi-observability/intent";
import { redactProviderPayload, type CredentialReplacement } from "@seank/pi-observability/redaction";
const replacements: CredentialReplacement[] = [];
const policy: ObservabilityPolicyCapability = {version:1,ready:true,sanitizeIntent:sanitizeAuditIntentDetailed,redactRecovery:payload=>redactProviderPayload(payload,replacements)};
void policy; void queryObservabilityCapability;
`);
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2023", "types.ts"], { cwd: consumer, stdio: "pipe", timeout: 30_000 });
  await mkdir(join(consumer, "home"));
  await writeFile(join(consumer, "home/.env"), "SERVICE_TOKEN=registry-only\n");
  await writeFile(join(consumer, "probe.ts"), `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { queryObservabilityCapability } from "@seank/pi-observability/contract";
import { sanitizeAuditIntentDetailed } from "@seank/pi-observability/intent";
import { redactProviderPayload } from "@seank/pi-observability/redaction";
assert.equal(sanitizeAuditIntentDetailed("Inspect source.").ok, true);
assert.deepEqual(redactProviderPayload({text:"fixture"}, []), {text:"fixture"});
assert.equal(existsSync("node_modules/@earendil-works"), false);
assert.equal(existsSync("node_modules/@seank/pi-ollama-provider"), false);
const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/extensions/loader.js")).href);
const { createEventBus } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/event-bus.js")).href);
const bus = createEventBus();
const entry = join(process.cwd(), "node_modules/@seank/pi-observability/dist/index.js");
const loaded = await loadExtensions([entry], process.cwd(), bus);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const entries = [];
loaded.runtime.appendEntry = (customType, data) => { entries.push({type:"custom", customType, data}); };
const extension = loaded.extensions[0];
const invoke = async (name, event, ctx) => {
  let result;
  for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
};
assert.equal(queryObservabilityCapability(bus)?.ready, true);
await invoke("session_start", {}, {});
const policy = queryObservabilityCapability(bus)!;
assert.equal(policy.ready, true);
assert.deepEqual(policy.redactRecovery({text:"packed-secret"}), {text:"<REDACTED SERVICE_TOKEN VALUE>"});
const ctx = {sessionManager:{getBranch:()=>entries}};
const prepared = await invoke("context_with_system", {messages:[{role:"system",content:"Inspect",toolsAdded:[{name:"inspect",parameters:{type:"object",properties:{},required:[]}}],timestamp:0}]},ctx);
assert.ok(prepared.messages[0].toolsAdded[0].parameters.required.includes("intent"));
const result = await invoke("before_provider_request", {payload:{model:"fixture",store:false,stream:true,instructions:"Inspect",input:[{text:"packed-secret"}],tools:[{type:"function",name:"inspect",parameters:{type:"object",properties:{},required:[]}}]}}, ctx);
assert.equal(result.input[0].text, "<REDACTED SERVICE_TOKEN VALUE>");
assert.equal(result.tools[0].parameters.required.includes("intent"), false);
const finalized = await invoke("message_end", {message:{role:"assistant",content:[{type:"toolCall",id:"audited",name:"inspect",arguments:{intent:"Inspect the source."}}]}}, ctx);
assert.deepEqual(finalized.message.content[0].arguments, {});
assert.equal(entries.at(-1).customType, "tool-intent");
assert.equal(await invoke("tool_call", {toolCallId:"audited",toolName:"inspect",input:{}}, ctx), undefined);
const blocked = await invoke("tool_call", {toolCallId:"unaudited",toolName:"inspect",input:{}}, ctx);
assert.equal(blocked.block, true);
assert.equal(entries.at(-1).data.reason, "tool_call_id_mismatch");
await invoke("session_shutdown", {}, {});
assert.equal(policy.ready, false);
assert.equal(policy.redactRecovery({text:"packed-secret"}), null);
assert.equal(queryObservabilityCapability(bus), undefined);
clearExtensionCache();
const reloaded = await loadExtensions([entry], process.cwd(), bus);
assert.deepEqual(reloaded.errors, []);
assert.equal(reloaded.extensions.length, 1);
for (const handler of reloaded.extensions[0].handlers.get("session_start") ?? []) await handler({}, {});
assert.equal(queryObservabilityCapability(bus)?.ready, true);
assert.equal(policy.ready, false);
for (const handler of reloaded.extensions[0].handlers.get("session_shutdown") ?? []) await handler({}, {});
assert.equal(queryObservabilityCapability(bus), undefined);
// Prove a real consumer can resolve during session_start in both load orders.
const { writeFileSync } = await import("node:fs");
const consumerEntry = join(process.cwd(), "consumer.ts");
writeFileSync(consumerEntry, 'import { queryObservabilityCapability } from "@seank/pi-observability/contract"; export default function(pi) { pi.on("session_start", () => { const policy = queryObservabilityCapability(pi.events); pi.events.emit("fixture:ready", {ready: policy?.ready, redacted: policy?.redactRecovery({text:"packed-secret"})}); }); }');
for (const order of [[consumerEntry, entry], [entry, consumerEntry]]) {
  clearExtensionCache();
  const pair = await loadExtensions(order, process.cwd(), bus);
  assert.deepEqual(pair.errors, []);
  assert.equal(pair.extensions.length, 2);
  let observed;
  const unsubscribe = bus.on("fixture:ready", value => { observed = value; });
  for (const item of pair.extensions) for (const handler of item.handlers.get("session_start") ?? []) await handler({}, {});
  assert.deepEqual(observed, {ready:true,redacted:{text:"<REDACTED SERVICE_TOKEN VALUE>"}});
  for (const item of pair.extensions) for (const handler of item.handlers.get("session_shutdown") ?? []) await handler({}, {});
  unsubscribe();
  assert.equal(queryObservabilityCapability(bus), undefined);
}
`);
  execFileSync(process.execPath, [join(consumer, "probe.ts")], {
    cwd: consumer,
    env: { ...process.env, HOME: join(consumer, "home"), PI_CODING_AGENT_DIR: join(consumer, "profile"), TEST_PI_HOST: host, SERVICE_TOKEN: "packed-secret" },
    stdio: "pipe",
    timeout: 30_000,
  });
});
