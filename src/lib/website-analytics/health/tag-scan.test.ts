import { describe, expect, it } from "vitest";

import {
  combinePageScans,
  mockSiteTagResult,
  scanPageTags,
  type GaPageTagScan,
} from "./tag-scan";

// Bu dosyanın kanıtladığı: standart gtag parçacığı yükleme + config olarak
// sayılır; çift yükleme görülür; yalnız config, yalnız GTM ve yalnız GT-
// (birleşik Google etiketi) ayrı ayrı tanınır; izin varsayılanı gtag ve
// dataLayer biçiminde, CMP işareti ve anahtar olay ipuçları bulunur;
// birleşim diğer kimlikleri 5'le sınırlar ve hiç sayfa yoksa fetch_failed;
// mock sonuç ağsızdır.

const GTAG = (id: string) =>
  `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
  `<script>window.dataLayer = window.dataLayer || [];` +
  `function gtag(){dataLayer.push(arguments);}gtag('js', new Date());` +
  `gtag('config', '${id}');</script>`;

const GTM = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];var f=d.getElementsByTagName(s)[0],
j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;
f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABC123');</script>`;

describe("scanPageTags", () => {
  it("reads the standard gtag snippet", () => {
    const scan = scanPageTags(
      `<html><head>${GTAG("G-ab12CD34")}</head></html>`,
    );
    expect(scan.measurementIds).toEqual(["G-AB12CD34"]);
    expect(scan.loads).toEqual({ "G-AB12CD34": 1 });
    expect(scan.configs).toEqual({ "G-AB12CD34": 1 });
    expect(scan.gtagJs).toBe(true);
    expect(scan.gtmContainers).toEqual([]);
    expect(scan.googleTagIds).toEqual([]);
    expect(scan.consentDefault).toBe(false);
    expect(scan.cmp).toBeNull();
  });

  it("counts a doubled snippet and another property's id", () => {
    const scan = scanPageTags(
      GTAG("G-AAAA1111") + GTAG("G-AAAA1111") + GTAG("G-BBBB2222"),
    );
    expect(scan.loads["G-AAAA1111"]).toBe(2);
    expect(scan.configs["G-AAAA1111"]).toBe(2);
    expect(scan.measurementIds).toEqual(["G-AAAA1111", "G-BBBB2222"]);
  });

  it("finds a config call without a gtag/js load", () => {
    const scan = scanPageTags(
      `<script>gtag("config","G-CONF1234",{send_page_view:false})</script>`,
    );
    expect(scan.measurementIds).toEqual(["G-CONF1234"]);
    expect(scan.loads).toEqual({});
    expect(scan.gtagJs).toBe(false);
  });

  it("finds a GTM container only", () => {
    const scan = scanPageTags(GTM);
    expect(scan.gtmContainers).toEqual(["GTM-ABC123"]);
    expect(scan.measurementIds).toEqual([]);
    expect(scan.gtagJs).toBe(false);

    const bySrc = scanPageTags(
      `<script src="https://www.googletagmanager.com/gtm.js?id=gtm-zz9988"></script>`,
    );
    expect(bySrc.gtmContainers).toEqual(["GTM-ZZ9988"]);
  });

  it("treats a GT- only page as a combined Google tag without measurement ids", () => {
    const scan = scanPageTags(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=GT-KQWERTY1"></script>` +
        `<script>gtag('config','GT-KQWERTY1');</script>`,
    );
    expect(scan.googleTagIds).toEqual(["GT-KQWERTY1"]);
    expect(scan.measurementIds).toEqual([]);
    expect(scan.gtagJs).toBe(true);
  });

  it("detects consent default via gtag and via dataLayer", () => {
    expect(
      scanPageTags(
        `<script>gtag('consent', 'default', {ad_storage:'denied'});</script>`,
      ).consentDefault,
    ).toBe(true);
    expect(
      scanPageTags(
        `<script>dataLayer.push(["consent","default",{analytics_storage:"denied"}])</script>`,
      ).consentDefault,
    ).toBe(true);
    expect(
      scanPageTags(`<script>gtag('consent','update',{})</script>`)
        .consentDefault,
    ).toBe(false);
  });

  it("names the first CMP marker", () => {
    const scan = scanPageTags(
      `<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="x"></script>` +
        `<script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>`,
    );
    expect(scan.cmp).toBe("Cookiebot");
    expect(
      scanPageTags(`<script src="https://cdn.cookielaw.org/x.js"></script>`)
        .cmp,
    ).toBe("OneTrust");
  });

  it("collects key-event hints from links and forms", () => {
    const scan = scanPageTags(
      `<a href="TEL:+905551112233">call</a><a href="https://wa.me/905551112233">wa</a>` +
        `<a href="mailto:hi@example.com">mail</a><a href="https://maps.app.goo.gl/abc">map</a>` +
        `<a href="/sepet?x=1">cart</a><form></form>`,
    );
    expect(scan.hints).toEqual({
      tel: true,
      whatsapp: true,
      mailto: true,
      form: true,
      maps: true,
      checkout: true,
    });
    expect(scanPageTags(`<a href="/cartoons">x</a>`).hints.checkout).toBe(
      false,
    );
  });

  it("returns empty findings for a page without tags", () => {
    expect(scanPageTags("<html><body>hello</body></html>")).toEqual({
      measurementIds: [],
      loads: {},
      configs: {},
      gtmContainers: [],
      googleTagIds: [],
      gtagJs: false,
      consentDefault: false,
      cmp: null,
      hints: {
        tel: false,
        whatsapp: false,
        mailto: false,
        form: false,
        maps: false,
        checkout: false,
      },
    });
  });
});

