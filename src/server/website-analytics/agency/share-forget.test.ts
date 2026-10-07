import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F8 share-forget.ts): proje ve rapor silmeleri
// ReportShares'a 'WEBSITE' türüyle devredilir, bayrağa bağlı değildir, hata
// yutulur ve 0 döner (yalnız hata adı yazılır); öksüz süpürme tek sınırlı ham
// DELETE atar ve hata yutar.

const mocks = vi.hoisted(() => ({
  deleteForProject: vi.fn(),
  deleteForReports: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: mocks.executeRaw } }));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: {
    deleteForProject: mocks.deleteForProject,
    deleteForReports: mocks.deleteForReports,
  },
}));

const {
  forgetWebsiteSharesForProject,
  forgetWebsiteSharesForReports,
  sweepOrphanWebsiteShares,
} = await import("./share-forget");

beforeEach(() => {
  vi.unstubAllEnvs();
  // Bayrak kapalı: yine de çalışmalı.
  vi.stubEnv("GA_AGENCY", "false");
  vi.stubEnv("GA_SYNC", "false");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.deleteForProject.mockResolvedValue(3);
  mocks.deleteForReports.mockResolvedValue(2);
  mocks.executeRaw.mockResolvedValue(4);
});

describe("forgetWebsiteSharesForProject / Reports", () => {
  it("delegates with the WEBSITE kind even when the flags are off", async () => {
    expect(await forgetWebsiteSharesForProject("proj_1")).toBe(3);
    expect(mocks.deleteForProject).toHaveBeenCalledWith("WEBSITE", "proj_1");
    expect(await forgetWebsiteSharesForReports(["a", "b"])).toBe(2);
    expect(mocks.deleteForReports).toHaveBeenCalledWith("WEBSITE", ["a", "b"]);
  });

  it("does not call the store for an empty id list", async () => {
    expect(await forgetWebsiteSharesForReports([])).toBe(0);
    expect(mocks.deleteForReports).not.toHaveBeenCalled();
  });

  it("swallows failures, returns 0 and logs only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = new Error("token tok_123 leaked in message");
    secret.name = "PrismaClientKnownRequestError";
    mocks.deleteForProject.mockRejectedValue(secret);
    mocks.deleteForReports.mockRejectedValue(secret);
    expect(await forgetWebsiteSharesForProject("proj_1")).toBe(0);
    expect(await forgetWebsiteSharesForReports(["a"])).toBe(0);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("PrismaClientKnownRequestError");
    expect(logged).not.toContain("tok_123");
    spy.mockRestore();
  });
});

describe("sweepOrphanWebsiteShares", () => {
  function statement(call = 0): { sql: string; values: unknown[] } {
    const sql = mocks.executeRaw.mock.calls[call]?.[0] as {
      sql: string;
      values: unknown[];
    };
    return sql;
  }

  it("issues one bounded raw DELETE on the real table names", async () => {
    expect(await sweepOrphanWebsiteShares()).toBe(4);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = statement();
    expect(sql).toContain('DELETE FROM "ReportShare"');
    expect(sql).toContain(`s."kind" = 'WEBSITE'`);
    expect(sql).toContain('FROM "Command"');
    expect(sql).toContain('FROM "Project"');
    expect(sql).toContain('c."projectId" = s."projectId"');
    expect(sql).toContain("LIMIT");
    expect(values).toEqual([500]);
  });

  it("clamps the limit", async () => {
    await sweepOrphanWebsiteShares(0);
    await sweepOrphanWebsiteShares(10_000_000);
    await sweepOrphanWebsiteShares(25.9);
    expect(statement(0).values).toEqual([1]);
    expect(statement(1).values).toEqual([5000]);
    expect(statement(2).values).toEqual([25]);
  });

  it("is not flag-gated and swallows failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.executeRaw.mockRejectedValue(new Error("connection string leaked"));
    expect(await sweepOrphanWebsiteShares()).toBe(0);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("connection string");
    spy.mockRestore();
  });
});
