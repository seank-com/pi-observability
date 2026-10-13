import { retryIntent, INTENT_RETRY_ENTRY_TYPE, RETRY_TIMEOUT_MS, RETRY_BUDGET_MS } from "./intent-retry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	discoverCredentialReplacements,
	redactProviderPayload,
	type CredentialDiscoveryOptions,
	type CredentialReplacement,
} from "./egress-redaction.ts";
import {
	findPersistedToolIntent,
	sanitizeAuditIntentDetailed,
	type AuditIntentRejectionReason,
} from "./intent.ts";
import { instrumentIntentContext, TOOL_INTENT_FIELD } from "./intent-context.ts";
import type { ProviderHistoryRehydrationSummary } from "./intent-history.ts";
import {
	OBSERVABILITY_CONTRACT_VERSION,
	OBSERVABILITY_CAPABILITY_REQUEST,
	OBSERVABILITY_CAPABILITY_REPLY,
	type ObservabilityCapabilityRequest,
	type ObservabilityPolicyCapability,
	TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE,
	TOOL_INTENT_ENTRY_TYPE,
	type ToolIntentDiagnosticEntryData,
	type ToolIntentDiagnosticReason,
	type ToolIntentEntryData,
} from "./contract.ts";

export interface ObservabilityExtensionOptions {
	now?: () => Date;
	intentRetry?: false | { requestTimeoutMs?: number; turnBudgetMs?: number };
	credentialDiscovery?: CredentialDiscoveryOptions;
	/** Privacy-safe test probe; receives no payload, arguments, IDs, or intent. */
	onProviderRequestDecorated?: (summary: ProviderHistoryRehydrationSummary & {
		boundary: "context_with_system";
		toolCount: number;
		intentRequired: true;
	}) => void;
}

interface PendingProviderRequest {
	readonly decoratedToolNames?: ReadonlySet<string>;
	readonly messages?: any[];
	readonly model?: any;
	egressConfirmed?: boolean;
}

interface FinalizedToolCall {
	readonly toolName: string;
	readonly reasons: readonly ToolIntentDiagnosticReason[];
}

// Codex response IDs use an internal pipe-separated form. Keep the alphabet
// narrow so diagnostic entries cannot become an arbitrary text channel.
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9_|-]{1,128}$/;
export const MAX_PENDING_PROVIDER_REQUESTS = 32;

const sanitizerReason: Record<AuditIntentRejectionReason, ToolIntentDiagnosticReason> = {
	missing: "provider_intent_missing",
	invalid_type: "provider_intent_invalid_type",
	too_long: "provider_intent_too_long",
	empty: "provider_intent_empty",
	shell_syntax: "provider_intent_shell_syntax",
	option: "provider_intent_option",
	path: "provider_intent_path",
	sanitized_too_long: "provider_intent_sanitized_too_long",
};

const INTENT_PROSE_RULE = "intent must be one short prose sentence stating the purpose, without file paths, command options, URLs, or shell syntax";
const UNVERIFIED_REQUEST_RULE = "this call did not come from a provider request that required intent, so it cannot be audited or run";
const UNVERIFIED_AUDIT_RULE = "the audit record for this call could not be verified; retry the call with a new required intent argument";

/**
 * Model-facing block text. It names the rejection class in plain words so the
 * model can self-correct, and never echoes the rejected intent or arguments.
 */
const blockExplanation: Record<ToolIntentDiagnosticReason, string> = {
	provider_intent_missing: `every tool call must include the required intent argument; ${INTENT_PROSE_RULE}`,
	provider_intent_invalid_type: `intent must be a string; ${INTENT_PROSE_RULE}`,
	provider_intent_too_long: `intent is too long; ${INTENT_PROSE_RULE}`,
	provider_intent_empty: `intent is empty; ${INTENT_PROSE_RULE}`,
	provider_intent_shell_syntax: `intent contains shell syntax; ${INTENT_PROSE_RULE}`,
	provider_intent_option: `intent contains a command option; ${INTENT_PROSE_RULE}`,
	provider_intent_path: `intent contains a file path; ${INTENT_PROSE_RULE}`,
	provider_intent_sanitized_too_long: `intent is too long; ${INTENT_PROSE_RULE}`,
	response_without_request: UNVERIFIED_REQUEST_RULE,
	request_correlation_ambiguous: UNVERIFIED_REQUEST_RULE,
	request_correlation_overflow: UNVERIFIED_REQUEST_RULE,
	response_undecorated: UNVERIFIED_REQUEST_RULE,
	response_tool_not_decorated: UNVERIFIED_REQUEST_RULE,
	tool_call_id_invalid: UNVERIFIED_AUDIT_RULE,
	tool_call_id_duplicate: UNVERIFIED_AUDIT_RULE,
	tool_call_id_mismatch: UNVERIFIED_AUDIT_RULE,
	tool_name_mismatch: UNVERIFIED_AUDIT_RULE,
	audit_not_visible: UNVERIFIED_AUDIT_RULE,
	audit_tool_name_mismatch: UNVERIFIED_AUDIT_RULE,
};

