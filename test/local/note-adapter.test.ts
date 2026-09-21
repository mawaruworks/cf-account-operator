import { describe, expect, it } from "vitest";
import { isNoteLoginUrl, normalizePostLinks } from "../../local/note-adapter.js";

describe("local note adapter", () => {
  it("normalizes and deduplicates rendered article links", () => {
    expect(
      normalizePostLinks(
        [
          { title: " First article ", url: "https://note.com/example/n/abc?from=home" },
          { title: "duplicate", url: "https://note.com/example/n/abc" },
          { title: "Second", url: "https://www.note.com/example/n/def#top" },
          { title: "external", url: "https://evil.example/example/n/nope" },
        ],
        10,
      ),
    ).toEqual([
      { title: "First article", url: "https://note.com/example/n/abc" },
      { title: "Second", url: "https://www.note.com/example/n/def" },
    ]);
  });

  it("recognizes login redirects without treating other paths as logged out", () => {
    expect(isNoteLoginUrl("https://note.com/login?redirect=/notes/new")).toBe(true);
    expect(isNoteLoginUrl("https://note.com/notes/new")).toBe(false);
  });
});
