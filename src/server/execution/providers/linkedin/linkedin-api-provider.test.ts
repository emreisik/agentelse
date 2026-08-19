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

import { LinkedInApiProvider } from "@/server/execution/providers/linkedin/linkedin-api-provider";
import type { ExecutionPolicyContext } from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "LINKEDIN_PUBLISH",
  riskLevel: "HIGH",
};

describe("LinkedInApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when LINKEDIN env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new LinkedInApiProvider();
    expect(await provider.canExecute("LINKEDIN_PUBLISH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new LinkedInApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when no LinkedIn credential exists for the project", async () => {
    prismaMocks.findUnique.mockResolvedValue(null);
    const provider = new LinkedInApiProvider();
    expect(await provider.canExecute("LINKEDIN_PUBLISH", context)).toBe(false);
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "EXPIRED" });
    const provider = new LinkedInApiProvider();
    expect(await provider.canExecute("LINKEDIN_PUBLISH", context)).toBe(false);
  });

  it("returns true once an ACTIVE LinkedIn credential exists", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const provider = new LinkedInApiProvider();
    expect(await provider.canExecute("LINKEDIN_PUBLISH", context)).toBe(true);
  });
});
