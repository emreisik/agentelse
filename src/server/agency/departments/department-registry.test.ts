import { describe, expect, it } from "vitest";

import {
  ALL_DEPARTMENT_KEYS,
  DEPARTMENTS,
  ownerOfCapability,
} from "@/server/agency/departments/department-registry";

describe("DepartmentRegistry", () => {
  it("defines all 19 departments", () => {
    expect(ALL_DEPARTMENT_KEYS).toHaveLength(19);
  });

  it("no capability is owned by two departments", () => {
    const seen = new Map<string, string>();
    for (const def of Object.values(DEPARTMENTS)) {
      for (const capability of def.ownedCapabilities) {
        expect(
          seen.has(capability),
          `${capability} owned by both ${seen.get(capability)} and ${def.key}`,
        ).toBe(false);
        seen.set(capability, def.key);
      }
    }
  });

  it("routes core capabilities to the expected owners", () => {
    expect(ownerOfCapability("CREATE_COPY")).toBe("COPY_CONTENT");
    expect(ownerOfCapability("INSTAGRAM_PUBLISH")).toBe("SOCIAL_MEDIA");
    expect(ownerOfCapability("SEO_RESEARCH")).toBe("SEO");
    expect(ownerOfCapability("WEBSITE_UPDATE")).toBe("WEB_PRODUCT");
    expect(ownerOfCapability("COMPETITOR_RESEARCH")).toBe(
      "COMPETITOR_INTELLIGENCE",
    );
    expect(ownerOfCapability("PR_OUTREACH")).toBe("PR_MEDIA");
  });

  it("every department declares a council affinity", () => {
    for (const def of Object.values(DEPARTMENTS)) {
      expect(def.councilAffinity).toBeTruthy();
    }
  });
});
