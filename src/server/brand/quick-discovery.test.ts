import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Quick Discovery is the first look at a new brand, made from public and
// therefore untrusted material. What this suite pins down: when a scan is
// allowed to start (once, not in mock mode, only for an active brand that has
// no constitution yet), that it reads the site through the injected safe
// fetcher and skips pages it cannot use, that nothing scraped ever becomes an
// approved claim, and that every failure comes back as a result instead of an
// exception into the chat turn that asked for the scan.

const projectFindUnique = vi.fn();
const auditFindFirst = vi.fn();
const dossierFindUnique = vi.fn();
const dossierCreate = vi.fn();
const dossierUpdate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    auditLog: { findFirst: auditFindFirst },
    brandDossier: {
      findUnique: dossierFindUnique,
      create: dossierCreate,
      update: dossierUpdate,
    },
  },
}));

const auditRecord = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const getActive = vi.fn();
vi.mock("@/server/repositories/brand-constitution.repository", () => ({
  BrandConstitutionRepository: { getActive },
}));

const publishVersion = vi.fn();
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { publishVersion },
}));

const recordPageEvidence = vi.fn();
const findFreshPageEvidence = vi.fn();
vi.mock("@/server/research/web-evidence", () => ({
  recordPageEvidence,
  findFreshPageEvidence,
}));

const isMockMode = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode, run: vi.fn() },
}));

// scan.ts pulls in the image toolchain; only its URL helper is needed here.
vi.mock("@/server/brand/site-scan/scan", () => ({
  normalizeScanUrl: (input: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())
      ? input.trim()
      : `https://${input.trim()}`,
}));

const { QuickDiscoveryService } = await import("./quick-discovery");
const { UnsafeUrlError } = await import("@/server/security/safe-fetch");
const { quickDiscoveryDef } =
  await import("@/server/reasoning/prompts/quick-discovery");

const target = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  brandName: "Acme Boya",
  domain: "acme.com.tr",
  language: "tr",
  country: "TR",
};

const HOME_HTML = `<html><head><title>Acme Boya — Ev boyaları</title></head><body>
<nav><a href="/hakkimizda">Hakkımızda</a><a href="/urunler">Ürünler</a><a href="/iletisim">İletişim</a></nav>
<h1>Acme Boya</h1>
<p>Acme Boya 1985'ten beri Türkiye'de ev ve endüstriyel boyalar üretir.</p>
<p>Su bazlı, düşük kokulu boyalarımız 12 renk seçeneğiyle sunulur.</p>
</body></html>`;
// Long enough to count as a readable page (the scan skips near-empty ones).
const ABOUT_HTML = `<html><head><title>Hakkımızda</title></head><body>
<p>Acme Boya, İzmir'de kurulan bir aile şirketidir. Üretimini kendi tesisinde yapar ve ürünlerini Türkiye genelindeki bayi ağı üzerinden satar.</p></body></html>`;
const PRODUCTS_HTML = `<html><head><title>Ürünler</title></head><body>
<p>İç cephe boyası, dış cephe boyası, ahşap vernikleri ve astar ürünleri ürün gamımızın başlıca kalemleridir. Tüm ürünlerimiz su bazlıdır.</p></body></html>`;
// A page that only paints itself with JavaScript: no readable text at all.
const JS_SHELL_HTML = `<html><head><title>Acme</title><script>window.app=1</script></head><body><div id="root"></div></body></html>`;

function htmlResponse(url: string, html: string) {
  return {
    url,
    status: 200,
    contentType: "text/html",
    body: Buffer.from(html),
    truncated: false,
  };
}

// A fake safeFetch serving the given pages by exact URL; anything else is 404.
function siteFetcher(pages: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const html = pages[url];
    if (html === undefined) throw new Error("The site answered with HTTP 404");
    return htmlResponse(url, html);
  });
}

