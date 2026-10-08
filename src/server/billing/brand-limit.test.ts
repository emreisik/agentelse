import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  current: { mode: "off", legacyBefore: null, legacyUntil: null } as {
    mode: "off" | "shadow" | "enforce";
    legacyBefore: Date | null;
    legacyUntil: Date | null;
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

const getEntitlements = vi.fn();
vi.mock("./entitlements", () => ({ getEntitlements }));

const projectCount = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { project: { count: projectCount } } }));

const create = vi.fn();
const createWithinLimit = vi.fn();
vi.mock("@/server/repositories/project.repository", () => ({
  ProjectRepository: { create, createWithinLimit },
}));

const recordShadowDecision = vi.fn();
vi.mock("./shadow-log", () => ({ recordShadowDecision }));

const { createProjectWithinBrandLimit } = await import("./brand-limit");

const input = {
  workspaceId: "ws-1",
  name: "Brand",
  slug: "brand",
  language: "en",
  country: "US",
};
const project = { id: "p1", brands: [{ id: "b1" }] };

function entitlements(overrides: Record<string, unknown> = {}) {
  return {
    access: "FULL",
    enforced: true,
    brandLimit: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
  create.mockResolvedValue(project);
});

describe("createProjectWithinBrandLimit", () => {
  it("off: faturalama sorgusu ATMADAN doğrudan eski oluşturma", async () => {
    const result = await createProjectWithinBrandLimit({ workspaceId: "ws-1", input });
    expect(result).toEqual({ ok: true, project });
    expect(getEntitlements).not.toHaveBeenCalled();
    expect(projectCount).not.toHaveBeenCalled();
    expect(createWithinLimit).not.toHaveBeenCalled();
  });

  it("sınırsız (LEGACY/muaf): doğrudan oluşturma", async () => {
    config.current = { ...config.current, mode: "enforce" };
    getEntitlements.mockResolvedValue(entitlements({ brandLimit: null }));
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toEqual({
      ok: true,
      project,
    });
    expect(createWithinLimit).not.toHaveBeenCalled();
  });

  it("enforce: limit dolu → BRAND_LIMIT, plan yok → PLAN_REQUIRED, limit atılan değerle", async () => {
    config.current = { ...config.current, mode: "enforce" };
    getEntitlements.mockResolvedValue(entitlements({ brandLimit: 1 }));
    createWithinLimit.mockResolvedValue({ ok: false, limit: 1, current: 1 });
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toEqual({
      ok: false,
      code: "BRAND_LIMIT",
      limit: 1,
      current: 1,
    });
    expect(createWithinLimit).toHaveBeenCalledWith(input, 1);
    expect(create).not.toHaveBeenCalled();

    getEntitlements.mockResolvedValue(entitlements({ access: "READ_ONLY", brandLimit: 0 }));
    createWithinLimit.mockResolvedValue({ ok: false, limit: 0, current: 0 });
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toMatchObject({
      ok: false,
      code: "PLAN_REQUIRED",
    });
  });

  it("enforce: limit boşsa oluşturur ve projeyi döner", async () => {
    config.current = { ...config.current, mode: "enforce" };
    getEntitlements.mockResolvedValue(entitlements({ brandLimit: 3 }));
    createWithinLimit.mockResolvedValue({ ok: true, project });
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toEqual({
      ok: true,
      project,
    });
  });

  it("shadow: limit dolu olsa da OLUŞTURUR ve 'engellenirdi' kaydı bırakır", async () => {
    config.current = { ...config.current, mode: "shadow" };
    getEntitlements.mockResolvedValue(entitlements({ enforced: false, brandLimit: 1 }));
    projectCount.mockResolvedValue(1);
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toEqual({
      ok: true,
      project,
    });
    expect(createWithinLimit).not.toHaveBeenCalled();
    expect(recordShadowDecision).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      kind: "brand_limit",
      detail: { code: "BRAND_LIMIT", limit: 1, current: 1 },
    });
  });

  it("shadow: sayım hatası oluşturmayı ENGELLEMEZ", async () => {
    config.current = { ...config.current, mode: "shadow" };
    getEntitlements.mockResolvedValue(entitlements({ enforced: false }));
    projectCount.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await createProjectWithinBrandLimit({ workspaceId: "ws-1", input })).toEqual({
      ok: true,
      project,
    });
    spy.mockRestore();
  });
});
