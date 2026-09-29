import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findMany: prismaMocks.findMany } },
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

// findMany is already filtered to ACTIVE rows by the provider's query, so
// the mocks only return what an ACTIVE-filtered query would.
function analyticsRow(metadata: Record<string, unknown>) {
  return {
    id: "cred-ga",
    provider: "google_analytics",
    encryptedSecret: "x",
    status: "ACTIVE",
    metadata: { ga4Properties: [], ...metadata },
  };
}

function searchConsoleRow(metadata: Record<string, unknown>) {
  return {
    id: "cred-gsc",
    provider: "google_search_console",
    encryptedSecret: "x",
    status: "ACTIVE",
    metadata: { searchConsoleSites: [], ...metadata },
  };
}

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
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it("queries only ACTIVE Google Analytics / Search Console credentials", async () => {
    prismaMocks.findMany.mockResolvedValue([]);
    const provider = new GoogleApiProvider();
    await provider.canExecute("ANALYTICS_ANALYSIS", context);
    expect(prismaMocks.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        provider: { in: ["google_analytics", "google_search_console"] },
        status: "ACTIVE",
      },
    });
  });

  it("returns false when no active Google credential exists for the project", async () => {
    prismaMocks.findMany.mockResolvedValue([]);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });

  it("returns false when connected but nothing is selected", async () => {
    prismaMocks.findMany.mockResolvedValue([
      analyticsRow({}),
      searchConsoleRow({}),
    ]);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });

  it("allows ANALYTICS_ANALYSIS with only Google Analytics connected", async () => {
    prismaMocks.findMany.mockResolvedValue([
      analyticsRow({ selectedGa4PropertyId: "123" }),
    ]);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(true);
  });

  it("allows ANALYTICS_ANALYSIS with only Search Console connected", async () => {
    prismaMocks.findMany.mockResolvedValue([
      searchConsoleRow({ selectedSearchConsoleSite: "sc-domain:example.com" }),
    ]);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(true);
  });

  it("ignores a Search Console selection stored on the analytics row", async () => {
    prismaMocks.findMany.mockResolvedValue([
      analyticsRow({ selectedSearchConsoleSite: "sc-domain:example.com" }),
    ]);
    const provider = new GoogleApiProvider();
    expect(await provider.canExecute("ANALYTICS_ANALYSIS", context)).toBe(
      false,
    );
  });
});
