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

export interface NotePostSummary {
  title: string;
  url: string;
}

export interface NotePostsResult {
  taskId: string;
  status: "succeeded";
  url: string;
  posts: NotePostSummary[];
  profileVersion: string;
}

export interface PublishResult {
  taskId: string;
  status: "succeeded";
  url: string;
  profileVersion: string;
}

export interface AuthenticationStatus {
  state: "authenticated" | "login_required" | "needs_human" | "busy";
  authenticated: boolean | null;
  checkedUrl?: string;
  next?: string;
}

export interface CoordinatorStatus {
  accountId: string;
  status: "idle" | "running" | "needs_human";
  currentTaskId?: string;
  leaseExpiresAt?: number;
  profileVersion?: string;
  authentication: AuthenticationStatus;
}
