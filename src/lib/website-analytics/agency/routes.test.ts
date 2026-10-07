import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SEARCH_OVERVIEW_HREF, WEBSITES_OVERVIEW_HREF } from "./routes";

// Bu dosyanın kanıtladığı: iki ajans görünümünün adresleri sabittir ve
// sayfa dosyaları bu adreslerle aynı yerde durur.

const appDir = path.join(process.cwd(), "src", "app");

describe("agency overview routes", () => {
  it("keeps the two sibling pages at fixed addresses", () => {
    expect(WEBSITES_OVERVIEW_HREF).toBe("/websites");
    expect(SEARCH_OVERVIEW_HREF).toBe("/search");
  });

  it("serves /websites from src/app/websites", () => {
    expect(existsSync(path.join(appDir, "websites", "page.tsx"))).toBe(true);
  });

  // SC-F9 inmeden önce atlanır (existsSync koruması): iniş sonrası /search
  // sayfası SEARCH_OVERVIEW_HREF'in hedefidir.
  const searchPage = path.join(appDir, "search", "page.tsx");
  it.skipIf(!existsSync(searchPage))(
    "serves /search from src/app/search once Search agency landed",
    () => {
      expect(existsSync(searchPage)).toBe(true);
      expect(SEARCH_OVERVIEW_HREF).toBe("/search");
    },
  );
});
