import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConnectedAccount } from "@/lib/connected-accounts";

import { BrandSummaryPanel } from "./brand-summary-panel";

function render(
  connections: ConnectedAccount[] = [],
  searchOverview?: boolean,
) {
  return renderToStaticMarkup(
    createElement(BrandSummaryPanel, {
      projectId: "proj-1",
      connections,
      ...(searchOverview === undefined ? {} : { searchOverview }),
    }),
  );
}

const accounts: ConnectedAccount[] = [
  {
    key: "instagram",
    label: "Instagram",
    state: "connected",
    detail: "@webhealth",
  },
  { key: "facebook", label: "Facebook", state: "connected" },
  { key: "meta-ads", label: "Meta Ads", state: "off" },
  { key: "ga4", label: "Google Analytics 4", state: "setup" },
  { key: "search-console", label: "Search Console", state: "connected" },
  {
    key: "website",
    label: "Website",
    state: "active",
    detail: "webhealth.com.tr",
  },
];

describe("BrandSummaryPanel", () => {
  it("leads with the accounts card and no longer carries the brand summary, kit or strategy cards", () => {
    const html = render(accounts);
    expect(html).toContain('data-card="connected-accounts"');
    expect(html).toContain("Bağlı hesaplar");
    for (const gone of [
      'data-card="brand-summary"',
      "Marka özeti",
      "Marka kiti",
      "Marka stratejisi",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("shows the Instagram card only while Instagram is connected", () => {
    const connected = render(accounts);
    expect(connected).toContain('data-card="instagram-overview"');
    expect(connected.indexOf('data-card="instagram-overview"')).toBeGreaterThan(
      connected.indexOf('data-card="connected-accounts"'),
    );

    const off = accounts.map((account) =>
      account.key === "instagram"
        ? { ...account, state: "off" as const }
        : account,
    );
    expect(render(off)).not.toContain('data-card="instagram-overview"');
    expect(render()).not.toContain('data-card="instagram-overview"');
  });

  it("shows only the accounts that are really linked, as icons linking to the integrations page", () => {
    const html = render(accounts);
    expect(html).toContain('title="Instagram · @webhealth"');
    expect(html).toContain('data-account="facebook"');
    expect(html).toContain('data-account="search-console"');
    // Not linked, half set up, or not an account at all: left out.
    expect(html).not.toContain('data-account="meta-ads"');
    expect(html).not.toContain('data-account="ga4"');
    expect(html).not.toContain('data-account="website"');
    expect(html.match(/data-account="/g)).toHaveLength(3);
    expect(html).toContain('href="/projects/proj-1/integrations"');
    expect(html).toContain("Yönet");
    expect(html).not.toContain("data-reconnect");
  });

  it("keeps a lapsed Google connection on the card, marked to reconnect", () => {
    const html = render([
      { key: "instagram", label: "Instagram", state: "off" },
      { key: "ga4", label: "GA4", state: "reconnect", detail: "Web Health" },
    ]);
    expect(html).toContain('data-account="ga4"');
    expect(html).toContain('title="GA4 · Web Health · yeniden bağlanmalı"');
    expect(html).toContain("data-reconnect");
    expect(html).not.toContain("Henüz bağlı hesap yok.");
  });

  it("invites a connection when nothing is linked, and says so when the accounts could not be read", () => {
    const html = render([
      { key: "instagram", label: "Instagram", state: "off" },
      { key: "ga4", label: "Google Analytics 4", state: "setup" },
      { key: "website", label: "Website", state: "active", detail: "x.com" },
    ]);
    expect(html).toContain("Henüz bağlı hesap yok.");
    expect(html).toContain("Hesap bağla");
    expect(html).not.toContain("data-account=");
    expect(html).not.toContain("Yönet");
    expect(render([])).toContain("Hesap durumu şu an okunamadı.");
  });

  it("leaves the markup unchanged without searchOverview (GSC_SYNC off)", () => {
    const before = render(accounts);
    expect(render(accounts, false)).toBe(before);
    // Açıkken kart kendi verisini sayfa çizildikten sonra çeker; sunucu
    // çiziminde yer kaplamaz.
    expect(render(accounts, true)).toBe(before);
  });
});
