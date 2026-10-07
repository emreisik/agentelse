import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BrandingSnapshot } from "@/lib/report-share/types";
import { WhiteLabelFrame } from "./white-label-frame";

// Çerçeve: logo varsa img (en çok 40 px), yoksa ad metni; vurgu rengi; alt not
// yedeği; printable bayrağı; Agentelse yazısı hiçbir durumda yok.

const BRANDING: BrandingSnapshot = {
  displayName: "Acme Agency",
  accent: "violet",
  footer: "Prepared by Acme.",
  logoAssetId: null,
};

function render(
  overrides: Partial<{
    branding: BrandingSnapshot;
    logoSrc: string | null;
    printable: boolean;
    periodLabel: string | null;
  }> = {},
): string {
  // Bileşen saf bir işlevdir (hook yok): doğrudan çağrılıp çıktı çizilir.
  return renderToStaticMarkup(
    WhiteLabelFrame({
      branding: overrides.branding ?? BRANDING,
      title: "Weekly report",
      periodLabel:
        overrides.periodLabel === undefined ? "Sep 28 - Oct 4" : overrides.periodLabel,
      logoSrc: overrides.logoSrc ?? null,
      printable: overrides.printable ?? false,
      children: createElement("p", null, "Body"),
    }),
  );
}

describe("WhiteLabelFrame", () => {
  it("shows the display name as text when there is no logo", () => {
    const html = render();
    expect(html).toContain('data-brand-name="true"');
    expect(html).toContain("Acme Agency");
    expect(html).not.toContain("<img");
  });

  it("shows the logo image (max height 40 px) instead of the name", () => {
    const html = render({ logoSrc: "/r/token/logo" });
    expect(html).toContain('<img src="/r/token/logo"');
    expect(html).toContain('alt="Acme Agency"');
    expect(html).toContain("max-height:40px");
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain('data-brand-name="true"');
  });

  it("applies the accent color to the bar", () => {
    expect(render()).toContain("background-color:#7c3aed");
    expect(render({ branding: { ...BRANDING, accent: "orange" } })).toContain(
      "background-color:#ea580c",
    );
  });

  it("renders the title, period and body", () => {
    const html = render();
    expect(html).toContain("Weekly report");
    expect(html).toContain("Sep 28 - Oct 4");
    expect(html).toContain("<p>Body</p>");
    expect(render({ periodLabel: null })).not.toContain("Sep 28");
  });

  it("uses the branding footer, or the default when empty", () => {
    expect(render()).toContain("Prepared by Acme.");
    const fallback = render({ branding: { ...BRANDING, footer: null } });
    expect(fallback).toContain("Numbers from Google.");
    const blank = render({ branding: { ...BRANDING, footer: "   " } });
    expect(blank).toContain("Numbers from Google.");
  });

  it("marks printable frames and keeps print-friendly classes", () => {
    expect(render()).toContain('data-printable="false"');
    const printable = render({ printable: true });
    expect(printable).toContain('data-printable="true"');
    expect(printable).toContain("print:bg-white");
    expect(printable).toContain("print:text-black");
  });

  it("pins light theme tokens so dark mode can't break the body or the print", () => {
    const html = render();
    expect(html).toContain("color-scheme:light");
    expect(html).toContain("--ws-text-2");
  });

  it("never mentions the product name", () => {
    expect(render({ logoSrc: "/x", printable: true }).toLowerCase()).not.toContain(
      "agentelse",
    );
  });
});
