import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BACKEND_PRIORITY } from "./backend";
import { createTask, getTask, listAccounts, requireAccount, updateTask, upsertAccount } from "./database";
import { isValidAccountId } from "./security";
import type { Env } from "./types";

function output(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function coordinator(env: Env, accountId: string) {
  return env.ACCOUNTS.getByName(accountId);
}

async function callCoordinator(env: Env, accountId: string, path: string, body: Record<string, unknown>) {
  const response = await coordinator(env, accountId).fetch(
    new Request(`https://account.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, ...body }),
    }),
  );
  const result = await response.json<Record<string, unknown>>();
  if (!response.ok) throw new Error(String(result.error ?? "Account operation failed"));
  return result;
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "CF Account Operator", version: "0.2.0" });

  server.registerTool(
    "account_backend_status",
    {
      description: "Report the browser backend order. This deployed server is the cf fallback in cdp > cua > cf.",
      inputSchema: {},
    },
    async () => output({ activeBackend: "cf", priority: BACKEND_PRIORITY }),
  );

  server.registerTool(
    "account_upsert",
    {
      description: "Register or rename a self-hosted browser account. v0.1 supports note only.",
      inputSchema: {
        accountId: z.string().describe("Lowercase stable ID, for example note-history"),
        displayName: z.string().min(1).max(100),
        platform: z.literal("note"),
      },
    },
    async ({ accountId, displayName, platform }) => {
      if (!isValidAccountId(accountId)) throw new Error("Invalid accountId");
      return output(await upsertAccount(env, { id: accountId, displayName, platform }));
    },
  );

  server.registerTool(
    "accounts_list",
    { description: "List configured browser accounts.", inputSchema: {} },
    async () => output({ accounts: await listAccounts(env) }),
  );

  server.registerTool(
    "account_status",
    {
      description: "Read the lock, login profile, and task status for one account.",
      inputSchema: { accountId: z.string() },
    },
    async ({ accountId }) => {
      await requireAccount(env, accountId);
      return output(await callCoordinator(env, accountId, "/status", {}));
    },
  );

  server.registerTool(
    "account_login_start",
    {
      description: "Open note in Browser Run and return a short-lived Live View URL for human login.",
      inputSchema: { accountId: z.string() },
    },
    async ({ accountId }) => {
      await requireAccount(env, accountId);
      const taskId = crypto.randomUUID();
      await createTask(env, { id: taskId, accountId, kind: "login", status: "running" });
      try {
        const result = await callCoordinator(env, accountId, "/login/start", { taskId });
        await updateTask(env, taskId, "needs_human", result);
        return output(result);
      } catch (error) {
        await updateTask(env, taskId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  );

  server.registerTool(
    "account_login_complete",
    {
      description: "Validate a completed human login and save a new encrypted browser profile version.",
      inputSchema: { accountId: z.string(), taskId: z.string().uuid() },
    },
    async ({ accountId, taskId }) => {
      await requireAccount(env, accountId);
      try {
        const result = await callCoordinator(env, accountId, "/login/complete", { taskId });
        await updateTask(env, taskId, "succeeded", result);
        return output(result);
      } catch (error) {
        await updateTask(env, taskId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  );

  server.registerTool(
    "note_draft_create",
    {
      description: "Create or autosave a note draft. This tool never clicks Publish.",
      inputSchema: {
        accountId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(200_000),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ accountId, title, body, idempotencyKey }) => {
      await requireAccount(env, accountId);
      const taskId = crypto.randomUUID();
      try {
        await createTask(env, {
          id: taskId,
          accountId,
          kind: "note_draft_create",
          status: "running",
          idempotencyKey,
        });
      } catch {
        const existing = await env.DB.prepare(
          "SELECT id FROM tasks WHERE account_id = ? AND idempotency_key = ?",
        )
          .bind(accountId, idempotencyKey)
          .first<{ id: string }>();
        if (!existing) throw new Error("Could not create task");
        return output(await getTask(env, existing.id));
      }
      try {
        const result = await callCoordinator(env, accountId, "/draft/create", { taskId, title, body });
        await updateTask(env, taskId, "succeeded", result);
        return output(result);
      } catch (error) {
        await updateTask(env, taskId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  );

  server.registerTool(
    "note_posts_list",
    {
      description: "Read published note links from a creator page through the rendered DOM.",
      inputSchema: {
        accountId: z.string(),
        creatorUrl: z.string().url(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ accountId, creatorUrl, limit }) => {
      await requireAccount(env, accountId);
      const taskId = crypto.randomUUID();
      await createTask(env, { id: taskId, accountId, kind: "note_posts_list", status: "running" });
      try {
        const result = await callCoordinator(env, accountId, "/posts/list", { taskId, creatorUrl, limit });
        await updateTask(env, taskId, "succeeded", result);
        return output(result);
      } catch (error) {
        await updateTask(env, taskId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  );

  server.registerTool(
    "note_publish",
    {
      description: "Publish a note through the rendered UI. Requires explicit confirm=true.",
      inputSchema: {
        accountId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(200_000),
        confirm: z.literal(true),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ accountId, title, body, idempotencyKey }) => {
      await requireAccount(env, accountId);
      const taskId = crypto.randomUUID();
      try {
        await createTask(env, { id: taskId, accountId, kind: "note_publish", status: "running", idempotencyKey });
      } catch {
        const existing = await env.DB.prepare(
          "SELECT id FROM tasks WHERE account_id = ? AND idempotency_key = ?",
        )
          .bind(accountId, idempotencyKey)
          .first<{ id: string }>();
        if (!existing) throw new Error("Could not create task");
        return output(await getTask(env, existing.id));
      }
      try {
        const result = await callCoordinator(env, accountId, "/publish", { taskId, title, body });
        await updateTask(env, taskId, "succeeded", result);
        return output(result);
      } catch (error) {
        await updateTask(env, taskId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  );

  server.registerTool(
    "task_get",
    {
      description: "Get the durable result or error for a task.",
      inputSchema: { taskId: z.string().uuid() },
    },
    async ({ taskId }) => output(await getTask(env, taskId)),
  );

  return server;
}
