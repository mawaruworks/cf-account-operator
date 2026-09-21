import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { AccountStore } from "./account-store.js";
import type { RuntimeRecord } from "./types.js";

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

interface ManagedBrowser {
  browser: Browser;
  context: BrowserContext;
  process?: ChildProcess;
  record: RuntimeRecord;
  closing: boolean;
}

export interface BrowserStartOptions {
  headless: boolean;
  startUrl?: string;
}

export class CdpBrowserManager {
  private readonly active = new Map<string, ManagedBrowser>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly accounts: AccountStore) {}

  async exclusive<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.queues.set(accountId, tail);
    try {
      return await current;
    } finally {
      if (this.queues.get(accountId) === tail) this.queues.delete(accountId);
    }
  }

  async hasLiveRuntime(accountId: string): Promise<boolean> {
    const record = await this.accounts.readRuntime(accountId);
    if (!record) return false;
    if (!isProcessAlive(record.pid)) {
      await this.accounts.clearRuntime(accountId);
      return false;
    }
    return true;
  }

  async start(accountId: string, options: BrowserStartOptions): Promise<BrowserContext> {
    await this.accounts.get(accountId);
    const active = this.active.get(accountId);
    if (active) return active.context;

    const persisted = await this.accounts.readRuntime(accountId);
    if (persisted && isProcessAlive(persisted.pid)) {
      try {
        return await this.attach(accountId, persisted);
      } catch (error) {
        throw new Error(
          `Account ${accountId} already has a live browser process on port ${persisted.port}, but it could not be attached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (persisted) await this.accounts.clearRuntime(accountId);

    const profileDir = await this.accounts.profileDir(accountId);
    const port = await findFreePort();
    const chromePath = resolveChromePath();
    const args = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
    ];
    if (options.headless) args.unshift("--headless=new");
    args.push(options.startUrl ?? "about:blank");

    const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.length > 8) stderr.shift();
    });
    try {
      await waitForCdp(port, child, () => stderr.join("").trim());
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = getDefaultContext(browser);
      const record: RuntimeRecord = {
        accountId,
        pid: child.pid ?? -1,
        port,
        profileDir,
        headless: options.headless,
        startedAt: new Date().toISOString(),
      };
      const managed: ManagedBrowser = { browser, context, process: child, record, closing: false };
      this.active.set(accountId, managed);
      await this.accounts.writeRuntime(record);
      this.observeDisconnect(accountId, managed);
      return context;
    } catch (error) {
      child.kill("SIGTERM");
      await this.accounts.clearRuntime(accountId);
      throw error;
    }
  }

  async stop(accountId: string): Promise<void> {
    const managed = this.active.get(accountId);
    const record = managed?.record ?? (await this.accounts.readRuntime(accountId));
    if (!record) return;
    if (managed) {
      managed.closing = true;
      await withTimeout(managed.browser.close(), CLOSE_TIMEOUT_MS).catch(() => undefined);
      this.active.delete(accountId);
    }
    const shouldKill = Boolean(managed) || (isProcessAlive(record.pid) && (await isCdpReachable(record.port)));
    if (shouldKill && isProcessAlive(record.pid)) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {
        // The process may have exited between the liveness check and kill.
      }
      await waitForProcessExit(record.pid, PROCESS_STOP_TIMEOUT_MS);
      if (isProcessAlive(record.pid)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // The process may have exited between the liveness check and kill.
        }
      }
    }
    await this.accounts.clearRuntime(accountId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((accountId) => this.stop(accountId)));
  }

  async describe(accountId: string): Promise<Record<string, unknown>> {
    await this.accounts.get(accountId);
    const record = await this.accounts.readRuntime(accountId);
    return {
      active: Boolean(record && isProcessAlive(record.pid)),
      ...(record
        ? {
            pid: record.pid,
            port: record.port,
            headless: record.headless,
            startedAt: record.startedAt,
            profileDir: record.profileDir,
          }
        : {}),
    };
  }

  private async attach(accountId: string, record: RuntimeRecord): Promise<BrowserContext> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${record.port}`);
    const context = getDefaultContext(browser);
    const managed: ManagedBrowser = { browser, context, record, closing: false };
    this.active.set(accountId, managed);
    this.observeDisconnect(accountId, managed);
    return context;
  }

  private observeDisconnect(accountId: string, managed: ManagedBrowser): void {
    managed.browser.on("disconnected", () => {
      if (managed.closing) return;
      this.active.delete(accountId);
      void this.accounts.clearRuntime(accountId);
    });
  }
}

function getDefaultContext(browser: Browser): BrowserContext {
  const context = browser.contexts()[0];
  if (!context) throw new Error("The CDP browser did not expose a persistent browser context");
  return context;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveChromePath(): string {
  const configured = process.env.NOTE_CHROME_PATH ?? process.env.CHROME_PATH;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!candidate.includes("/") || canExecute(candidate)) return candidate;
  }
  throw new Error("Chrome was not found. Set NOTE_CHROME_PATH to a Chromium executable.");
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a local CDP port");
  return address.port;
}

async function waitForCdp(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready${stderr() ? `: ${stderr()}` : ""}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for Chrome CDP on port ${port}${stderr() ? `: ${stderr()}` : ""}`);
}

async function isCdpReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out closing browser")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
