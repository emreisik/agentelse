import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique: prismaMocks.findUnique } },
}));

const envMocks = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/env", () => ({
  isIntegrationConfigured: () => envMocks.configured,
}));

import { TikTokApiProvider } from "@/server/execution/providers/tiktok/tiktok-api-provider";
import type { ExecutionPolicyContext } from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "TIKTOK_PUBLISH",
  riskLevel: "HIGH",
};

describe("TikTokApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when TIKTOK env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new TikTokApiProvider();
    expect(await provider.canExecute("TIKTOK_PUBLISH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new TikTokApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when no TikTok credential exists for the project", async () => {
    prismaMocks.findUnique.mockResolvedValue(null);
    const provider = new TikTokApiProvider();
    expect(await provider.canExecute("TIKTOK_PUBLISH", context)).toBe(false);
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "EXPIRED" });
    const provider = new TikTokApiProvider();
    expect(await provider.canExecute("TIKTOK_PUBLISH", context)).toBe(false);
  });

  it("returns true once an ACTIVE TikTok credential exists", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const provider = new TikTokApiProvider();
    expect(await provider.canExecute("TIKTOK_PUBLISH", context)).toBe(true);
  });
});
