/** Stable, implementation-free contract shared by observability producers and consumers. */
export const OBSERVABILITY_CONTRACT_VERSION = 1 as const;
export const TOOL_INTENT_ENTRY_TYPE = "tool-intent";
export const TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE = "tool-intent-diagnostic";
/** The tool-call argument that carries the audit intent. */
export const TOOL_INTENT_ARGUMENT = "intent" as const;

/** In-process request/reply identifiers. Functions are capabilities, not wire JSON. */
export const OBSERVABILITY_CAPABILITY_REQUEST = "pi-observability:v1:capability-request";
export const OBSERVABILITY_CAPABILITY_REPLY = "pi-observability:v1:capability-reply";
export interface ObservabilityPolicyCapability {
	version: 1;
	ready: boolean;
	sanitizeIntent: typeof import("./intent.js").sanitizeAuditIntentDetailed;
	/** Returns null after teardown or when credential discovery failed. */
	redactRecovery: (payload: unknown) => unknown;
}
export interface ObservabilityCapabilityRequest { version: 1; requestId: string }
export interface ObservabilityCapabilityReply {
	version: 1;
	requestId: string;
	capability: ObservabilityPolicyCapability;
}
interface CapabilityBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Pi's bus is synchronous: absence is determined before this function returns. */
export function queryObservabilityCapability(bus: CapabilityBus): ObservabilityPolicyCapability | undefined {
	const requestId = globalThis.crypto.randomUUID();
	let result: ObservabilityPolicyCapability | undefined;
	let replies = 0;
	const unsubscribe = bus.on(OBSERVABILITY_CAPABILITY_REPLY, (data) => {
		const reply = data as Partial<ObservabilityCapabilityReply> | null;
		if (!reply || reply.requestId !== requestId || reply.version !== 1) return;
		const capability = reply.capability;
		if (!capability || capability.version !== 1 || typeof capability.ready !== "boolean"
			|| typeof capability.sanitizeIntent !== "function" || typeof capability.redactRecovery !== "function") return;
		replies++;
		result = capability;
	});
	try {
		bus.emit(OBSERVABILITY_CAPABILITY_REQUEST, { version: 1, requestId } satisfies ObservabilityCapabilityRequest);
	} finally { unsubscribe(); }
	return replies === 1 ? result : undefined;
}

export type ToolIntentDiagnosticReason =
	| "provider_intent_missing"
	| "provider_intent_invalid_type"
	| "provider_intent_too_long"
	| "provider_intent_empty"
	| "provider_intent_shell_syntax"
	| "provider_intent_option"
	| "provider_intent_path"
	| "provider_intent_sanitized_too_long"
	| "response_without_request"
	| "request_correlation_ambiguous"
	| "request_correlation_overflow"
	| "response_undecorated"
	| "response_tool_not_decorated"
	| "tool_call_id_invalid"
	| "tool_call_id_duplicate"
	| "tool_call_id_mismatch"
	| "tool_name_mismatch"
	| "audit_not_visible"
	| "audit_tool_name_mismatch";

export interface ToolIntentEntryData {
	version: typeof OBSERVABILITY_CONTRACT_VERSION;
	toolCallId: string;
	toolName: string;
	intent: string;
	timestamp: string;
}

/** Contains structural reason data only; never raw intent or tool arguments. */
export interface ToolIntentDiagnosticEntryData {
	version: typeof OBSERVABILITY_CONTRACT_VERSION;
	reason: ToolIntentDiagnosticReason;
	timestamp: string;
}