export function toolExecutionBlockReason(reason: ToolIntentDiagnosticReason): string {
	return `Tool execution blocked: ${blockExplanation[reason]} (${reason}).`;
}

/**
 * Adds one transport-only intent field to normalized request tool declarations.
 * No tool is wrapped or re-registered: finalized assistant calls are copied
 * without the synthetic field before Pi performs ordinary argument validation.
 */
export function createObservabilityExtension(options: ObservabilityExtensionOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const now = options.now ?? (() => new Date());
		// All service prerequisites are synchronous. Ready at initialization so a
		// consumer's session_start can query before our own lifecycle handler.
		let sessionReady = true;
		let capabilityGeneration = 0;
		let credentialReplacements: readonly CredentialReplacement[] | undefined;
		try {
			credentialReplacements = discoverCredentialReplacements(options.credentialDiscovery);
		} catch {
			// Discovery is an egress prerequisite. The request hook substitutes null
			// rather than throwing because Pi 0.85.1 swallows hook exceptions and
			// otherwise continues with the unredacted current payload.
			credentialReplacements = undefined;
		}
		const createPolicy = (): ObservabilityPolicyCapability => {
			const generation = capabilityGeneration;
			const capability: ObservabilityPolicyCapability = {
				version: 1,
				get ready() { return sessionReady && generation === capabilityGeneration && credentialReplacements !== undefined; },
				sanitizeIntent: sanitizeAuditIntentDetailed,
				redactRecovery(payload) {
					if (!capability.ready || !credentialReplacements) return null;
					try { return redactProviderPayload(payload, credentialReplacements); }
					catch { return null; }
				},
			};
			return capability;
		};
		let policy = createPolicy();
		const subscribeCapability = () => pi.events.on(OBSERVABILITY_CAPABILITY_REQUEST, (data) => {
			const request = data as Partial<ObservabilityCapabilityRequest> | null;
			if (!request || request.version !== 1 || typeof request.requestId !== "string" || request.requestId.length > 128) return;
			pi.events.emit(OBSERVABILITY_CAPABILITY_REPLY, { version: 1, requestId: request.requestId, capability: policy });
		});
		let unsubscribeCapability: (() => void) | undefined = subscribeCapability();
		pi.on("session_start", () => {
			if (!sessionReady) {
				capabilityGeneration++;
				policy = createPolicy();
			}
			unsubscribeCapability ??= subscribeCapability();
			sessionReady = true;
		});
		pi.on("session_shutdown", () => {
			sessionReady = false;
			capabilityGeneration++;
			unsubscribeCapability?.();
			unsubscribeCapability = undefined;
		});
		// Each provider request owns an immutable decoration snapshot. Pi normally
		// has one request in flight; overlapping responses are trusted only when
		// their tool-name set identifies exactly one decorated request.
		let generation = 0;
		let retryLifecycle = new AbortController();
		const pendingProviderRequests: PendingProviderRequest[] = [];
		const finalizedToolCalls = new Map<string, FinalizedToolCall>();
		let correlationPoison: "request_correlation_ambiguous" | "request_correlation_overflow" | undefined;

		const resetRequestCorrelation = (): void => {
			generation++;
			retryLifecycle.abort();
			retryLifecycle = new AbortController();
			pendingProviderRequests.splice(0);
			finalizedToolCalls.clear();
			correlationPoison = undefined;
		};

		const recordProviderRequest = (request: PendingProviderRequest): void => {
			if (correlationPoison) return;
			if (pendingProviderRequests.length >= MAX_PENDING_PROVIDER_REQUESTS) {
				pendingProviderRequests.splice(0);
				correlationPoison = "request_correlation_overflow";
				return;
			}
			pendingProviderRequests.push(request);
		};

		const appendDiagnostic = (reason: ToolIntentDiagnosticReason): void => {
			const data: ToolIntentDiagnosticEntryData = {
				version: OBSERVABILITY_CONTRACT_VERSION,
				reason,
				timestamp: now().toISOString(),
			};
			pi.appendEntry(TOOL_INTENT_DIAGNOSTIC_ENTRY_TYPE, data);
		};

		pi.on("agent_start", resetRequestCorrelation);
		pi.on("agent_settled", resetRequestCorrelation);
		pi.on("session_shutdown", resetRequestCorrelation);

		pi.on("context_with_system", (event, ctx) => {
			try {
				if (!credentialReplacements || !sessionReady) throw new Error("Observability unavailable");
				const { messages, activeNames, history } = instrumentIntentContext(event.messages, ctx.sessionManager.getBranch());
				options.onProviderRequestDecorated?.({ boundary: "context_with_system", toolCount: activeNames.size, intentRequired: true, ...history });
				recordProviderRequest({ decoratedToolNames: new Set(activeNames), messages: structuredClone(messages), model: ctx.model });
				return { messages: messages as typeof event.messages };
			} catch {
				// Pi catches context-hook errors. Record the failed attempt explicitly;
				// neither partial changes nor trust from an earlier attempt may survive.
				recordProviderRequest({});
				return { messages: event.messages };
			}
		});

		pi.on("before_provider_request", (event) => {
			// No provider shape inspection. Confirm exactly one awaiting context.
			// Extra requests (e.g. summaries) cannot borrow an already confirmed one.
			const awaiting = pendingProviderRequests.filter(request => !request.egressConfirmed);
			let request: PendingProviderRequest;
			if (awaiting.length === 1) request = awaiting[0];
			else {
				request = {};
				if (awaiting.length > 1) {
					pendingProviderRequests.splice(0);
					correlationPoison = "request_correlation_ambiguous";
				} else recordProviderRequest(request);
			}
			request.egressConfirmed = true;
			try {
				if (!credentialReplacements || !sessionReady) throw new Error("Redaction unavailable");
				return redactProviderPayload(event.payload, credentialReplacements);
			} catch {
				// Retain overlap uncertainty even if the failed request clears state.
				if (pendingProviderRequests.length > 1) correlationPoison = "request_correlation_ambiguous";
				pendingProviderRequests.splice(0);
				recordProviderRequest({ egressConfirmed: true });
				return null;
			}
		});

		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
			const responseToolNames = event.message.content
				.filter((part) => part.type === "toolCall")
				.map((part) => part.name);
			let request: PendingProviderRequest | undefined;
			let correlationFailure: ToolIntentDiagnosticReason | undefined = correlationPoison;
			if (correlationPoison) {
				// Stay poisoned until the agent run settles. An abandoned response may
				// still arrive, so trusting a later snapshot would not be fail-closed.
			} else if (pendingProviderRequests.length <= 1 || responseToolNames.length === 0) {
				request = pendingProviderRequests.shift();
			} else if (pendingProviderRequests.every((candidate) => candidate.decoratedToolNames && candidate.egressConfirmed)) {
				const candidates = pendingProviderRequests
					.map((candidate, index) => ({ candidate, index }))
					.filter(({ candidate }) => responseToolNames.every((name) => candidate.decoratedToolNames!.has(name)));
				if (candidates.length === 1) {
					request = pendingProviderRequests.splice(candidates[0].index, 1)[0];
				} else {
					// No provider request ID is exposed by Pi. If immutable snapshots do not
					// uniquely identify an overlapping response, discard all correlation
					// rather than attributing trust by guesswork.
					pendingProviderRequests.splice(0);
					correlationPoison = "request_correlation_ambiguous";
					correlationFailure = correlationPoison;
				}
			} else {
				pendingProviderRequests.splice(0);
				correlationPoison = "request_correlation_ambiguous";
				correlationFailure = correlationPoison;
			}
			const idCounts = new Map<string, number>();
			for (const part of event.message.content) {
				if (part.type === "toolCall" && typeof part.id === "string") {
					idCounts.set(part.id, (idCounts.get(part.id) ?? 0) + 1);
				}
			}
			const finalize = (message: typeof event.message) => {
				let changed = false;
				const content = message.content.map((part) => {
					if (part.type !== "toolCall") return part;
					const args = part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
						? part.arguments
						: {};
					const hasIntent = Object.prototype.hasOwnProperty.call(args, TOOL_INTENT_FIELD);
					const intentResult = sanitizeAuditIntentDetailed(args[TOOL_INTENT_FIELD], hasIntent);
					const reasons: ToolIntentDiagnosticReason[] = [];

					if (correlationFailure) reasons.push(correlationFailure);
					else if (!request) reasons.push("response_without_request");
					else if (!request.decoratedToolNames || !request.egressConfirmed) reasons.push("response_undecorated");
					else if (!request.decoratedToolNames.has(part.name)) reasons.push("response_tool_not_decorated");
					if (typeof part.id !== "string" || !SAFE_TOOL_CALL_ID.test(part.id)) reasons.push("tool_call_id_invalid");
					else if (idCounts.get(part.id) !== 1) reasons.push("tool_call_id_duplicate");
					if (intentResult.ok === false) reasons.push(sanitizerReason[intentResult.reason]);

					if (reasons.length === 0 && intentResult.ok) {
						const data: ToolIntentEntryData = {
							version: OBSERVABILITY_CONTRACT_VERSION,
							toolCallId: part.id,
							toolName: part.name,
							intent: intentResult.value,
							timestamp: now().toISOString(),
						};
						pi.appendEntry(TOOL_INTENT_ENTRY_TYPE, data);
					} else {
						for (const reason of reasons) appendDiagnostic(reason);
					}

					if (typeof part.id === "string") {
						// Raw IDs stay in memory only. This lets the execution gate report an
						// invalid-ID reason without persisting an unsafe identifier.
						finalizedToolCalls.set(part.id, { toolName: part.name, reasons });
					}
					if (!hasIntent) return part;
					changed = true;
					const strippedArguments = { ...args };
					delete strippedArguments[TOOL_INTENT_FIELD];
					return { ...part, arguments: strippedArguments };
				});
				if (changed) return { message: { ...message, content } };
			};
			const eligible = event.message.content.filter(part =>
				part.type === "toolCall" && part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
				&& !Object.hasOwn(part.arguments, TOOL_INTENT_FIELD) && SAFE_TOOL_CALL_ID.test(part.id)
				&& idCounts.get(part.id) === 1 && request?.decoratedToolNames?.has(part.name));
			if (options.intentRetry === false || correlationFailure || !request?.egressConfirmed || !request.messages || !eligible.length || event.message.stopReason !== "toolUse") return finalize(event.message);
			const ownedRequest = request;
			const epoch = generation;
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, retryLifecycle.signal]) : retryLifecycle.signal;
			const message = structuredClone(event.message);
			return (async () => {
				const settings = options.intentRetry || {};
				const deadline = Date.now() + (settings.turnBudgetMs ?? RETRY_BUDGET_MS);
				for (const part of message.content) {
					if (part.type !== "toolCall" || !eligible.some(call => call.type === "toolCall" && call.id === part.id)) continue;
					const started = Date.now();
					const result = started >= deadline ? { reason: "timeout" } : await retryIntent(
						part, ownedRequest.messages!,
						{ model: ownedRequest.model, modelRegistry: ctx.modelRegistry, thinkingLevel: ctx.thinkingLevel },
						signal, payload => policy.redactRecovery(payload),
						Math.min(settings.requestTimeoutMs ?? RETRY_TIMEOUT_MS, deadline - started));
					if (signal.aborted || epoch !== generation || !sessionReady) return;
					pi.appendEntry(INTENT_RETRY_ENTRY_TYPE, {
						version: 1, toolCallId: part.id, toolName: part.name, outcome: result.intent ? "accepted" : "rejected",
						reason: result.reason, latencyMs: Date.now() - started, usage: result.usage, timestamp: now().toISOString(),
					});
					if (result.intent) part.arguments = { ...part.arguments, intent: result.intent };
				}
				return finalize(message);
			})();
		});

		pi.on("tool_call", (event, ctx) => {
			// Defense in depth for synthetic or third-party events. Normal calls were
			// already stripped at message_end, before Pi's argument validation.
			if (event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
				delete (event.input as Record<string, unknown>)[TOOL_INTENT_FIELD];
			}
			const finalized = finalizedToolCalls.get(event.toolCallId);
			finalizedToolCalls.delete(event.toolCallId);
			let reason: ToolIntentDiagnosticReason | undefined;
			if (!finalized) reason = "tool_call_id_mismatch";
			else if (finalized.toolName !== event.toolName) reason = "tool_name_mismatch";
			else if (finalized.reasons.length > 0) reason = finalized.reasons[0];
			else {
				const persisted = findPersistedToolIntent(ctx.sessionManager.getBranch(), event.toolCallId);
				if (!persisted) reason = "audit_not_visible";
				else if (persisted.toolName !== event.toolName) reason = "audit_tool_name_mismatch";
			}
			if (reason) {
				if (!finalized || finalized.reasons.length === 0) {
					appendDiagnostic(reason);
				}
				return {
					block: true,
					reason: toolExecutionBlockReason(reason),
				};
			}
		});
	};
}

export default createObservabilityExtension();
