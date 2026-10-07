import { describe, expect, it } from "vitest";

import { LLMS_MAX_BYTES, LLMS_MAX_LINKS, buildLlmsTxt, parseLlmsTxt } from "./llms";

// Bu dosyanın kanıtladığı (SC-F8 GEO1): geçerli, boş, HTML, başlıksız ve çok
// büyük dosya ayrıştırması; taslak altın örnek, aynı site filtresi, https
// zorunluluğu, tek satır temizliği, 40 bağlantı sınırı ve belirleyicilik.

describe("parseLlmsTxt", () => {
  it("reads a valid file", () => {
    const parsed = parseLlmsTxt(
      "# Acme\n\n> Widgets.\n\n## Docs\n\n- [Start](https://acme.test/start): go\n- [More](https://acme.test/more)\n",
    );
    expect(parsed).toMatchObject({
      valid: true,
      hasTitle: true,
      links: 2,
      sections: 1,
    });
  });

  it("flags an empty file and an HTML page", () => {
    expect(parseLlmsTxt("   \n").valid).toBe(false);
    expect(parseLlmsTxt("<!doctype html><html></html>").valid).toBe(false);
    expect(parseLlmsTxt("<html><body># Hi</body></html>").hasTitle).toBe(false);
  });

  it("is valid without a title line but reports it", () => {
    const parsed = parseLlmsTxt("Just a note about the site.\n");
    expect(parsed.valid).toBe(true);
    expect(parsed.hasTitle).toBe(false);
  });

  it("needs the title on the first non-empty line", () => {
    expect(parseLlmsTxt("\n\n# Late title\n").hasTitle).toBe(true);
    expect(parseLlmsTxt("intro\n# Title\n").hasTitle).toBe(false);
    expect(parseLlmsTxt("#NoSpace\n").hasTitle).toBe(false);
  });

  it("handles an oversized file without throwing", () => {
    const big = `# Big\n${"- [x](https://acme.test/a)\n".repeat(20_000)}`;
    const parsed = parseLlmsTxt(big);
    expect(parsed.valid).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(LLMS_MAX_BYTES);
  });
});

describe("buildLlmsTxt", () => {
  const pages = [
    { url: "https://acme.test/", title: "Home", description: "Welcome home" },
    { url: "https://acme.test/pricing", title: "Pricing", description: null },
    { url: "https://acme.test/blog/post", title: null, description: "A post" },
  ];

  it("builds the golden draft", () => {
    expect(
      buildLlmsTxt({ siteName: "Acme", description: "We sell widgets.", pages }),
    ).toBe(
      [
        "# Acme",
        "",
        "> We sell widgets.",
        "",
        "## Key pages",
        "",
        "- [Home](https://acme.test/): Welcome home",
        "- [Pricing](https://acme.test/pricing)",
        "- [/blog/post](https://acme.test/blog/post): A post",
        "",
      ].join("\n"),
    );
  });

  it("is deterministic and parses as a valid llms.txt", () => {
    const input = { siteName: "Acme", description: null, pages };
    expect(buildLlmsTxt(input)).toBe(buildLlmsTxt(input));
    const parsed = parseLlmsTxt(buildLlmsTxt(input));
    expect(parsed).toMatchObject({ valid: true, hasTitle: true, links: 3 });
  });

  it("keeps only https links of the same site", () => {
    const text = buildLlmsTxt({
      siteName: "Acme",
      description: null,
      pages: [
        ...pages,
        { url: "http://acme.test/plain", title: "Plain", description: null },
        { url: "https://other.test/x", title: "Other", description: null },
        { url: "not a url", title: "Bad", description: null },
        { url: "https://acme.test/pricing#top", title: "Dup", description: null },
      ],
    });
    expect(text).not.toContain("plain");
    expect(text).not.toContain("other.test");
    expect(text).not.toContain("Bad");
    expect(text).not.toContain("Dup");
  });

  it("uses an explicit host when given", () => {
    const text = buildLlmsTxt({
      siteName: "Acme",
      description: null,
      host: "acme.test",
      pages: [
        { url: "https://other.test/", title: "Other", description: null },
        ...pages,
      ],
    });
    expect(text).not.toContain("other.test");
    expect(text).toContain("https://acme.test/pricing");
  });

  it("flattens multi-line and markdown-breaking text", () => {
    const text = buildLlmsTxt({
      siteName: "## Acme\nInc",
      description: "Line one\n\nline two\u0000",
      pages: [
        {
          url: "https://acme.test/a(b)",
          title: "A [tricky]\ntitle",
          description: "x\ny",
        },
      ],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Acme Inc");
    expect(lines[2]).toBe("> Line one line two");
    expect(text).toContain("- [A (tricky) title](https://acme.test/a%28b%29): x y");
  });

  it("caps the link count at 40", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      url: `https://acme.test/p${index}`,
      title: `P${index}`,
      description: null,
    }));
    const text = buildLlmsTxt({ siteName: "Acme", description: null, pages: many });
    expect(parseLlmsTxt(text).links).toBe(LLMS_MAX_LINKS);
  });

  it("writes only the title when there are no pages", () => {
    expect(buildLlmsTxt({ siteName: "", description: null, pages: [] })).toBe(
      "# Site\n",
    );
  });
});
