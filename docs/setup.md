# Setup and troubleshooting

Build the local candidate with `npm ci && npm run build`, then pass
`-e /path/to/pi-observability/dist/index.js` to a compatible Pi host. Load it once.
The manifest also exposes that one entry for Pi package discovery. Publication
and managed package installation are separate release steps.

## Credential registry

The default registry is `~/.env`. Load its environment through your usual launcher
before starting Pi. For example, the registry may declare `SERVICE_API_KEY`;
the inherited value of that variable is replaced in outgoing payload strings
with `<REDACTED SERVICE_API_KEY VALUE>`. Empty/missing values are ignored. Values
are never evaluated from the file or rewritten there. A missing/unreadable
registry prevents safe request preparation and produces a blocking `null` body.
An empty readable registry is valid if no credentials need filtering.

For an embedded integration or isolated tests, import `createObservabilityExtension`
from the package root and inject `credentialDiscovery` (`envFilePath`,
`environment`, or `readFile`). The default entry uses the normal registry. The
factory also accepts a clock and a structural decoration-summary probe for tests.

## Tool intent

Intent must be one plain sentence describing purpose, with no line breaks, Markdown
formatting, quoted passages, or backticks. Those are model instructions, not syntax
rejections: apostrophes, quotes, URLs, backticks, and Markdown pass through as plain
text. The only content redaction is the exact credential-value replacement shared with
provider egress, using the same discovered set. Audited intent is capped at 1,000
characters. A rejected call is blocked with a reason code and prose guidance;
its rejected arguments are not echoed in the diagnostic. If credential discovery is
unavailable, intent sanitization fails closed rather than treating the missing set as
empty.

If a call is blocked for missing request/audit correlation, check the host event sequence: `context_with_system`,
`before_provider_request`, then `message_end` before validation. Only normalized
object JSON-schema declarations are decorated. A reserved `intent` schema field, ambiguous request,
duplicate/invalid ID, or invisible audit record also blocks execution. Do not
work around these failures by disabling validation or rewriting audit history.

## Compaction and request correlation

Compaction needs no extension setting. The host must expose
`session_before_compact`, `session_compact` and `session_compact_failed`, keep
normal agent execution quiescent during summary generation, and finish the
compaction lifecycle before normal requests resume. Both stock and the
callback-forwarding patched Pi 0.87.1 expose those lifecycle hooks. Compaction
correlation isolation does not require the callback-forwarding patch.

Choose the host according to the required redaction coverage:

| Host | Normal agent auditing/redaction | Compaction correlation isolation | Default summary redaction |
| --- | --- | --- | --- |
| Stock Pi 0.87.1 | Supported | Requires native lifecycle qualification | Not covered: host bypasses the payload callback |
| Callback-forwarding patched Pi 0.87.1, or equivalent upstream behavior | Supported | Requires native lifecycle qualification | Requires qualification that every attempt invokes and honors the payload callback |

The patch is optional for standalone use that accepts the documented lack of
summary redaction. It is required, or must be replaced by equivalent upstream
behavior, when an integration requires credentials to be redacted from compaction
summaries. There is no extension switch to restore a missing host callback. A
matching version string alone does not establish callback forwarding or provider
compliance.

When the host forwards payload callbacks, summary requests are redacted. In
either case, compaction-scoped events do not create or confirm tool-authorization
snapshots. Successful, failed and cancelled compaction close their own scope.
The next normal tool call must independently satisfy the usual context, egress,
response and durable-audit checks. A summary's missing agent `message_end` does
not leave an authorization entry waiting for that normal response.

If a post-compaction call is blocked, distinguish a missing/failed host lifecycle
boundary from an independently ambiguous agent request. Existing genuine
ambiguity/overflow still fails closed until agent lifecycle retirement; a
compaction event is not permission to clear it. Record the exact host artifact,
compaction reason/outcome, event ordering and structural diagnostic reason for
reproduction. Do not expire pending entries, disable the audit gate, rewrite
journals or repeatedly retry tools to conceal broken correlation. A host that
omits the required terminal boundary needs compatibility investigation rather
than a timer-based scope reset.

Compatibility qualification uses disposable sessions and scripted model streams
through the actual host's manual, threshold and overflow compaction paths. Cover
success, failure/cancellation, multiple summaries, redaction failure, subsequent
audited tool execution and preservation of genuine ambiguity protections. Run
these checks against the exact selected host and again with the installed
package during assembly acceptance. Synthetic fixtures establish lifecycle
correctness; a separately authorized live sniff test confirms the deployed
provider/model path and does not replace the regressions.

## Optional policy consumers

Use `queryObservabilityCapability(pi.events)` from `/contract` at session start.
Require `version === 1` and `ready === true` before using granted helpers.
Clear references on shutdown/reload and query again for the replacement session.
An absent extension returns `undefined` immediately. Failed credential discovery
returns an unready capability; recovery redaction returns `null` and must never
be treated as permission to send the original payload.

## Host limits

The general tool/serializer test host is stock Pi 0.87.1; acceptance additionally
exercises the selected patched 0.87.1 artifact. Qualify compaction lifecycle
isolation on both hosts, and summary redaction only on a callback-forwarding host,
as described above. This
extension does not upgrade Pi or supply missing payload callbacks. If a
host/provider bypasses `before_provider_request`, the extension cannot redact
that request. Other versions require their own
serializer, lifecycle, and packed-loader validation before support is claimed.

Shared examples use `read` and `bash` and are added once per ordinary request.
An explicit forced system prompt can replace that guidance after our hook;
include equivalent intent instructions/examples in that forced prompt. See the
[verified paths and limits](design.md#compatibility-evidence-and-limits).

Missing intent triggers one corrective tool-call retry through the same model.
Invalid supplied intent is blocked directly. Retry failure leaves execution
blocked; there is no repeated repair loop. The factory supports `intentRetry: false`
and bounded deadline overrides. See [retry semantics](design.md#one-corrective-tool-call-retry).
