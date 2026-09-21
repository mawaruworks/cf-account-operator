import type { AccountRecord, Env, Platform } from "./types";

export async function upsertAccount(
  env: Env,
  account: { id: string; platform: Platform; displayName: string },
): Promise<AccountRecord> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO accounts (id, platform, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET platform = excluded.platform,
       display_name = excluded.display_name, updated_at = excluded.updated_at`,
  )
    .bind(account.id, account.platform, account.displayName, now, now)
    .run();
  return account;
}

export async function listAccounts(env: Env): Promise<AccountRecord[]> {
  const result = await env.DB.prepare(
    "SELECT id, platform, display_name AS displayName FROM accounts ORDER BY id",
  ).all<AccountRecord>();
  return result.results;
}

export async function requireAccount(env: Env, accountId: string): Promise<AccountRecord> {
  const row = await env.DB.prepare(
    "SELECT id, platform, display_name AS displayName FROM accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<AccountRecord>();
  if (!row) throw new Error(`Unknown account: ${accountId}`);
  return row;
}

export async function createTask(
  env: Env,
  values: { id: string; accountId: string; kind: string; status: string; idempotencyKey?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tasks (id, account_id, kind, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(values.id, values.accountId, values.kind, values.status, values.idempotencyKey ?? null, now, now)
    .run();
}

export async function updateTask(env: Env, taskId: string, status: string, result?: unknown, error?: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE tasks SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?",
  )
    .bind(status, result ? JSON.stringify(result) : null, error ?? null, new Date().toISOString(), taskId)
    .run();
}

export async function getTask(env: Env, taskId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT id, account_id AS accountId, kind, status, idempotency_key AS idempotencyKey,
      result_json AS resultJson, error, created_at AS createdAt, updated_at AS updatedAt
     FROM tasks WHERE id = ?`,
  )
    .bind(taskId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error(`Unknown task: ${taskId}`);
  return { ...row, result: row.resultJson ? JSON.parse(String(row.resultJson)) : undefined, resultJson: undefined };
}
