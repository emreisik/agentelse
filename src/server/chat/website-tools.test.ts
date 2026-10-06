import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Bu dosyanın kanıtladığı: dört araç var, hepsi salt okunur ve external,
// aktif ve beklemedeki projede sunulur; şemalar örnek argümanları kabul edip
// sınır dışını reddeder ve JSON şemasına çevrilir; websiteChatToolsListed
// GA_INSIGHTS'i izler. tools.ts'te: GA_INSIGHTS kapalıyken araçlar gizli,
// açıkken analytics / seo modül sohbetlerinde ve genel sohbette görünür,
// social ve ads'te görünmez.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));

const {
  WEBSITE_CHAT_TOOLS,
  WEBSITE_CHAT_TOOL_NAMES,
  WEBSITE_CHAT_TOOL_NAME_SET,
  websiteChatToolsListed,
  WebsiteQueryArgsSchema,
} = await import("./website-tools");

afterEach(() => {
  vi.unstubAllEnvs();
});

function tool(name: string) {
  const found = WEBSITE_CHAT_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("website chat tools", () => {
  it("are four read-only external tools for active and on-hold projects", () => {
    expect(WEBSITE_CHAT_TOOLS.map((t) => t.name)).toEqual([
      ...WEBSITE_CHAT_TOOL_NAMES,
    ]);
    expect([...WEBSITE_CHAT_TOOL_NAME_SET]).toEqual([
      ...WEBSITE_CHAT_TOOL_NAMES,
    ]);
    for (const candidate of WEBSITE_CHAT_TOOLS) {
      expect(candidate.kind).toBe("read");
      expect(candidate.external).toBe(true);
      expect(candidate.sensitive).toBeUndefined();
      expect([...candidate.phases]).toEqual(["ACTIVE", "ON_HOLD"]);
      expect(() => z.toJSONSchema(candidate.schema)).not.toThrow();
    }
    expect(tool("get_website_overview").label).toBe("Checking your website…");
    expect(tool("query_website_analytics").label).toBe(
      "Looking up website numbers…",
    );
    expect(tool("explain_website_change").label).toBe("Explaining the change…");
    expect(tool("get_measurement_health").label).toBe(
      "Checking website tracking…",
    );
  });

  it("parse sample arguments and reject out-of-range ones", () => {
    expect(
      tool("get_website_overview").schema.safeParse({ period: "7d" }).success,
    ).toBe(true);
    expect(
      tool("get_website_overview").schema.safeParse({ period: "1y" }).success,
    ).toBe(false);
    expect(
      tool("explain_website_change").schema.safeParse({
        metric: "keyEvents",
        period: "last_week",
        compare: "last_year",
      }).success,
    ).toBe(true);
    expect(tool("get_measurement_health").schema.safeParse({}).success).toBe(
      true,
    );

    const query = tool("query_website_analytics").schema;
    expect(
      query.safeParse({
        dimensions: ["sessionSource", "landingPage"],
        metrics: ["sessions", "keyEventRate"],
        period: "custom",
        from: "2026-09-01",
        to: "2026-09-30",
        limit: 20,
        filter: { dimension: "landingPage", contains: "/blog" },
      }).success,
    ).toBe(true);
    expect(query.safeParse({ metrics: [] }).success).toBe(false);
    expect(
      query.safeParse({
        dimensions: ["country", "deviceCategory", "landingPage"],
        metrics: ["sessions"],
      }).success,
    ).toBe(false);
    expect(
      query.safeParse({
        metrics: [
          "sessions",
          "keyEvents",
          "newUsers",
          "eventCount",
          "activeUsers",
        ],
      }).success,
    ).toBe(false);
    expect(query.safeParse({ metrics: ["sessions"], limit: 21 }).success).toBe(
      false,
    );
    expect(
      query.safeParse({ metrics: ["sessions"], from: "1/9/2026" }).success,
    ).toBe(false);
    expect(
      WebsiteQueryArgsSchema.safeParse({
        metrics: ["sessions"],
        filter: { dimension: "pagePath", contains: "x".repeat(81) },
      }).success,
    ).toBe(false);
  });

  it("are listed only while GA_INSIGHTS lists them", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "off");
    expect(websiteChatToolsListed()).toBe(false);
    vi.stubEnv("GA_INSIGHTS", "on");
    expect(websiteChatToolsListed()).toBe(true);
    vi.stubEnv("GA_INSIGHTS", "shadow");
    vi.stubEnv("GA_INSIGHTS_PROJECTS", "");
    expect(websiteChatToolsListed()).toBe(false);
    vi.stubEnv("GA_INSIGHTS_PROJECTS", "proj-1");
    expect(websiteChatToolsListed()).toBe(true);
    vi.stubEnv("GA_SYNC", "false");
    expect(websiteChatToolsListed()).toBe(false);
  });
});

describe("toolsForPhase with website tools", () => {
  const names = async (
    options: Parameters<typeof import("./tools").toolsForPhase>[1],
  ) => {
    const { toolsForPhase } = await import("./tools");
    return toolsForPhase("ACTIVE", options).map((candidate) => candidate.name);
  };

  it("hides them while GA_INSIGHTS is off", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "off");
    for (const moduleKey of [null, "analytics", "seo"] as const) {
      const list = await names({ module: moduleKey });
      for (const name of WEBSITE_CHAT_TOOL_NAMES)
        expect(list).not.toContain(name);
    }
  });

  it("shows them in analytics, seo and general chats only", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "on");
    for (const moduleKey of [null, "analytics", "seo"] as const) {
      const list = await names({ module: moduleKey });
      for (const name of WEBSITE_CHAT_TOOL_NAMES) expect(list).toContain(name);
    }
    for (const moduleKey of ["social", "ads"] as const) {
      const list = await names({ module: moduleKey });
      for (const name of WEBSITE_CHAT_TOOL_NAMES)
        expect(list).not.toContain(name);
    }
  });
});
