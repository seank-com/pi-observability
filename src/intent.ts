import {
	OBSERVABILITY_CONTRACT_VERSION,
	TOOL_INTENT_ENTRY_TYPE,
	type ToolIntentEntryData,
} from "./contract.ts";

export const MAX_AUDIT_INTENT_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SECRET_ASSIGNMENT = /\b(token|secret|password|passwd|credential|cookie|authorization|api[-_ ]?key)\s*(?::|=|\bis\b)\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const BEARER_SECRET = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COMMON_TOKEN = /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}\b/gi;
const TELEGRAM_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;
const URL_TEXT = /https?:\/\/[^\s<>"']+/gi;
const SHELL_SYNTAX = /[`$\\|;<>]|&&/m;
const OPTION_TOKEN = /(?:^|\s)--?[A-Za-z0-9]/m;
const RAW_PATH = /(?:^|\s)(?:~\/|\/(?!\s))/m;

export type AuditIntentRejectionReason =
	| "missing"
	| "invalid_type"
	| "too_long"
	| "empty"
	| "shell_syntax"
	| "option"
	| "path"
	| "sanitized_too_long";

export type AuditIntentSanitizationResult =
	| { ok: true; value: string }
	| { ok: false; reason: AuditIntentRejectionReason };

function redactUrlText(raw: string): string {
	const trailing = raw.match(/[),.;!?]+$/)?.[0] ?? "";
	return `[redacted-url]${trailing}`;
}

const QUOTE_WORD_CHAR = /\p{L}|\p{N}/u;
const MAX_QUOTED_DETAIL_CONTENT = 200;
const DOUBLE_QUOTED_DETAIL = /"[^"\r\n]{1,200}"/g;

/** True when the Unicode code point immediately before `index` is a letter or digit. */
function wordCharBefore(text: string, index: number): boolean {
	if (index <= 0) return false;
	const unit = text.charCodeAt(index - 1);
	if (unit >= 0xdc00 && unit <= 0xdfff && text.charCodeAt(index - 2) >= 0xd800 && text.charCodeAt(index - 2) <= 0xdbff)
		return QUOTE_WORD_CHAR.test(String.fromCodePoint((text.charCodeAt(index - 2) - 0xd800) * 0x400 + unit - 0xdc00 + 0x10000));
	return QUOTE_WORD_CHAR.test(String.fromCharCode(unit));
}

/** True when the Unicode code point at or after `index` is a letter or digit. */
function wordCharAfter(text: string, index: number): boolean {
	if (index >= text.length) return false;
	const unit = text.charCodeAt(index);
	if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff)
		return QUOTE_WORD_CHAR.test(String.fromCodePoint((unit - 0xd800) * 0x400 + text.charCodeAt(index + 1) - 0xdc00 + 0x10000));
	return QUOTE_WORD_CHAR.test(String.fromCharCode(unit));
}

/** Redacts `'...'` spans. An apostrophe counts as a quote delimiter only when
 * it actually quotes: the opening `'` is not preceded by a letter or digit and
 * the closing `'` is not followed by one (checked per Unicode code point, so
 * supplementary-plane letters behave like any other), keeping possessives and
 * contractions (`Alice's`, `isn't`, `teams'`, `\u{10400}'s`) intact. Content is
 * 1-200 characters and cannot cross CR/LF. Idempotent: the replacement text
 * contains no quote characters. */
function redactSingleQuotedDetail(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === "'" && !wordCharBefore(text, index)) {
			let close = -1;
			for (let probe = index + 1; probe < text.length; probe++) {
				const unit = text[probe];
				if (unit === "\r" || unit === "\n" || probe - index > MAX_QUOTED_DETAIL_CONTENT) break;
				if (unit === "'" && !wordCharAfter(text, probe + 1)) { close = probe; break; }
			}
			if (close !== -1) {
				output += "[redacted-detail]";
				index = close + 1;
				continue;
			}
		}
		output += char;
		index++;
	}
	return output;
}

/** Classifies rejection without retaining or reporting the rejected content. */
export function sanitizeAuditIntentDetailed(
	value: unknown,
	present = true,
): AuditIntentSanitizationResult {
	if (!present) return { ok: false, reason: "missing" };
	if (typeof value !== "string") return { ok: false, reason: "invalid_type" };
	if (value.length > 4_000) return { ok: false, reason: "too_long" };
	const withoutUrls = value.replace(URL_TEXT, redactUrlText);
	// Intent is prose, never a second argument channel. Tool/command names and
	// filename basenames are fine; executable shell syntax, options, and raw paths
	// invalidate it instead of being guessed or partially retained.
	if (SHELL_SYNTAX.test(withoutUrls)) return { ok: false, reason: "shell_syntax" };
	if (OPTION_TOKEN.test(withoutUrls)) return { ok: false, reason: "option" };
	if (RAW_PATH.test(withoutUrls)) return { ok: false, reason: "path" };
	const quoted = withoutUrls
		.replace(CONTROL_OR_BIDI, "")
		.replace(SECRET_ASSIGNMENT, "$1=[redacted]")
		.replace(BEARER_SECRET, "Bearer [redacted]")
		.replace(COMMON_TOKEN, "[redacted]")
		.replace(TELEGRAM_TOKEN, "[redacted]")
		.replace(OPAQUE_TOKEN, "[redacted]")
		// Double-quoted detail keeps its exact pre-existing matching behavior
		// (including empty/adjacent quote cases), so it stays the original regex.
		.replace(DOUBLE_QUOTED_DETAIL, "[redacted-detail]");
	const sanitized = redactSingleQuotedDetail(quoted)
		.replace(/\s+/g, " ")
		.trim();
	if (!sanitized) return { ok: false, reason: "empty" };
	if (sanitized.length > MAX_AUDIT_INTENT_LENGTH) return { ok: false, reason: "sanitized_too_long" };
	return { ok: true, value: sanitized };
}

/** Returns a complete, bounded, redacted audit value or undefined to fail closed. */
export function sanitizeAuditIntent(value: unknown): string | undefined {
	const result = sanitizeAuditIntentDetailed(value);
	return result.ok ? result.value : undefined;
}

function isToolIntentData(value: unknown): value is ToolIntentEntryData {
	if (!isRecord(value)) return false;
	return value.version === OBSERVABILITY_CONTRACT_VERSION
		&& typeof value.toolCallId === "string"
		&& typeof value.toolName === "string"
		&& typeof value.intent === "string"
		&& typeof value.timestamp === "string"
		&& sanitizeAuditIntent(value.intent) === value.intent;
}

export function findPersistedToolIntent(entries: readonly unknown[], toolCallId: string): ToolIntentEntryData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_INTENT_ENTRY_TYPE) continue;
		if (isToolIntentData(entry.data) && entry.data.toolCallId === toolCallId) return entry.data;
	}
	return undefined;
}
