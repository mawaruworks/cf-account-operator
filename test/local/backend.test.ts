import { describe, expect, it } from "vitest";
import { backendOrder, selectAvailableBackend } from "../../local/backend-selection.js";

describe("browser backend routing", () => {
  it("prefers CDP, then CUA, then CF in auto mode", () => {
    expect(backendOrder("auto")).toEqual(["cdp", "cua", "cf"]);
    expect(selectAvailableBackend(new Set(["cua", "cf"]), "auto")).toBe("cua");
    expect(selectAvailableBackend(new Set(["cf"]), "auto")).toBe("cf");
  });

  it("keeps the explicit backend first while retaining fallback order", () => {
    expect(backendOrder("cf")).toEqual(["cf", "cdp", "cua"]);
    expect(selectAvailableBackend(new Set(["cf", "cdp"]), "cf")).toBe("cf");
    expect(() => selectAvailableBackend(new Set(["cdp"]), "cua")).toThrow("Requested backend is unavailable");
  });
});
