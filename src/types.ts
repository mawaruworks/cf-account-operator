export type Platform = "note";

export interface Env {
  BROWSER: Fetcher;
  PROFILES: R2Bucket;
  DB: D1Database;
  ACCOUNTS: DurableObjectNamespace;
  MCP_API_KEY: string;
  PROFILE_ENCRYPTION_KEY: string;
}

export interface AccountRecord {
  id: string;
  platform: Platform;
  displayName: string;
}

export interface LoginStartResult {
  taskId: string;
  status: "needs_human";
  liveViewUrl: string;
  handoffId: string;
  expiresAt: string;
  instructions: string;
}

export interface DraftResult {
  taskId: string;
  status: "succeeded";
  url: string;
  profileVersion: string;
}

export interface CoordinatorStatus {
  accountId: string;
  status: "idle" | "running" | "needs_human";
  currentTaskId?: string;
  leaseExpiresAt?: number;
  profileVersion?: string;
}
