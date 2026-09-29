import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { asset: { findMany } } }));
const readAsset = vi.fn();
vi.mock("@/server/storage/asset-storage", () => ({ readAsset }));

const { loadRecentHistoryFiles } = await import("./history-files");

const row = (
  id: string,
  attachments: unknown,
  source = "WEB",
): import("./history").HistoryRow => ({
  id,
  source,
  rawText: "x",
  replyText: null,
  attachments,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("loadRecentHistoryFiles", () => {
  it("loads images/PDFs from recent turns, scoped to the project", async () => {
    findMany.mockResolvedValue([
      { id: "a1", storageKey: "k1", mimeType: "image/png" },
    ]);
    readAsset.mockResolvedValue(Buffer.from("PNG"));

    const files = await loadRecentHistoryFiles(
      [
        row("old", [{ assetId: "a0", mimeType: "image/png" }]),
        row("mid", [{ assetId: "a1", mimeType: "image/png" }]),
        row("cur", null),
      ],
      "cur",
      "proj-1",
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["a1", "a0"] }, projectId: "proj-1" },
      }),
    );
    expect(files.get("a1")).toEqual({
      mimeType: "image/png",
      data: Buffer.from("PNG").toString("base64"),
    });
  });

  it("ignores text files, SYSTEM rows and the current turn", async () => {
    const files = await loadRecentHistoryFiles(
      [
        row("s", [{ assetId: "a2", mimeType: "image/png" }], "SYSTEM"),
        row("t", [{ assetId: "a3", mimeType: "text/plain" }]),
        row("cur", [{ assetId: "a4", mimeType: "image/png" }]),
      ],
      "cur",
      "proj-1",
    );
    expect(files.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("skips a file that can't be read instead of failing the turn", async () => {
    findMany.mockResolvedValue([
      { id: "a1", storageKey: "k1", mimeType: "image/png" },
    ]);
    readAsset.mockRejectedValue(new Error("gone"));
    const files = await loadRecentHistoryFiles(
      [row("m", [{ assetId: "a1", mimeType: "image/png" }])],
      "cur",
      "proj-1",
    );
    expect(files.size).toBe(0);
  });
});
