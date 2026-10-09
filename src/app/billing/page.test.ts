import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingOverview } from "@/server/billing/overview";

// The /billing page wiring: hidden unless the screens are switched on, scoped to the
// caller's own workspace, and the open tab comes from the address.

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  requireUser: vi.fn(),
  membership: vi.fn(),
  manager: vi.fn(),
  overview: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/billing/ui-flag", () => ({
  isBillingUiEnabled: mocks.enabled,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.membership,
  isWorkspaceManager: mocks.manager,
}));
vi.mock("@/server/billing/overview", () => ({
  getBillingOverview: mocks.overview,
}));
// The shell around every page needs a session and a database of its own.
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-shell": "" }, children),
}));

import BillingPage from "./page";

const OVERVIEW: BillingOverview = {
  mode: "off",
  subscription: null,
  allowances: [],
  measured: {
    since: "2026-10-01T00:00:00.000Z",
    images: 5,
    aiRequests: 9,
    byModule: [],
    daily: [],
  },
  tasks: { active: [], paused: [], awaitingApproval: [] },
};

async function render(params: Record<string, string | string[] | undefined> = {}) {
  const element = (await BillingPage({
    searchParams: Promise.resolve(params),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.membership.mockResolvedValue({ workspaceId: "w1" });
  mocks.manager.mockResolvedValue(true);
  mocks.overview.mockResolvedValue(OVERVIEW);
});

describe("/billing", () => {
  it("is not found while the screens are switched off, and reads nothing", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("opens on the plans, in the app shell, with the four tabs", async () => {
    const markup = await render();
    expect(markup).toContain("data-shell");
    expect(markup).toContain("Plan &amp; usage");
    expect(markup).toContain("Compare plans");
    for (const label of ["Plans", "My subscription", "Usage", "Tasks"]) {
      expect(markup).toContain(`>${label}<`);
    }
  });

  it("reads the caller's own workspace and nothing else", async () => {
    mocks.membership.mockResolvedValue({ workspaceId: "w-mine" });
    await render({ tab: "usage" });
    expect(mocks.membership).toHaveBeenCalledWith("u1");
    expect(mocks.overview).toHaveBeenCalledTimes(1);
    expect(mocks.overview.mock.calls[0]![0]).toBe("w-mine");
    expect(mocks.manager).toHaveBeenCalledWith("u1", "w-mine");
  });

  it("shows the tab the address names", async () => {
    expect(await render({ tab: "usage" })).toContain("This month so far");
    expect(await render({ tab: "tasks" })).toContain("Waiting for your approval");
    expect(await render({ tab: "subscription" })).toContain("Invoices and payments");
  });

  it("an unknown tab falls back to the plans", async () => {
    expect(await render({ tab: "nonsense" })).toContain("Compare plans");
  });

  it("tells a member who cannot manage the plan who can", async () => {
    mocks.manager.mockResolvedValue(false);
    expect(await render({ tab: "subscription" })).toContain(
      "Only a workspace owner or admin can change the plan",
    );
    mocks.manager.mockResolvedValue(true);
    expect(await render({ tab: "subscription" })).not.toContain(
      "Only a workspace owner or admin can change the plan",
    );
  });
});
