import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GEO_CHECKS, GEO_LLMS_INSTRUCTION } from "@/lib/seo/geo/catalog";
import { GEO_CHECK_IDS, type GeoCheckId, type GeoStatus } from "@/lib/seo/geo/types";
import type { GeoCheckView, GeoPanel } from "@/lib/seo/geo/view-types";

// Bu dosyanın kanıtladığı (SC-F8 "AI search visibility"): bekliyor ve tarama
// gerekli durumları; hazır durumda puan rozeti, kontrol listesi, "Your decision"
// tarayıcı tablosu ve "I decided this"; ACK durumu ("You decided", "Count it
// again"); üye için kabul düğmesi yok; llms.txt metni ve taslağı; "Check again"
// ve 6 saat notu; trafik boşken hiçbir GA sayısı ve kart yok.

vi.mock("@/server/actions/seo-geo-actions", () => ({
  auditGeoNowAction: vi.fn(),
  acknowledgeGeoCheckAction: vi.fn(),
}));
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    children,
  }: {
    action: { getMockName?: () => string };
    children: ReactNode;
  }) =>
    createElement(
      "form",
      { "data-action": action?.getMockName?.() ?? "" },
      children,
    ),
}));

import { GeoPanelView } from "./geo-panel-view";

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ");

function check(id: GeoCheckId, status: GeoStatus, extra: Partial<GeoCheckView> = {}): GeoCheckView {
  const def = GEO_CHECKS[id];
  return {
    id,
    status,
    title: def.title,
    why: def.why,
    how: def.how,
    recommendation: null,
    facts: {},
    canAcknowledge: false,
    ...extra,
  };
}

const CRAWLERS = [
  { token: "PerplexityBot", owner: "Perplexity", purpose: "search" as const, allowed: false },
  { token: "OAI-SearchBot", owner: "OpenAI", purpose: "search" as const, allowed: true },
  { token: "GPTBot", owner: "OpenAI", purpose: "training" as const, allowed: false },
];

function ready(overrides: Partial<GeoPanel> = {}): GeoPanel {
  return {
    enabled: true,
    state: "ready",
    score: 62,
    previousScore: 55,
    checks: GEO_CHECK_IDS.map((id) => check(id, id === "GEO2" ? "WARN" : id === "GEO1" ? "INFO" : "PASS")),
    crawlers: CRAWLERS,
    llms: { state: "missing", draft: "# Acme\n\n> We make widgets.\n" },
    auditedAt: new Date(Date.now() - 7 * 3_600_000).toISOString(),
    canAuditNow: true,
    canAcknowledge: true,
    recommendationSource: "ai",
    traffic: null,
    ...overrides,
  };
}

const render = (panel: GeoPanel) =>
  renderToStaticMarkup(createElement(GeoPanelView, { panel, projectId: "p1" }));

describe("GeoPanelView states", () => {
  it("explains a waiting first check", () => {
    const html = render({ ...ready(), state: "waiting", score: null, checks: [], crawlers: [], auditedAt: null });
    const plain = text(html);
    expect(plain).toContain("AI search visibility");
    expect(plain).toContain("waiting for the site audit");
    expect(plain).not.toContain("Check again");
    expect(html).not.toContain("data-score");
  });

  it("asks for a verified site and audit when there is no crawl", () => {
    const plain = text(render({ ...ready(), state: "needs_crawl", score: null, checks: [], crawlers: [] }));
    expect(plain).toContain("Verify your site and run the site audit");
  });
});

