import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIAL_KEY_FRAGMENTS = ["TOKEN", "API_KEY", "PASSWORD"] as const;

export interface CredentialDiscoveryOptions {
	envFilePath?: string;
	environment?: Readonly<Record<string, string | undefined>>;
	readFile?: (path: string) => string;
}

export interface CredentialReplacement {
	readonly key: string;
	readonly value: string;
	readonly marker: string;
}

function isCredentialKey(key: string): boolean {
	return CREDENTIAL_KEY_FRAGMENTS.some((fragment) => key.includes(fragment));
}

/**
 * Uses the assignment names in ~/.env as a credential registry without
 * evaluating the file. Effective values come only from the inherited process
 * environment. Duplicate values choose the lexicographically first key.
 */
export function discoverCredentialReplacements(
	options: CredentialDiscoveryOptions = {},
): readonly CredentialReplacement[] {
	const envFilePath = options.envFilePath ?? join(homedir(), ".env");
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const environment = options.environment ?? process.env;
	const contents = readFile(envFilePath);
	const declaredKeys = new Set<string>();

	for (const line of contents.split(/\r?\n/u)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
		if (match && isCredentialKey(match[1])) declaredKeys.add(match[1]);
	}

	const valueToKey = new Map<string, string>();
	for (const key of [...declaredKeys].sort()) {
		const value = environment[key];
		if (typeof value !== "string" || value.length === 0) continue;
		if (!valueToKey.has(value)) valueToKey.set(value, key);
	}

	return [...valueToKey.entries()]
		.map(([value, key]) => ({ key, value, marker: `<REDACTED ${key} VALUE>` }))
		.sort((left, right) => {
			const lengthOrder = right.value.length - left.value.length;
			if (lengthOrder !== 0) return lengthOrder;
			return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
		});
}

/** Replaces exact occurrences of every discovered credential value with its
 * marker, longest match first. Shared by provider-payload egress and the
 * audit-intent sanitizer so both redact against the same discovered set. */
export function redactString(value: string, replacements: readonly CredentialReplacement[]): string {
	if (value.length === 0 || replacements.length === 0) return value;
	let result = "";
	let cursor = 0;
	while (cursor < value.length) {
		const replacement = replacements.find((candidate) => value.startsWith(candidate.value, cursor));
		if (replacement) {
			result += replacement.marker;
			cursor += replacement.value.length;
			continue;
		}
		result += value[cursor];
		cursor += 1;
	}
	return result;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function redactValue(
	value: unknown,
	replacements: readonly CredentialReplacement[],
	ancestors: Set<object>,
): unknown {
	if (typeof value === "string") return redactString(value, replacements);
	if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) {
		return value;
	}
	if (typeof value !== "object") throw new Error("Unsupported provider payload scalar");
	if (ancestors.has(value)) throw new Error("Cyclic provider payload");
	if (!Array.isArray(value) && !isPlainRecord(value)) {
		throw new Error("Unsupported provider payload object");
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => redactValue(item, replacements, ancestors));
		}
		const redacted: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
		for (const [key, item] of Object.entries(value)) {
			Object.defineProperty(redacted, key, {
				value: redactValue(item, replacements, ancestors),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return redacted;
	} finally {
		ancestors.delete(value);
	}
}

/**
 * Returns a structurally separate payload with exact credential occurrences
 * replaced in every string value. Unsupported or cyclic object graphs throw so
 * the caller can substitute a credential-free blocking payload.
 */
export function redactProviderPayload(
	payload: unknown,
	replacements: readonly CredentialReplacement[],
): unknown {
	return redactValue(payload, replacements, new Set());
}
