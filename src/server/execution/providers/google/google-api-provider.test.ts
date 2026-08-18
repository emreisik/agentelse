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

import { GoogleApiProvider } from "@/server/execution/providers/google/google-api-provider";
import type { ExecutionPolicyContext } from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "ANALYTICS_ANALYSIS",
  riskLevel: "LOW",
};

describe("GoogleApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when GOOGLE env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when no active Google credential exists for the project", async () => {
    prismaMocks.findUnique.mockResolvedValue(null);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "EXPIRED",
      metadata: { selectedGa4PropertyId: "123" },
    });
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });

  it("returns false when neither a GA4 property nor a Search Console site is selected", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { ga4Properties: [], searchConsoleSites: [] },
    });
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });

  it("allows ANALYTICS_ANALYSIS once a GA4 property is selected", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        ga4Properties: [],
        searchConsoleSites: [],
        selectedGa4PropertyId: "123",
      },
    });
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(true);
  });

  it("allows ANALYTICS_ANALYSIS once a Search Console site is selected", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        ga4Properties: [],
        searchConsoleSites: [],
        selectedSearchConsoleSite: "sc-domain:example.com",
      },
    });
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(true);
  });
});
