import {
  BACKEND_PRIORITY,
  backendOrder as sharedBackendOrder,
  selectBackend as sharedSelectBackend,
} from "../shared/backend.js";
import type { BrowserBackend } from "../shared/backend.js";

export { BACKEND_PRIORITY };

export function backendOrder(requested = process.env.NOTE_BROWSER_BACKEND): BrowserBackend[] {
  return sharedBackendOrder(requested ?? "auto");
}

export function selectAvailableBackend(
  available: ReadonlySet<BrowserBackend>,
  requested = process.env.NOTE_BROWSER_BACKEND,
): BrowserBackend {
  return sharedSelectBackend(available, requested ?? "auto");
}
