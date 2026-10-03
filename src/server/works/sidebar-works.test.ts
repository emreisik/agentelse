import { beforeEach, describe, expect, it, vi } from "vitest";

const enabled = vi.hoisted(() => vi.fn());
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: enabled }));
const recents = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { recents, listRecent: vi.fn() },
}));

const { loadSidebarWorks } = await import("./sidebar-works");

const view = (id: string, title = id) => ({
  id,
  title,
  summary: null,
  status: "ACTIVE" as const,
  channels: ["instagram"],
  acknowledgedUnconnected: [],
  lastActivityAt: "2026-10-02T10:00:00.000Z",
});

beforeEach(() => {
  vi.resetAllMocks();
  enabled.mockReturnValue(true);
  recents.mockResolvedValue([view("w1", "Weekly plan"), view("w2")]);
});

describe("loadSidebarWorks", () => {
  it("is the project's Recents, mapped to what the sidebar shows", async () => {
    const works = await loadSidebarWorks("p1");
    expect(recents).toHaveBeenCalledWith("p1");
    expect(works).toEqual([
      { id: "w1", title: "Weekly plan", summary: null, status: "ACTIVE" },
      { id: "w2", title: "w2", summary: null, status: "ACTIVE" },
    ]);
    // Nothing else of the Work leaks into the client.
    expect(Object.keys(works?.[0] ?? {}).sort()).toEqual([
      "id",
      "status",
      "summary",
      "title",
    ]);
  });

  it("uses Recents (no blank chat, no Today), never the plain list of every live Work", async () => {
    const { WorkRepository } = await import("@/server/repositories/work.repository");
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
    expect(await loadSidebarWorks("p1")).toEqual([]);
  });
});
