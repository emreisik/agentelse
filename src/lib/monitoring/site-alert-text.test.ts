import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example"),
}));
// SC-F3 D'nin modülü (sözleşme): SEO türleri sabit ifade, GSC genel ifade.
vi.mock("@/lib/seo/health/alert-kinds", () => ({
  SEARCH_TELEGRAM_FALLBACK: "a search health check needs attention",
  seoTelegramPhrase: (kind: string) =>
    kind === "SEO_KEY_PAGE_NOINDEX"
      ? "a key page is set to noindex"
      : "a search health check needs attention",
}));

import { GA_ALERT_KINDS } from "@/lib/website-analytics/health/registry";

import { siteAlertTelegramText } from "./site-alert-text";

// Bu dosyanın kanıtladığı: Telegram metni Google verisinden rakam taşımaz,
// proje adı düz metin olarak geçer (HTML kaçışı yok) ve GA4 bağlantısı
// Website sayfası bayrağına göre seçilir.

const base = { projectName: "Acme", projectId: "proj", websitePage: true };

function stripped(text: string, name: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .split(name)
    .join("");
}

describe("siteAlertTelegramText", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([...GA_ALERT_KINDS, "GA_UNKNOWN"])(
    "GA4 %s carries no digits outside the link and the project name",
    (kind) => {
      const name = "Shop 24/7 2026";
      const text = siteAlertTelegramText({
        ...base,
        projectName: name,
        source: "GA4",
        kind,
      });
      expect(text.startsWith(`Website tracking alert for ${name}: `)).toBe(
        true,
      );
      expect(stripped(text, name)).not.toMatch(/\d/);
    },
  );

  it.each([
    ["GSC", "GSC_SEARCH_DROP"],
    ["SEO", "SEO_KEY_PAGE_NOINDEX"],
    ["SEO", "SEO_SOMETHING_NEW"],
  ] as const)("%s %s carries no digits", (source, kind) => {
    const text = siteAlertTelegramText({ ...base, source, kind });
    expect(stripped(text, "Acme")).not.toMatch(/\d/);
    expect(text).toContain("/projects/proj/arama#health");
  });

  it("uses fixed phrases per kind and the generic phrase for GSC", () => {
    expect(
      siteAlertTelegramText({ ...base, source: "GA4", kind: "GA_MH1" }),
    ).toBe(
      "Website tracking alert for Acme: Google Analytics stopped receiving data. Open Agentelse: https://app.example/projects/proj/site#measurement-health",
    );
    expect(
      siteAlertTelegramText({ ...base, source: "GA4", kind: "GA_MH7" }),
    ).toContain("Google Analytics tracking needs your attention");
    const gsc = siteAlertTelegramText({
      ...base,
      source: "GSC",
      kind: "GSC_SEARCH_DROP",
    });
    expect(gsc).toContain(
      "Search alert for Acme: a search health check needs attention.",
    );
    expect(gsc).not.toContain("drop");
    expect(
      siteAlertTelegramText({
        ...base,
        source: "SEO",
        kind: "SEO_KEY_PAGE_NOINDEX",
      }),
    ).toContain("Search alert for Acme: a key page is set to noindex.");
  });

  it("keeps the project name verbatim (plain text, no escaping)", () => {
    const text = siteAlertTelegramText({
      ...base,
      projectName: "A & B <x>",
      source: "GA4",
      kind: "GA_MH24",
    });
    expect(text).toContain("A & B <x>");
    expect(text).not.toContain("&amp;");
  });

  it("collapses whitespace and caps the project name", () => {
    const text = siteAlertTelegramText({
      ...base,
      projectName: `  A \n  B ${"x".repeat(200)}`,
      source: "GA4",
      kind: "GA_MH1",
    });
    const name = text.slice(
      "Website tracking alert for ".length,
      text.indexOf(": "),
    );
    expect(name.startsWith("A B x")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it("links GA4 to the Website panel or falls back to the Integrations dialog", () => {
    expect(
      siteAlertTelegramText({ ...base, source: "GA4", kind: "GA_MH1" }),
    ).toContain("/projects/proj/site#measurement-health");
    expect(
      siteAlertTelegramText({
        ...base,
        websitePage: false,
        source: "GA4",
        kind: "GA_MH1",
      }),
    ).toContain("/projects/proj/integrations?integration=google_analytics");
  });
});
