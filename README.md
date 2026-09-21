# CF Account Operator

Self-hosted, human-in-the-loop browser automation on Cloudflare Browser Run, exposed as a remote MCP server.

CF Account Operator is designed for people who want an AI client such as Codex to operate their own web accounts without handing passwords to the model. Authentication happens in Cloudflare Live View, browser state is encrypted and versioned in R2, and a Durable Object serializes work per account.

> [!WARNING]
> Browser automation can violate a site's terms, trigger anti-bot systems, or suspend an account. You are responsible for obtaining permission and complying with applicable terms and laws. Do not use this project to bypass CAPTCHA, access controls, rate limits, or technical protections.

## Status

This is an early v0.1 proof of concept. It supports:

- Remote MCP over Streamable HTTP at `/mcp`
- Bearer-token authentication, failing closed when unconfigured
- Named `note` accounts stored in D1
- One Durable Object coordinator per account
- Human login through Browser Run Live View
- AES-256-GCM encrypted, versioned Playwright storage state in R2
- Safe note draft creation that never clicks Publish
- Idempotency keys for draft tasks
- Domain allowlisting and task leases

It does **not** yet support publishing, arbitrary browser instructions, local-runner fallback, or a production OAuth flow.

## Architecture

```text
Codex / MCP client
        |
        | Streamable HTTP + Bearer token
        v
Cloudflare Worker (/mcp)
   |         |          |
   |         |          +-- D1: accounts and task history
   |         +------------- R2: encrypted browser profiles
   v
Account Durable Object
   |
   +-- per-account lease / browser lifecycle
   v
Cloudflare Browser Run -- Live View --> human operator
   |
   v
note.com
```

## Prerequisites

- Node.js 22 or newer
- A Cloudflare account with Workers and Browser Run enabled
- Wrangler authenticated with `npx wrangler login`
- An MCP client that can send an `Authorization: Bearer ...` header

## Deploy

Install dependencies:

```bash
npm install
```

Create storage:

```bash
npx wrangler d1 create cf-account-operator
npx wrangler r2 bucket create cf-account-operator-profiles
```

Copy the returned D1 database ID into `wrangler.jsonc`, then initialize the schema:

```bash
npx wrangler d1 execute cf-account-operator --remote --file=schema.sql
```

Generate and store secrets. Keep both values private:

```bash
openssl rand -hex 32
npx wrangler secret put MCP_API_KEY

openssl rand -hex 32
npx wrangler secret put PROFILE_ENCRYPTION_KEY
```

Deploy:

```bash
npm run deploy
```

The MCP endpoint will be `https://<worker>.<account>.workers.dev/mcp`. The unauthenticated health endpoint is `/health`.

## MCP workflow

1. Call `account_upsert` with a stable ID such as `note-history`.
2. Call `account_login_start` and open the returned Live View URL.
3. Log in yourself, complete MFA/CAPTCHA, and select **Done**.
4. Call `account_login_complete` with the returned task ID.
5. Call `note_draft_create` with a unique idempotency key.
6. Open note normally and review the draft before publishing it yourself.

Available tools:

- `account_upsert`
- `accounts_list`
- `account_status`
- `account_login_start`
- `account_login_complete`
- `note_draft_create`
- `task_get`

## Local development

Copy `.dev.vars.example` to `.dev.vars`, replace both secrets, and insert a development D1 ID in `wrangler.jsonc`.

Browser Run requires remote resources:

```bash
npm run dev
```

Run checks:

```bash
npm test
npm run check
```

## Security model

- Stored browser state is equivalent to a login credential.
- Profile objects are encrypted before they reach R2 using AES-256-GCM.
- Encryption uses account/version-bound additional authenticated data.
- Live View URLs are short-lived bearer credentials. Never log or publish them.
- The browser adapter accepts only explicit HTTPS hostnames.
- Known-site adapters are preferred over model-driven arbitrary browsing.
- v0.1 intentionally has no Publish tool.

For internet-facing production deployments, put Cloudflare Access or an OAuth-capable gateway in front of `/mcp` in addition to the bearer secret.

## Contributing and support

Bug reports and pull requests are welcome. Community support is best-effort. Paid installation, adapter development, and operational support can be offered independently by maintainers; the Apache-2.0 license does not require purchasing support.

If this project saves you time, you can support its maintenance through the GitHub Sponsors button. Commercial setup and adapter work remain separate from the open-source license.

Do not include cookies, Live View URLs, account identifiers, screenshots containing private data, or secret values in issues.

## License

Apache License 2.0. See [LICENSE](LICENSE).
