import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AccountConfig, RuntimeRecord } from "./types.js";

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DEFAULT_CONFIG_ROOT = process.env.XDG_CONFIG_HOME
  ?? (process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : join(homedir(), ".config"));
const DEFAULT_ROOT = join(DEFAULT_CONFIG_ROOT, "cf-account-operator", "note-accounts");

export function isValidLocalAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function assertLocalAccountId(value: string): string {
  if (!isValidLocalAccountId(value)) throw new Error("accountId must match [a-z0-9][a-z0-9-]{1,62}");
  return value;
}

export function resolveProfileRoot(value = process.env.NOTE_PROFILE_ROOT): string {
  if (value && !isAbsolute(value)) throw new Error("NOTE_PROFILE_ROOT must be an absolute path");
  return resolve(value ?? DEFAULT_ROOT);
}

export class AccountStore {
  readonly root: string;
  private readonly accountsPath: string;

  constructor(root = resolveProfileRoot()) {
    this.root = resolveProfileRoot(root);
    this.accountsPath = join(this.root, "accounts.json");
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
  }

  async list(): Promise<AccountConfig[]> {
    return Object.values(await this.readAccounts()).sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  async get(accountId: string): Promise<AccountConfig> {
    assertLocalAccountId(accountId);
    const account = (await this.readAccounts())[accountId];
    if (!account) throw new Error(`Unknown account: ${accountId}`);
    return account;
  }

  async upsert(input: { accountId: string; displayName: string; creatorUrl?: string }): Promise<AccountConfig> {
    assertLocalAccountId(input.accountId);
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 100) throw new Error("displayName must be 1-100 characters");
    await this.ensure();
    const accounts = await this.readAccounts();
    const now = new Date().toISOString();
    const existing = accounts[input.accountId];
    const account: AccountConfig = {
      accountId: input.accountId,
      displayName,
      ...(input.creatorUrl ? { creatorUrl: input.creatorUrl } : existing?.creatorUrl ? { creatorUrl: existing.creatorUrl } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    accounts[input.accountId] = account;
    await this.writeAccounts(accounts);
    await this.profileDir(input.accountId);
    return account;
  }

  async profileDir(accountId: string): Promise<string> {
    assertLocalAccountId(accountId);
    const directory = join(this.root, accountId, "chrome-profile");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    return directory;
  }

  runtimePath(accountId: string): string {
    assertLocalAccountId(accountId);
    return join(this.root, accountId, "runtime.json");
  }

  async readRuntime(accountId: string): Promise<RuntimeRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.runtimePath(accountId), "utf8")) as RuntimeRecord;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeRuntime(record: RuntimeRecord): Promise<void> {
    const path = this.runtimePath(record.accountId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }

  async clearRuntime(accountId: string): Promise<void> {
    await rm(this.runtimePath(accountId), { force: true });
  }

  private async readAccounts(): Promise<Record<string, AccountConfig>> {
    await this.ensure();
    try {
      const parsed = JSON.parse(await readFile(this.accountsPath, "utf8")) as Record<string, AccountConfig>;
      return parsed ?? {};
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw new Error(`Could not read ${this.accountsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeAccounts(accounts: Record<string, AccountConfig>): Promise<void> {
    await this.ensure();
    const temporaryPath = `${this.accountsPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, this.accountsPath);
  }
}
