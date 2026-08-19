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

import { XApiProvider } from "@/server/execution/providers/x/x-api-provider";
import type { ExecutionPolicyContext } from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "X_PUBLISH",
  riskLevel: "HIGH",
};

describe("XApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when X env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new XApiProvider();
    expect(await provider.canExecute("X_PUBLISH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new XApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when no X credential exists for the project", async () => {
    prismaMocks.findUnique.mockResolvedValue(null);
    const provider = new XApiProvider();
    expect(await provider.canExecute("X_PUBLISH", context)).toBe(false);
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "EXPIRED" });
    const provider = new XApiProvider();
    expect(await provider.canExecute("X_PUBLISH", context)).toBe(false);
  });

  it("returns true once an ACTIVE X credential exists", async () => {
    prismaMocks.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const provider = new XApiProvider();
    expect(await provider.canExecute("X_PUBLISH", context)).toBe(true);
  });
});
