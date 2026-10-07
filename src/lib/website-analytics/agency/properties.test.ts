import { describe, expect, it } from "vitest";

import {
  addablePropertyOptions,
  canAddExtraProperty,
  pickSelectedLink,
  propertyChips,
} from "./properties";

// Bu dosyanın kanıtladığı: seçili bağ geçerli istekte o mülk, bilinmeyen ya da
// boş istekte ana mülk (hiç yoksa null); çipler ana mülk önde sıralanır, ana
// çip ?property= taşımaz, ekler taşır, dönem korunur; eklenebilir liste
// bağlı olanları düşürür; sınır 4.

type L = {
  id: string;
  propertyId: string;
  propertyName: string | null;
  isPrimary: boolean;
  isSecondary: boolean;
  serviceLevel: string | null;
  health: string;
};

function link(partial: Partial<L> & { id: string; propertyId: string }): L {
  return {
    propertyName: null,
    isPrimary: false,
    isSecondary: false,
    serviceLevel: null,
    health: "OK",
    ...partial,
  };
}

const MAIN = link({ id: "l1", propertyId: "100", propertyName: "Main", isPrimary: true });
const B = link({ id: "l2", propertyId: "200", propertyName: "Blog", isSecondary: true, serviceLevel: "GOOGLE_ANALYTICS_360" });
const A = link({ id: "l3", propertyId: "300", propertyName: "Alpha", isSecondary: true, serviceLevel: "GOOGLE_ANALYTICS_STANDARD" });
const RETIRED = link({ id: "l4", propertyId: "400", propertyName: "Old" });

describe("pickSelectedLink", () => {
  const links = [B, MAIN, A, RETIRED];
  it("returns the requested extra", () => {
    expect(pickSelectedLink(links, "200")?.id).toBe("l2");
    expect(pickSelectedLink(links, "100")?.id).toBe("l1");
  });
  it("falls back to the main property for unknown, empty or retired requests", () => {
    expect(pickSelectedLink(links, "999")?.id).toBe("l1");
    expect(pickSelectedLink(links, "400")?.id).toBe("l1");
    expect(pickSelectedLink(links, null)?.id).toBe("l1");
    expect(pickSelectedLink(links, undefined)?.id).toBe("l1");
    expect(pickSelectedLink(links, "")?.id).toBe("l1");
  });
  it("returns null when there is nothing to select", () => {
    expect(pickSelectedLink([], "100")).toBeNull();
    expect(pickSelectedLink([A], "999")).toBeNull();
  });
});

describe("propertyChips", () => {
  const chips = propertyChips({
    projectId: "p1",
    links: [B, A, RETIRED, MAIN],
    selectedLinkId: "l2",
    period: null,
  });

  it("puts the main property first and sorts extras by name", () => {
    expect(chips.map((chip) => chip.linkId)).toEqual(["l1", "l3", "l2"]);
    expect(chips.map((chip) => chip.role)).toEqual(["main", "extra", "extra"]);
  });

  it("omits ?property= on the main chip and sets it on extras", () => {
    expect(chips[0]?.href).toBe("/projects/p1/site");
    expect(chips[1]?.href).toBe("/projects/p1/site?property=300");
    expect(chips[2]?.href).toBe("/projects/p1/site?property=200");
  });

  it("marks the selected chip and the service level", () => {
    expect(chips.map((chip) => chip.selected)).toEqual([false, false, true]);
    expect(chips.map((chip) => chip.serviceLevel)).toEqual([null, "standard", "360"]);
  });

  it("keeps the period in every href", () => {
    const withPeriod = propertyChips({
      projectId: "p1",
      links: [MAIN, B],
      selectedLinkId: "l1",
      period: "7d",
    });
    expect(withPeriod[0]?.href).toBe("/projects/p1/site?period=7d");
    expect(withPeriod[1]?.href).toBe("/projects/p1/site?property=200&period=7d");
  });

  it("labels an unnamed property by its id", () => {
    const [chip] = propertyChips({
      projectId: "p1",
      links: [link({ id: "l9", propertyId: "900", isPrimary: true })],
      selectedLinkId: null,
      period: null,
    });
    expect(chip?.label).toBe("Property 900");
  });
});

describe("addablePropertyOptions", () => {
  const accessible = [
    { propertyId: "100", propertyName: "Main", accountName: "Acme" },
    { propertyId: "500", propertyName: "Shop", accountName: "Acme" },
    { propertyId: "600", propertyName: "Docs", accountName: "" },
  ];
  it("drops linked properties and labels with the account", () => {
    expect(addablePropertyOptions(accessible, ["100"])).toEqual([
      { propertyId: "500", label: "Shop (Acme)" },
      { propertyId: "600", label: "Docs" },
    ]);
  });
  it("returns nothing when everything is linked", () => {
    expect(addablePropertyOptions(accessible, ["100", "500", "600"])).toEqual([]);
  });
});

describe("canAddExtraProperty", () => {
  it("allows up to four extras", () => {
    expect(canAddExtraProperty(0)).toBe(true);
    expect(canAddExtraProperty(3)).toBe(true);
    expect(canAddExtraProperty(4)).toBe(false);
    expect(canAddExtraProperty(5)).toBe(false);
  });
});
