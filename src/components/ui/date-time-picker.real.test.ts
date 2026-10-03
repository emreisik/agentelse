import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DateTimePicker, TimePicker } from "./date-time-picker";

// Popover SAHTELENMEDEN, gerçek base-ui ile: alan bir formun içinde durur
// (ayarlar, "Add to calendar"...). Tetikleyici `type="button"` olmak ZORUNDA,
// yoksa tarihe tıklamak formu gönderirdi.
describe("gerçek popover ile alan", () => {
  it("tetikleyici bir form içinde formu göndermez ve değeri gizli alanda taşır", () => {
    const out = renderToStaticMarkup(
      createElement(TimePicker, {
        id: "slot-1",
        name: "slot1",
        defaultValue: "09:30",
      }),
    );
    expect(out).toContain('<input type="hidden" name="slot1" value="09:30"');
    const trigger = /<button[^>]*id="slot-1"[^>]*>/.exec(out)?.[0] ?? "";
    expect(trigger).toContain('type="button"');
    expect(out).toContain("09:30");
    // Kapalıyken panel çizilmez (açılışta kurulur).
    expect(out).not.toContain("time-panel");
  });

  it("gün+saat alanı da aynı şekilde", () => {
    const out = renderToStaticMarkup(
      createElement(DateTimePicker, {
        name: "date",
        defaultValue: "2026-10-07T10:00",
        timezone: "UTC",
      }),
    );
    expect(out).toContain('name="date" value="2026-10-07T10:00"');
    expect(/<button[^>]*>/.exec(out)?.[0]).toContain('type="button"');
    expect(out).toContain("Wed, Oct 7 · 10:00");
    expect(out).not.toContain("data-day");
  });
});
