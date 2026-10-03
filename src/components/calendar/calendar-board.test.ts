import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { fortnightGridDays, monthGridDays } from "@/lib/calendar/grid";
import type { CalendarConnection } from "@/lib/calendar/types";
import { sourceOf } from "@/lib/calendar/source";
import { item, payload } from "@/lib/calendar/test-fixtures";

// Sürükle-bırak bir Server Action'a yazar (prisma, next-auth); statik render'da
// hiçbiri çalışmaz. Kart bağlantıları da yönlendiriciyi okur.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/creative-calendar-actions", () => ({
  rescheduleCreativeAction: vi.fn(),
}));
// Açık panel de bu eylemleri içe aktarır.
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: vi.fn(),
  rejectApprovalAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  markCreativePublishedAction: vi.fn(),
}));

const { CalendarBoard } = await import("./calendar-board");
type BoardProps = Parameters<typeof CalendarBoard>[0];

const TODAY = "2026-10-03";

const connections: CalendarConnection[] = [
  { source: sourceOf(null, "INSTAGRAM"), connected: true, account: "@brand" },
  { source: sourceOf(null, "FACEBOOK"), connected: false, account: null },
  { source: sourceOf(null, "TIKTOK"), connected: false, account: null },
];

const hrefs: BoardProps["hrefs"] = {
  prev: "/projects/p1/takvim?month=2026-09",
  next: "/projects/p1/takvim?month=2026-11",
  today: "/projects/p1/takvim",
  month: "/projects/p1/takvim",
  week: "/projects/p1/takvim?view=week",
  creativePrefix: "/projects/p1/takvim?creative=",
  integrations: "/projects/p1/integrations",
  settings: "/projects/p1/ayarlar",
  chat: "/projects/p1",
};

