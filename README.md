# pi-observability
Tool-intent auditing and credential redaction for Pi.

Intent instrumentation uses Pi's normalized transcript before provider
serialization. It SHOULD WORK across Pi providers that consume those tool
declarations and honor the context, payload, and finalized-message hooks.
Missing intent gets one corrective tool-call retry before execution; changed
arguments or a failed retry remain blocked. There are no provider adapters or
sibling-extension dependencies. Cross-provider support is an architectural
expectation, not a claim of live testing against every provider.

Verified offline on stock and the selected patched Pi 0.87.1:

- Real host agent loop and strict tool validation: successful intent auditing,
  missing/invalid intent blocking, stripping before execution, and history restoration.
- Real serializers: OpenAI Completions, OpenAI Responses, OpenAI Codex Responses,
  Anthropic Messages, Google Generative AI, and Mistral Conversations. Required
  intent, shared examples, historical intent, and final redaction survive;
  requests stop before HTTP.
- Corrective retry through the real Codex serializer/parser with scripted SSE,
  including rejection of changed arguments; generic retry failure/lifecycle tests.
- Packed-package loading, capability lifecycle, and execution gating without
  sibling packages.

The private assembly also verifies a real SDK session with Pi’s built-in `read`
tool, the native Ollama provider, and a local HTTP fixture on the selected patched
Pi 0.87.1. Live-model compliance and complete Codex/Ollama service round trips
have not been reverified for this change.
Object JSON-schema tools, including JSON-schema constrained sampling, are
supported; grammar tools are not. See [design](docs/design.md) for hook ordering
and forced-prompt limits.

## Quick start

This is a local `0.1.0` candidate; it has not been published to npm.

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm run test:package
pi -e ./dist/index.js
```

Use Node 24.14.1 or later and Pi 0.87.1. CI pins the stock npm host at 0.87.1;
local acceptance also uses an explicitly selected patched 0.87.1 artifact.
Other host versions are unverified. Host payload callbacks must actually run
for redaction to apply; successful extension loading does not prove every
provider/compaction path invokes the hook.

Load your environment before starting Pi. By default, `~/.env` supplies the
credential **names**, and inherited environment variables supply their effective
values. The extension does not evaluate or modify the file. See
[setup](docs/setup.md) for configuration and failure behavior.

## Optional integration and helper APIs

`@seank/pi-observability/contract`, `/intent`, and `/redaction` are pure exports.
Importing them does not load or activate the Pi extension. `/contract` owns a
versioned event-bus query for an active policy capability. Consumers
query at session readiness, check `version` and `ready`, and discard capability
references at teardown/reload. Installing this package alone does not prove
its extension is active. See [design](docs/design.md).

## Development

`npm test` includes real host serializer and session-manager checks, plus
synthetic provider, auditing, redaction, and lifecycle tests. No provider calls
or live agent state are used. `npm run test:package` packs and installs into a
disposable consumer without any sibling component or private repository.

Select a different host artifact explicitly:

```bash
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm test
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm run test:package
```

Only compiled JS, declarations, generic docs, README, LICENSE, and package
metadata ship. Source, tests, CI configuration, and development fixtures do not.
MIT attribution includes both the original public repository and extracted code.
