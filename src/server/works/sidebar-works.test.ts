import { beforeEach, describe, expect, it, vi } from "vitest";

const enabled = vi.hoisted(() => vi.fn());
const modulesEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: enabled,
  isModulesEnabled: modulesEnabled,
}));
const recents = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { recents, listRecent: vi.fn() },
}));

const { loadSidebarWorks } = await import("./sidebar-works");

const view = (id: string, title = id, module: "social" | null = null) => ({
  id,
  title,
  summary: null,
  status: "ACTIVE" as const,
  channels: ["instagram"],
  acknowledgedUnconnected: [],
  module,
  lastActivityAt: "2026-10-02T10:00:00.000Z",
});

beforeEach(() => {
  vi.resetAllMocks();
  enabled.mockReturnValue(true);
  modulesEnabled.mockReturnValue(false);
  recents.mockResolvedValue([view("w1", "Weekly plan", "social"), view("w2")]);
});

describe("loadSidebarWorks", () => {
  it("is the project's Recents, mapped to what the sidebar shows", async () => {
    const works = await loadSidebarWorks("p1");
    expect(recents).toHaveBeenCalledWith("p1");
    expect(works?.recents).toEqual([
      {
        id: "w1",
        title: "Weekly plan",
        summary: null,
        status: "ACTIVE",
        module: null,
      },
      { id: "w2", title: "w2", summary: null, status: "ACTIVE", module: null },
    ]);
    // Nothing else of the Work leaks into the client.
    expect(Object.keys(works?.recents[0] ?? {}).sort()).toEqual([
      "id",
      "module",
      "status",
      "summary",
      "title",
    ]);
  });

  it("modules off: no Modules group, and no row carries its module (the sidebar is as before)", async () => {
    const works = await loadSidebarWorks("p1");
    expect(works?.modulesUi).toBe(false);
    expect(works?.recents.map((work) => work.module)).toEqual([null, null]);
  });

  it("modules on: the Modules group, and each chat's module for its Recents icon", async () => {
    modulesEnabled.mockReturnValue(true);
    const works = await loadSidebarWorks("p1");
    expect(works?.modulesUi).toBe(true);
    expect(works?.recents.map((work) => work.module)).toEqual(["social", null]);
  });

  it("uses Recents (no blank chat, no Today), never the plain list of every live Work", async () => {
    const { WorkRepository } =
      await import("@/server/repositories/work.repository");
    await loadSidebarWorks("p1");
    expect(WorkRepository.listRecent).not.toHaveBeenCalled();
  });

  it("is undefined with Works off, and reads nothing", async () => {
    enabled.mockReturnValue(false);
    expect(await loadSidebarWorks("p1")).toBeUndefined();
    expect(recents).not.toHaveBeenCalled();
  });

  it("is undefined when the read fails (the sidebar then renders as before Works)", async () => {
    recents.mockRejectedValue(new Error("relation Work does not exist"));
    expect(await loadSidebarWorks("p1")).toBeUndefined();
  });

  it("an empty project has an empty list, which is not the same as Works being off", async () => {
    recents.mockResolvedValue([]);
    expect(await loadSidebarWorks("p1")).toEqual({
      recents: [],
      modulesUi: false,
    });
  });
});
