import { isDeepStrictEqual } from "node:util";
import { sanitizeAuditIntentDetailed } from "./intent.ts";

export const INTENT_RETRY_ENTRY_TYPE = "tool-intent-retry";
export const INTENT_RETRY_PROMPT = "Your previous tool call omitted the required intent argument. Repeat exactly the same tool call once, adding only intent: a single plain sentence describing its purpose without argument values, paths, or executable syntax. Do not change the tool name or any other arguments. Return exactly one tool call, not a prose explanation.";
export const RETRY_TIMEOUT_MS = 120_000;
export const RETRY_BUDGET_MS = 240_000;
export interface RetryCall { id: string; name: string; arguments: Record<string, unknown> }
export interface RetryResult { intent?: string; reason?: string; usage?: unknown }

/** The auxiliary completion never enters the agent loop or executes tools. */
export async function retryIntent(call: RetryCall, messages: any[], ctx: any, signal: AbortSignal,
    redact: (payload: unknown) => unknown, timeoutMs: number): Promise<RetryResult> {
    if (!ctx.model || !ctx.modelRegistry?.streamSimple || signal.aborted) return { reason: "unavailable" };
    let tool: any;
    for (const message of messages) {
        if (message.role !== "system") continue;
        if (message.toolsRemoved?.some((item: any) => item.name === call.name)) tool = undefined;
        tool = message.toolsAdded?.find((item: any) => item.name === call.name) ?? tool;
    }
    if (!tool) return { reason: "unavailable" };
    const held = structuredClone(call);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, Math.max(0, timeoutMs));
    let checkedEgress = false;
    let oversized = false;
    try {
        const task = messages.findLast(message => message.role === "user")?.content ?? "";
        const context = { messages: [
            { role: "system", content: INTENT_RETRY_PROMPT, toolsAdded: [structuredClone(tool)], timestamp: Date.now() },
            { role: "user", content: JSON.stringify({ task, previousToolCall: { name: held.name, arguments: held.arguments } }), timestamp: Date.now() },
        ] };
        const aborted = new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            if (controller.signal.aborted) reject(new Error("cancelled"));
        });
        aborted.catch(() => undefined); // Also observe abort if stream creation throws synchronously.
        const stream = ctx.modelRegistry.streamSimple(ctx.model, context, {
            signal: controller.signal, reasoning: ctx.thinkingLevel, maxRetries: 0,
            onPayload(payload: unknown) {
                if (controller.signal.aborted) throw new Error("cancelled");
                const result = redact(payload);
                if (!result || typeof result !== "object") throw new Error("redaction_unavailable");
                checkedEgress = true;
                return result;
            },
        });
        const completion = (async () => {
            if (stream[Symbol.asyncIterator]) {
                for await (const event of stream) {
                    const partial = event.partial ?? event.message ?? event.error;
                    if (partial && Buffer.byteLength(JSON.stringify(partial)) > 1024 * 1024) {
                        oversized = true;
                        controller.abort();
                        throw new Error("too_large");
                    }
                    if (controller.signal.aborted) throw new Error("cancelled");
                }
            }
            return stream.result();
        })();
        const answer: any = await Promise.race([completion, aborted]);
        if (controller.signal.aborted) return { reason: signal.aborted ? "cancelled" : "timeout" };
        if (!checkedEgress) return { reason: "egress_unverified" };
        if (Buffer.byteLength(JSON.stringify(answer)) > 1024 * 1024) return { reason: "too_large" };
        const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
        const usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, count(answer.usage?.[key])]));
        if (answer.stopReason !== "toolUse" || !Array.isArray(answer.content)) return { reason: "not_tool_call", usage };
        const calls = answer.content.filter((part: any) => part.type === "toolCall");
        if (calls.length !== 1) return { reason: "call_count", usage };
        const repeated = calls[0];
        const args = repeated.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args)) return { reason: "arguments_invalid", usage };
        const { intent, ...ordinary } = args;
        if (repeated.name !== held.name || !isDeepStrictEqual(ordinary, held.arguments) || !isDeepStrictEqual(call, held)) return { reason: "call_changed", usage };
        const valid = sanitizeAuditIntentDetailed(intent, Object.hasOwn(args, "intent"));
        return valid.ok ? { intent: valid.value, usage } : { reason: `intent_${valid.reason}`, usage };
    } catch {
        return { reason: oversized ? "too_large" : controller.signal.aborted ? (signal.aborted ? "cancelled" : "timeout") : "request_failed" };
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
    }
}
