import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı (GA-F8 huni eylemleri): proje üyesi olmayan reddedilir
// ve hiçbir iş yapılmaz; bayrak/yerel koruma kapalıyken eylemler yazmaz;
// geçersiz tanım doğrulama iletisiyle döner; hazır tanım ve düz adım
// alanları doğru tanıma çevrilir (boş satırlar atılır); çalıştırma sonuçları
// kullanıcı iletilerine eşlenir ve yalnız başarıda sayfa tazelenir.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  saveFunnel: vi.fn(),
  deleteFunnel: vi.fn(),
  runFunnel: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/website-analytics/funnel/store", () => ({
  GA_MAX_FUNNELS_PER_LINK: 5,
  saveFunnel: mocks.saveFunnel,
  deleteFunnel: mocks.deleteFunnel,
}));
vi.mock("@/server/website-analytics/funnel/run", () => ({
  runFunnel: mocks.runFunnel,
}));

const { deleteFunnelAction, runFunnelAction, saveFunnelAction } = await import(
  "./funnel-actions"
);

function form(fields: Record<string, string | string[]> = {}) {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("linkId", "link-1");
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      data.append(key, item);
    }
  }
  return data;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_FUNNEL", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws-1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.saveFunnel.mockResolvedValue({ ok: true, id: "f1" });
  mocks.deleteFunnel.mockResolvedValue("ok");
  mocks.runFunnel.mockResolvedValue("ok");
});

describe("access and flag guard", () => {
  it.each([
    ["save", () => saveFunnelAction(form({ preset: "lead" }))],
    ["delete", () => deleteFunnelAction(form({ funnelId: "f1" }))],
    ["run", () => runFunnelAction(form({ funnelId: "f1" }))],
  ])("refuses %s for a non-member and does nothing", async (_, call) => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "Forbidden"),
    );
    expect(await call()).toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expect(mocks.saveFunnel).not.toHaveBeenCalled();
    expect(mocks.deleteFunnel).not.toHaveBeenCalled();
    expect(mocks.runFunnel).not.toHaveBeenCalled();
  });

  it.each([
    ["save", () => saveFunnelAction(form({ preset: "lead" }))],
    ["delete", () => deleteFunnelAction(form({ funnelId: "f1" }))],
  ])("refuses %s for a plain member and does nothing", async (_, call) => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await call()).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change funnels.",
    });
    expect(mocks.saveFunnel).not.toHaveBeenCalled();
    expect(mocks.deleteFunnel).not.toHaveBeenCalled();
  });

  it("lets a plain member run a funnel", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await runFunnelAction(form({ funnelId: "f1" }))).toEqual({ ok: true });
  });

  it.each([
    ["save", () => saveFunnelAction(form({ preset: "lead" }))],
    ["delete", () => deleteFunnelAction(form({ funnelId: "f1" }))],
    ["run", () => runFunnelAction(form({ funnelId: "f1" }))],
  ])("never returns an internal error message from %s", async (_, call) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = new Error("Invalid `prisma.gaFunnel.create()` invocation");
    mocks.saveFunnel.mockRejectedValue(boom);
    mocks.deleteFunnel.mockRejectedValue(boom);
    mocks.runFunnel.mockRejectedValue(boom);
    const result = await call();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("prisma");
    spy.mockRestore();
  });

  it.each([
    ["save", () => saveFunnelAction(form({ preset: "lead" }))],
    ["delete", () => deleteFunnelAction(form({ funnelId: "f1" }))],
    ["run", () => runFunnelAction(form({ funnelId: "f1" }))],
  ])("refuses %s when the flag is off", async (_, call) => {
    vi.stubEnv("GA_FUNNEL", "");
    expect(await call()).toEqual({
      ok: false,
      message: "Funnels aren't available right now.",
    });
    expect(mocks.saveFunnel).not.toHaveBeenCalled();
    expect(mocks.deleteFunnel).not.toHaveBeenCalled();
    expect(mocks.runFunnel).not.toHaveBeenCalled();
  });

  it("refuses a project outside the local dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.neon.tech/main");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect((await runFunnelAction(form({ funnelId: "f1" }))).ok).toBe(false);
    expect(mocks.runFunnel).not.toHaveBeenCalled();
  });
});

