# CF Account Operator

Self-hosted, human-in-the-loop browser automation on Cloudflare Browser Run, exposed as a remote MCP server.

CF Account Operator is designed for people who want an AI client such as Codex to operate their own web accounts without handing passwords to the model. Authentication happens in Cloudflare Live View, browser state is encrypted and versioned in R2, and a Durable Object serializes work per account.

> [!WARNING]
> Browser automation can violate a site's terms, trigger anti-bot systems, or suspend an account. You are responsible for obtaining permission and complying with applicable terms and laws. Do not use this project to bypass CAPTCHA, access controls, rate limits, or technical protections.

## Status

This is an early proof of concept. It supports:

- Remote MCP over Streamable HTTP at `/mcp`
- Bearer-token authentication, failing closed when unconfigured
- Named `note` accounts stored in D1
- One Durable Object coordinator per account
- Human login through Browser Run Live View
- AES-256-GCM encrypted, versioned Playwright storage state in R2
- Safe note draft creation that never clicks Publish
- Rendered-DOM note history inspection
- Explicitly confirmed note publishing
- Idempotency keys for draft tasks
- Domain allowlisting and task leases
- A local CDP MCP runner with one persistent Chrome profile per account

It does **not** support arbitrary browser instructions or a production OAuth flow.

## Backend order

The intended backend order is:

```text
CDP (local account-specific Chrome profile)
  > CUA (Codex In-App Browser, visible when human interaction is needed)
  > CF (this Cloudflare Browser Run worker)
```

The local CDP runner is the first implementation of that routing. The existing worker remains the `cf` fallback and keeps its Cloudflare Browser Run/Live View flow.

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
3. Log in yourself, complete MFA/CAPTCHA, and select **Done**. The agent never receives or enters the credentials.
4. Call `account_login_complete` with the returned task ID.
5. Confirm `account_status` reports `authentication.state: "authenticated"`.
6. Call `note_draft_create` with a unique idempotency key.
7. Open note normally and review the draft before publishing it yourself, or call `note_publish` with explicit confirmation and an idempotency key.

Available tools:

- `account_upsert`
- `account_backend_status`
- `accounts_list`
- `account_status`
- `account_login_start`
- `account_login_complete`
- `note_draft_create`
- `note_posts_list`
- `note_publish`
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
npm run check:local
```

### Local CDP MCP

Use this when Codex should operate separate local Chrome profiles without routing through Cloudflare Browser Run:

```bash
npm run cdp:mcp
```

The MCP server stores account metadata and persistent Chrome profiles outside the repository by default:

```text
~/.config/cf-account-operator/note-accounts/<account-id>/chrome-profile
```

Set `NOTE_PROFILE_ROOT` to an absolute directory to change the root, and `NOTE_CHROME_PATH` when Chrome is not at the macOS default path. `NOTE_BROWSER_BACKEND=auto` uses the shared order `cdp > cua > cf`; the local server currently implements `cdp` and reports the other two as fallbacks.

The local tools include `account_upsert`, `account_login_start`, `account_login_complete`, `account_status`, `account_browser_stop`, `note_posts_list`, `note_draft_create`, and `note_publish`. The manual login flow is:

1. Call `account_login_start`.
2. Log in manually in the opened headed, account-specific Chrome window and complete MFA/CAPTCHA yourself.
3. You may leave Chrome open or close it after logging in. Call `account_login_complete`; it verifies the live session or re-opens the persisted profile, closes only the account browser, and preserves the profile.
4. If `account_status` reports `login_required`, repeat the flow. If a login window is still active, finish it or call `account_browser_stop` before any other operation for that account.

Routine DOM operations launch the same profile through localhost-only CDP and close the browser afterward. The current note editor requires headed Chrome for draft and publish flows; authentication checks and history inspection may use headless Chrome. `account_status` performs a read-only authentication check and never asks Codex to handle credentials.

Install the repository skill when using Codex from this checkout: `.agents/skills/note-account-operator/SKILL.md`.

### Chrome DevTools MCP

The account workflow uses the official Chrome DevTools MCP with one persistent Chrome profile per account. Account IDs are not limited to ten; use any valid lowercase ID and switch by restarting the single profile owner:

Install the MCP once globally:

```bash
npm install --global chrome-devtools-mcp@latest
chrome-devtools-mcp --help
```

Or keep it inside a designated folder for this checkout:

```bash
npm install --prefix .tools/chrome-devtools-mcp chrome-devtools-mcp@latest
export NOTE_CHROME_DEVTOOLS_MCP_DIR="$(pwd)/.tools/chrome-devtools-mcp"
```

The launcher prefers `NOTE_CHROME_DEVTOOLS_MCP_BIN`, then `NOTE_CHROME_DEVTOOLS_MCP_DIR`, then a global `chrome-devtools-mcp` on `PATH`; if none is available, it falls back to `npx`. Do not put the MCP package inside an account's Chrome profile directory.

```bash
NOTE_ACCOUNT_ID=note-account-10 npm run chrome-devtools:mcp -- --chrome-arg=--start-minimized
# or override the environment value directly:
npm run chrome-devtools:mcp -- --account-id=note-account-10 --chrome-arg=--start-minimized
```

The checked-in `.codex/config.toml` keeps `note-account-1` as the current default:

```toml
[mcp_servers.chrome_devtools]
command = "npm"
args = ["run", "chrome-devtools:mcp", "--", "--chrome-arg=--start-minimized"]
cwd = "."
env = { NOTE_ACCOUNT_ID = "note-account-1" }
```

The launcher maps each selected account to `<profile-root>/<account-id>/chrome-profile`, where `profile-root` is `NOTE_PROFILE_ROOT` or the platform config directory, starts headed Chrome minimized, and opts out of usage statistics. Profiles are local credentials: another person must log in on their own machine; do not copy or share the Chrome profile. Reload the Codex session after changing MCP configuration so the `chrome_devtools` tools are discovered. To attach to an already running debuggable Chrome instead, use the official server's `--browser-url` or `--auto-connect` option.

See the [Chrome DevTools MCP project](https://github.com/ChromeDevTools/chrome-devtools-mcp) for its current configuration and connection options.

## Security model

- Stored browser state is equivalent to a login credential.
- Profile objects are encrypted before they reach R2 using AES-256-GCM.
- Encryption uses account/version-bound additional authenticated data.
- Live View URLs are short-lived bearer credentials. Never log or publish them.
- The browser adapter accepts only explicit HTTPS hostnames.
- Known-site adapters are preferred over model-driven arbitrary browsing.
- Publishing is an explicit separate tool and requires `confirm=true`; draft creation never publishes.

For internet-facing production deployments, put Cloudflare Access or an OAuth-capable gateway in front of `/mcp` in addition to the bearer secret.

## Contributing and support

Bug reports and pull requests are welcome. Community support is best-effort. Paid installation, adapter development, and operational support can be offered independently by maintainers; the Apache-2.0 license does not require purchasing support.

If this project saves you time, you can support its maintenance through the GitHub Sponsors button. Commercial setup and adapter work remain separate from the open-source license.

Do not include cookies, Live View URLs, account identifiers, screenshots containing private data, or secret values in issues.

## License

Apache License 2.0. See [LICENSE](LICENSE).
