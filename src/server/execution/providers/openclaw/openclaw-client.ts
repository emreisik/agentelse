import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import { openClawAgentListSchema } from "@/server/execution/providers/openclaw/openclaw-schemas";

const execFileAsync = promisify(execFile);

const AGENT_CACHE_TTL_MS = 60_000;
let agentIdCache: { ids: ReadonlySet<string>; fetchedAt: number } | null = null;

// Thin wrapper over the real OpenClaw CLI — used only for `agents list`
// now. The actual agent-turn execution (`agent --json`) moved to
// openclaw-gateway-client.ts (WebSocket, non-blocking); this class stopped
// carrying that logic once OpenClawProvider switched to the Gateway. Kept
// around because image generation (openclaw-image-client.ts) and agent
// provisioning (openclaw-agent-provisioner.ts) still shell out to the CLI
// directly for their own commands, and OpenClawProvider.resolveAgentId
// still needs listAgentIds() to validate a candidate agent id.
export class OpenClawClient {
  get isConfigured(): boolean {
    return isIntegrationConfigured("OPENCLAW");
  }

  // Agent ids configured in the local OpenClaw install. Cached because the
  // provider consults it on every dispatch; a newly added agent shows up
  // after the TTL (or a server restart), which is fine for a config list.
  async listAgentIds(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (agentIdCache && now - agentIdCache.fetchedAt < AGENT_CACHE_TTL_MS) {
      return agentIdCache.ids;
    }

    const env = getEnv();
    if (!env.OPENCLAW_CLI_PATH) return new Set();

    const command = env.OPENCLAW_NODE_PATH || env.OPENCLAW_CLI_PATH;
    const commandArgs = env.OPENCLAW_NODE_PATH
      ? [env.OPENCLAW_CLI_PATH, "agents", "list", "--json"]
      : ["agents", "list", "--json"];

    try {
      const { stdout } = await execFileAsync(command, commandArgs, {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed = openClawAgentListSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) return agentIdCache?.ids ?? new Set();
      const ids = new Set(parsed.data.map((agent) => agent.id));
      agentIdCache = { ids, fetchedAt: now };
      return ids;
    } catch {
      // Gateway down / CLI unusable — keep whatever we knew, and let the
      // caller fall back to the default agent rather than hard-failing.
      return agentIdCache?.ids ?? new Set();
    }
  }
}
