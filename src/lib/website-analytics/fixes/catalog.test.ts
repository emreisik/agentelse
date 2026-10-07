import { describe, expect, it } from "vitest";
import {
  GA_FIX_CATALOG,
  GA_FIX_FOR_CHECK,
  gaFixIsAlpha,
} from "./catalog";
import { GA_FIX_KINDS, type GaFixKind, type GaFixParams } from "./types";

const PARAMS: Record<GaFixKind, GaFixParams> = {
  KEY_EVENT_CREATE: { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" },
  RETENTION_14M: { kind: "RETENTION_14M" },
  ENHANCED_MEASUREMENT: { kind: "ENHANCED_MEASUREMENT" },
  CHANNEL_GROUP_AI: { kind: "CHANNEL_GROUP_AI" },
  ANNOTATION_CREATE: {
    kind: "ANNOTATION_CREATE",
    title: `Agentelse: ${"x".repeat(49)}`,
    day: "2026-10-01",
  },
};

describe("GA_FIX_CATALOG", () => {
  it("her tür için bir girdi var", () => {
    for (const kind of GA_FIX_KINDS) {
      expect(GA_FIX_CATALOG[kind].kind).toBe(kind);
    }
  });

  it("başlıklar en çok 80 karakter", () => {
    for (const kind of GA_FIX_KINDS) {
      const title = GA_FIX_CATALOG[kind].title(PARAMS[kind]);
      expect(title.length).toBeGreaterThan(0);
      expect(Array.from(title).length).toBeLessThanOrEqual(80);
    }
  });

  it("başlık içeriği", () => {
    expect(GA_FIX_CATALOG.KEY_EVENT_CREATE.title(PARAMS.KEY_EVENT_CREATE)).toBe(
      "Mark generate_lead as a key event in Google Analytics",
    );
    expect(GA_FIX_CATALOG.RETENTION_14M.title(PARAMS.RETENTION_14M)).toBe(
      "Keep Google Analytics event data for 14 months",
    );
    expect(
      GA_FIX_CATALOG.ANNOTATION_CREATE.title({
        kind: "ANNOTATION_CREATE",
        title: "Agentelse: Spring sale",
        day: "2026-10-01",
      }),
    ).toBe("Add a note to Google Analytics: Spring sale");
  });

  it("alfa bayrakları", () => {
    expect(gaFixIsAlpha("ENHANCED_MEASUREMENT")).toBe(true);
    expect(gaFixIsAlpha("CHANNEL_GROUP_AI")).toBe(true);
    expect(gaFixIsAlpha("ANNOTATION_CREATE")).toBe(true);
    expect(gaFixIsAlpha("KEY_EVENT_CREATE")).toBe(false);
    expect(gaFixIsAlpha("RETENTION_14M")).toBe(false);
    expect(GA_FIX_CATALOG.KEY_EVENT_CREATE.api).toBe("v1beta");
    expect(GA_FIX_CATALOG.RETENTION_14M.api).toBe("v1beta");
  });

  it("onay satırları dört satır ve mülk adı yok", () => {
    for (const kind of GA_FIX_KINDS) {
      const rows = GA_FIX_CATALOG[kind].approvalRows(PARAMS[kind]);
      expect(rows.map((row) => row.label)).toEqual([
        "What happens",
        "Where",
        "Undo",
        "Expires",
      ]);
      expect(rows[0]?.value).toBe(GA_FIX_CATALOG[kind].effect(PARAMS[kind]));
      expect(rows[1]?.value).toBe("Your Google Analytics property");
      expect(rows[2]?.value).toBe("You can undo it later");
      expect(rows[3]?.value).toBe("In 7 days if nobody decides");
    }
  });

  it("yalnız saklama süresinin geri alma uyarısı var", () => {
    for (const kind of GA_FIX_KINDS) {
      const warning = GA_FIX_CATALOG[kind].undoWarning;
      if (kind === "RETENTION_14M") expect(warning).toMatch(/shortens/);
      else expect(warning).toBeNull();
      expect(GA_FIX_CATALOG[kind].undoable).toBe(true);
    }
  });

  it("kontrol eşlemesi", () => {
    expect(GA_FIX_FOR_CHECK).toEqual({
      MH5: "KEY_EVENT_CREATE",
      MH14: "RETENTION_14M",
      MH17: "ENHANCED_MEASUREMENT",
    });
  });
});
