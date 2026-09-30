import { describe, expect, it } from "vitest";

import {
  DOMAIN_MAX_LENGTH,
  MAX_MARKETS,
  NAME_MAX_LENGTH,
  parseCreateProjectForm,
} from "./project-create-input";
import { SUPPORTED_COUNTRIES } from "./locales";

// The create-project Server Action is a public POST endpoint. This parser is
// the server-side rule: it accepts only what the screen can produce, and every
// refusal says which field it belongs to so the form can print it there.

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const valid: [string, string][] = [
  ["name", "Mülk Web"],
  ["language", "tr"],
  ["country", "TR"],
];

const withEntries = (...extra: [string, string][]) =>
  form([...valid, ...extra]);
const without = (key: string) => form(valid.filter(([name]) => name !== key));

describe("a valid form", () => {
  it("parses the smallest one", () => {
    expect(parseCreateProjectForm(form(valid))).toEqual({
      ok: true,
      value: {
        name: "Mülk Web",
        language: "tr",
        countries: ["TR"],
        country: "TR",
      },
    });
  });

  it("trims the text fields", () => {
    const result = parseCreateProjectForm(
      form([
        ["name", "  Mülk Web  "],
        ["brandName", "  Mülk  "],
        ["language", "tr"],
        ["country", " TR "],
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { name: "Mülk Web", brandName: "Mülk", country: "TR" },
    });
  });

  it("keeps the website as a bare domain", () => {
    const result = parseCreateProjectForm(
      withEntries(["domain", "https://www.Mulkweb.com.tr/hakkimizda?x=1"]),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { domain: "mulkweb.com.tr" },
    });
  });

  it("leaves the optional fields out entirely when they are empty", () => {
    const result = parseCreateProjectForm(
      withEntries(["domain", "  "], ["brandName", ""]),
    );

    expect(result.ok && "domain" in result.value).toBe(false);
    expect(result.ok && "brandName" in result.value).toBe(false);
  });

  it("makes the first market the primary one and keeps the order", () => {
    const result = parseCreateProjectForm(
      form([
        ["name", "X"],
        ["language", "en"],
        ["country", "MK"],
        ["country", "AL"],
        ["country", "MK"],
        ["country", "XK"],
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { country: "MK", countries: ["MK", "AL", "XK"] },
    });
  });

  it("keeps a known locale source and drops an unknown one", () => {
    expect(
      parseCreateProjectForm(withEntries(["localeSource", "tld"])),
    ).toMatchObject({ ok: true, value: { localeSource: "tld" } });

    const unknown = parseCreateProjectForm(
      withEntries(["localeSource", "gps"]),
    );
    expect(unknown.ok && "localeSource" in unknown.value).toBe(false);
  });

  it("accepts every supported market as the primary one", () => {
    for (const { code } of SUPPORTED_COUNTRIES) {
      expect(
        parseCreateProjectForm(
          form([
            ["name", "X"],
            ["language", "en"],
            ["country", code],
          ]),
        ).ok,
      ).toBe(true);
    }
  });
});

describe("refusals name their field", () => {
  it("asks for a brand name", () => {
    expect(parseCreateProjectForm(without("name"))).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(
      parseCreateProjectForm(
        form([
          ["name", "   "],
          ["language", "tr"],
          ["country", "TR"],
        ]),
      ),
    ).toMatchObject({ ok: false, field: "name" });
  });

  it("refuses an over-long name at the limit plus one", () => {
    const build = (length: number) =>
      form([
        ["name", "a".repeat(length)],
        ["language", "tr"],
        ["country", "TR"],
      ]);

    expect(parseCreateProjectForm(build(NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseCreateProjectForm(build(NAME_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
      field: "name",
    });
  });

  it("refuses an over-long brand name", () => {
    expect(
      parseCreateProjectForm(
        withEntries(["brandName", "b".repeat(NAME_MAX_LENGTH + 1)]),
      ),
    ).toMatchObject({ ok: false, field: "brandName" });
  });

  it.each([
    "not a domain",
    "http://",
    "a..b",
    "-bad.com",
    "localhost",
    "a b.com",
  ])("refuses the website %j", (domain) => {
    expect(
      parseCreateProjectForm(withEntries(["domain", domain])),
    ).toMatchObject({ ok: false, field: "domain" });
  });

  it("refuses a website longer than a hostname can be", () => {
    const label = "a".repeat(60);
    const long = `${label}.${label}.${label}.${label}.${label}.com`;

    expect(long.length).toBeGreaterThan(DOMAIN_MAX_LENGTH);
    expect(parseCreateProjectForm(withEntries(["domain", long]))).toMatchObject(
      { ok: false, field: "domain" },
    );
  });

  it("asks for a market when there is none", () => {
    expect(parseCreateProjectForm(without("country"))).toMatchObject({
      ok: false,
      field: "country",
    });
    expect(
      parseCreateProjectForm(
        form([
          ["name", "X"],
          ["language", "tr"],
          ["country", "  "],
        ]),
      ),
    ).toMatchObject({ ok: false, field: "country" });
  });

  it("refuses a market that is not on the list, even as an extra one", () => {
    expect(
      parseCreateProjectForm(
        form([
          ["name", "X"],
          ["language", "tr"],
          ["country", "ZZ"],
        ]),
      ),
    ).toMatchObject({ ok: false, field: "country" });
    expect(
      parseCreateProjectForm(withEntries(["country", "ZZ"])),
    ).toMatchObject({ ok: false, field: "country" });
    expect(
      parseCreateProjectForm(
        form([
          ["name", "X"],
          ["language", "tr"],
          ["country", "tr"],
        ]),
      ),
    ).toMatchObject({ ok: false, field: "country" });
  });

  it("refuses more markets than there are supported ones", () => {
    const many = [
      ...SUPPORTED_COUNTRIES.map((country) => country.code),
      ...Array.from({ length: MAX_MARKETS }, (_, index) => `X${index}`),
    ];

    expect(
      parseCreateProjectForm(
        form([
          ["name", "X"],
          ["language", "tr"],
          ...many.map((code): [string, string] => ["country", code]),
        ]),
      ),
    ).toMatchObject({ ok: false, field: "country" });
  });

  it("refuses a language that is not offered", () => {
    expect(parseCreateProjectForm(without("language"))).toMatchObject({
      ok: false,
      field: "language",
    });
    expect(
      parseCreateProjectForm(
        form([
          ["name", "X"],
          ["language", "xx"],
          ["country", "TR"],
        ]),
      ),
    ).toMatchObject({ ok: false, field: "language" });
  });

  it("gives every refusal a message to print", () => {
    const refusals = [
      without("name"),
      without("country"),
      without("language"),
      withEntries(["domain", "nope"]),
    ].map(parseCreateProjectForm);

    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(!refusal.ok && refusal.message.length > 0).toBe(true);
    }
  });

  it("does not trust a file that arrives under a text field's name", () => {
    const data = new FormData();
    data.append("name", new File(["x"], "name.txt"));
    data.append("language", "tr");
    data.append("country", "TR");

    expect(parseCreateProjectForm(data)).toMatchObject({
      ok: false,
      field: "name",
    });
  });
});
