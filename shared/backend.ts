export type BrowserBackend = "cdp" | "cua" | "cf";

export const BACKEND_PRIORITY: readonly BrowserBackend[] = ["cdp", "cua", "cf"];

export function backendOrder(requested = "auto"): BrowserBackend[] {
  if (requested === "auto") return [...BACKEND_PRIORITY];
  if (requested !== "cdp" && requested !== "cua" && requested !== "cf") {
    throw new Error("Backend must be auto, cdp, cua, or cf");
  }
  return [requested, ...BACKEND_PRIORITY.filter((backend) => backend !== requested)];
}

export function selectBackend(
  available: ReadonlySet<BrowserBackend>,
  requested = "auto",
): BrowserBackend {
  const order = backendOrder(requested);
  if (requested !== "auto") {
    const explicit = order[0];
    if (!explicit || !available.has(explicit)) throw new Error(`Requested backend is unavailable: ${requested}`);
    return explicit;
  }
  const selected = order.find((backend) => available.has(backend));
  if (!selected) throw new Error("No browser backend is available");
  return selected;
}
