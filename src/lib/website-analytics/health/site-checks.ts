import type { GaTableRow } from "@/lib/website-analytics/slices";

import { share, sumColumn } from "./baseline";
import { EU_EEA_COUNTRIES, checkResult, round3 } from "./known-values";
import type { GaCheckResult, GaCheckStatus, GaSiteTagResult } from "./types";

// GA-F3 site etiketi kontrolleri (docs/measurement-health.md): haftalık site
// taramasının (GaSiteTagResult) üzerinden MH3 etiket, MH23 rıza sinyali ve
// MH4'ün site yarısı (çift yükleme). MH3 asla FAIL vermez: GTM, birleşik
// Google etiketi ve istemci tarafı yükleme sayfada görünmeyebilir. Saf modül.

// MH23: AB/AEA payı bu oturum sayısının altında değerlendirilmez.
const MH23_MIN_SESSIONS = 200;
const MH23_EU_SHARE = 0.2;

export function checkMH3(
  siteTag: GaSiteTagResult | null,
  mh1Status: GaCheckStatus,
): GaCheckResult {
  const evidence = {
    pagesChecked: siteTag?.pagesChecked ?? null,
    pagesWithExpected: siteTag?.pagesWithExpected ?? null,
    otherIds: siteTag?.otherIds ?? [],
    checkedAt: siteTag?.at ?? null,
  };
  if (!siteTag) {
    return checkResult("MH3", "UNKNOWN", {
      reason: "not_checked",
      ...evidence,
    });
  }
  if (siteTag.outcome !== "ok") {
    const reason =
      siteTag.outcome === "no_site"
        ? "no_site"
        : siteTag.outcome === "blocked_by_robots"
          ? "robots"
          : "fetch_failed";
    return checkResult("MH3", "UNKNOWN", { reason, ...evidence });
  }
  if (!siteTag.expectedId) {
    return checkResult("MH3", "UNKNOWN", {
      reason: "no_measurement_id",
      ...evidence,
    });
  }
  if (siteTag.pagesWithExpected > 0) {
    return checkResult("MH3", "PASS", { reason: "ok", ...evidence });
  }
  if (siteTag.otherIds.length > 0) {
    return checkResult(
      "MH3",
      "WARN",
      { reason: "other_id", ...evidence },
      { severity: "WARN" },
    );
  }
  // Etiket GTM ya da birleşik Google etiketi içinden yükleniyor olabilir;
  // sayfada görünmemesi eksik olduğunu kanıtlamaz.
  if (siteTag.gtm) {
    return checkResult("MH3", "UNKNOWN", { reason: "gtm_only", ...evidence });
  }
  if (siteTag.googleTag) {
    return checkResult("MH3", "UNKNOWN", {
      reason: "google_tag_only",
      ...evidence,
    });
  }
  // Veri akıyorsa etiket istemci tarafında (ör. eklenti) ekleniyordur.
  if (mh1Status === "PASS") {
    return checkResult("MH3", "UNKNOWN", {
      reason: "client_side",
      ...evidence,
    });
  }
  return checkResult(
    "MH3",
    "WARN",
    { reason: "missing", ...evidence },
    { severity: "WARN" },
  );
}

// MH4'ün site yarısı: tarama başarılıysa çift yükleme var mı; değerlendirilemezse
// null.
export function siteDoubleLoad(
  siteTag: GaSiteTagResult | null,
): boolean | null {
  if (!siteTag || siteTag.outcome !== "ok") return null;
  return siteTag.doubleLoad;
}

// MH23: AB/AEA ziyaretçisi belirgin bir sitede sayfada rıza varsayılanı
// (Consent Mode `default`) ya da bir CMP işareti görünüyor mu.
export function checkMH23(
  siteTag: GaSiteTagResult | null,
  country: readonly GaTableRow[],
): GaCheckResult {
  const total = sumColumn(country, 0);
  const eu = sumColumn(
    country.filter((row) => EU_EEA_COUNTRIES.has(row.key[0] ?? "")),
    0,
  );
  const euShareRaw = share(eu, total);
  const euShare = euShareRaw === null ? null : round3(euShareRaw);
  const cmp = siteTag?.cmp ?? null;
  if (total < MH23_MIN_SESSIONS || euShareRaw === null) {
    return checkResult("MH23", "UNKNOWN", {
      reason: "low_volume",
      euShare,
      cmp,
    });
  }
  if (euShareRaw <= MH23_EU_SHARE) {
    return checkResult("MH23", "PASS", { reason: "few_eu", euShare, cmp });
  }
  if (!siteTag || siteTag.outcome !== "ok") {
    return checkResult("MH23", "UNKNOWN", {
      reason: "not_checked",
      euShare,
      cmp,
    });
  }
  if (siteTag.consentDefault || siteTag.cmp) {
    return checkResult("MH23", "PASS", { reason: "ok", euShare, cmp });
  }
  // GTM ya da Google etiketi rıza varsayılanını kendi içinde verebilir.
  if (siteTag.gtm || siteTag.googleTag) {
    return checkResult("MH23", "UNKNOWN", { reason: "gtm_only", euShare, cmp });
  }
  return checkResult(
    "MH23",
    "WARN",
    { reason: "no_consent_default", euShare, cmp },
    { severity: "INFO" },
  );
}
