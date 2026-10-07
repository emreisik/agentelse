import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UtmCoverageResult } from "@/lib/website-analytics/health/utm-coverage";

// Bu dosyanın kanıtladığı (MH25 kartı): GA_UTM kapalıyken yükleyici hiç
// çağrılmadan null; WARN "Code MH25" rozetini, başlığı ve rehberi çizer; PASS
// tek soluk satırdır; UNKNOWN ve null hiçbir şey çizmez; "I fixed it" yok.

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/server/website-analytics/health/utm-coverage", () => ({
  loadUtmCoverageCheck: mocks.load,
}));

const { UtmCoverageCheck } = await import("./utm-coverage-check");

const PROJECT_ID = "project-1";
const saved = {
  utm: process.env.GA_UTM,
  sync: process.env.GA_SYNC,
  dev: process.env.GA_SYNC_DEV_PROJECTS,
};

function restore(key: keyof typeof saved, name: string) {
  if (saved[key] === undefined) delete process.env[name];
  else process.env[name] = saved[key];
}

function result(
  status: UtmCoverageResult["status"],
  reason: UtmCoverageResult["evidence"]["reason"],
): UtmCoverageResult {
  return {
    key: "MH25",
    status,
    severity: "INFO",
    evidence: { reason, ads: 10, tagged: 6, coveragePct: 60, unseen: 0 },
  };
}

async function render(): Promise<string | null> {
  const element = await UtmCoverageCheck({ projectId: PROJECT_ID });
  return element ? renderToStaticMarkup(element) : null;
}

describe("UtmCoverageCheck", () => {
  beforeEach(() => {
    mocks.load.mockReset();
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
  });
  afterEach(() => {
    restore("utm", "GA_UTM");
    restore("sync", "GA_SYNC");
    restore("dev", "GA_SYNC_DEV_PROJECTS");
  });

  it("GA_UTM kapalıyken yükleyiciyi çağırmadan null döner", async () => {
    delete process.env.GA_UTM;
    expect(await render()).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("GA_SYNC kapalıyken de null döner", async () => {
    delete process.env.GA_SYNC;
    expect(await render()).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("WARN sonucu Code MH25, başlık, metin ve rehberi çizer", async () => {
    mocks.load.mockResolvedValue(result("WARN", "low_coverage"));
    const html = await render();
    expect(html).toContain("Code MH25");
    expect(html).toContain("Some ads Agentelse created have no tracking tags");
    expect(html).toContain("6 of 10 ads");
    expect(html).toContain("How to fix");
    expect(html).toContain("Review &amp; launch");
    expect(html).not.toContain("I fixed it");
    expect(html).not.toContain("Mute");
  });

  it("PASS sonucu tek soluk satır çizer", async () => {
    mocks.load.mockResolvedValue(result("PASS", "ok"));
    const html = await render();
    expect(html).toContain("MH25");
    expect(html).toContain("Agentelse links carry tracking");
    expect(html).not.toContain("How to fix");
  });

  it("UNKNOWN ve null hiçbir şey çizmez", async () => {
    mocks.load.mockResolvedValue(result("UNKNOWN", "no_ads"));
    expect(await render()).toBeNull();
    mocks.load.mockResolvedValue(null);
    expect(await render()).toBeNull();
  });
});

describe("UtmCoverageCheck geliştirme koruması", () => {
  it("ortak veritabanında listede olmayan proje için null döner", async () => {
    mocks.load.mockReset();
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    // gaSyncAllowedFor koruması yoksa bu test anlamsız kalır; yalnız
    // listedeki proje çalışsın diye liste yanlış projeyle doldurulur.
    process.env.GA_SYNC_DEV_PROJECTS = "baska-proje";
    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    const savedUrl = env.DATABASE_URL;
    env.NODE_ENV = "development";
    env.DATABASE_URL = "postgresql://user@db.neon.tech/prod";
    try {
      expect(await render()).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
    } finally {
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
      if (savedUrl === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = savedUrl;
      restore("utm", "GA_UTM");
      restore("sync", "GA_SYNC");
      restore("dev", "GA_SYNC_DEV_PROJECTS");
    }
  });
});
