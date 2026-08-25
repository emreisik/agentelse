import { beforeEach, describe, expect, it, vi } from "vitest";

const envMocks = vi.hoisted(() => ({
  gatewayConfigured: true,
  workspaceRoot: "/data/workspace",
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENCLAW_GATEWAY_WORKSPACE_ROOT: envMocks.workspaceRoot,
  }),
  isIntegrationConfigured: (key: string) =>
    key === "OPENCLAW_GATEWAY" ? envMocks.gatewayConfigured : false,
}));

const gatewayMocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
}));
vi.mock(
  "@/server/execution/providers/openclaw/openclaw-gateway-client",
  () => ({
    OpenClawGatewayClient: { createAgent: gatewayMocks.createAgent },
  }),
);

import { provisionOpenClawAgent } from "@/server/execution/providers/openclaw/openclaw-agent-provisioner";

describe("provisionOpenClawAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.gatewayConfigured = true;
  });

  it("returns null when the Gateway isn't configured, without calling it", async () => {
    envMocks.gatewayConfigured = false;
    const result = await provisionOpenClawAgent("acme-co");
    expect(result).toBeNull();
    expect(gatewayMocks.createAgent).not.toHaveBeenCalled();
  });

  it("creates the agent under the Gateway's workspace root and returns the slug", async () => {
    gatewayMocks.createAgent.mockResolvedValue(true);
    const result = await provisionOpenClawAgent("acme-co");
    expect(result).toBe("acme-co");
    expect(gatewayMocks.createAgent).toHaveBeenCalledWith({
      id: "acme-co",
      workspace: "/data/workspace/acme-co",
    });
  });

  it("returns null when the Gateway fails to create the agent", async () => {
    gatewayMocks.createAgent.mockResolvedValue(false);
    const result = await provisionOpenClawAgent("acme-co");
    expect(result).toBeNull();
  });
});
