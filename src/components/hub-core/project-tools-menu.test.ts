import { describe, expect, it } from "vitest";

import { ADVANCED_PANEL_KEYS } from "./hub-core-params";
import { MENU_PANELS } from "./project-tools-menu";

// The sidebar no longer lists Setup, Departments and Human Action: the header's
// Advanced menu is the way to them. This pins that it still offers every one,
// so taking them off the sidebar can never leave a panel without an entry.

describe("Advanced menu", () => {
  it("offers every advanced panel and nothing else", () => {
    expect([...MENU_PANELS].sort()).toEqual([...ADVANCED_PANEL_KEYS].sort());
  });

  it("includes the panels the sidebar dropped", () => {
    for (const panel of ["setup", "departments", "human-action"] as const) {
      expect(MENU_PANELS).toContain(panel);
    }
  });

  it("still offers Settings (it is also a line in the sidebar)", () => {
    expect(MENU_PANELS).toContain("settings");
  });
});