// A complete constitution as the model would return it.
function constitutionOutput(overrides: Record<string, unknown> = {}) {
  return {
    language: "en",
    country: "US",
    identity: "Acme Boya, İzmir merkezli boya üreticisi",
    businessModel: "Üretici, bayi ağı üzerinden satış",
    products: ["İç cephe boyası", "Dış cephe boyası"],
    markets: ["Türkiye"],
    audiences: ["Ev sahipleri", "Müteahhitler"],
    positioning: "Düşük kokulu su bazlı boya",
    valueProposition: "Sağlıklı iç mekan",
    personality: "Güvenilir",
    toneOfVoice: "Sade ve samimi",
    visualIdentity: "",
    approvedClaims: [],
    forbiddenClaims: [],
    negativeBrief: [],
    customerProblems: [],
    customerObjections: [],
    competitors: [],
    differentiators: [],
    legalRestrictions: [],
    knownFacts: ["1985'ten beri üretim yapıyor [source: https://acme.com.tr]"],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

function reasonReturning(output: Record<string, unknown>, isMock = false) {
  return vi.fn().mockResolvedValue({ output, isMock, reasoningCallId: "rc-1" });
}

const activeProject = {
  workspaceId: "ws-1",
  name: "Acme",
  domain: "acme.com.tr",
  status: "ACTIVE",
  language: "tr",
  country: "TR",
  brands: [{ id: "brand-1", name: "Acme Boya" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  isMockMode.mockReturnValue(false);
  projectFindUnique.mockResolvedValue(activeProject);
  getActive.mockResolvedValue(null);
  auditFindFirst.mockResolvedValue(null);
  auditRecord.mockResolvedValue(undefined);
  publishVersion.mockResolvedValue({ id: "const-1", version: 1 });
  findFreshPageEvidence.mockResolvedValue(null);
  recordPageEvidence.mockImplementation(
    async (_scope: unknown, page: { url: string }) => `ev:${page.url}`,
  );
  dossierFindUnique.mockResolvedValue(null);
  dossierCreate.mockResolvedValue({});
  dossierUpdate.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuickDiscoveryService.claim", () => {
  it("claims an active brand that has no constitution, and records that the scan started", async () => {
    const claimed = await QuickDiscoveryService.claim("proj-1");

    expect(claimed).toEqual(target);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        action: "brand.quick_discovery.started",
      }),
    );
  });

  it("never runs in mock mode, so a made-up constitution cannot reach a real Brand Brain", async () => {
    isMockMode.mockReturnValue(true);

    await expect(QuickDiscoveryService.claim("proj-1")).resolves.toBeNull();
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it.each([
    ["the project does not exist", null],
    ["the project has no default brand", { ...activeProject, brands: [] }],
    ["the project is paused", { ...activeProject, status: "PAUSED" }],
    [
      "the project was never activated",
      { ...activeProject, status: "CREATED" },
    ],
  ])("does not claim when %s", async (_label, project) => {
    projectFindUnique.mockResolvedValue(project);

    await expect(QuickDiscoveryService.claim("proj-1")).resolves.toBeNull();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("does not claim a brand the agency already has a constitution for", async () => {
    getActive.mockResolvedValue({ id: "const-9", version: 3 });

    await expect(QuickDiscoveryService.claim("proj-1")).resolves.toBeNull();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("does not start a second scan while one started in the last few minutes", async () => {
    auditFindFirst.mockResolvedValue({ id: "audit-1" });

    await expect(QuickDiscoveryService.claim("proj-1")).resolves.toBeNull();
    expect(auditRecord).not.toHaveBeenCalled();
    // The cool-down is looked up by project and action, inside a time window.
    expect(auditFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          action: "brand.quick_discovery.started",
          createdAt: { gte: expect.any(Date) },
        }),
      }),
    );
  });

  it("trims the domain, drops a blank one, and falls back to the project name", async () => {
    projectFindUnique.mockResolvedValue({
      ...activeProject,
      name: "Acme Proje",
      domain: "   ",
      brands: [{ id: "brand-1", name: "" }],
    });

    const claimed = await QuickDiscoveryService.claim("proj-1");

    expect(claimed).toMatchObject({ brandName: "Acme Proje" });
    expect(claimed?.domain).toBeUndefined();
  });
});

describe("QuickDiscoveryService.run", () => {
  it("reads the home page and the pages worth reading, and hands the model only url, title and text", async () => {
    const fetch = siteFetcher({
      "https://acme.com.tr": HOME_HTML,
      "https://acme.com.tr/hakkimizda": ABOUT_HTML,
      "https://acme.com.tr/urunler": PRODUCTS_HTML,
    });
    const reason = reasonReturning(constitutionOutput());

    const result = await QuickDiscoveryService.run(target, { fetch, reason });

    expect(result).toEqual({ status: "DONE", version: 1, pages: 3 });
    const [def, input] = reason.mock.calls[0]!;
    expect(def).toBe(quickDiscoveryDef);
    expect(input).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      context: {
        brandName: "Acme Boya",
        domain: "acme.com.tr",
        language: "tr",
        country: "TR",
      },
    });
    const pages = (input.context as { pages: Record<string, unknown>[] }).pages;
    expect(pages.map((page) => page.url)).toEqual([
      "https://acme.com.tr",
      "https://acme.com.tr/hakkimizda",
      "https://acme.com.tr/urunler",
    ]);
    // Evidence ids stay on our side; the model gets the page text only.
    expect(pages.every((page) => !("evidenceId" in page))).toBe(true);
    expect(pages[0]).toMatchObject({ title: "Acme Boya — Ev boyaları" });
    expect(String(pages[0]!.text)).toContain("1985'ten beri");
  });

  it("keeps a record of every page it read and ties the constitution to them", async () => {
    const fetch = siteFetcher({
      "https://acme.com.tr": HOME_HTML,
      "https://acme.com.tr/hakkimizda": ABOUT_HTML,
      "https://acme.com.tr/urunler": PRODUCTS_HTML,
    });

    await QuickDiscoveryService.run(target, {
      fetch,
      reason: reasonReturning(constitutionOutput()),
    });

    expect(recordPageEvidence).toHaveBeenCalledTimes(3);
    expect(publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFindingIds: [],
        evidenceIds: [
          "ev:https://acme.com.tr",
          "ev:https://acme.com.tr/hakkimizda",
          "ev:https://acme.com.tr/urunler",
        ],
        note: "quick discovery",
      }),
    );
  });

  it("never lets anything scraped become an approved claim, whatever the model returns", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
    const reason = reasonReturning(
      constitutionOutput({ approvedClaims: ["Türkiye'nin 1 numaralı boyası"] }),
    );

    await QuickDiscoveryService.run(target, { fetch, reason });

    const { payload } = publishVersion.mock.calls[0]![0] as {
      payload: { approvedClaims: string[]; logoAssetIds: string[] };
    };
    expect(payload.approvedClaims).toEqual([]);
    expect(payload.logoAssetIds).toEqual([]);
  });

  it("writes the project's own language and country codes, not the model's paraphrase", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
    const reason = reasonReturning(
      constitutionOutput({ language: "Turkish", country: "Turkey" }),
    );

    await QuickDiscoveryService.run(target, { fetch, reason });

    const { payload } = publishVersion.mock.calls[0]![0] as {
      payload: { language: string; country: string };
    };
    expect(payload).toMatchObject({ language: "tr", country: "TR" });
  });

  it("passes the model's mock flag on, so a mock run is stored as one", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

    await QuickDiscoveryService.run(target, {
      fetch,
      reason: reasonReturning(constitutionOutput(), true),
    });

    expect(publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ isMock: true }),
    );
  });

  it("records a completed scan in the audit trail", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
    publishVersion.mockResolvedValue({ id: "const-7", version: 1 });

    await QuickDiscoveryService.run(target, {
      fetch,
      reason: reasonReturning(constitutionOutput()),
    });

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "brand.quick_discovery.completed",
        entityId: "const-7",
        metadata: { version: 1, pages: 1 },
      }),
    );
  });

  describe("reading the site", () => {
    it("asks the model to work from web search alone when the project has no website", async () => {
      const fetch = siteFetcher({});
      const reason = reasonReturning(constitutionOutput());

      const result = await QuickDiscoveryService.run(
        { ...target, domain: undefined },
        { fetch, reason },
      );

      expect(result).toEqual({ status: "DONE", version: 1, pages: 0 });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (reason.mock.calls[0]![1].context as { pages: unknown[] }).pages,
      ).toEqual([]);
    });

    it("carries on with web search alone when the site cannot be reached", async () => {
      const fetch = siteFetcher({});
      const reason = reasonReturning(constitutionOutput());

      const result = await QuickDiscoveryService.run(target, { fetch, reason });

      expect(result).toMatchObject({ status: "DONE", pages: 0 });
      expect(recordPageEvidence).not.toHaveBeenCalled();
    });

    it("tries plain http for a bare domain that only answers there", async () => {
      const fetch = siteFetcher({ "http://acme.com.tr": HOME_HTML });

      const result = await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      // https first, then plain http for the home page. (The pages linked from
      // it are then tried on http too; this site serves none of them.)
      expect(fetch.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
        "https://acme.com.tr",
        "http://acme.com.tr",
      ]);
      expect(result).toMatchObject({ status: "DONE", pages: 1 });
    });

    it("does not downgrade a domain the client gave with an explicit https address", async () => {
      const fetch = siteFetcher({ "http://acme.com.tr": HOME_HTML });

      const result = await QuickDiscoveryService.run(
        { ...target, domain: "https://acme.com.tr" },
        { fetch, reason: reasonReturning(constitutionOutput()) },
      );

      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        "https://acme.com.tr",
      ]);
      expect(result).toMatchObject({ status: "DONE", pages: 0 });
    });

    it("skips a page the safe fetcher refuses, and keeps the rest", async () => {
      const fetch = vi.fn(async (url: string) => {
        if (url === "https://acme.com.tr") return htmlResponse(url, HOME_HTML);
        if (url.endsWith("/hakkimizda")) {
          throw new UnsafeUrlError("Blocked address");
        }
        return htmlResponse(url, PRODUCTS_HTML);
      });

      const result = await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(result).toMatchObject({ status: "DONE", pages: 2 });
      expect(recordPageEvidence.mock.calls.map((call) => call[1].url)).toEqual([
        "https://acme.com.tr",
        "https://acme.com.tr/urunler",
      ]);
    });

    it("ignores a page that only paints itself with JavaScript", async () => {
      const fetch = siteFetcher({ "https://acme.com.tr": JS_SHELL_HTML });

      const result = await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(result).toMatchObject({ status: "DONE", pages: 0 });
      expect(recordPageEvidence).not.toHaveBeenCalled();
    });

    it("reuses a page it read recently instead of fetching it again", async () => {
      const fetch = siteFetcher({
        "https://acme.com.tr": HOME_HTML,
        "https://acme.com.tr/urunler": PRODUCTS_HTML,
      });
      findFreshPageEvidence.mockImplementation(
        async (_projectId: string, url: string) =>
          url.endsWith("/hakkimizda")
            ? {
                id: "ev-cached",
                url,
                title: "Hakkımızda",
                text: "Önceden okunmuş hakkımızda sayfası metni.",
              }
            : null,
      );
      const reason = reasonReturning(constitutionOutput());

      await QuickDiscoveryService.run(target, { fetch, reason });

      expect(fetch.mock.calls.map((call) => call[0])).not.toContain(
        "https://acme.com.tr/hakkimizda",
      );
      const pages = (
        reason.mock.calls[0]![1].context as { pages: { text: string }[] }
      ).pages;
      expect(pages.map((page) => page.text)).toContain(
        "Önceden okunmuş hakkımızda sayfası metni.",
      );
      expect(publishVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          evidenceIds: expect.arrayContaining(["ev-cached"]),
        }),
      );
      // Only the two pages it actually fetched were recorded again.
      expect(recordPageEvidence).toHaveBeenCalledTimes(2);
    });
  });

  describe("the dossier", () => {
    it("creates the dossier from the first read when the brand has none", async () => {
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(dossierCreate).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          projectId: "proj-1",
          brandId: "brand-1",
          summary: "Acme Boya, İzmir merkezli boya üreticisi",
          positioning: "Düşük kokulu su bazlı boya",
          toneOfVoice: "Sade ve samimi",
          targetAudiences: ["Ev sahipleri", "Müteahhitler"],
          markets: ["Türkiye"],
          products: ["İç cephe boyası", "Dış cephe boyası"],
          language: "tr",
          country: "TR",
        },
      });
    });

    it("leaves out whatever the model left empty instead of writing blanks", async () => {
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(
          constitutionOutput({ toneOfVoice: "  ", audiences: [], markets: [] }),
        ),
      });

      const { data } = dossierCreate.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).not.toHaveProperty("toneOfVoice");
      expect(data).not.toHaveProperty("targetAudiences");
      expect(data).not.toHaveProperty("markets");
    });

    it("fills only the empty columns of an existing dossier and never overwrites the client's words", async () => {
      dossierFindUnique.mockResolvedValue({
        summary: "Yazan müşteri: benim özetim",
        positioning: null,
        toneOfVoice: "",
        targetAudiences: null,
        markets: ["TR"],
        products: [],
        language: "tr",
        country: "TR",
      });
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(dossierCreate).not.toHaveBeenCalled();
      expect(dossierUpdate).toHaveBeenCalledWith({
        where: { brandId: "brand-1" },
        data: {
          positioning: "Düşük kokulu su bazlı boya",
          toneOfVoice: "Sade ve samimi",
          targetAudiences: ["Ev sahipleri", "Müteahhitler"],
          products: ["İç cephe boyası", "Dış cephe boyası"],
        },
      });
    });

    it("writes nothing when every column is already filled", async () => {
      dossierFindUnique.mockResolvedValue({
        summary: "a",
        positioning: "b",
        toneOfVoice: "c",
        targetAudiences: ["d"],
        markets: ["e"],
        products: ["f"],
        language: "tr",
        country: "TR",
      });
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(dossierCreate).not.toHaveBeenCalled();
      expect(dossierUpdate).not.toHaveBeenCalled();
    });

    it("does not turn a finished scan into a failure when the dossier cannot be written", async () => {
      dossierFindUnique.mockRejectedValue(new Error("db blip"));
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      const result = await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(result).toMatchObject({ status: "DONE", version: 1 });
      expect(publishVersion).toHaveBeenCalled();
    });
  });

  describe("failing", () => {
    it("returns a failure instead of throwing when the model call fails, and audits it", async () => {
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
      const reason = vi
        .fn()
        .mockRejectedValue(new Error("provider quota exhausted"));

      const result = await QuickDiscoveryService.run(target, { fetch, reason });

      expect(result).toEqual({
        status: "FAILED",
        message: "provider quota exhausted",
      });
      expect(publishVersion).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "brand.quick_discovery.failed",
          metadata: { error: "provider quota exhausted" },
        }),
      );
    });

    it("treats an answer that is not a constitution as a failure and stores nothing", async () => {
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
      const reason = reasonReturning({ nonsense: true });

      const result = await QuickDiscoveryService.run(target, { fetch, reason });

      expect(result.status).toBe("FAILED");
      expect(publishVersion).not.toHaveBeenCalled();
    });

    it("returns a failure when storing the constitution fails", async () => {
      publishVersion.mockRejectedValue(new Error("db down"));
      const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

      const result = await QuickDiscoveryService.run(target, {
        fetch,
        reason: reasonReturning(constitutionOutput()),
      });

      expect(result).toEqual({ status: "FAILED", message: "db down" });
    });

    it("still returns a failure when even the audit write fails", async () => {
      auditRecord.mockRejectedValue(new Error("audit down"));
      const reason = vi.fn().mockRejectedValue(new Error("boom"));

      await expect(
        QuickDiscoveryService.run(target, { fetch: siteFetcher({}), reason }),
      ).resolves.toEqual({ status: "FAILED", message: "boom" });
    });
  });
});

