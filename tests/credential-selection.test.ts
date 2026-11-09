import assert from "node:assert/strict";
import test from "node:test";
import { discoverCredentialReplacements } from "../src/egress-redaction.ts";
import { parseSecretValues } from "../scripts/check-private-terms.ts";

test("publication and provider egress select the same nonempty credential names without a length cutoff", () => {
	const text = [
		'export SERVICE_TOKEN="synthetic-token-value"',
		"DB_PASSWORD='q7!'",
		"SERVICE_API_KEY=x",
		"TOKEN_COUNT=0",
		"EMPTY_PASSWORD=''",
		"OTHER=long-noncredential-value",
		"lower_token=long-lowercase-value",
	].join("\n");
	const environment = {
		SERVICE_TOKEN: "synthetic-token-value",
		DB_PASSWORD: "q7!",
		SERVICE_API_KEY: "x",
		TOKEN_COUNT: "0",
		EMPTY_PASSWORD: "",
		OTHER: "long-noncredential-value",
		lower_token: "long-lowercase-value",
	};
	const published = parseSecretValues(text, "env").map(term => [term.label.slice(4), term.value]);
	const outgoing = discoverCredentialReplacements({ readFile: () => text, environment }).map(term => [term.key, term.value]);
	const sorted = (entries: string[][]) => entries.sort((a, b) => a[0]!.localeCompare(b[0]!));
	assert.deepEqual(sorted(published), sorted(outgoing));
	assert.deepEqual(published.map(entry => entry[0]).sort(), ["DB_PASSWORD", "SERVICE_API_KEY", "SERVICE_TOKEN", "TOKEN_COUNT"]);
});