describe("saveFunnelAction", () => {
  it("saves a preset under the typed name", async () => {
    const result = await saveFunnelAction(
      form({ preset: "shop", name: "My shop" }),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.saveFunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        linkId: "link-1",
        userId: "user-1",
        id: undefined,
        definition: expect.objectContaining({
          name: "My shop",
          steps: expect.arrayContaining([
            expect.objectContaining({ value: "purchase" }),
          ]),
        }),
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it("builds a definition from the six plain rows and drops blank ones", async () => {
    await saveFunnelAction(
      form({
        id: "f9",
        name: "Pricing",
        periodDays: "14",
        isOpen: "on",
        step_name: ["Visit", "Pricing", "", "", "", ""],
        step_kind: ["event", "page", "event", "event", "event", "event"],
        step_value: ["page_view", "/pricing", "", "", "", ""],
      }),
    );
    expect(mocks.saveFunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "f9",
        definition: {
          name: "Pricing",
          isOpen: true,
          periodDays: 14,
          steps: [
            { name: "Visit", kind: "event", value: "page_view" },
            { name: "Pricing", kind: "page", value: "/pricing" },
          ],
        },
      }),
    );
  });

  it("returns the validation message for an invalid definition", async () => {
    const result = await saveFunnelAction(
      form({
        name: "Bad",
        periodDays: "28",
        step_name: ["Only one", "", "", "", "", ""],
        step_kind: ["event", "event", "event", "event", "event", "event"],
        step_value: ["page_view", "", "", "", "", ""],
      }),
    );
    expect(result).toEqual({
      ok: false,
      message: "A funnel needs 2 to 6 steps.",
    });
    expect(mocks.saveFunnel).not.toHaveBeenCalled();
  });

  it.each([
    ["limit", "You can save up to 5 funnels per property."],
    ["no_link", "This property isn't available for funnels."],
    ["not_found", "Funnel not found."],
    ["off", "Funnels aren't available right now."],
  ])("maps the store reason %s", async (reason, message) => {
    mocks.saveFunnel.mockResolvedValue({ ok: false, reason });
    expect(await saveFunnelAction(form({ preset: "lead" }))).toEqual({
      ok: false,
      message,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("uses the store's own message when it has one", async () => {
    mocks.saveFunnel.mockResolvedValue({
      ok: false,
      reason: "invalid",
      message: "Step 2 needs a name.",
    });
    expect(await saveFunnelAction(form({ preset: "lead" }))).toEqual({
      ok: false,
      message: "Step 2 needs a name.",
    });
  });
});

describe("deleteFunnelAction", () => {
  it("deletes and revalidates, or reports not found", async () => {
    expect(await deleteFunnelAction(form({ funnelId: "f1" }))).toEqual({
      ok: true,
    });
    expect(mocks.deleteFunnel).toHaveBeenCalledWith({
      projectId: "proj-1",
      funnelId: "f1",
    });
    mocks.deleteFunnel.mockResolvedValue("not_found");
    expect(await deleteFunnelAction(form({ funnelId: "f2" }))).toEqual({
      ok: false,
      message: "Funnel not found.",
    });
  });
});

describe("runFunnelAction", () => {
  it("revalidates the Website page on success", async () => {
    expect(await runFunnelAction(form({ funnelId: "f1" }))).toEqual({ ok: true });
    expect(mocks.runFunnel).toHaveBeenCalledWith({
      projectId: "proj-1",
      funnelId: "f1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it.each([
    ["throttled", "Ran a moment ago. Try again in a few minutes."],
    ["daily_limit", "Daily funnel limit reached for this property."],
    ["quota", "Google Analytics is busy. Try again later."],
    ["unavailable", "Funnels aren't available right now."],
    ["auth", "Reconnect Google Analytics first."],
    ["not_found", "Funnel not found."],
    ["failed", "The funnel could not be read. Try again later."],
  ])("maps %s to its message", async (result, message) => {
    mocks.runFunnel.mockResolvedValue(result);
    expect(await runFunnelAction(form({ funnelId: "f1" }))).toEqual({
      ok: false,
      message,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
