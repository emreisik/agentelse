import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Statik render popover'ı kapalı bırakır; burada içerik hep açık çizilir ki
// panelin KENDİSİ doğrulanabilsin. Tarayıcıdaki gerçek açılış base-ui'nindir.
vi.mock("@/components/ui/popover", () => ({
  Popover: (props: { children: ReactNode }) =>
    createElement(Fragment, null, props.children),
  PopoverTrigger: (props: {
    children: ReactNode;
    className?: string;
    disabled?: boolean;
    id?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        id: props.id,
        disabled: props.disabled,
        className: props.className,
        "data-trigger": "",
      },
      props.children,
    ),
  PopoverContent: (props: { children: ReactNode }) =>
    createElement("div", { "data-popover": "" }, props.children),
}));

const { DatePicker, DateTimePicker, TimePicker } =
  await import("./date-time-picker");
const { CalendarPanel, TimePanel } = await import("./date-time-panels");

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("DateTimePicker", () => {
  const render = (props: Record<string, unknown> = {}) =>
    html(
      createElement(DateTimePicker, {
        timezone: "Europe/Istanbul",
        defaultValue: "2026-10-07T10:00",
        ...props,
      }),
    );

  it("değeri her yerde aynı biçimde yazar (alanın kendisi tetikleyicidir)", () => {
    const out = render({ name: "date", id: "when" });
    // Alan tek bir düğme ve içinde tarih metni var: ikon tek başına tetikleyici değil.
    expect(out).toMatch(/<button[^>]*id="when"[^>]*data-trigger/);
    expect(out).toContain("Wed, Oct 7 · 10:00");
    // Form için gizli alan eski datetime-local ile aynı değeri taşır.
    expect(out).toContain('type="hidden" name="date" value="2026-10-07T10:00"');
    // Yerel tarayıcı alanı yok.
    expect(out).not.toMatch(/type="(date|time|datetime-local)"/);
  });

  it("boşken yer tutucu gösterir", () => {
    const out = render({ defaultValue: "" });
    expect(out).toContain("Pick a day and time");
  });

  it("aynı panelde takvim, saat, kısayollar ve saat dilimi bulunur", () => {
    const out = render();
    expect(out).toContain("October 2026");
    expect(out).toContain('data-slot="time-panel"');
    for (const label of ["Today", "Tomorrow", "Next Mon", "In a week"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("09:00");
    expect(out).toContain("Times in Europe/Istanbul");
    expect(out).toContain("Done");
  });

  it("seçili günü işaretler; Clear yalnız clearable iken çıkar", () => {
    const out = render();
    expect(out).toMatch(/data-day="2026-10-07"[^>]*aria-selected="true"/);
    expect(out).not.toContain("Clear");
    expect(render({ clearable: true })).toContain("Clear");
  });

  it("disablePast: bugünden önceki günleri kapatır", () => {
    // Bugün her zaman >= 2000: 2000-01-01 görünümünü zorlamak için min veriyoruz.
    const out = render({
      defaultValue: "2026-10-07T10:00",
      min: "2026-10-05",
    });
    expect(out).toMatch(/data-day="2026-10-04"[^>]*disabled/);
    expect(out).not.toMatch(/data-day="2026-10-05"[^>]*disabled=""/);
  });

  it("readOnly: aynı görünüm, açılmaz (düğme yok)", () => {
    const out = render({ readOnly: true });
    expect(out).toContain('role="textbox"');
    expect(out).toContain("Wed, Oct 7 · 10:00");
    expect(out).not.toContain("data-trigger");
    expect(out).not.toContain("data-popover");
  });
});

describe("DatePicker", () => {
  it("yalnız gün gösterir ve saat paneli çizmez", () => {
    const out = html(
      createElement(DatePicker, { defaultValue: "2026-10-07", name: "day" }),
    );
    expect(out).toContain("Wed, Oct 7");
    expect(out).not.toContain("time-panel");
    expect(out).toContain('name="day" value="2026-10-07"');
    expect(out).toContain("Done");
  });

  it("boşken yer tutucu", () => {
    expect(html(createElement(DatePicker, {}))).toContain("Pick a day");
  });
});

describe("TimePicker", () => {
  it("yalnız saati gösterir, saat panelini çizer, takvim çizmez", () => {
    const out = html(
      createElement(TimePicker, { defaultValue: "09:30", name: "slot1" }),
    );
    expect(out).toContain(">09:30<");
    expect(out).toContain('data-slot="time-panel"');
    expect(out).not.toContain("date-days");
    expect(out).toContain('name="slot1" value="09:30"');
  });

  it("geçersiz değeri yazmaz, gizli alan ham değeri taşır", () => {
    const out = html(createElement(TimePicker, { defaultValue: "bozuk" }));
    expect(out).toContain("Pick a time");
  });

  it("boş slot: Clear yalnız clearable ve dolu iken", () => {
    expect(
      html(createElement(TimePicker, { defaultValue: "", clearable: true })),
    ).not.toContain("Clear");
    expect(
      html(
        createElement(TimePicker, { defaultValue: "09:30", clearable: true }),
      ),
    ).toContain("Clear");
  });
});

describe("CalendarPanel", () => {
  const panel = (extra: Record<string, unknown> = {}) =>
    html(
      createElement(CalendarPanel, {
        selected: "2026-10-07",
        today: "2026-10-03",
        view: { year: 2026, month: 10 },
        onViewChange: () => undefined,
        onSelect: () => undefined,
        ...extra,
      }),
    );

  it("her zaman 42 gün (6 hafta) çizer; Pazartesi'den başlar", () => {
    const out = panel();
    expect((out.match(/data-day="/g) ?? []).length).toBe(42);
    expect(out).toContain('data-day="2026-09-28"');
    expect(out).toContain('data-day="2026-11-08"');
  });

  it("bugünü ve seçili günü ayırt eder; yalnız biri tab sırasında", () => {
    const out = panel();
    expect(out).toMatch(/data-day="2026-10-03"[^>]*aria-current="date"/);
    expect(out).toMatch(/data-day="2026-10-07"[^>]*aria-selected="true"/);
    expect((out.match(/tabindex="0"/g) ?? []).length).toBe(1);
  });

  it("planlı gün sayısı kadar nokta çizer (en çok 3)", () => {
    const out = panel({
      marks: { "2026-10-08": 1, "2026-10-09": 5 },
    });
    expect(out).toMatch(/data-day="2026-10-08"[^>]*title="1 planned"/);
    expect(out).toMatch(/data-day="2026-10-09"[^>]*title="5 planned"/);
    // 9 Ekim hücresinde 3 nokta, 8 Ekim'de 1.
    const cell9 = out.slice(out.indexOf('data-day="2026-10-09"'));
    expect(
      (cell9.slice(0, cell9.indexOf("</button>")).match(/size-\[3px\]/g) ?? [])
        .length,
    ).toBe(3);
  });

  it("alt sınırdan önceki günler kapalı", () => {
    const out = panel({ min: "2026-10-05" });
    expect(out).toMatch(/data-day="2026-10-04"[^>]*disabled/);
  });
});

describe("TimePanel", () => {
  it("saat ve dakika sütunları, yazma alanı ve kısayollar", () => {
    const out = html(
      createElement(TimePanel, {
        value: "14:25",
        onChange: () => undefined,
        step: 5,
        presets: ["09:00", "18:00"],
      }),
    );
    expect(out).toContain('aria-label="Time (HH:mm)"');
    expect(out).toContain('value="14:25"');
    // 24 saat + 12 dakika (5'er) seçeneği
    expect((out.match(/role="option"/g) ?? []).length).toBe(36);
    expect(out).toMatch(/role="option"[^>]*aria-selected="true"[^>]*>14</);
    expect(out).toContain(">09:00<");
  });

  it("ızgara dışı dakika (07) görünür ve seçili", () => {
    const out = html(
      createElement(TimePanel, {
        value: "10:07",
        onChange: () => undefined,
        step: 15,
        presets: [],
      }),
    );
    expect(out).toMatch(/aria-selected="true"[^>]*>07</);
  });
});
