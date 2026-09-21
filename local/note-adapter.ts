import type { BrowserContext, Page } from "playwright-core";
import type { NotePostSummary } from "./types.js";

export const NOTE_HOSTS = new Set(["note.com", "www.note.com", "editor.note.com"]);
export const NOTE_LOGIN_URL = "https://note.com/login";
export const NOTE_COMPOSER_URL = "https://note.com/notes/new";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("The note session is not authenticated. Run account_login_start first.");
    this.name = "AuthenticationRequiredError";
  }
}

export interface NoteAuthenticationStatus {
  authenticated: boolean;
  url: string;
}

export async function openNoteLogin(context: BrowserContext): Promise<Page> {
  const page = await getWorkingPage(context);
  await page.goto(NOTE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assertNoteUrl(page.url());
  return page;
}

export async function isNoteAuthenticated(context: BrowserContext): Promise<boolean> {
  return (await getNoteAuthenticationStatus(context)).authenticated;
}

export async function getNoteAuthenticationStatus(context: BrowserContext): Promise<NoteAuthenticationStatus> {
  const page = await getWorkingPage(context);
  await gotoComposer(page);
  assertNoteUrl(page.url());
  return { authenticated: !isNoteLoginUrl(page.url()), url: page.url() };
}

export async function requireNoteAuthentication(context: BrowserContext): Promise<void> {
  if (!(await isNoteAuthenticated(context))) throw new AuthenticationRequiredError();
}

export async function createNoteDraft(
  context: BrowserContext,
  title: string,
  body: string,
): Promise<{ url: string }> {
  const page = await prepareComposer(context, title, body);
  try {
    const saveButton = page.getByRole("button", { name: /下書き保存|保存する/ }).first();
    if (await saveButton.isVisible().catch(() => false)) await saveButton.click();
    await page.waitForTimeout(2_000);
    assertNoteUrl(page.url());
    return { url: page.url() };
  } finally {
    await page.close();
  }
}

export async function publishNote(
  context: BrowserContext,
  title: string,
  body: string,
): Promise<{ url: string }> {
  const page = await prepareComposer(context, title, body);
  try {
    const proceedButton = page.getByRole("button", { name: /公開に進む/ }).first();
    await proceedButton.waitFor({ state: "visible", timeout: 20_000 });
    await proceedButton.click();

    const publishButton = page.getByRole("button", { name: /^(公開する|投稿する)$/ }).last();
    await publishButton.waitFor({ state: "visible", timeout: 20_000 });
    await publishButton.click();
    const updateButton = page.getByRole("button", { name: /^更新する$/ }).last();
    await updateButton.waitFor({ state: "visible", timeout: 30_000 });
    const editorUrl = assertNoteUrl(page.url());
    const match = editorUrl.pathname.match(/^\/notes\/([^/]+)\/publish\/?$/);
    const noteId = match?.[1];
    if (!noteId) throw new Error("Publish succeeded but the editor article ID could not be resolved");
    return { url: await resolvePublishedUrl(page, noteId) };
  } finally {
    await page.close();
  }
}

export async function listNotePosts(
  context: BrowserContext,
  creatorUrl: string,
  limit: number,
): Promise<{ url: string; posts: NotePostSummary[] }> {
  assertNoteUrl(creatorUrl);
  await requireNoteAuthentication(context);
  const page = await getWorkingPage(context);
  try {
    await page.goto(creatorUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assertNoteUrl(page.url());
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const candidates = await page.locator('a[href*="/n/"]').evaluateAll((elements) =>
      elements.map((element) => {
        const anchor = element as unknown as {
          getAttribute(name: string): string | null;
          textContent: string | null;
          href: string;
        };
        return {
          title: (anchor.getAttribute("aria-label") ?? anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
          url: anchor.href,
        };
      }),
    );
    return { url: page.url(), posts: normalizePostLinks(candidates, limit) };
  } finally {
    await page.close();
  }
}

export function normalizePostLinks(
  candidates: Array<{ title: string; url: string }>,
  limit: number,
): NotePostSummary[] {
  const results: NotePostSummary[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.url);
      if (!NOTE_HOSTS.has(url.hostname) || !url.pathname.includes("/n/")) continue;
      const normalizedUrl = `${url.origin}${url.pathname}`;
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      results.push({ title: candidate.title.trim() || normalizedUrl, url: normalizedUrl });
      if (results.length >= limit) break;
    } catch {
      // Ignore malformed links returned by the page.
    }
  }
  return results;
}

export function assertNoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !NOTE_HOSTS.has(url.hostname)) {
    throw new Error(`Navigation blocked: ${url.hostname}`);
  }
  return url;
}

export function isNoteLoginUrl(value: string): boolean {
  return /\/login(?:[/?#]|$)/.test(new URL(value).pathname);
}

async function prepareComposer(context: BrowserContext, title: string, body: string): Promise<Page> {
  const page = await getWorkingPage(context);
  await gotoComposer(page);
  assertNoteUrl(page.url());
  if (isNoteLoginUrl(page.url())) throw new AuthenticationRequiredError();

  const titleLocator = page
    .locator(
      'textarea[placeholder*="タイトル"], input[placeholder*="タイトル"], [contenteditable="true"][data-placeholder*="タイトル"]',
    )
    .first();
  await titleLocator.waitFor({ state: "visible", timeout: 20_000 });
  await titleLocator.fill(title);

  const editable = page.locator('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]').last();
  await editable.waitFor({ state: "visible", timeout: 20_000 });
  await editable.fill(body);
  return page;
}

async function getWorkingPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? context.newPage();
}

async function gotoComposer(page: Page): Promise<void> {
  try {
    await page.goto(NOTE_COMPOSER_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    if (!isExpectedNavigationAbort(error)) throw error;
  }
}

async function resolvePublishedUrl(page: Page, noteId: string): Promise<string> {
  const lookupUrl = `https://note.com/notes/${encodeURIComponent(noteId)}`;
  try {
    await page.goto(lookupUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    if (!isExpectedNavigationAbort(error)) throw error;
  }
  assertNoteUrl(page.url());
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const url = new URL(page.url());
  if (!/^\/[^/]+\/n\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error(`Publish completed but the public note URL was not resolved: ${url.pathname}`);
  }
  return `${url.origin}${url.pathname}`;
}

function isExpectedNavigationAbort(error: unknown): boolean {
  return error instanceof Error && /ERR_ABORTED|Navigation was aborted/i.test(error.message);
}
