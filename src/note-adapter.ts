import type { BrowserContext, Page } from "@cloudflare/playwright";
import { assertAllowedUrl } from "./security";

const NOTE_HOSTS = new Set(["note.com", "www.note.com"]);
const COMPOSER_URL = "https://note.com/notes/new";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("The note session is not authenticated. Run account_login_start first.");
  }
}

export async function openNoteLogin(page: Page): Promise<void> {
  await page.goto("https://note.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 });
  assertAllowedUrl(page.url(), NOTE_HOSTS);
}

export async function createNoteDraft(
  context: BrowserContext,
  title: string,
  body: string,
): Promise<{ url: string }> {
  const page = await context.newPage();
  try {
    await page.goto(COMPOSER_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assertAllowedUrl(page.url(), NOTE_HOSTS);
    if (/\/login(?:[/?#]|$)/.test(new URL(page.url()).pathname)) throw new AuthenticationRequiredError();

    const titleLocator = page
      .locator('textarea[placeholder*="タイトル"], input[placeholder*="タイトル"], [contenteditable="true"][data-placeholder*="タイトル"]')
      .first();
    await titleLocator.waitFor({ state: "visible", timeout: 20_000 });
    await titleLocator.fill(title);

    const editable = page.locator('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]').last();
    await editable.waitFor({ state: "visible", timeout: 20_000 });
    await editable.fill(body);

    // note normally autosaves. If a dedicated draft-save button exists, it is safe to use;
    // this adapter intentionally never clicks a publish button.
    const saveButton = page.getByRole("button", { name: /下書き保存|保存する/ }).first();
    if (await saveButton.isVisible().catch(() => false)) await saveButton.click();

    await page.waitForTimeout(2_000);
    assertAllowedUrl(page.url(), NOTE_HOSTS);
    return { url: page.url() };
  } finally {
    await page.close();
  }
}
