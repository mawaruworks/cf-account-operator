import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { AccountStore } from "./account-store.js";
import { backendOrder, selectAvailableBackend } from "./backend-selection.js";
import { CdpBrowserManager } from "./browser-manager.js";
import {
  assertNoteUrl,
  createNoteDraft,
  getNoteAuthenticationStatus,
  isNoteAuthenticated,
  listNotePosts,
  NOTE_LOGIN_URL,
  openNoteLogin,
  publishNote,
} from "./note-adapter.js";

const accounts = new AccountStore();
const browsers = new CdpBrowserManager(accounts);

async function readAuthentication(accountId: string): Promise<Record<string, unknown>> {
  return browsers.exclusive(accountId, async () => {
    if (await browsers.hasLiveRuntime(accountId)) {
      return {
        state: "needs_human",
        authenticated: null,
        next: "Call account_login_complete after finishing the visible Chrome login, or account_browser_stop to cancel.",
      };
    }

    const context = await browsers.start(accountId, { headless: true });
    try {
      const status = await getNoteAuthenticationStatus(context);
      return status.authenticated
        ? { state: "authenticated", authenticated: true, checkedUrl: status.url }
        : {
            state: "login_required",
            authenticated: false,
            checkedUrl: status.url,
            next: "Call account_login_start and complete the login manually in the opened Chrome window.",
          };
    } finally {
      await browsers.stop(accountId);
    }
  });
}

