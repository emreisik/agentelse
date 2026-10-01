import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The panel's interactive leaves import server actions (prisma, next-auth,
// object storage); none of them run during a static render.
vi.mock("@/server/actions/project-actions", () => ({
  updateApprovedFontsAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-visual-identity-actions", () => ({
  updateVisualIdentityColorsAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-layout-actions", () => ({
  updateLayoutTemplatesAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-scan-actions", () => ({
  applyBrandScanAction: vi.fn(),
  scanBrandWebsiteAction: vi.fn(),
}));

const { BrandSummaryPanel } = await import("./brand-summary-panel");
const { buildBrandKit, DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");

import type { ConnectedAccount } from "@/lib/connected-accounts";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

const twin = (overrides: Partial<BrandTwin> = {}): BrandTwin => ({
  brandId: "brand-1",
  projectId: "proj-1",
  name: "Web Health",
  version: 1,
  confidence: "high",
  isMock: false,
  identity: null,
  businessModel: null,
  positioning: null,
  valueProposition: "Measurable patient acquisition",
  audience: [],
  markets: ["Turkey"],
  products: [],
  voice: { personality: "Confident, calm", toneOfVoice: null },
  visualDNA: { description: null, colors: [], fonts: [], logoAssetId: null },
  approvedClaims: [],
  unverifiedClaims: [],
  negativeRules: ["No stock smiles"],
  currentFocus: null,
  creativePreferences: [],
  creativeMemory: { works: [], avoid: [] },
  sources: [],
  updatedAt: null,
  ...overrides,
});

const identity = (
  overrides: Partial<BrandVisualIdentityContext> = {},
): BrandVisualIdentityContext => ({
  primaryColors: [{ hex: "#0b1f3a", name: "Navy" }],
  secondaryColors: [{ hex: "#0d9488", name: "Teal" }],
  accentColors: [{ hex: "#2dd4bf" }],
  photographyStyle: "PHOTOGRAPHIC",
  styleRefinement: "Soft daylight, clean surfaces",
  moodTags: ["calm", "trustworthy"],
  compositionNotes: "Generous negative space",
  backgroundTone: "DARK",
  alwaysInclude: ["natural light"],
  alwaysAvoid: ["stock smiles"],
  referenceImageAssetId: null,
  template: {
    enabled: true,
    logoPosition: "BOTTOM_RIGHT",
    logoSizePercent: 16,
    logoMarginPercent: 4,
    accentBarEnabled: true,
    accentBarColorHex: null,
    accentBarHeightPercent: 5,
    accentBarPosition: "BOTTOM",
  },
  ...overrides,
});

function render(
  brand: BrandTwin | null,
  kitInput: Parameters<typeof buildBrandKit>[0] | null,
  website: string | null = "webhealth.com.tr",
  connections: ConnectedAccount[] = [],
) {
  return renderToStaticMarkup(
    createElement(BrandSummaryPanel, {
      projectId: "proj-1",
      brand,
      website,
      kit: kitInput ? buildBrandKit(kitInput) : null,
      connections,
    }),
  );
}

// The slice of the markup between two markers (to assert inside one card).
function between(html: string, from: string, to?: string) {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  return to ? html.slice(start, html.indexOf(to, start + from.length)) : html.slice(start);
}

const fullKit = {
  legacyColors: [],
  fonts: ["Playfair Display", "Inter"],
  logoAssetId: "logo-light",
  darkLogoAssetId: "logo-dark",
  identity: identity(),
};

const accounts: ConnectedAccount[] = [
  { key: "instagram", label: "Instagram", state: "connected", detail: "@webhealth" },
  { key: "facebook", label: "Facebook", state: "connected" },
  { key: "meta-ads", label: "Meta Ads", state: "off" },
  { key: "ga4", label: "Google Analytics 4", state: "setup" },
  { key: "search-console", label: "Search Console", state: "connected" },
  { key: "website", label: "Website", state: "active", detail: "webhealth.com.tr" },
];

describe("BrandSummaryPanel (cards)", () => {
  it("leads with the brand summary card, then the accounts card, then the collapsed cards", () => {
    const html = render(twin(), fullKit, "webhealth.com.tr", accounts);
    const order = [
      'data-card="brand-summary"',
      'data-card="connected-accounts"',
      'data-card="collapsible-Marka kiti"',
      'data-card="collapsible-Marka stratejisi"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Marka özeti");
    expect(html).toContain("Bağlı hesaplar");
    // The mockup's third card was dropped on purpose.
    expect(html).not.toContain("Agentelse fark etti");
  });

  it("shows the name once, the site, the verified tick and an edit link into Brand Brain", () => {
    const html = render(twin(), fullKit);
    const card = between(html, 'data-card="brand-summary"', 'data-card="connected-accounts"');
    expect(card).toContain("webhealth.com.tr");
    expect(card).toContain("Düzenle");
    expect(card).toContain("panel=brand-brain");
    // The visible name is rendered exactly once in the whole tab.
    expect(html.match(/>Web Health</g)).toHaveLength(1);
    // The old hero and its settings popover are gone.
    expect(html).not.toContain('data-kit="hero"');
    expect(html).not.toContain('aria-label="Brand settings"');
  });

  it("lists sector, audience, tone of voice and markets, leaving out what is empty", () => {
    const full = render(
      twin({
        businessModel: "Sağlık turizmi",
        audience: ["Yurt dışı hastalar", "Aileler"],
        voice: { personality: "Profesyonel, net", toneOfVoice: "net, güvenilir" },
        markets: ["Türkiye", "Almanya"],
      }),
      fullKit,
    );
    const card = between(full, 'data-card="brand-summary"', 'data-card="connected-accounts"');
    expect(card).toContain("Sektör");
    expect(card).toContain("Sağlık turizmi");
    expect(card).toContain("Hedef Kitle");
    expect(card).toContain("Yurt dışı hastalar, Aileler");
    expect(card).toContain("Tone of Voice");
    // Traits from both fields are deduped into one line.
    expect(card).toContain("Profesyonel, net, güvenilir");
    expect(card).toContain("Pazarlar");
    expect(card).toContain("Türkiye, Almanya");
    expect(card).toContain("Marka Renkleri");

    const sparse = render(
      twin({ markets: [], voice: { personality: null, toneOfVoice: null } }),
      { ...fullKit, identity: null, legacyColors: [] },
    );
    const sparseCard = between(sparse, 'data-card="brand-summary"', 'data-card="connected-accounts"');
    for (const label of ["Sektör", "Hedef Kitle", "Tone of Voice", "Pazarlar", "Marka Renkleri"]) {
      expect(sparseCard).not.toContain(label);
    }
  });

  it("falls back to positioning for the sector and shows at most five colours", () => {
    const html = render(
      twin({ businessModel: null, positioning: "Premium klinik" }),
      {
        ...fullKit,
        identity: identity({
          primaryColors: [{ hex: "#111111" }, { hex: "#222222" }],
          secondaryColors: [{ hex: "#333333" }, { hex: "#444444" }],
          accentColors: [{ hex: "#555555" }, { hex: "#666666" }],
        }),
      },
    );
    const card = between(html, 'data-card="brand-summary"', 'data-card="connected-accounts"');
    expect(card).toContain("Premium klinik");
    const colors = between(card, 'data-row="brand-colors"');
    expect(colors.match(/ring-1 ring-black\/10/g)).toHaveLength(5);
  });

  it("puts the brand's logo in the summary card, else its initial", () => {
    const withLogo = between(
      render(twin(), fullKit),
      'data-card="brand-summary"',
      'data-card="connected-accounts"',
    );
    expect(withLogo).toContain("/api/assets/logo-dark");

    const noLogo = between(
      render(twin(), { ...fullKit, logoAssetId: null, darkLogoAssetId: null }),
      'data-card="brand-summary"',
      'data-card="connected-accounts"',
    );
    expect(noLogo).not.toContain("/api/assets/");
    expect(noLogo).toContain(">W<");
  });

  it("says when the brand is still being learned, and when it is an example", () => {
    const html = render(twin({ confidence: "low", isMock: true }), fullKit, null);
    expect(html).toContain("Marka profili yeni başlıyor");
    expect(html).toContain("Örnek marka profili");
    expect(render(twin({ confidence: "high" }), fullKit)).not.toContain("Marka hâlâ öğreniliyor");
  });

  it("shows each account with its state in words, linking to the integrations page", () => {
    const html = render(twin(), fullKit, "webhealth.com.tr", accounts);
    const card = between(html, 'data-card="connected-accounts"', 'data-card="collapsible-Marka kiti"');
    const row = (key: string) =>
      between(card, `data-account="${key}"`, "</li>");
    expect(row("instagram")).toContain("Instagram");
    expect(row("instagram")).toContain("Bağlı");
    expect(row("meta-ads")).toContain("Bağlı değil");
    expect(row("ga4")).toContain("Kurulum gerekli");
    expect(row("website")).toContain("Aktif");
    expect(card).toContain('href="/projects/proj-1/integrations"');
    // The account's own name is the tooltip, never a visible "Bağlı" lookalike.
    expect(card).toContain('title="@webhealth" data-account="instagram"');
  });

  it("calls a missing website 'Eklenmedi' and says so when the accounts could not be read", () => {
    const html = render(twin(), fullKit, null, [
      { key: "website", label: "Website", state: "off" },
    ]);
    expect(html).toContain("Eklenmedi");
    expect(html).not.toContain("Bağlı değil");
    expect(render(twin(), fullKit, null, [])).toContain("Hesap durumu şu an okunamadı.");
  });
});

describe("BrandSummaryPanel (visual brand kit)", () => {
  it("shows each logo variant on the surface it is made for", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain('data-kit="logo-on-light"');
    expect(html).toContain('data-kit="logo-on-dark"');
    const onLight = html.slice(html.indexOf('data-kit="logo-on-light"'), html.indexOf('data-kit="logo-on-dark"'));
    expect(onLight).toContain("/api/assets/logo-dark");
    expect(onLight).toMatch(/background-color:\s*#ffffff/i);
    const onDark = html.slice(html.indexOf('data-kit="logo-on-dark"'));
    expect(onDark).toContain("/api/assets/logo-light");
    // The dark tile uses the brand's own (dark) primary colour.
    expect(onDark).toMatch(/background-color:\s*#0b1f3a/i);
  });

  it("invites the missing logo variant when only one exists", () => {
    const html = render(twin(), { ...fullKit, logoAssetId: null });
    expect(html).toContain('data-kit="logo-on-dark-missing"');
    expect(html).toContain("Add a light-colored logo");
    expect(html).toContain('data-kit="logo-on-light"');
  });

  it("lays out the palette by role with copyable hex swatches and contrast-aware labels", () => {
    const html = render(twin(), fullKit);
    for (const label of ["Primary", "Secondary", "Accent"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("#0B1F3A");
    expect(html).toContain("Navy");
    expect(html).toContain("#2DD4BF");
    // White label on navy, dark label on the bright teal accent.
    expect(html).toMatch(/background-color:\s*#0b1f3a;\s*color:\s*#ffffff/i);
    expect(html).toMatch(/background-color:\s*#2dd4bf;\s*color:\s*#0b0b0b/i);
    expect(html).toContain("Click to copy");
  });

  it("shows fonts, style, mood and the post layout", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain("Playfair Display");
    expect(html).toContain("Inter");
    expect(html).toContain("Photographic");
    expect(html).toContain("Dark backgrounds");
    expect(html).toContain("trustworthy");
    expect(html).toContain("natural light");
    expect(html).toContain("stock smiles");
    expect(html).toContain("POST LAYOUTS");
    expect(html).toContain('data-kit="layout-preview"');
    // No layouts saved yet: the brand's own template shown as the default
    // "Classic", with the suggested set beside it.
    expect(html).toContain("Classic");
    expect(html).toContain("no headline · logo bottom-right corner · thin bar bottom");
    expect(html).toContain("Set up layouts");
    expect(html).toContain("Suggested layouts, not saved yet");
    expect(html.match(/data-kit="layout-thumb"/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it("shows the saved default layout and says posts follow it", () => {
    const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
    const html = render(twin(), {
      ...fullKit,
      identity: identity({ layoutTemplates: { ...layouts, defaultId: "bottom-band" } }),
    });
    expect(html).toContain("Brand band");
    expect(html).toContain("headline bottom, left · logo bottom-left corner · brand band bottom");
    expect(html).toContain("Edit layouts");
    expect(html).toContain("New posts follow these layouts");
    expect(html).not.toContain("Suggested layouts, not saved yet");
  });

  it("keeps the kit and the strategy text in cards that are closed by default, with a scan button", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain("Marka kiti");
    expect(html).toContain("Marka stratejisi");
    expect(html).toContain("Measurable patient acquisition");
    expect(html).toContain("No stock smiles");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("Scan site");
  });

  it("presents legacy colours as one unlabelled row", () => {
    const html = render(twin(), {
      legacyColors: [{ hex: "#123456" }, { hex: "#abcdef" }],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(html).toContain('data-kit="palette-colors"');
    expect(html).not.toContain('data-kit="palette-primary"');
    expect(html).toContain("#123456");
    // The summary card shows the colours it has too.
    expect(between(html, 'data-row="brand-colors"')).toContain("#123456");
    // Default post template applies when no identity row exists.
    expect(html).toContain("no headline · logo bottom-right corner · thin bar bottom");
  });

  it("invites a scan when there is nothing visual yet", () => {
    const html = render(twin(), {
      legacyColors: [],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(html).toContain('data-kit="empty"');
    expect(html).toContain("Build your brand kit");
    expect(html).toContain("Scan my website");
    expect(html).not.toContain("COLORS");
    // With nothing to show, the kit card opens by itself so the invitation is
    // seen, and it is the only scan button on the page.
    expect(html).toMatch(/<details[^>]*\sopen=""[^>]*data-card="collapsible-Marka kiti"/);
    expect(html).not.toMatch(/<details[^>]*\sopen=""[^>]*data-card="collapsible-Marka stratejisi"/);
    expect(html.match(/Scan site/g)).toBeNull();
    // The strategy text is still reachable.
    expect(html).toContain("Marka stratejisi");
  });

  it("derives a kit from the twin when none is passed, and handles a missing brand", () => {
    const html = render(
      twin({ visualDNA: { description: null, colors: [{ hex: "#e11d48" }], fonts: [], logoAssetId: "logo-x" } }),
      null,
    );
    expect(html).toContain("#E11D48");
    expect(html).toContain("/api/assets/logo-x");
    expect(render(null, null)).toContain("Brand not set up yet.");
  });
});
