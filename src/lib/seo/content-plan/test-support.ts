import type {
  ContentPlanInput,
  PlanCandidate,
  PlanCluster,
  PlanPage,
  PlanPair,
  PlanQuery,
  PlanSlot,
  SeoContentPlanData,
} from "./types";

// SC-F7 saf çekirdeğinin ve B/C/D/E paketlerinin testlerinin paylaştığı
// fikstürler. Hepsi ayrıştırıcılara karşı geçerlidir. Bu dosya üretim kodundan
// içe aktarılmaz.

export const FIXTURE_WEEK = "2026-09-21";
export const FIXTURE_MONTH = "2026-10";

export function queryFixture(
  queryId: string,
  text: string,
  overrides: Partial<PlanQuery> = {},
): PlanQuery {
  return {
    queryId,
    text,
    impressions: 500,
    clicks: 5,
    position: 30,
    intent: null,
    isBrand: false,
    clusterId: null,
    firstSeenWeek: "2025-01-06",
    previousImpressions: null,
    ...overrides,
  };
}

export function pairFixture(
  queryId: string,
  pageId: string,
  position: number | null,
  impressions = 500,
): PlanPair {
  return { queryId, pageId, impressions, clicks: 0, position };
}

export function pageFixture(
  pageId: string | null,
  path: string,
  overrides: Partial<PlanPage> = {},
): PlanPage {
  return {
    pageId,
    url: `https://example.com${path}`,
    path,
    title: null,
    h1: null,
    h2: [],
    clicks: 0,
    impressions: 100,
    inlinks: 10,
    indexable: true,
    noindex: false,
    status: 200,
    isHomepage: path === "/",
    ...overrides,
  };
}

export function clusterFixture(
  id: string,
  name: string,
  queryIds: string[],
  pillarPageId: string | null,
  overrides: Partial<PlanCluster> = {},
): PlanCluster {
  return { id, name, pillarPageId, queryIds, impressions: 0, clicks: 0, ...overrides };
}

// Bir güçlü kümeli ("c-strong"), bir zayıf ana sayfalı ("c-weak") ve bir
// kümesiz sorgulu ("x1") örnek girdi. Ayrıca marka, yerel ve düşük gösterimli
// sorgular (hiçbiri aday olmaz).
export function planInputFixture(
  overrides: Partial<ContentPlanInput> = {},
): ContentPlanInput {
  const queries: PlanQuery[] = [
    queryFixture("q1", "dental implants cost", {
      impressions: 3000,
      position: 4,
      clusterId: "c-strong",
      intent: "transactional",
    }),
    queryFixture("q2", "dental implants price", {
      impressions: 1500,
      position: 6,
      clusterId: "c-strong",
      intent: "transactional",
    }),
    queryFixture("q3", "implants aftercare tips", {
      impressions: 900,
      position: 35,
      clusterId: "c-strong",
    }),
    queryFixture("w1", "teeth whitening at home", {
      impressions: 2500,
      position: 28,
      clusterId: "c-weak",
    }),
    queryFixture("w2", "whitening strips review", {
      impressions: 800,
      position: 0,
      clusterId: "c-weak",
    }),
    queryFixture("w3", "how to whiten teeth fast", {
      impressions: 400,
      position: 31,
      clusterId: "c-weak",
    }),
    queryFixture("x1", "invisalign vs braces", { impressions: 600, position: 0 }),
    queryFixture("b1", "acme dental", {
      impressions: 5000,
      position: 1,
      isBrand: true,
      intent: "navigational",
    }),
    queryFixture("l1", "dentist near me", { impressions: 700, position: 12 }),
    queryFixture("t1", "tiny odd query", { impressions: 20, position: 50 }),
  ];
  const pairs: PlanPair[] = [
    pairFixture("q1", "p-strong", 4, 3000),
    pairFixture("q2", "p-strong", 6, 1500),
    pairFixture("q3", "p-strong", 35, 900),
    pairFixture("w1", "p-weak", 28, 2500),
    pairFixture("w3", "p-weak", 31, 400),
    pairFixture("b1", "p-home", 1, 5000),
  ];
  const pages: PlanPage[] = [
    pageFixture("p-home", "/", { title: "Acme Dental", impressions: 5000, inlinks: 60 }),
    pageFixture("p-strong", "/services/dental-implants", {
      title: "Dental implants guide",
      h1: "Dental implants",
      impressions: 5400,
      inlinks: 25,
    }),
    pageFixture("p-weak", "/blog/our-news", {
      title: "Our news",
      h1: "News",
      impressions: 2900,
      inlinks: 4,
    }),
    pageFixture("p-contact", "/contact", {
      title: "Contact us",
      impressions: 300,
      inlinks: 40,
    }),
  ];
  const clusters: PlanCluster[] = [
    clusterFixture("c-strong", "Dental implants", ["q1", "q2", "q3"], "p-strong", {
      impressions: 5400,
      clicks: 120,
    }),
    clusterFixture("c-weak", "Teeth whitening", ["w1", "w2", "w3"], "p-weak", {
      impressions: 3700,
      clicks: 30,
    }),
  ];
  return {
    week: FIXTURE_WEEK,
    month: FIXTURE_MONTH,
    webImpressions28d: 50_000,
    nonBrandImpressions: 45_000,
    brandTerms: ["acme"],
    queries,
    pairs,
    pages,
    clusters,
    hasCrawl: true,
    crawlComplete: true,
    links: [{ fromPageId: "p-home", toPageId: "p-strong" }],
    findings: [],
    existingTitles: [],
    existingKeywords: [],
    poolIdeas: [],
    rejectedKeys: [],
    deprioritizedKeys: [],
    ...overrides,
  };
}

