# Observability design

The extension owns normalized tool instrumentation, intent sanitization, audit
records, tool execution gating, and credential redaction. Pi owns serialization;
observability contains no provider payload adapters.

## Request boundaries

Tool-authorization correlation and provider redaction have different lifetimes.
Only a normal agent request can own an immutable decorated tool-name snapshot
and authorize tool execution. Compaction summary requests receive credential
redaction but never enter that authorization queue.

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

`before_provider_request` applies provider-independent credential redaction to
normal and compaction requests. Outside the compaction scope, exactly one
pending context must await that egress event before its tool-name snapshot can
authorize a response. Missing context, missing egress, failed decoration, failed
redaction, or ambiguous pairing cannot authorize execution. Pi exposes no request
ID linking these hooks: genuinely overlapping unconfirmed agent contexts poison
correlation until settlement. An unmatched egress outside a known compaction
scope grants no authority and retains the existing fail-closed correlation
behavior. Transport retries below the payload hook reuse the original
preparation. Providers must preserve this event ordering.

### Compaction lifecycle

Pi's `session_before_compact` opens a compaction scope. The host enters that
boundary after the main request/tool-execution path has quiesced. Within the
scope, `context_with_system` cannot create a normal authorization snapshot;
summary contexts are not decorated as executable agent requests. Payload hooks
still redact every summary request, including separate history and turn-prefix
summaries and summary retries. These egress events neither confirm a normal
snapshot nor append an undecorated entry to the normal pending queue. Summary
redaction failure returns the same blocking replacement as other redaction
failures; it grants no authority and does not poison an unrelated normal
request's correlation. Summary completion is owned by the host's compaction
lifecycle, not by an assumed agent `message_end` event.

`session_compact` closes a successful scope. `session_compact_failed` closes a
failed or cancelled scope. Terminal cleanup is safe when no scope was opened,
including cancellation by another extension before this extension's start
handler ran. Both outcomes retire compaction-local state before a subsequent
normal context can establish fresh authorization. Session shutdown and the
existing agent/session lifecycle retirement also clear abandoned compaction
state; they do not allow a late summary to authorize a replacement session.

This boundary is not a general correlation reset. Existing genuine ambiguity or
overflow is not cleared merely because compaction occurs. A normal pending
request or tool-authorization obligation unexpectedly crossing the entry
boundary is not silently discarded or reclassified as a summary. It remains
unverified and fails closed. No tool execution or corrective tool-call retry can
be authorized from a compaction-scoped event, including an unexpected assistant
tool response. Failed decoration on a normal request also remains a failed
attempt, not permission to reuse a prior snapshot.

After a complete, unambiguous compaction lifecycle, the next ordinary request
must still pass its own context decoration, egress confirmation, response
matching, audit persistence and execution checks. Recovery requires those
positive boundaries, not elapsed time, request age, payload-shape guessing or a
"trust the next request" exception. Compaction uses the host's existing lifecycle
hooks without adding a request ID API, new timers, queue limits or settings.

### Credential redaction

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
later response. Compaction-scoped requests are excluded from this normal pending
count. Errors/aborts retire request snapshots; agent lifecycle resets abandoned
state. Compaction completion retires only its own scope, not pre-existing
ambiguous normal-request state. `tool_call` verifies the ID, name, and persisted
audit visibility before execution. Diagnostic records contain structural reasons, never raw
rejected intent or arguments. `tool-intent`, `tool-intent-diagnostic`, contract
version 1, and the `intent` argument remain unchanged.

Intent sanitization is the account boundary, not a content filter. It checks the
value is a string within the input and stored length bounds, strips control and
invisible-directionality characters, normalizes whitespace, and replaces exact
credential values using the same discovered set and string replacer as provider
egress. It performs no URL, path, option, shell-syntax, token, or quoted-detail
parsing: apostrophes, quotes, URLs, backticks, and Markdown pass through as plain
text. When credential discovery is unavailable, sanitization fails closed with a
specific reason instead of defaulting to an empty replacement set. Persisted audit
evidence is validated structurally (contract version, field types, nonempty intent
within the stored cap) and by call identity/uniqueness, never by re-running the
current replacement set: a set can change with rotation and even a redaction marker
can contain a registered value, so equality after today's replacement would
misclassify valid stored evidence. Restored copies enter the provider path and are
protected by the existing egress redaction.

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

The `/intent` export is the current supported surface for standalone sanitizers:
`sanitizeAuditIntentDetailed(value, present, replacements)` requires the
discovered replacement set. `replacements === undefined` (failed discovery)
fails closed and is distinct from an explicitly empty set, which is a valid
registry with nothing to filter. `isToolIntentData` is the structural
validator used for persisted evidence; `MAX_AUDIT_INTENT_LENGTH` is the stored
cap. Runtime consumers should prefer the capability's
bound `sanitizeIntent`, which carries the live set and readiness.
`/redaction` additionally exports `redactString`, the exact-occurrence replacer
shared by provider egress and intent sanitization.

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

Native compaction fixtures use public SDK sessions, in-memory histories and a
scripted provider on stock and callback-forwarding patched Pi 0.87.1. They cover
manual, automatic threshold and overflow recovery, split-turn summaries,
transient summary retry, success, failure, cancellation, early extension
cancellation and extension-supplied summaries. Threshold cases prove that a
subsequent audited tool executes without settling the assignment merely to
reset correlation. The installed-tarball consumer runs the same native suite.
Patched-host fixtures verify summary redaction, including blocking replacements
on traversal failure; stock fixtures explicitly assert its missing summary
callback coverage. Extension-boundary regressions preserve genuine ambiguity,
overflow and unverified obligations across compaction and discard late held
retry results. No live provider/model behavior is inferred from these fixtures.

Pi's explicit forced-system-prompt projection runs after the context hook. Our
host regression test confirms it preserves decorated schemas but replaces the
shared system guidance/examples. Ordinary prompts are the tested guidance path;
callers using a forced prompt must include equivalent guidance themselves.
Later extensions can also change the transformed context; composition must
preserve its decorated declarations and audit contract. Arbitrary extension
model calls do not necessarily run the agent context hook. Compaction support
requires `session_before_compact`, `session_compact` and
`session_compact_failed`, with main-agent execution quiescent during the summary
scope and terminal notification before normal execution resumes. Stock and the
callback-forwarding patched Pi 0.87.1 both expose these lifecycle hooks; the
correlation-isolation fix does not itself require the callback-forwarding patch.
Each selected artifact must be qualified with native compaction fixtures.

Summary credential redaction is a separate host guarantee. Stock Pi 0.87.1 does
not forward the agent's payload callback to its default summary requests, so
observability cannot redact those requests. Normal agent-request auditing and
redaction remain supported on stock Pi; summary egress is outside that host's
redaction coverage. The callback-forwarding patch, or an upstream host with
equivalent behavior, is required when compaction-summary redaction is required.
Such a host and its summary providers must invoke the final payload callback and
honor its replacement on every attempt. The patch forwards callbacks; it does
not add the compaction lifecycle hooks.

No extension option can supply a callback the host bypasses. Integrations that
require summary redaction must select a qualified callback-forwarding host;
stock compatibility is not evidence of full-egress redaction. Other auxiliary
model paths are not classified as compaction by inference. Other host versions,
provider-specific schema restrictions, and nonstandard tool-call IDs need
separate verification.

The optional `onProviderRequestDecorated` probe now reports
`boundary: "context_with_system"` instead of an adapter ID. Its other structural
counters and all versioned audit/capability wire identifiers are unchanged.
