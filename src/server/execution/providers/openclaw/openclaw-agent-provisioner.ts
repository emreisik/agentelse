import "server-only";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import { OpenClawGatewayClient } from "@/server/execution/providers/openclaw/openclaw-gateway-client";

// Provisions a dedicated OpenClaw agent for each project. Carried over from
// the old 3-step setup wizard: the new 12-stage flow was creating browser
// profiles but not the agent, so the agent id derived from the profile slug
// never existed in OpenClaw, and every real browser task failed with
// `Unknown agent id`.
//
// Returns null on failure — if the agent can't be provisioned, the job
// falls back to the default agent (see openclaw-provider.ts resolveAgentId),
// so setup must not stop because of this.
export async function provisionOpenClawAgent(
  projectSlug: string,
): Promise<string | null> {
  if (!isIntegrationConfigured("OPENCLAW_GATEWAY")) return null;

  const env = getEnv();
  // `workspace` is resolved by the Gateway process itself, not this app —
  // see OPENCLAW_GATEWAY_WORKSPACE_ROOT's doc comment in env.ts.
  const workspace = `${env.OPENCLAW_GATEWAY_WORKSPACE_ROOT}/${projectSlug}`;

  const created = await OpenClawGatewayClient.createAgent({
    id: projectSlug,
    workspace,
  });
  return created ? projectSlug : null;
}