describe("GeoPanelView ready", () => {
  it("shows the score, the delta and every check with its status", () => {
    const html = render(ready());
    const plain = text(html);
    expect(html).toContain('data-score="62"');
    expect(plain).toContain("AI visibility 62/100");
    expect(plain).toContain("Up 7 since the check before");
    expect(plain).toContain("Tips written by AI from these results");
    for (const id of GEO_CHECK_IDS) expect(plain).toContain(GEO_CHECKS[id].title);
    expect(plain).toContain("Needs attention");
    expect(plain).toContain("For your information");
    expect(plain).toContain("Good");
  });

  it("shows the AI tip or the fixed how text for checks that need attention", () => {
    const withTip = text(
      render(
        ready({
          checks: [check("GEO2", "WARN", { recommendation: "Let the answer crawlers in." }), check("GEO1", "INFO")],
        }),
      ),
    );
    expect(withTip).toContain("Let the answer crawlers in.");
    expect(withTip).toContain(GEO_CHECKS.GEO1.how);
    expect(withTip).not.toContain(GEO_CHECKS.GEO2.how);
  });

  it("labels the crawler table Your decision and offers I decided this to managers", () => {
    const html = render(
      ready({
        checks: [check("GEO2", "WARN", { canAcknowledge: true, facts: { blocked: ["PerplexityBot"] } })],
      }),
    );
    const plain = text(html);
    expect(plain).toContain("Your decision");
    expect(plain).toContain("PerplexityBot");
    expect(plain).toContain("Blocked");
    expect(plain).toContain("Agentelse only reports this and never edits your robots.txt");
    expect(plain).toContain("Allowing or blocking training is your decision; Agentelse only reports it.");
    expect(plain).toContain("I decided this");
    expect(html).toContain('name="checkId" value="GEO2"');
    expect(html).toContain('name="on" value="true"');
    expect(plain).toContain("Blocked: PerplexityBot");
  });

  it("shows the ACK state and a way back", () => {
    const html = render(
      ready({
        checks: [check("GEO2", "ACK", { canAcknowledge: true })],
      }),
    );
    const plain = text(html);
    expect(plain).toContain("You decided");
    expect(plain).toContain("It is not counted in your score");
    expect(plain).toContain("Count it again");
    expect(plain).not.toContain("I decided this");
    expect(html).toContain('name="on" value="false"');
  });

  it("offers the GEO9 decision inside its check row only", () => {
    const html = render(
      ready({
        crawlers: [],
        checks: [check("GEO9", "WARN", { canAcknowledge: true, facts: { snippetBlocked: 2 } })],
      }),
    );
    expect(html).toContain('name="checkId" value="GEO9"');
    expect(text(html)).toContain("2 pages block snippets");
  });

  it("hides every decision button for a member", () => {
    const html = render(
      ready({
        canAcknowledge: false,
        checks: [check("GEO2", "WARN"), check("GEO9", "WARN")],
      }),
    );
    expect(html).not.toContain('name="checkId"');
    expect(text(html)).not.toContain("Count it again");
  });

  it("shows the llms.txt instruction and the draft when the file is missing", () => {
    const plain = text(render(ready()));
    expect(plain).toContain("Your site has no llms.txt file");
    expect(plain).toContain(GEO_LLMS_INSTRUCTION);
    expect(plain).toContain("# Acme");
    expect(plain).toContain("Copy the text");
  });

  it("describes present, invalid and unknown llms.txt states without a draft", () => {
    expect(text(render(ready({ llms: { state: "present", draft: null } })))).toContain("Your site has an llms.txt file");
    expect(text(render(ready({ llms: { state: "invalid", draft: null } })))).toContain("does not look right");
    const unknown = text(render(ready({ llms: { state: "blocked", draft: null } })));
    expect(unknown).toContain("could not check for an llms.txt");
    expect(unknown).not.toContain(GEO_LLMS_INSTRUCTION);
  });

  it("offers Check again, or explains the 6 hour gap", () => {
    const again = render(ready());
    expect(text(again)).toContain("Check again");
    expect(again).toContain('name="projectId" value="p1"');
    const waiting = text(render(ready({ canAuditNow: false })));
    expect(waiting).not.toContain("Check again");
    expect(waiting).toContain("6 hours after the last one");
  });
});

describe("GeoPanelView traffic", () => {
  it("shows no Analytics numbers and no card without traffic", () => {
    const html = render(ready({ traffic: null }));
    expect(html).not.toContain('data-card="ai-traffic"');
    expect(text(html)).not.toContain("Visits from AI assistants");
    expect(text(html)).not.toContain("Google Analytics");
  });

  it("shows the live numbers when traffic is present", () => {
    const plain = text(
      render(
        ready({
          traffic: {
            from: "2026-09-08",
            to: "2026-10-05",
            sessions: 1234,
            previousSessions: 1000,
            keyEvents: 56,
            sharePct: 4.1,
            assistants: [{ name: "ChatGPT", sessions: 900, previousSessions: 700 }],
            domainMatch: "match",
          },
        }),
      ),
    );
    expect(plain).toContain("Visits from AI assistants");
    expect(plain).toContain("1,234");
    expect(plain).toContain("Up 23% from the 28 days before");
    expect(plain).toContain("4.1% of all sessions");
    expect(plain).toContain("ChatGPT 900");
    expect(plain).toContain("Shown live and never saved");
  });

  it("says so when there are no AI visits yet", () => {
    const plain = text(
      render(
        ready({
          traffic: {
            from: "2026-09-08",
            to: "2026-10-05",
            sessions: 0,
            previousSessions: 0,
            keyEvents: 0,
            sharePct: null,
            assistants: [],
            domainMatch: "unknown",
          },
        }),
      ),
    );
    expect(plain).toContain("No visits from AI assistants in this period yet");
  });
});
