# Threat model

## Assets

- Browser storage state, cookies, and refresh tokens
- Live View URLs
- MCP bearer tokens
- Account names and task history
- Unpublished draft content

## Trust boundaries

The MCP client, Worker, Durable Object, Browser Run session, R2 bucket, D1 database, human operator, and destination website are separate trust boundaries. Website content is untrusted even after authentication.

## Primary threats and controls

| Threat | Control |
| --- | --- |
| Unauthenticated MCP use | Required long bearer token; fail closed |
| SSRF or arbitrary navigation | Adapter-owned HTTPS hostname allowlist |
| Cross-account races | One named Durable Object and persisted lease per account |
| Profile theft from R2 | AES-256-GCM before upload; key kept as Worker secret |
| Profile rollback or object swapping | Account/version-bound authenticated data |
| Duplicate side effects | D1 uniqueness on account and idempotency key |
| Prompt injection from a website | Deterministic site adapters; no arbitrary instruction tool |
| Live View link disclosure | Short expiry and explicit credential handling guidance |
| Accidental publication | No publish operation in v0.1 |
| Browser left running | Ten-minute lease, alarm cleanup, and explicit close paths |

## Out of scope

- Compromise of the user's Cloudflare account
- Malicious browser or Cloudflare runtime updates
- Destination-site account recovery and fraud decisions
- Legal approval for automating a third-party site
- Availability when a destination site changes its UI

## Required review for future publish tools

Any irreversible adapter action must add a separate preview/prepare call, a short-lived approval token bound to the exact content hash and account, an idempotency key, and post-action verification. Workflow retries must never blindly replay the final action.
