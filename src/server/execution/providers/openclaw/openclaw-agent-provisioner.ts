import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getEnv, isIntegrationConfigured } from "@/lib/env";

const execFileAsync = promisify(execFile);

// Her projeye kendi OpenClaw ajanını açar. Bu, eski 3 adımlı kurulum
// sihirbazından taşındı: yeni 12 aşamalı akış tarayıcı profillerini
// oluşturuyordu ama ajanı oluşturmuyordu, bu yüzden profil slug'ından
// türetilen ajan kimliği OpenClaw'da hiç bulunmuyor ve her gerçek tarayıcı
// görevi `Unknown agent id` ile düşüyordu.
//
// Başarısızlıkta null döner — ajan açılamadıysa iş varsayılan ajana düşer
// (bkz. openclaw-provider.ts resolveAgentId), kurulum bu yüzden durmamalı.
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
      `[openclaw-agent-provisioner] ${projectSlug} için ajan açılamadı`,
      error,
    );
    return null;
  }
}
