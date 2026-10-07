import { describe, expect, it } from "vitest";

import {
  detectSeoPlugin,
  probeSeoFields,
  SEO_META_KEYS,
  seoValuesOf,
  seoWritePlan,
} from "./plugin-fields";
import { fieldsFixture } from "./test-support";

// Bu dosyanın kanıtladığı: eklenti algılama önceliği, yoklama matrisi (Yoast açık/
// gizli, Rank Math meta/uç nokta, eklenti yok), her biri için yazma planı,
// desteklenmeyen açıklama ve "" ile varsayılana dönüş.

describe("detectSeoPlugin", () => {
  it("detects Yoast and Rank Math namespaces", () => {
    expect(detectSeoPlugin(["wp/v2", "yoast/v1"])).toBe("YOAST");
    expect(detectSeoPlugin(["wp/v2", "rankmath/v1"])).toBe("RANK_MATH");
    expect(detectSeoPlugin(["wp/v2"])).toBe("NONE");
    expect(detectSeoPlugin([])).toBe("NONE");
  });

  it("prefers Rank Math when both are present", () => {
    expect(detectSeoPlugin(["yoast/v1", "rankmath/v1"])).toBe("RANK_MATH");
  });
});

describe("probeSeoFields", () => {
  it("Yoast with exposed keys writes and reads through meta", () => {
    expect(fieldsFixture("yoast")).toEqual({
      plugin: "YOAST",
      titleVia: "META",
      descriptionVia: "META",
      verifiable: true,
    });
  });

  it("Yoast with hidden keys falls back to the post title and no description", () => {
    expect(fieldsFixture("yoast-hidden")).toEqual({
      plugin: "YOAST",
      titleVia: "POST_TITLE",
      descriptionVia: "NONE",
      verifiable: true,
    });
  });

  it("Yoast with only the description exposed", () => {
    expect(
      probeSeoFields("YOAST", {
        metaKeys: [SEO_META_KEYS.yoast.description],
        namespaces: ["yoast/v1"],
      }),
    ).toMatchObject({ titleVia: "POST_TITLE", descriptionVia: "META" });
  });

  it("Rank Math with exposed keys uses meta", () => {
    expect(fieldsFixture("rankmath")).toMatchObject({
      plugin: "RANK_MATH",
      titleVia: "META",
      descriptionVia: "META",
      verifiable: true,
    });
  });

  it("Rank Math with hidden keys uses its endpoint and is not fully verifiable", () => {
    expect(fieldsFixture("rankmath-endpoint")).toEqual({
      plugin: "RANK_MATH",
      titleVia: "RANKMATH_ENDPOINT",
      descriptionVia: "RANKMATH_ENDPOINT",
      verifiable: false,
    });
  });

  it("Rank Math with a mix of exposed and hidden keys", () => {
    expect(
      probeSeoFields("RANK_MATH", {
        metaKeys: [SEO_META_KEYS.rankMath.title],
        namespaces: ["rankmath/v1"],
      }),
    ).toEqual({
      plugin: "RANK_MATH",
      titleVia: "META",
      descriptionVia: "RANKMATH_ENDPOINT",
      verifiable: false,
    });
  });

  it("no plugin: post title only, no description, nothing hidden to verify", () => {
    expect(fieldsFixture("none")).toEqual({
      plugin: "NONE",
      titleVia: "POST_TITLE",
      descriptionVia: "NONE",
      verifiable: true,
    });
  });

  it("ignores another plugin's meta keys", () => {
    expect(
      probeSeoFields("YOAST", {
        metaKeys: Object.values(SEO_META_KEYS.rankMath),
        namespaces: ["yoast/v1"],
      }),
    ).toMatchObject({ titleVia: "POST_TITLE", descriptionVia: "NONE" });
  });
});

describe("seoValuesOf", () => {
  it("reads Yoast meta values, keeping the empty string", () => {
    expect(
      seoValuesOf(fieldsFixture("yoast"), {
        _yoast_wpseo_title: "%%title%%",
        _yoast_wpseo_metadesc: "",
      }),
    ).toEqual({ seoTitle: "%%title%%", seoDescription: "" });
  });

  it("returns null for absent keys and non-string values", () => {
    expect(seoValuesOf(fieldsFixture("yoast"), { _yoast_wpseo_title: 5 })).toEqual({
      seoTitle: null,
      seoDescription: null,
    });
  });

  it("returns null when the fields are not readable through meta", () => {
    expect(
      seoValuesOf(fieldsFixture("rankmath-endpoint"), { rank_math_title: "x" }),
    ).toEqual({ seoTitle: null, seoDescription: null });
    expect(seoValuesOf(fieldsFixture("none"), { _yoast_wpseo_title: "x" })).toEqual({
      seoTitle: null,
      seoDescription: null,
    });
  });
});

describe("seoWritePlan", () => {
  it("Yoast meta: both fields go through meta", () => {
    expect(
      seoWritePlan(fieldsFixture("yoast"), { title: "Başlık", description: "Açıklama" }),
    ).toEqual({
      coreTitle: null,
      meta: { _yoast_wpseo_title: "Başlık", _yoast_wpseo_metadesc: "Açıklama" },
      endpointMeta: null,
      unsupported: null,
    });
  });

  it("Rank Math meta uses the Rank Math keys", () => {
    expect(
      seoWritePlan(fieldsFixture("rankmath"), { title: "T", description: "D" }).meta,
    ).toEqual({ rank_math_title: "T", rank_math_description: "D" });
  });

  it("Rank Math endpoint: nothing in meta, everything in endpointMeta", () => {
    expect(
      seoWritePlan(fieldsFixture("rankmath-endpoint"), { title: "T", description: "D" }),
    ).toEqual({
      coreTitle: null,
      meta: {},
      endpointMeta: { rank_math_title: "T", rank_math_description: "D" },
      unsupported: null,
    });
  });

  it("Yoast hidden: the title falls back to the core title, the description is unsupported", () => {
    expect(seoWritePlan(fieldsFixture("yoast-hidden"), { title: "T", description: null })).toEqual({
      coreTitle: "T",
      meta: {},
      endpointMeta: null,
      unsupported: null,
    });
    expect(
      seoWritePlan(fieldsFixture("yoast-hidden"), { title: "T", description: "D" }).unsupported,
    ).toBe("description");
  });

  it("no plugin: description unsupported, title is the core title", () => {
    expect(seoWritePlan(fieldsFixture("none"), { title: null, description: "D" })).toEqual({
      coreTitle: null,
      meta: {},
      endpointMeta: null,
      unsupported: "description",
    });
  });

  it("an empty string is a valid value that restores the default", () => {
    expect(seoWritePlan(fieldsFixture("yoast"), { title: "", description: "" })).toMatchObject({
      meta: { _yoast_wpseo_title: "", _yoast_wpseo_metadesc: "" },
      unsupported: null,
    });
    expect(seoWritePlan(fieldsFixture("none"), { title: "", description: null }).coreTitle).toBe("");
  });

  it("null fields are not written", () => {
    expect(seoWritePlan(fieldsFixture("yoast"), { title: null, description: null })).toEqual({
      coreTitle: null,
      meta: {},
      endpointMeta: null,
      unsupported: null,
    });
  });
});