function toBoardDays(days: ReturnType<typeof monthGridDays>) {
  return days.map((d) => ({
    key: d.key,
    day: d.day,
    month: d.month,
    weekday:
      (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7,
  }));
}

type Options = Partial<
  Pick<
    BoardProps,
    "view" | "title" | "days" | "focusMonth" | "isCurrent" | "initialOpenId"
  >
> & {
  items?: ReturnType<typeof item>[];
  scheduleEnabled?: boolean;
};

function render({ items = [item()], scheduleEnabled = true, ...rest }: Options = {}) {
  return renderToStaticMarkup(
    createElement(CalendarBoard, {
      projectId: "p1",
      timezone: "Europe/Istanbul",
      todayKey: TODAY,
      view: "month",
      title: "October 2026",
      days: toBoardDays(monthGridDays(2026, 10)),
      focusMonth: 10,
      isCurrent: true,
      hrefs,
      data: payload(items, { connections, scheduleEnabled }),
      ...rest,
    }),
  );
}

describe("CalendarBoard (ay görünümü)", () => {
  it("parçayı kendi gününde, durumuyla ve açma bağlantısıyla gösterir", () => {
    const html = render();
    expect(html).toContain("Autumn launch");
    expect(html).toContain("10:00 · Instagram · Post");
    expect(html).toContain('href="/projects/p1/takvim?creative=c1"');
    // Taşınabilir parça sürüklenebilir.
    expect(html).toContain('draggable="true"');
  });

  it("durum şeridi sayıyı ve açıklamayı gösterir", () => {
    const html = render({
      items: [
        item({ id: "a", stage: "failed", reason: "Token expired" }),
        item({ id: "b", stage: "published", movable: false }),
        item({ id: "c", stage: "published", movable: false }),
      ],
    });
    expect(html).toContain("Failed");
    expect(html).toContain("Published");
    // Yayınlanan iki parça: sayaç 2.
    expect(html).toMatch(/Published<span[^>]*>2<\/span>/);
  });

  it("yayınlanmış parça sürüklenemez", () => {
    const html = render({
      items: [item({ stage: "published", movable: false })],
    });
    expect(html).toContain('draggable="false"');
  });

  it("entegrasyon şeridi bağlı hesabı ve bağlı olmayan platformu ayırır", () => {
    const html = render({
      items: [
        item({ id: "a" }),
        item({
          id: "b",
          source: sourceOf(null, "TIKTOK"),
          label: "TikTok · Video",
          stage: "held",
        }),
      ],
    });
    expect(html).toContain("@brand");
    expect(html).toContain("Connected");
    // TikTok'ta parça var ama bağlı değil: uyarılır.
    expect(html).toContain("Not connected");
    // Parçası olmayan, bağlı olmayan Facebook gürültü yapmaz.
    expect(html).not.toContain(">Facebook<");
    expect(html).toContain('href="/projects/p1/integrations"');
  });

  it("günü atanmamış parçalar tepsiye girer", () => {
    const html = render({
      items: [
        item({
          id: "free",
          title: "Loose idea",
          localDay: null,
          localTime: null,
          scheduledFor: null,
          stage: "needs-content",
        }),
      ],
    });
    expect(html).toContain("Unscheduled");
    expect(html).toContain("Loose idea");
    expect(html).toContain("Drag a piece onto a day to schedule it");
  });

  it("hiç parça yoksa planlamaya yönlendirir", () => {
    const html = render({ items: [] });
    expect(html).toContain("Nothing planned here yet");
    expect(html).toContain('href="/projects/p1"');
  });

  it("zamanlı yayın kapalıyken ve Instagram parçası beklerken uyarır", () => {
    const html = render({
      scheduleEnabled: false,
      items: [item({ stage: "held" })],
    });
    expect(html).toContain("Scheduled posting is off");
    expect(html).toContain('href="/projects/p1/ayarlar"');
    expect(render({ scheduleEnabled: true })).not.toContain(
      "Scheduled posting is off",
    );
  });

  it("açık parça vurgulanır", () => {
    const html = render({ initialOpenId: "c1" });
    expect(html).toContain("ring-2 ring-ring");
  });

  it("başlıksız parçada kısa metni başlık yapar", () => {
    const html = render({
      items: [item({ title: null, preview: "Fall menu is here" })],
    });
    expect(html).toContain("Fall menu is here");
  });
});

describe("CalendarBoard (iki hafta alt alta)", () => {
  const fortnight = {
    view: "week" as const,
    title: "Sep 28 – Oct 11, 2026",
    days: toBoardDays(fortnightGridDays({ year: 2026, month: 10, day: 3 })),
    focusMonth: null,
    isCurrent: true,
  };

  it("iki haftayı kendi satırında, başlıklarıyla gösterir", () => {
    const html = render({
      ...fortnight,
      items: [item({ stage: "needs-approval" })],
    });
    // Bugün 3 Ekim: ilk satır bu hafta, ikinci satır gelecek hafta.
    expect(html).toContain("This week");
    expect(html).toContain("Sep 28 – Oct 4");
    expect(html).toContain("Next week");
    expect(html).toContain("Oct 5 – Oct 11");
    // 14 gün hücresi.
    expect((html.match(/role="gridcell"/g) ?? []).length).toBe(14);
    expect(html).toContain("Wed");
    expect(html).toContain("Needs approval");
    expect(html).toContain("Previous week");
  });

  it("ikinci haftadaki parça ikinci satırda durur", () => {
    const html = render({ ...fortnight, items: [item()] });
    // Varsayılan parça 7 Ekim'de: "Next week" satırından SONRA gelir.
    expect(html.indexOf("Next week")).toBeLessThan(
      html.indexOf("Autumn launch"),
    );
  });

  it("görünüm anahtarı '2 weeks' der", () => {
    expect(render(fortnight)).toContain("2 weeks");
  });

  it("başarısız parçanın nedenini kartta söyler", () => {
    const html = render({
      ...fortnight,
      items: [
        item({
          stage: "failed",
          reason: "The platform said: Token expired",
        }),
      ],
    });
    expect(html).toContain("The platform said: Token expired");
  });
});