function output(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function requireLocalCdp(): "cdp" {
  const selected = selectAvailableBackend(new Set(["cdp"] as const));
  if (selected !== "cdp") throw new Error(`Local runner selected unsupported backend: ${selected}`);
  return selected;
}

function server(): McpServer {
  const instance = new McpServer({ name: "Note Account Operator (CDP)", version: "0.2.0" });

  instance.registerTool(
    "account_upsert",
    {
      description: "Register a local note account. Profile data stays in the configured local profile root.",
      inputSchema: {
        accountId: z.string(),
        displayName: z.string().min(1).max(100),
        creatorUrl: z.string().url().optional(),
      },
    },
    async ({ accountId, displayName, creatorUrl }) => {
      if (creatorUrl) assertNoteUrl(creatorUrl);
      return output(await accounts.upsert({ accountId, displayName, creatorUrl }));
    },
  );

  instance.registerTool(
    "accounts_list",
    {
      description: "List local note accounts without exposing cookies or secrets.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => output({ accounts: await accounts.list(), profileRoot: accounts.root }),
  );

  instance.registerTool(
    "account_status",
    {
      description: "Inspect the local profile, browser runtime, and note authentication state for one account.",
      inputSchema: { accountId: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId }) => {
      const account = await accounts.get(accountId);
      return output({ account, browser: await browsers.describe(accountId), authentication: await readAuthentication(accountId) });
    },
  );

  instance.registerTool(
    "account_backend_status",
    {
      description: "Show backend priority. Local CDP is implemented first; CUA and CF remain fallbacks.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const available = new Set(["cdp"] as const);
      return output({ requested: process.env.NOTE_BROWSER_BACKEND ?? "auto", priority: backendOrder(), selected: selectAvailableBackend(available) });
    },
  );

  instance.registerTool(
    "account_login_start",
    {
      description: "Open a headed account-specific Chrome profile at note login for human sign-in and MFA.",
      inputSchema: { accountId: z.string() },
    },
    async ({ accountId }) =>
      browsers.exclusive(accountId, async () => {
        const backend = requireLocalCdp();
        if (await browsers.hasLiveRuntime(accountId)) {
          throw new Error("This account already has an active browser. Complete login or call account_browser_stop first.");
        }
        const context = await browsers.start(accountId, { headless: false, startUrl: NOTE_LOGIN_URL });
        const page = await openNoteLogin(context);
        return output({
          accountId,
          status: "needs_human",
          backend,
          loginUrl: page.url(),
          profileDir: (await accounts.readRuntime(accountId))?.profileDir,
          instructions: [
            "Use the opened account-specific Chrome window to log in to note manually.",
            "Complete MFA or CAPTCHA yourself; credentials are never passed to Codex or stored in tool arguments.",
            "After the account page or editor is visible, call account_login_complete.",
          ],
        });
      }),
  );

  instance.registerTool(
    "account_login_complete",
    {
      description: "Verify the headed login session or its persisted profile, then close only the account browser while retaining the profile.",
      inputSchema: { accountId: z.string() },
    },
    async ({ accountId }) =>
      browsers.exclusive(accountId, async () => {
        const backend = requireLocalCdp();
        const browserWasOpen = await browsers.hasLiveRuntime(accountId);
        const context = await browsers.start(accountId, { headless: !browserWasOpen });
        try {
          if (!(await isNoteAuthenticated(context))) throw new Error("Login does not appear to be complete yet");
          await browsers.stop(accountId);
          return output({ accountId, status: "succeeded", backend, browserWasOpen, profilePreserved: true });
        } catch (error) {
          if (!browserWasOpen) await browsers.stop(accountId);
          throw error;
        }
      }),
  );

  instance.registerTool(
    "account_browser_stop",
    {
      description: "Stop an account-specific Chrome process without deleting its login profile.",
      inputSchema: { accountId: z.string() },
    },
    async ({ accountId }) =>
      browsers.exclusive(accountId, async () => {
        await accounts.get(accountId);
        await browsers.stop(accountId);
        return output({ accountId, status: "stopped", profilePreserved: true });
      }),
  );

  instance.registerTool(
    "note_posts_list",
    {
      description: "Read published note links from the configured creator page through the rendered DOM.",
      inputSchema: { accountId: z.string(), creatorUrl: z.string().url().optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, creatorUrl, limit }) => {
      const backend = requireLocalCdp();
      const account = await accounts.get(accountId);
      const target = creatorUrl ?? account.creatorUrl;
      if (!target) throw new Error("creatorUrl is required on this call or account_upsert");
      assertNoteUrl(target);
      return output(
        await browsers.exclusive(accountId, async () => {
          if (await browsers.hasLiveRuntime(accountId)) throw new Error("Account browser is active; finish or stop the login handoff first.");
          const context = await browsers.start(accountId, { headless: true });
          try {
            return { accountId, backend, ...(await listNotePosts(context, target, limit)) };
          } finally {
            await browsers.stop(accountId);
          }
        }),
      );
    },
  );

  instance.registerTool(
    "note_draft_create",
    {
      description: "Create or autosave a note draft with the account-specific CDP profile.",
      inputSchema: { accountId: z.string(), title: z.string().min(1).max(200), body: z.string().min(1).max(200_000) },
    },
    async ({ accountId, title, body }) =>
      output(
        await browsers.exclusive(accountId, async () => {
          const backend = requireLocalCdp();
          if (await browsers.hasLiveRuntime(accountId)) throw new Error("Account browser is active; finish or stop the login handoff first.");
          const context = await browsers.start(accountId, { headless: false });
          try {
            return { accountId, backend, ...(await createNoteDraft(context, title, body)) };
          } finally {
            await browsers.stop(accountId);
          }
        }),
      ),
  );

  instance.registerTool(
    "note_publish",
    {
      description: "Publish a note through the rendered UI. Requires confirm=true and is intentionally separate from draft creation.",
      inputSchema: {
        accountId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(200_000),
        confirm: z.literal(true),
      },
    },
    async ({ accountId, title, body }) =>
      output(
        await browsers.exclusive(accountId, async () => {
          const backend = requireLocalCdp();
          if (await browsers.hasLiveRuntime(accountId)) throw new Error("Account browser is active; finish or stop the login handoff first.");
          const context = await browsers.start(accountId, { headless: false });
          try {
            return { accountId, backend, ...(await publishNote(context, title, body)) };
          } finally {
            await browsers.stop(accountId);
          }
        }),
      ),
  );

  return instance;
}

async function main(): Promise<void> {
  await accounts.ensure();
  const transport = new StdioServerTransport();
  await server().connect(transport);
}

const shutdown = async (code: number): Promise<void> => {
  await browsers.stopAll();
  process.exit(code);
};

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