describe("combinePageScans", () => {
  const AT = "2026-10-06T10:00:00.000Z";

  it("ORs the pages and caps other ids at five", () => {
    const ids = [
      "G-OTHER001",
      "G-OTHER002",
      "G-OTHER003",
      "G-OTHER004",
      "G-OTHER005",
      "G-OTHER006",
    ];
    const home = scanPageTags(GTAG("G-EXPECT01") + `<form></form>`);
    const landing = scanPageTags(ids.map(GTAG).join("") + GTM);
    const result = combinePageScans({
      at: AT,
      host: "example.com",
      expectedId: "g-expect01",
      pages: [home, null, landing],
    });
    expect(result).toMatchObject({
      v: 1,
      at: AT,
      host: "example.com",
      outcome: "ok",
      pagesChecked: 2,
      pagesFailed: 1,
      pagesWithExpected: 1,
      expectedId: "G-EXPECT01",
      otherIds: ids.slice(0, 5),
      gtm: true,
      googleTag: false,
      gtagJs: true,
      doubleLoad: false,
      consentDefault: false,
      cmp: null,
    });
    expect(result.hints.form).toBe(true);
  });

  it("flags a double load of the expected id, or of any id without one", () => {
    const doubled = scanPageTags(GTAG("G-AAAA1111") + GTAG("G-AAAA1111"));
    const single = scanPageTags(GTAG("G-BBBB2222"));
    const combine = (expectedId: string | null, pages: GaPageTagScan[]) =>
      combinePageScans({ at: AT, host: "example.com", expectedId, pages })
        .doubleLoad;
    expect(combine("G-AAAA1111", [doubled])).toBe(true);
    expect(combine("G-BBBB2222", [doubled, single])).toBe(false);
    expect(combine(null, [single, doubled])).toBe(true);
    expect(combine(null, [single])).toBe(false);
  });

  it("is fetch_failed when no page could be read", () => {
    const result = combinePageScans({
      at: AT,
      host: "example.com",
      expectedId: "G-EXPECT01",
      pages: [null, null],
    });
    expect(result.outcome).toBe("fetch_failed");
    expect(result.pagesChecked).toBe(0);
    expect(result.pagesFailed).toBe(2);
    expect(result.pagesWithExpected).toBe(0);
  });
});

describe("mockSiteTagResult", () => {
  it("reports one healthy page with a form", () => {
    expect(
      mockSiteTagResult({
        at: "2026-10-06T10:00:00.000Z",
        host: "example.com",
        expectedId: "G-MOCK1234",
      }),
    ).toEqual({
      v: 1,
      at: "2026-10-06T10:00:00.000Z",
      host: "example.com",
      outcome: "ok",
      pagesChecked: 1,
      pagesFailed: 0,
      pagesWithExpected: 1,
      expectedId: "G-MOCK1234",
      otherIds: [],
      gtm: false,
      googleTag: false,
      gtagJs: true,
      doubleLoad: false,
      consentDefault: true,
      cmp: null,
      hints: {
        tel: false,
        whatsapp: false,
        mailto: false,
        form: true,
        maps: false,
        checkout: false,
      },
    });
  });

  it("is no_site without a host and counts no expected page without an id", () => {
    expect(
      mockSiteTagResult({ at: "x", host: null, expectedId: "G-MOCK1234" })
        .outcome,
    ).toBe("no_site");
    expect(
      mockSiteTagResult({ at: "x", host: "example.com", expectedId: null })
        .pagesWithExpected,
    ).toBe(0);
  });
});

describe("scanPageTags pathological input", () => {
  it("scans a long run of repeated tag prefixes quickly", () => {
    const run = "gtm.js?gtag/js?googletagmanager.com/gtag/js?".repeat(8_000);
    const html = `<script>${run}</script><script>${run}</script>`;
    const started = performance.now();
    const scan = scanPageTags(html);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(scan.gtmContainers).toEqual([]);
    expect(scan.measurementIds).toEqual([]);
  });

  it("still reads an id after several query parameters", () => {
    const scan = scanPageTags(
      '<script src="https://www.googletagmanager.com/gtag/js?l=dataLayer&cx=c&id=G-ABCD1234"></script>',
    );
    expect(scan.measurementIds).toEqual(["G-ABCD1234"]);
  });
});
