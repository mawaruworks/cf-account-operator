import { describe, expect, it } from "vitest";
import { assertAllowedUrl, decryptJson, encryptJson, isAuthorized, isValidAccountId } from "../src/security";

describe("account IDs", () => {
  it("accepts safe stable identifiers", () => {
    expect(isValidAccountId("note-history")).toBe(true);
    expect(isValidAccountId("../secret")).toBe(false);
    expect(isValidAccountId("Uppercase")).toBe(false);
  });
});

describe("bearer authentication", () => {
  it("fails closed and accepts only an exact token", () => {
    const token = "a-very-long-random-token-value";
    expect(isAuthorized(new Request("https://example.com/mcp"), token)).toBe(false);
    expect(
      isAuthorized(new Request("https://example.com/mcp", { headers: { authorization: `Bearer ${token}` } }), token),
    ).toBe(true);
    expect(
      isAuthorized(new Request("https://example.com/mcp", { headers: { authorization: "Bearer wrong" } }), token),
    ).toBe(false);
  });
});

describe("profile encryption", () => {
  it("round trips and binds ciphertext to account and version", async () => {
    const key = "11".repeat(32);
    const encrypted = await encryptJson({ cookies: [{ name: "session", value: "secret" }] }, key, "a:v1");
    expect(encrypted).not.toContain("secret");
    await expect(decryptJson(encrypted, key, "a:v1")).resolves.toEqual({
      cookies: [{ name: "session", value: "secret" }],
    });
    await expect(decryptJson(encrypted, key, "a:v2")).rejects.toThrow();
  });
});

describe("navigation allowlist", () => {
  it("blocks non-HTTPS and unlisted hosts", () => {
    expect(assertAllowedUrl("https://note.com/login", new Set(["note.com"])).hostname).toBe("note.com");
    expect(() => assertAllowedUrl("http://note.com/login", new Set(["note.com"]))).toThrow();
    expect(() => assertAllowedUrl("https://evil.example", new Set(["note.com"]))).toThrow();
  });

  it("allows note's editor host when explicitly included", () => {
    expect(assertAllowedUrl("https://editor.note.com/notes/new", new Set(["note.com", "editor.note.com"])).hostname).toBe(
      "editor.note.com",
    );
  });
});