describe("QuickDiscoveryService.runWithin", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("returns the result when the scan finishes inside the wait", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });

    const result = await QuickDiscoveryService.runWithin(target, 5_000, {
      fetch,
      reason: reasonReturning(constitutionOutput()),
    });

    expect(result).toEqual({ status: "DONE", version: 1, pages: 1 });
  });

  it("stops waiting after the deadline but lets the scan finish in the background", async () => {
    const fetch = siteFetcher({ "https://acme.com.tr": HOME_HTML });
    const slowReason = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                output: constitutionOutput(),
                isMock: false,
                reasoningCallId: "rc-1",
              }),
            40,
          ),
        ),
    );

    const result = await QuickDiscoveryService.runWithin(target, 5, {
      fetch,
      reason: slowReason as never,
    });

    expect(result).toEqual({ status: "PENDING" });
    expect(publishVersion).not.toHaveBeenCalled();

    // The scan was not cancelled: the brand is known from the next turn.
    await sleep(120);
    expect(publishVersion).toHaveBeenCalledTimes(1);
  });

  it("reports a scan that failed within the wait as failed, not pending", async () => {
    const result = await QuickDiscoveryService.runWithin(target, 5_000, {
      fetch: siteFetcher({}),
      reason: vi.fn().mockRejectedValue(new Error("boom")),
    });

    expect(result).toEqual({ status: "FAILED", message: "boom" });
  });
});
