export type BrowserBackend = "cdp" | "cua" | "cf";

export interface AccountConfig {
  accountId: string;
  displayName: string;
  creatorUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRecord {
  accountId: string;
  pid: number;
  port: number;
  profileDir: string;
  headless: boolean;
  startedAt: string;
}

export interface NotePostSummary {
  title: string;
  url: string;
}
