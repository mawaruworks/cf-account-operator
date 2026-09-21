import { DurableObject } from "cloudflare:workers";
import { launch, type Browser, type BrowserContext, type Page } from "@cloudflare/playwright";
import { createNoteDraft, openNoteLogin } from "./note-adapter";
import { ProfileStore } from "./profile-store";
import type { CoordinatorStatus, DraftResult, Env, LoginStartResult } from "./types";

const LEASE_MS = 10 * 60 * 1_000;

interface PersistentState {
  status: CoordinatorStatus["status"];
  currentTaskId?: string;
  leaseExpiresAt?: number;
  profileVersion?: string;
}

export class AccountCoordinator extends DurableObject<Env> {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json<Record<string, unknown>>() : {};
      const accountId = this.requiredString(body.accountId, "accountId");

      switch (url.pathname) {
        case "/status":
          return Response.json(await this.status(accountId));
        case "/login/start":
          return Response.json(await this.startLogin(accountId, this.requiredString(body.taskId, "taskId")));
        case "/login/complete":
          return Response.json(await this.completeLogin(accountId, this.requiredString(body.taskId, "taskId")));
        case "/draft/create":
          return Response.json(
            await this.createDraft(
              accountId,
              this.requiredString(body.taskId, "taskId"),
              this.requiredString(body.title, "title"),
              this.requiredString(body.body, "body"),
            ),
          );
        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return Response.json({ error: message }, { status: message.includes("busy") ? 409 : 400 });
    }
  }

  override async alarm(): Promise<void> {
    const state = await this.readState();
    if (state.status !== "needs_human") return;
    if (!state.leaseExpiresAt || state.leaseExpiresAt <= Date.now()) {
      await this.closeBrowser();
      await this.writeState({ status: "idle", profileVersion: state.profileVersion });
      return;
    }
    try {
      await this.browser?.version();
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    } catch {
      await this.writeState({ status: "idle", profileVersion: state.profileVersion });
    }
  }

  private async startLogin(accountId: string, taskId: string): Promise<LoginStartResult> {
    const state = await this.acquire(taskId, "needs_human");
    const profiles = new ProfileStore(this.env.PROFILES, this.env.PROFILE_ENCRYPTION_KEY);
    const storageState = await profiles.load(accountId, state.profileVersion);

    try {
      this.browser = await launch(this.env.BROWSER, { keep_alive: LEASE_MS });
      this.context = await this.browser.newContext({ storageState });
      this.page = await this.context.newPage();
      await openNoteLogin(this.page);
      const cdp = await this.context.newCDPSession(this.page);
      const { devtoolsFrontendUrl } = await cdp.send("Cloudflare.getLiveView", {
        mode: "tab",
        expiresInMs: LEASE_MS,
      });
      const { handoffId } = await cdp.send("Cloudflare.handoff", {
        instructions: "Log in to note, complete any MFA or CAPTCHA, then select Done.",
        timeout: LEASE_MS,
      });
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return {
        taskId,
        status: "needs_human",
        liveViewUrl: devtoolsFrontendUrl,
        handoffId,
        expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        instructions: "Open the Live View URL, log in to note, select Done, then call account_login_complete.",
      };
    } catch (error) {
      await this.release(state.profileVersion);
      throw error;
    }
  }

  private async completeLogin(accountId: string, taskId: string): Promise<{ status: "succeeded"; profileVersion: string }> {
    const state = await this.requireLease(taskId, "needs_human");
    if (!this.context || !this.page || !this.browser) {
      await this.release(state.profileVersion);
      throw new Error("The login browser expired. Start the login flow again.");
    }
    if (/\/login(?:[/?#]|$)/.test(new URL(this.page.url()).pathname)) {
      throw new Error("Login does not appear to be complete yet");
    }
    const profiles = new ProfileStore(this.env.PROFILES, this.env.PROFILE_ENCRYPTION_KEY);
    const storageState = await this.context.storageState({ indexedDB: true });
    const profileVersion = await profiles.save(accountId, storageState);
    await this.closeBrowser();
    await this.release(profileVersion);
    return { status: "succeeded", profileVersion };
  }

  private async createDraft(accountId: string, taskId: string, title: string, body: string): Promise<DraftResult> {
    const state = await this.acquire(taskId, "running");
    const profiles = new ProfileStore(this.env.PROFILES, this.env.PROFILE_ENCRYPTION_KEY);
    try {
      const storageState = await profiles.load(accountId, state.profileVersion);
      if (!storageState) throw new Error("No login profile exists. Run account_login_start first.");
      const browser = await launch(this.env.BROWSER);
      try {
        const context = await browser.newContext({ storageState });
        const result = await createNoteDraft(context, title, body);
        const updatedState = await context.storageState({ indexedDB: true });
        const profileVersion = await profiles.save(accountId, updatedState);
        await this.release(profileVersion);
        return { taskId, status: "succeeded", url: result.url, profileVersion };
      } finally {
        await browser.close();
      }
    } catch (error) {
      await this.release(state.profileVersion);
      throw error;
    }
  }

  private async acquire(taskId: string, status: "running" | "needs_human"): Promise<PersistentState> {
    const state = await this.readState();
    if (state.currentTaskId && state.leaseExpiresAt && state.leaseExpiresAt > Date.now()) {
      throw new Error(`Account is busy with task ${state.currentTaskId}`);
    }
    const next: PersistentState = {
      status,
      currentTaskId: taskId,
      leaseExpiresAt: Date.now() + LEASE_MS,
      profileVersion: state.profileVersion,
    };
    await this.writeState(next);
    return next;
  }

  private async requireLease(taskId: string, status: PersistentState["status"]): Promise<PersistentState> {
    const state = await this.readState();
    if (state.currentTaskId !== taskId || state.status !== status || (state.leaseExpiresAt ?? 0) <= Date.now()) {
      throw new Error("Task lease is missing or expired");
    }
    return state;
  }

  private async release(profileVersion?: string): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.writeState({ status: "idle", profileVersion });
  }

  private async status(accountId: string): Promise<CoordinatorStatus> {
    const state = await this.readState();
    return { accountId, ...state };
  }

  private async readState(): Promise<PersistentState> {
    return (await this.ctx.storage.get<PersistentState>("state")) ?? { status: "idle" };
  }

  private async writeState(state: PersistentState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  private async closeBrowser(): Promise<void> {
    try {
      await this.browser?.close();
    } finally {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
    }
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
    return value;
  }
}
