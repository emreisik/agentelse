// SC-F8: AI arama görünürlüğü (GEO/AEO) denetiminin ortak tipleri. Saf dosya
// (istemciden de içe aktarılabilir). Sonuç SeoGeoAudit.result içinde saklanır
// ve yalnız sitenin kendi verisini taşır (GA ya da Search Console verisi yok).

export const GEO_CHECK_IDS = [
  "GEO1",
  "GEO2",
  "GEO3",
  "GEO4",
  "GEO5",
  "GEO6",
  "GEO7",
  "GEO8",
  "GEO9",
  "GEO10",
  "GEO11",
] as const;
export type GeoCheckId = (typeof GEO_CHECK_IDS)[number];

export const GEO_STATUSES = ["PASS", "WARN", "INFO", "NA", "ACK"] as const;
export type GeoStatus = (typeof GEO_STATUSES)[number];

// Yalnız bunlar "I decided this" ile kabul edilebilir: engelleme bilinçli bir
// karar olabilir (robots.txt'e Agentelse dokunmaz, yalnız bildirir).
export const GEO_ACKNOWLEDGEABLE = ["GEO2", "GEO9"] as const;

export type GeoFacts = Record<
  string,
  number | boolean | string | string[] | null
>;

export type GeoCheckResult = {
  id: GeoCheckId;
  status: GeoStatus;
  facts: GeoFacts;
};

export type GeoCrawlerRow = {
  token: string;
  owner: string;
  purpose: "search" | "training";
  allowed: boolean;
};

export type LlmsFacts = {
  state: "present" | "missing" | "invalid" | "blocked" | "unknown";
  bytes: number;
  hasTitle: boolean;
  links: number;
  sections: number;
};

export type OrgFacts = {
  present: boolean;
  types: string[];
  name: string | null;
  // En çok 20, yalnız https
  sameAs: string[];
  hasLogo: boolean;
};

export type GeoAuditResult = {
  v: 1;
  score: number | null;
  checks: GeoCheckResult[];
  crawlers: GeoCrawlerRow[];
  llms: LlmsFacts;
  org: OrgFacts | null;
  pages: {
    audited: number;
    indexable: number;
    withFaqSchema: number;
    withQuestionHeadings: number;
    longWithoutHeadings: number;
    snippetBlocked: number;
    renderRisk: number;
  };
  auditedAt: string;
};

export function isGeoCheckId(value: unknown): value is GeoCheckId {
  return (
    typeof value === "string" &&
    (GEO_CHECK_IDS as readonly string[]).includes(value)
  );
}

export function isAcknowledgeable(
  id: unknown,
): id is (typeof GEO_ACKNOWLEDGEABLE)[number] {
  return (
    typeof id === "string" &&
    (GEO_ACKNOWLEDGEABLE as readonly string[]).includes(id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LLMS_STATES: readonly LlmsFacts["state"][] = [
  "present",
  "missing",
  "invalid",
  "blocked",
  "unknown",
];

// Saklı JSON'dan sonuç: şekil bozuksa ya da sürüm farklıysa null (satır
// "bekliyor" sayılır). Yalnız yapıyı doğrular; değerlere güvenilir çünkü
// kaydı biz yazarız.
export function parseGeoResult(value: unknown): GeoAuditResult | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { checks, crawlers, llms, pages, auditedAt, score } = value;
  if (!Array.isArray(checks) || !Array.isArray(crawlers)) return null;
  if (!isRecord(llms) || !isRecord(pages) || typeof auditedAt !== "string") {
    return null;
  }
  const parsedChecks: GeoCheckResult[] = [];
  for (const entry of checks) {
    if (!isRecord(entry)) return null;
    if (!isGeoCheckId(entry.id)) return null;
    if (!(GEO_STATUSES as readonly unknown[]).includes(entry.status)) {
      return null;
    }
    parsedChecks.push({
      id: entry.id,
      status: entry.status as GeoStatus,
      facts: isRecord(entry.facts) ? (entry.facts as GeoFacts) : {},
    });
  }
  if (!LLMS_STATES.includes(llms.state as LlmsFacts["state"])) return null;
  const org = value.org;
  return {
    v: 1,
    score: typeof score === "number" ? score : null,
    checks: parsedChecks,
    crawlers: crawlers.filter(
      (row): row is GeoCrawlerRow =>
        isRecord(row) &&
        typeof row.token === "string" &&
        typeof row.allowed === "boolean",
    ),
    llms: llms as unknown as LlmsFacts,
    org: isRecord(org) ? (org as unknown as OrgFacts) : null,
    pages: pages as unknown as GeoAuditResult["pages"],
    auditedAt,
  };
}
