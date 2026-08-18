import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getEnv, isIntegrationConfigured } from "@/lib/env";

const execFileAsync = promisify(execFile);

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
  if (!isIntegrationConfigured("OPENCLAW")) return null;

  const env = getEnv();
  const command = env.OPENCLAW_NODE_PATH || env.OPENCLAW_CLI_PATH;
  const args = [
    "agents",
    "add",
    projectSlug,
    "--non-interactive",
    "--workspace",
    `${process.env.HOME}/.openclaw/workspaces/${projectSlug}`,
    "--json",
  ];
  const commandArgs = env.OPENCLAW_NODE_PATH
    ? [env.OPENCLAW_CLI_PATH, ...args]
    : args;

  try {
    await execFileAsync(command, commandArgs, { timeout: 30_000 });
    return projectSlug;
  } catch (error) {
    console.error(
      `[openclaw-agent-provisioner] failed to provision agent for ${projectSlug}`,
      error,
    );
    return null;
  }
}
