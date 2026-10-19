import {
	OBSERVABILITY_CONTRACT_VERSION,
	TOOL_INTENT_ENTRY_TYPE,
	type ToolIntentEntryData,
} from "./contract.ts";
import { redactString, type CredentialReplacement } from "./egress-redaction.ts";

export const MAX_AUDIT_INTENT_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export type AuditIntentRejectionReason =
	| "missing"
	| "invalid_type"
	| "too_long"
	| "empty"
	| "redaction_unavailable"
	| "sanitized_too_long";

export type AuditIntentSanitizationResult =
	| { ok: true; value: string }
	| { ok: false; reason: AuditIntentRejectionReason };

/**
 * Sanitizes an audit intent for storage. The account is the security boundary:
 * the only content redaction is the exact credential-value replacement shared
 * with provider-egress redaction (same discovered set and implementation).
 * Basic text hygiene (control/BiDi stripping, whitespace normalization) runs
 * BEFORE the single shared redaction pass, so normalization cannot rejoin the
 * pieces of a credential after they were redacted; the stored-length and
 * nonempty checks then apply to the redacted value. Formatting is a model
 * instruction, not a syntax rule: apostrophes, quotes, URLs, backticks, and
 * Markdown pass through as plain text. `replacements === undefined` (failed
 * discovery) fails closed and is distinct from an explicitly empty set, which
 * is a valid registry with nothing to filter.
 */
export function sanitizeAuditIntentDetailed(
	value: unknown,
	present = true,
	replacements: readonly CredentialReplacement[] | undefined,
): AuditIntentSanitizationResult {
	if (!present) return { ok: false, reason: "missing" };
	if (typeof value !== "string") return { ok: false, reason: "invalid_type" };
	if (value.length > 4_000) return { ok: false, reason: "too_long" };
	if (replacements === undefined) return { ok: false, reason: "redaction_unavailable" };
	const sanitized = redactString(
		value.replace(CONTROL_OR_BIDI, "").replace(/\s+/g, " ").trim(),
		replacements,
	);
	if (!sanitized) return { ok: false, reason: "empty" };
	if (sanitized.length > MAX_AUDIT_INTENT_LENGTH) return { ok: false, reason: "sanitized_too_long" };
	return { ok: true, value: sanitized };
}

/**
 * Structural validity of persisted audit evidence: contract version, field
 * types, and basic intent text bounds (nonempty, stored cap). This deliberately
 * does NOT re-run the current pipeline: a credential replacement set can change
 * with rotation, and even a redaction marker can contain a registered value,
 * so equality after today's replacement would misclassify valid stored
 * evidence. Call identity/uniqueness is preserved by the call sites.
 */
export function isToolIntentData(value: unknown): value is ToolIntentEntryData {
	if (!isRecord(value)) return false;
	const intent = value.intent;
	return value.version === OBSERVABILITY_CONTRACT_VERSION
		&& typeof value.toolCallId === "string"
		&& typeof value.toolName === "string"
		&& typeof intent === "string"
		&& intent.length > 0
		&& intent.length <= MAX_AUDIT_INTENT_LENGTH
		&& typeof value.timestamp === "string";
}

export function findPersistedToolIntent(entries: readonly unknown[], toolCallId: string): ToolIntentEntryData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_INTENT_ENTRY_TYPE) continue;
		if (isToolIntentData(entry.data) && entry.data.toolCallId === toolCallId) return entry.data;
	}
	return undefined;
}