export function candidateFixture(
  overrides: Partial<PlanCandidate> = {},
): PlanCandidate {
  const kind = overrides.kind ?? "SUPPORT";
  const clusterId = overrides.clusterId === undefined ? "c-strong" : overrides.clusterId;
  const keyword = overrides.keyword ?? "implants aftercare tips";
  return {
    id: `${kind}:${clusterId ?? "q"}:${keyword.split(" ").sort().join(" ")}`,
    kind,
    clusterId,
    clusterName: clusterId ? "Dental implants" : null,
    keyword,
    queries: [],
    queryIds: ["q3"],
    intent: "informational",
    impressions: 900,
    clicks: 0,
    share: 0.02,
    position: 35,
    gap: kind === "PILLAR" ? "NO_PILLAR" : "NO_PAGE",
    rising: false,
    findingId: null,
    findingConfidence: null,
    score: 0.02,
    bestPageId: "p-strong",
    reuseIdeaId: null,
    ...overrides,
  };
}

export function slotFixture(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: "s1",
    status: "PLANNED",
    kind: "SUPPORT",
    clusterId: "c-strong",
    clusterName: "Dental implants",
    keyword: "implants aftercare tips",
    queries: ["aftercare for implants"],
    intent: "informational",
    impressions: 900,
    share: 0.02,
    position: 35,
    gap: "NO_PAGE",
    rising: false,
    findingId: null,
    title: "Implants aftercare tips",
    angle: "Answer this one question fully, then link to the main page on the topic.",
    description: "Everything to know about implants aftercare tips.",
    date: "2026-10-07",
    time: "10:00",
    creativeId: "creative-1",
    postId: "post-1",
    ideaId: "idea-1",
    prevIdeaStatus: null,
    linkFrom: [
      {
        url: "https://example.com/services/dental-implants",
        path: "/services/dental-implants",
        anchor: "implants aftercare tips",
        role: "pillar",
      },
    ],
    linkTo: [
      {
        url: "https://example.com/services/dental-implants",
        path: "/services/dental-implants",
        anchor: "Dental implants guide",
        role: "pillar",
      },
    ],
    linksVerified: true,
    reusedIdea: false,
    ...overrides,
  };
}

export function planDataFixture(
  overrides: Partial<SeoContentPlanData> = {},
): SeoContentPlanData {
  return {
    v: 1,
    slots: [
      slotFixture(),
      slotFixture({
        id: "s2",
        kind: "PILLAR",
        clusterId: "c-weak",
        clusterName: "Teeth whitening",
        keyword: "teeth whitening at home",
        queries: ["how to whiten teeth fast"],
        impressions: 3700,
        share: 0.08,
        position: 28,
        gap: "NO_PILLAR",
        title: "Teeth whitening at home",
        date: "2026-10-12",
        creativeId: "creative-2",
        postId: "post-2",
        ideaId: "idea-2",
        linkFrom: [],
        linkTo: [],
      }),
    ],
    nextSlot: 3,
    rejected: [],
    reason: null,
    notes: [],
    pillars: [
      {
        clusterId: "c-weak",
        name: "Teeth whitening",
        impressions: 3700,
        share: 0.08,
        pillarUrl: "https://example.com/blog/our-news",
        pillarPath: "/blog/our-news",
        weak: true,
        slotIds: ["s2"],
      },
    ],
    totals: { nonBrandImpressions: 45_000 },
    considered: 9,
    filtered: [{ reason: "BRAND_QUERY", count: 1 }],
    checkedAt: "2026-10-02T09:05:00.000Z",
    regeneratedAt: null,
    wordingNote: null,
    ...overrides,
  };
}
