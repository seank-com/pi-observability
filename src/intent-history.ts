import { isToolIntentData } from "./intent.ts";
import { OBSERVABILITY_CONTRACT_VERSION, TOOL_INTENT_ENTRY_TYPE, type ToolIntentEntryData } from "./contract.ts";
export interface ProviderHistoryRehydrationSummary {
    functionCalls: number;
    rehydrated: number;
    missingAudit: number;
    invalidAudit: number;
    ambiguousAudit: number;
    unsafeShape: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
interface HistoricalCall {
    toolName: string;
    count: number;
}
interface AuditCandidates {
    valid: ToolIntentEntryData[];
    invalidCount: number;
}
function collectHistoricalCalls(entries: readonly unknown[]): Map<string, HistoricalCall> {
    const calls = new Map<string, HistoricalCall>();
    for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message))
            continue;
        const message = entry.message;
        if (message.role !== "assistant" || !Array.isArray(message.content))
            continue;
        for (const part of message.content) {
            if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string")
                continue;
            const previous = calls.get(part.id);
            calls.set(part.id, {
                toolName: previous ? (previous.toolName === part.name ? part.name : "") : part.name,
                count: (previous?.count ?? 0) + 1,
            });
        }
    }
    return calls;
}
function collectAudits(entries: readonly unknown[]): Map<string, AuditCandidates> {
    const audits = new Map<string, AuditCandidates>();
    for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_INTENT_ENTRY_TYPE)
            continue;
        const data = entry.data;
        const id = isRecord(data) && typeof data.toolCallId === "string" ? data.toolCallId : undefined;
        if (!id)
            continue;
        const candidates = audits.get(id) ?? { valid: [], invalidCount: 0 };
        if (isToolIntentData(data))
            candidates.valid.push(data);
        else
            candidates.invalidCount += 1;
        audits.set(id, candidates);
    }
    return audits;
}
/** Restore audited intent only into request-local normalized assistant calls.
 * Validity is structural (see isToolIntentData): stored evidence is never
 * revalidated against today's credential replacement set. Restored copies
 * enter the provider path and are protected by the existing egress redaction. */
export function rehydrateToolIntentHistory(messages: Record<string, unknown>[], branchEntries: readonly unknown[]): ProviderHistoryRehydrationSummary {
    const summary = { functionCalls: 0, rehydrated: 0, missingAudit: 0, invalidAudit: 0, ambiguousAudit: 0, unsafeShape: 0 };
    const historicalCalls = collectHistoricalCalls(branchEntries);
    const audits = collectAudits(branchEntries);
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content))
            continue;
        message.content = message.content.map((part: unknown) => {
            if (!isRecord(part) || part.type !== "toolCall")
                return part;
            summary.functionCalls++;
            if (typeof part.id !== "string" || typeof part.name !== "string" || !isRecord(part.arguments) || Object.hasOwn(part.arguments, "intent")) {
                summary.unsafeShape++;
                return part;
            }
            const call = historicalCalls.get(part.id), candidates = audits.get(part.id);
            if (!call || call.count !== 1 || call.toolName !== part.name) {
                summary.ambiguousAudit++;
                return part;
            }
            if (!candidates) {
                summary.missingAudit++;
                return part;
            }
            if (candidates.valid.length === 0) {
                summary.invalidAudit++;
                return part;
            }
            if (candidates.valid.length !== 1 || candidates.invalidCount > 0 || candidates.valid[0].toolName !== part.name) {
                summary.ambiguousAudit++;
                return part;
            }
            summary.rehydrated++;
            return { ...part, arguments: { ...part.arguments, intent: candidates.valid[0].intent } };
        });
    }
    return summary;
}
