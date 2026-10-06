import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: loadSearchAttention her Today görüntülemesinde
// koşar; SEO_HEALTH, GSC_SEARCH_PAGE ya da izin listesi kapalıyken uyarı
// okuyucusuna (ve prisma'ya) hiç gitmez; açıkken en yeni en çok iki CRITICAL
// uyarıyı Search sayfasının sağlık bölümüne bağlar.

const mocks = vi.hoisted(() => ({ list: vi.fn(), prisma: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // Testte önbellek yok: her çağrı gerçekten koşar.
  return { ...actual, cache: <T>(fn: T) => fn };
});
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        mocks.prisma();
        return {};
      },
    },
  ),
}));
vi.mock("@/server/seo/health/alerts", () => ({
  listSearchAlerts: mocks.list,
}));

const { loadSearchAttention, searchIssueHref } = await import("./attention");

function alert(
  id: string,
  severity: "INFO" | "WARN" | "CRITICAL",
  minutesAgo: number,
) {
  return {
    id,
    source: "SEO" as const,
    kind: `SEO_${id}`,
    severity,
    title: `Title ${id}`,
    detail: null,
    lastSeenAt: new Date(Date.UTC(2026, 9, 6, 12) - minutesAgo * 60_000),
    dedupeKey: `seo:SEO_${id}`,
  };
}

beforeEach(() => {
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("GSC_SEARCH_PAGE", "true");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  mocks.list.mockReset();
  mocks.prisma.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSearchAttention", () => {
  it.each([
    ["SEO_HEALTH", "false"],
    ["GSC_SEARCH_PAGE", "false"],
    ["SEO_ROLLOUT_PROJECTS", "other-project"],
  ])("returns null without any read when %s=%s", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await loadSearchAttention("p1")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.prisma).not.toHaveBeenCalled();
  });

  it("returns at most two newest criticals with Search page links", async () => {
    mocks.list.mockResolvedValue([
      alert("A", "CRITICAL", 30),
      alert("B", "CRITICAL", 5),
      alert("C", "CRITICAL", 60),
      alert("D", "WARN", 1),
      alert("E", "INFO", 1),
    ]);
    const attention = await loadSearchAttention("p1");
    expect(mocks.list).toHaveBeenCalledWith("p1", 10);
    expect(attention).toEqual({
      critical: [
        {
          id: "B",
          kind: "SEO_B",
          title: "Title B",
          href: "/projects/p1/arama?issue=B#health",
        },
        {
          id: "A",
          kind: "SEO_A",
          title: "Title A",
          href: "/projects/p1/arama?issue=A#health",
        },
      ],
      criticalCount: 3,
      warnCount: 1,
      href: "/projects/p1/arama#health",
    });
  });
});

describe("searchIssueHref", () => {
  it("encodes the alert id", () => {
    expect(searchIssueHref("p1", "a b")).toBe(
      "/projects/p1/arama?issue=a%20b#health",
    );
    expect(searchIssueHref("p1")).toBe("/projects/p1/arama#health");
  });
});
