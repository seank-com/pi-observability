# Observability design

The extension owns normalized tool instrumentation, intent sanitization, audit
records, tool execution gating, and credential redaction. Pi owns serialization;
observability contains no provider payload adapters.

## Request boundaries

`context_with_system` transforms a separate copy of the normalized transcript.
Every system message's `toolsAdded` declarations receive a required `intent`
property; removals and redefinitions determine the active tool-name snapshot.
Registered executable schemas remain unchanged. Unsupported declarations,
grammar tools, or a tool-owned `intent` field reject the whole
transformation without exposing partial edits.

The same hook restores historical intents only from unique valid persisted audit
and assistant-call evidence. It adds shared guidance and complete `read`/`bash`
examples to the leading system message, preserving structured prompt sections
and later deltas. Examples illustrate names and argument objects without a
provider wire-format wrapper. Nothing is written back to session history.

`before_provider_request` performs only provider-independent redaction. Exactly
one pending context must await that egress event before its tool-name snapshot
can authorize a response. Missing context, missing egress, failed decoration,
failed redaction, or ambiguous pairing cannot authorize execution. Pi exposes
no request ID linking these hooks: overlapping unconfirmed contexts poison
correlation until settlement. A request without a context snapshot gets
redaction but no tool authority. Transport retries below the payload hook reuse
the original preparation. Providers must preserve this event ordering.

Credential discovery uses assignment names containing `TOKEN`, `API_KEY`, or
`PASSWORD` in the configured registry file. Only nonempty inherited values are
used. Duplicate values pick the lexicographically first key; overlapping values
match longest first. Redaction recursively copies strings, arrays, and plain
records without mutating local history. Discovery/traversal failure returns a
credential-free `null` payload rather than throwing through a host that might
continue with the original body. This protection depends on the host honoring
the payload replacement on the request path.

## Auditing and execution

`message_end` removes transport intent before ordinary tool argument validation,
persists sanitized audit entries, and correlates finalized calls with immutable
request snapshots. The maximum pending request count is 32. Ambiguous correlation
or overflow poisons correlation until agent settlement, rather than trusting a
later response. Errors/aborts retire request snapshots; agent lifecycle resets
abandoned state. `tool_call` verifies the ID, name, and persisted audit visibility
before execution. Diagnostic records contain structural reasons, never raw
rejected intent or arguments. `tool-intent`, `tool-intent-diagnostic`, contract
version 1, and the `intent` argument remain unchanged.

## One corrective tool-call retry

At the awaited `message_end` boundary, a verified decorated call with absent
intent is held before execution. Observability asks the same request's model
through `ctx.modelRegistry.streamSimple` to repeat exactly that tool call,
adding only intent. This is a native tool-call retry, not a prose explanation.
Only the held tool is offered; the request contains its decorated schema, the
latest user task, and the original call as data. It does not replay the full
conversation. Present but invalid intent, duplicate/invalid IDs, unverified
requests, and unsuccessful main responses are not retried.

The auxiliary completion never enters the agent execution loop. Exactly one
returned call is accepted, with the same tool name and deeply equal ordinary
arguments. Its new provider-generated ID is discarded: the original held ID and
arguments remain authoritative. The normal sanitizer, durable audit and execution
gate then apply. Refusal, changed arguments, missing/invalid intent, extra calls,
truncation, or transport failure leave execution blocked without a second retry.

Retries are serial, with a 120-second deadline per call and a shared 240-second
budget per finalized assistant response. Requests use the model’s normal output
limit; normalized streamed/final responses over 1 MiB are rejected. Parent
cancellation and session lifecycle changes abort retries; late completions cannot create
an audit or authorize execution. The factory's `intentRetry: false` disables
retries; optional requestTimeoutMs/turnBudgetMs override these deadlines.

