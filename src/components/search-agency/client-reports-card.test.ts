import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrandingSnapshot } from "@/lib/report-share/types";
import type { SeoReportListItem } from "@/lib/seo/reports/types";
import type { ReportShareView } from "@/server/report-share/store";

// Bu dosyanın kanıtladığı (SC-F9 Client reports kartı): paylaşım listesi durum,
// görüntülenme ve bitiş tarihiyle; yalnız ACTIVE bağlantıda Revoke; onay kutusu
// zorunlu ve düğme ona bağlı; bağlantı adresi tek seferlik panelde uyarıyla;
// yönetmeyen kullanıcı yalnız müşteri görünümü bağlantısını görür.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/report-share-actions", () => ({
  saveReportBrandingAction: vi.fn(),
  createReportShareAction: vi.fn(),
  revokeReportShareAction: vi.fn(),
}));

const { ClientReportsCard } = await import("./client-reports-card");
const { ShareCreateControls, NewShareUrlPanel, SHARE_CONFIRM_TEXT } =
  await import("./share-controls");

const reports: SeoReportListItem[] = [
  {
    id: "r1",
    kind: "WEEKLY",
    title: "Weekly search report",
    periodLabel: "Sep 28 - Oct 4",
    periodKey: "2026-W40",
    createdAt: "2026-10-05T00:00:00.000Z",
    isMock: false,
  },
  {
    id: "r2",
    kind: "MONTHLY",
    title: "Monthly search report",
    periodLabel: "September 2026",
    periodKey: "2026-09",
    createdAt: "2026-10-01T00:00:00.000Z",
    isMock: false,
  },
];

const branding: BrandingSnapshot = {
  displayName: "Acme Agency",
  accent: "blue",
  footer: null,
  logoAssetId: null,
};

function share(
  id: string,
  status: ReportShareView["status"],
  overrides: Partial<ReportShareView> = {},
): ReportShareView {
  return {
    id,
    kind: "SEARCH",
    reportId: "r1",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    revokedAt: null,
    viewCount: 7,
    lastViewedAt: "2026-10-04T00:00:00.000Z",
    status,
    ...overrides,
  };
}

function render(
  options: {
    isManager?: boolean;
    shares?: Record<string, ReportShareView[]>;
    reports?: SeoReportListItem[];
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ClientReportsCard, {
      projectId: "p1",
      reports: options.reports ?? reports,
      shares: options.shares ?? {},
      branding,
      isManager: options.isManager ?? true,
    }),
  );
}

describe("ClientReportsCard", () => {
  it("her rapor için müşteri görünümü bağlantısı ve dönem etiketi", () => {
    const html = render();
    expect(html).toContain('href="/projects/p1/arama/client/r1"');
    expect(html).toContain('href="/projects/p1/arama/client/r2"');
    expect(html).toContain("Open client view");
    expect(html).toContain("Weekly");
    expect(html).toContain("Monthly");
    expect(html).toContain("2 reports");
  });

  it("paylaşım listesi durum, görüntülenme ve bitiş tarihini yazar", () => {
    const html = render({
      shares: {
        r1: [
          share("s1", "ACTIVE"),
          share("s2", "EXPIRED", { expiresAt: "2026-09-20T00:00:00.000Z", viewCount: 1 }),
          share("s3", "REVOKED", { revokedAt: "2026-10-02T00:00:00.000Z" }),
        ],
      },
    });
    expect(html).toContain("Active");
    expect(html).toContain("Expired");
    expect(html).toContain("Revoked");
    expect(html).toContain("7 views");
    expect(html).toContain("1 view<");
    expect(html).toContain("expires Oct 31, 2026");
    expect(html).toContain("expired Sep 20, 2026");
    expect(html).toContain("revoked Oct 2, 2026");
    expect(html).toContain("1 active");
  });

  it("Revoke yalnız ACTIVE bağlantıda çıkar", () => {
    const html = render({
      shares: { r1: [share("s1", "ACTIVE"), share("s2", "REVOKED")] },
    });
    expect(html.match(/>Revoke</g)).toHaveLength(1);
    expect(html).toContain('name="shareId" value="s1"');
    expect(html).not.toContain('name="shareId" value="s2"');
  });

  it("yönetici markalama özetini ve /search bağlantısını görür", () => {
    const html = render();
    expect(html).toContain("Acme Agency");
    expect(html).toContain('href="/search"');
    expect(html).toContain("Create share link");
    expect(html).toContain(SHARE_CONFIRM_TEXT);
  });

  it("yönetmeyen kullanıcı müşteri görünümü bağlantısını görmez (sayfa yalnız yöneticiye açık)", () => {
    const html = render({
      isManager: false,
      shares: { r1: [share("s1", "ACTIVE")] },
    });
    expect(html).not.toContain("Open client view");
    expect(html).not.toContain("Create share link");
    expect(html).not.toContain("Revoke");
    expect(html).not.toContain("expires Oct 31");
    expect(html).not.toContain('href="/search"');
    expect(html).toContain("Ask a workspace admin");
  });

  it("rapor yokken boş durum çıkar", () => {
    const html = render({ reports: [] });
    expect(html).toContain("No weekly or monthly reports yet.");
    expect(html).toContain("0 reports");
  });
});

describe("ShareCreateControls", () => {
  const html = renderToStaticMarkup(
    createElement(ShareCreateControls, { projectId: "p1", reportId: "r1" }),
  );

  it("onay kutusu zorunludur ve işaretlenmeden düğme kapalıdır", () => {
    expect(html).toContain(SHARE_CONFIRM_TEXT);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*required=""|<input[^>]*required=""[^>]*type="checkbox"/);
    const button = html
      .split("<button")
      .slice(1)
      .find((part) => part.split("</button>")[0]?.includes("Create share link"));
    expect(button).toContain('disabled=""');
  });

  it("7, 30 ve 90 gün seçenekleri vardır, 30 seçili gelir", () => {
    for (const days of [7, 30, 90]) expect(html).toContain(`${days} days`);
    expect(html).toMatch(/<option value="30" selected="">30 days/);
  });

  it("henüz bağlantı oluşturulmadıkça adres paneli çıkmaz", () => {
    expect(html).not.toContain("Share link created");
  });
});

describe("NewShareUrlPanel", () => {
  it("adresi, kopyala düğmesini, tek seferlik notu ve uyarıyı yazar", () => {
    const html = renderToStaticMarkup(
      createElement(NewShareUrlPanel, {
        url: "https://app.example/r/abc.def",
        expiresAt: "2026-10-31T00:00:00.000Z",
      }),
    );
    expect(html).toContain("https://app.example/r/abc.def");
    expect(html).toContain("Copy link");
    expect(html).toContain("copy it now");
    expect(html).toContain("Expires Oct 31, 2026");
    expect(html).toContain("This link shows the full report to anyone who has it.");
  });
});
