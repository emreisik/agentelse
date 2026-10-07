import type { GaPropertyLink } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { selectedGaLinkFor, withSelectedGaLink } from "./selected-link";

// Bu dosyanın kanıtladığı: geçersiz kılma yalnız run içinde ve yalnız aynı
// projede görünür; iç içe await'ler depoyu korur; null ile run() aynen çalışır;
// run bitince depo temizdir.

function link(projectId: string): GaPropertyLink {
  return { id: `l-${projectId}`, projectId } as unknown as GaPropertyLink;
}

describe("selected-link", () => {
  it("returns nothing outside a run", () => {
    expect(selectedGaLinkFor("p1")).toBeNull();
  });

  it("returns the link inside the run for the same project only", async () => {
    const selected = link("p1");
    await withSelectedGaLink(selected, async () => {
      expect(selectedGaLinkFor("p1")).toBe(selected);
      expect(selectedGaLinkFor("p2")).toBeNull();
    });
    expect(selectedGaLinkFor("p1")).toBeNull();
  });

  it("keeps the store across nested awaits and parallel branches", async () => {
    const selected = link("p1");
    await withSelectedGaLink(selected, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(selectedGaLinkFor("p1")).toBe(selected);
      const [a, b] = await Promise.all([
        (async () => {
          await Promise.resolve();
          return selectedGaLinkFor("p1");
        })(),
        (async () => selectedGaLinkFor("p1"))(),
      ]);
      expect(a).toBe(selected);
      expect(b).toBe(selected);
    });
  });

  it("with null just awaits run() and sets nothing", async () => {
    const result = await withSelectedGaLink(null, async () => {
      expect(selectedGaLinkFor("p1")).toBeNull();
      return 42;
    });
    expect(result).toBe(42);
  });

  it("does not leak into a concurrent unrelated run", async () => {
    const selected = link("p1");
    const inside = withSelectedGaLink(selected, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return selectedGaLinkFor("p1");
    });
    const outside = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return selectedGaLinkFor("p1");
    })();
    expect(await inside).toBe(selected);
    expect(await outside).toBeNull();
  });
});
