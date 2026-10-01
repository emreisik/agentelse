import { describe, expect, it } from "vitest";

import {
  CREATE_COPY,
  NO_OFFER,
  intakeCopyFor,
  intakeStartsOf,
} from "./intake-offer";

// The creation screen's note and the server's start decision come from these two
// functions, so what the screen promises is exactly what the tap starts.

const OFFERS = [
  { name: "nothing", offer: NO_OFFER },
  { name: "scan", offer: { scan: true, research: false } },
  { name: "scan and research", offer: { scan: true, research: true } },
  { name: "research without a scan (never offered)", offer: { scan: false, research: true } },
];

describe("what the tap starts", () => {
  it("starts nothing without a website, whatever is offered", () => {
    for (const { offer } of OFFERS) {
      expect(intakeStartsOf(offer, false)).toEqual(NO_OFFER);
    }
  });

  it("starts what is offered once there is a website", () => {
    expect(intakeStartsOf({ scan: true, research: false }, true)).toEqual({
      scan: true,
      research: false,
    });
    expect(intakeStartsOf({ scan: true, research: true }, true)).toEqual({
      scan: true,
      research: true,
    });
  });

  it("never starts the research without the scan being offered", () => {
    expect(intakeStartsOf({ scan: false, research: true }, true)).toEqual({
      scan: true,
      research: false,
    });
  });
});

describe("what the screen says", () => {
  it("says nothing and keeps today's label when nothing can start", () => {
    expect(intakeCopyFor(NO_OFFER, true)).toEqual({
      button: CREATE_COPY.idle,
      note: null,
      spends: false,
    });
    expect(intakeCopyFor(NO_OFFER, false).note).toBeNull();
  });

  it("names the spend and the bigger half when the research starts", () => {
    const copy = intakeCopyFor({ scan: true, research: true }, true);

    expect(copy.button).toBe("Create and set up with AI");
    expect(copy.note).toContain("research your brand");
    expect(copy.note).toContain("AI credit");
    expect(copy.spends).toBe(true);
  });

  it("names the spend for the scan alone", () => {
    const copy = intakeCopyFor({ scan: true, research: false }, true);

    expect(copy.button).toBe("Create and read my website");
    expect(copy.note).toContain("logo, colors and fonts");
    expect(copy.spends).toBe(true);
  });

  it("promises no spend when there is no website: nothing will start", () => {
    for (const offer of [
      { scan: true, research: false },
      { scan: true, research: true },
    ]) {
      const copy = intakeCopyFor(offer, false);
      expect(copy.button).toBe("Create and continue");
      expect(copy.note).toBe(CREATE_COPY.noteNoSite);
      expect(copy.spends).toBe(false);
      expect(copy.note).not.toContain("AI credit");
    }
  });

  it("the note mentions AI credit exactly when the tap starts something (promise equals action)", () => {
    for (const { offer } of OFFERS) {
      for (const hasWebsite of [false, true]) {
        const copy = intakeCopyFor(offer, hasWebsite);
        const starts = intakeStartsOf(offer, hasWebsite);
        expect(copy.spends).toBe(starts.scan || starts.research);
        expect((copy.note ?? "").includes("AI credit")).toBe(copy.spends);
      }
    }
  });
});
