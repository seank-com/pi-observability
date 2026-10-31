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

## Optional policy consumers

Use `queryObservabilityCapability(pi.events)` from `/contract` at session start.
Require `version === 1` and `ready === true` before using granted helpers.
Clear references on shutdown/reload and query again for the replacement session.
An absent extension returns `undefined` immediately. Failed credential discovery
returns an unready capability; recovery redaction returns `null` and must never
be treated as permission to send the original payload.

## Host limits

The test host is stock Pi 0.87.1; acceptance additionally exercises the selected
patched 0.87.1 artifact. This does not upgrade Pi or repair its compaction payload
callback behavior. If a host/provider bypasses `before_provider_request`, this
extension cannot redact that request. Other versions require their own
serializer, lifecycle, and packed-loader validation before support is claimed.

Shared examples use `read` and `bash` and are added once per ordinary request.
An explicit forced system prompt can replace that guidance after our hook;
include equivalent intent instructions/examples in that forced prompt. See the
[verified paths and limits](design.md#compatibility-evidence-and-limits).

Missing intent triggers one corrective tool-call retry through the same model.
Invalid supplied intent is blocked directly. Retry failure leaves execution
blocked; there is no repeated repair loop. The factory supports `intentRetry: false`
and bounded deadline overrides. See [retry semantics](design.md#one-corrective-tool-call-retry).
