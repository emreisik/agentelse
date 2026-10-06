import "server-only";

import {
  parseInspectionResult,
  type ParsedInspection,
} from "@/lib/seo/inspection";
import { googleFetchJson } from "@/server/integrations/google/http";

import { mockUrlInspection } from "./inspection-mock";
import { gscMockMode } from "./search-analytics";

// Search Console URL Inspection istemcisi (docs/google-search-console-plan.md
// §3.5, SK6). YALNIZ OKUMA: index:inspect bir URL'nin Google'daki indeks
// durumunu döndürür, hiçbir şeyi değiştirmez. Kota (site başına günde 2.000,
// dakikada 600) çağıranda tutulur: bütçe SeoSite'ta atomik CAS'la
// (src/server/seo/health/inspection.ts). 429 tekrar edilmez (retry false):
// kota hatası işi PT gece yarısına ya da 15 dakika sonrasına erteler.
// Mock modunda fetch hiç çağrılmaz. Token asla loglanmaz.

export const URL_INSPECTION_ENDPOINT =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
  options: { languageCode?: string } = {},
): Promise<ParsedInspection> {
  if (gscMockMode()) {
    return parseInspectionResult(mockUrlInspection(siteUrl, inspectionUrl));
  }
  const raw = await googleFetchJson<unknown>(
    URL_INSPECTION_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inspectionUrl,
        siteUrl,
        languageCode: options.languageCode ?? "en-US",
      }),
    },
    { kind: "read", retry: false },
  );
  return parseInspectionResult(raw);
}
