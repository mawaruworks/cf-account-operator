import { createMcpHandler } from "agents/mcp/server";
import { AccountCoordinator } from "./account-coordinator";
import { createMcpServer } from "./mcp";
import { isAuthorized } from "./security";
import type { Env } from "./types";

export { AccountCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "cf-account-operator", version: "0.1.0" });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!isAuthorized(request, env.MCP_API_KEY)) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    return createMcpHandler(() => createMcpServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