The retry uses session authentication, the captured request model and current
thinking level. Its explicit payload callback applies credential redaction
without entering the main request-correlation queue. Failed redaction throws
before egress; a provider that omits the callback cannot authorize recovery.
As with ordinary requests, providers must honor the callback before sending.
If redaction changes ordinary argument values, a repeated redacted call fails
the equality check; execution never silently substitutes those values.

`tool-intent-retry` version-1 records capture the original ID, tool name,
accepted/rejected outcome, reason, latency and separate auxiliary usage. They
exclude arguments and intent text. The ordinary `tool-intent` audit remains
unchanged; the shared ID identifies retry provenance. Auxiliary usage is not
added to the main response or its context estimate. Cancellation/lifecycle
retirement discards late results rather than writing to a replacement session.

## Optional policy capability

The pure `/contract` export defines `pi-observability:v1:capability-request` and
`pi-observability:v1:capability-reply`. Requests contain `{version: 1, requestId}`;
replies contain the same correlation ID and a capability with `version`, live
`ready`, `sanitizeIntent`, and `redactRecovery` functions. These functions are
explicit in-process grants on Pi's synchronous bus, not serialized RPC or a
general service registry.

The responder registers during initialization. Successful synchronous credential
discovery makes it ready immediately, so a consumer's session-start handler may
run first in either initialization order. Consumers resolve at session readiness.
Queries subscribe, emit, and unsubscribe in one
synchronous call, so absence requires no timer or retry. Malformed/incompatible
replies are ignored; duplicate compatible responders yield no capability.

Shutdown revokes the capability, removes the responder, and clears correlation.
Restart creates a fresh capability generation; previously captured redactors
remain unusable. Recovery redaction returns `null` when unavailable, revoked, or
given an unsupported value. The intent sanitizer is pure and remains usable on
its own; consumers must check readiness before using granted functions. No module
singleton or installed-package check substitutes for this handshake.

## Package boundary

`dist/index.js` is the single explicit Pi entry. `/contract`, `/intent`, and
`/redaction` have declarations and no entry-point activation side effects.
TypeScript emits ESM and rewrites relative `.ts` imports to `.js`. No production
library dependency is required; the imported Pi host type is a `*` peer, with an
exact separate development host pin. The tarball test exercises native helper
imports and real-loader initialization, successful audited execution, blocked
unaudited execution, redaction, shutdown, and reload without sibling packages.

## Compatibility evidence and limits

This design SHOULD WORK across providers using Pi's normalized object-tool
contract. Offline tests cover stock and the selected patched Pi 0.87.1: real
agent-loop execution with a synthetic response stream, strict validation,
audit ordering, history restoration, missing/invalid intent refusal, and six
real serializers (OpenAI Completions, Responses, Codex Responses, Anthropic
Messages, Google Generative AI, Mistral Conversations). Serializer tests stop
before HTTP and do not measure model compliance. Packed-loader tests cover a
standalone installed artifact. Retry tests also use the real Codex serializer
and parser with scripted SSE (accept identical arguments; reject changed ones).
Packed native Ollama composition covers both load orders, a real SDK session,
redaction, retry rejection and cancellation on stock and patched Pi. Private
assembly verifies the complete component composition on the patched host.
Live Ollama/Codex model compliance remains acceptance work for this revision.

Pi's explicit forced-system-prompt projection runs after the context hook. Our
host regression test confirms it preserves decorated schemas but replaces the
shared system guidance/examples. Ordinary prompts are the tested guidance path;
callers using a forced prompt must include equivalent guidance themselves.
Later extensions can also change the transformed context; composition must
preserve its decorated declarations and audit contract. Arbitrary extension
model calls and compaction do not necessarily run the agent context hook.
Redaction still depends on their invoking the final payload hook; this change
does not repair host callback bypasses. Other host versions, provider-specific
schema restrictions, and nonstandard tool-call IDs need separate verification.

The optional `onProviderRequestDecorated` probe now reports
`boundary: "context_with_system"` instead of an adapter ID. Its other structural
counters and all versioned audit/capability wire identifiers are unchanged.
