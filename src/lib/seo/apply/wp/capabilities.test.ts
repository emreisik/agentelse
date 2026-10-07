import { describe, expect, it } from "vitest";

import {
  capabilityAllows,
  deriveWpCapabilities,
  healthFromCapabilities,
  isAdministrator,
} from "./capabilities";
import { fixtureMe } from "./test-support";

// Bu dosyanın kanıtladığı: rol başına yetki matrisi (editör, katkıcı, yönetici),
// değişiklik türü başına gereken yetki, sağlık sınıfı ve yönetici uyarısı.

describe("deriveWpCapabilities", () => {
  it("editor can do everything Agentelse needs", () => {
    expect(deriveWpCapabilities(fixtureMe("meEditor"))).toEqual({
      draftPosts: true,
      publishPosts: true,
      editPublishedPosts: true,
      editPages: true,
      editPublishedPages: true,
      editOthers: true,
      deletePosts: true,
    });
  });

  it("contributor can only draft", () => {
    expect(deriveWpCapabilities(fixtureMe("meContributor"))).toEqual({
      draftPosts: true,
      publishPosts: false,
      editPublishedPosts: false,
      editPages: false,
      editPublishedPages: false,
      editOthers: false,
      deletePosts: true,
    });
  });

  it("missing capabilities are false", () => {
    expect(
      deriveWpCapabilities({ id: 1, name: null, roles: [], capabilities: {} }),
    ).toEqual({
      draftPosts: false,
      publishPosts: false,
      editPublishedPosts: false,
      editPages: false,
      editPublishedPages: false,
      editOthers: false,
      deletePosts: false,
    });
  });
});

describe("capabilityAllows", () => {
  const editor = deriveWpCapabilities(fixtureMe("meEditor"));
  const contributor = deriveWpCapabilities(fixtureMe("meContributor"));
  const author = { ...editor, editOthers: false };

  it("allows every kind for an editor", () => {
    expect(capabilityAllows(editor, "PUBLISH_ARTICLE", "post")).toBe(true);
    expect(capabilityAllows(editor, "PUBLISH_LIVE", "post")).toBe(true);
    expect(capabilityAllows(editor, "TITLE_META", "page")).toBe(true);
    expect(capabilityAllows(editor, "INTERNAL_LINKS", "post")).toBe(true);
  });

  it("lets a contributor create drafts only", () => {
    expect(capabilityAllows(contributor, "PUBLISH_ARTICLE", null)).toBe(true);
    expect(capabilityAllows(contributor, "PUBLISH_LIVE", "post")).toBe(false);
    expect(capabilityAllows(contributor, "TITLE_META", "post")).toBe(false);
    expect(capabilityAllows(contributor, "INTERNAL_LINKS", "page")).toBe(false);
  });

  it("editing others' published content needs editOthers", () => {
    expect(capabilityAllows(author, "TITLE_META", "post")).toBe(false);
    expect(capabilityAllows(author, "PUBLISH_LIVE", "post")).toBe(true);
  });

  it("checks the post or page rule separately", () => {
    const noPages = { ...editor, editPublishedPages: false };
    expect(capabilityAllows(noPages, "TITLE_META", "post")).toBe(true);
    expect(capabilityAllows(noPages, "TITLE_META", "page")).toBe(false);
    expect(capabilityAllows(noPages, "INTERNAL_LINKS", null)).toBe(false);
  });
});

describe("healthFromCapabilities", () => {
  it("classifies roles", () => {
    expect(healthFromCapabilities(deriveWpCapabilities(fixtureMe("meEditor")))).toBe("OK");
    expect(healthFromCapabilities(deriveWpCapabilities(fixtureMe("meAdministrator")))).toBe("OK");
    expect(healthFromCapabilities(deriveWpCapabilities(fixtureMe("meContributor")))).toBe("LIMITED");
    expect(
      healthFromCapabilities(
        deriveWpCapabilities({ id: 2, name: null, roles: ["subscriber"], capabilities: { read: true } }),
      ),
    ).toBe("NO_PERMISSION");
  });
});

describe("isAdministrator", () => {
  it("is true only for the administrator role", () => {
    expect(isAdministrator(fixtureMe("meAdministrator"))).toBe(true);
    expect(isAdministrator(fixtureMe("meEditor"))).toBe(false);
    expect(isAdministrator(fixtureMe("meContributor"))).toBe(false);
  });
});
