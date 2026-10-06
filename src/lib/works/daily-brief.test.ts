import { describe, expect, it } from "vitest";

import { STAGE_LABEL } from "@/lib/content-plan-view";
import type { NextStep } from "@/lib/journey";
import { parsePlanBrief } from "@/lib/plan-brief";

import { isSameOriginPath } from "./card-action";
import {
  MAX_BRIEF_ROWS,
  buildDailyBrief,
  type BriefAction,
  type BriefFacts,
} from "./daily-brief";

// 2026-10-01 is a Thursday.
const TODAY = "2026-10-01";

function facts(over: Partial<BriefFacts> = {}): BriefFacts {
  return {
    today: TODAY,
    nowLocalTime: "09:30",
    projectId: "p1",
    connections: { instagram: { connected: true } },
    hasAnalytics: false,
    todayItems: [],
    nextSteps: [],
    yesterdayPublished: 0,
    yesterdayFailed: 0,
    shortlistedIdeas: 0,
    channelsWithoutWork: [],
    ...over,
  };
}

const step = (
  action: NextStep["action"],
  label: string,
  title = `${label} title`,
): NextStep => ({ key: label, tone: "next", label, title, action });

const produce = step(
  { kind: "produce_plan", planId: "plan1", count: 3 },
  "Produce 3",
);
const approve = step(
  {
    kind: "approve_plan",
    planIds: ["plan1"],
    creativeIds: ["c1", "c2"],
    count: 2,
  },
  "Approve 2",
);
const publish = step(
  { kind: "publish_manual", creativeIds: ["c1"] },
  "Publish 1",
);

const item = (
  id: string,
  stage: BriefFacts["todayItems"][number]["stage"],
  channel?: BriefFacts["todayItems"][number]["channel"],
) => ({ id, title: `Title ${id}`, stage, channel });

function sentText(action: BriefAction): string {
  if (action.kind !== "send") throw new Error(`not a send: ${action.kind}`);
  return action.text;
}

describe("buildDailyBrief: rows and summary", () => {
  it("shows an honest empty day", () => {
    const brief = buildDailyBrief(facts());
    expect(brief.kind).toBe("daily-brief");
    expect(brief.day).toBe(TODAY);
    expect(brief.rows).toEqual([]);
    expect(brief.more).toBe(0);
    expect(brief.next).toBeUndefined();
    expect(brief.summary).toBe("Nothing is scheduled for today.");
    expect(brief.yesterday).toEqual({ published: 0, failed: 0 });
  });

  it("maps channels to groups and statuses to STAGE_LABEL", () => {
    const brief = buildDailyBrief(
      facts({
        todayItems: [
          item("a", "IN_REVIEW", "instagram"),
          item("b", "PLANNED", "seo"),
          item("c", "PLANNED", "ads"),
          item("d", "PRODUCING"),
        ],
      }),
    );
    const byId = Object.fromEntries(brief.rows.map((r) => [r.id, r]));
    expect(byId["item-a"]?.group).toBe("content");
    expect(byId["item-b"]?.group).toBe("seo");
    expect(byId["item-c"]?.group).toBe("ads");
    expect(byId["item-d"]?.group).toBe("content");
    for (const row of brief.rows) {
      expect(row.statusLabel).toBe(STAGE_LABEL[row.stage!]);
    }
    expect(byId["item-a"]?.statusLabel).toBe("Waiting for your decision");
  });

  it("gives EVERY row a button: Review for IN_REVIEW, Open otherwise", () => {
    const brief = buildDailyBrief(
      facts({
        connections: {},
        shortlistedIdeas: 2,
        channelsWithoutWork: ["linkedin"],
        todayItems: [
          item("a", "IN_REVIEW", "instagram"),
          item("b", "PLANNED", "seo"),
          item("c", "APPROVED", "instagram"),
          item("d", "PUBLISHED", "instagram"),
        ],
      }),
    );
    // Seven rows exist; the cap drops the last one (the channel row).
    expect(brief.rows.length).toBe(6);
    expect(brief.more).toBe(1);
    for (const row of brief.rows) {
      expect(row.actionLabel.length).toBeGreaterThan(0);
      expect(row.action).toBeDefined();
      if (row.action.kind === "link") {
        expect(isSameOriginPath(row.action.href)).toBe(true);
      }
    }
    const byId = Object.fromEntries(brief.rows.map((r) => [r.id, r]));
    expect(byId["item-a"]?.actionLabel).toBe("Review");
    expect(byId["item-b"]?.actionLabel).toBe("Open");
    expect(byId["item-c"]?.actionLabel).toBe("Open");
    expect(byId["item-d"]?.actionLabel).toBe("Open");
    // Production never starts from a row: item rows only open the calendar.
    expect(byId["item-a"]?.action).toEqual({
      kind: "link",
      href: "/projects/p1/takvim?creative=a",
    });
  });

  it("lists PUBLISHED items last and does not count them as things to do", () => {
    const brief = buildDailyBrief(
      facts({
        todayItems: [
          item("p", "PUBLISHED", "instagram"),
          item("a", "PLANNED", "ads"),
          item("b", "PLANNED", "instagram"),
        ],
      }),
    );
    expect(brief.rows.map((r) => r.id)).toEqual(["item-b", "item-a", "item-p"]);
    expect(brief.summary).toBe("2 things for today");
  });

  it("caps rows at 6 and reports +N more", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      item(`i${i}`, "PLANNED", "instagram"),
    );
    const brief = buildDailyBrief(facts({ todayItems: many }));
    expect(MAX_BRIEF_ROWS).toBe(6);
    expect(brief.rows).toHaveLength(6);
    expect(brief.more).toBe(3);
    // The summary counts everything that needs a look, not only the shown rows.
    expect(brief.summary).toBe("9 things for today");
  });

  it("uses the singular summary for one thing", () => {
    const brief = buildDailyBrief(
      facts({ todayItems: [item("a", "PLANNED", "instagram")] }),
    );
    expect(brief.summary).toBe("1 thing for today");
  });

  it("adds the connect, ideas and channel rows only with their facts", () => {
    expect(buildDailyBrief(facts()).rows).toEqual([]);

    const brief = buildDailyBrief(
      facts({
        connections: {},
        shortlistedIdeas: 2,
        channelsWithoutWork: ["instagram"],
      }),
    );
    const byId = Object.fromEntries(brief.rows.map((r) => [r.id, r]));
    expect(byId["connect"]?.title).toBe(
      "Connect a channel to publish automatically",
    );
    expect(byId["ideas"]?.title).toBe("2 ideas worth a look");
    expect(byId["channel-instagram"]?.title).toBe(
      "Instagram is connected. Start a Work for it",
    );
    expect(byId["channel-instagram"]?.action).toEqual({
      kind: "open-channel-work",
      channel: "instagram",
    });
    expect(brief.summary).toBe("3 things for today");

    // Connected: no connect row; zero ideas: no ideas row.
    const quiet = buildDailyBrief(facts({ shortlistedIdeas: 0 }));
    expect(quiet.rows.some((r) => r.group === "connect")).toBe(false);
    expect(quiet.rows.some((r) => r.group === "ideas")).toBe(false);
  });
});

describe("buildDailyBrief: next row (guard brief-pure)", () => {
  it("carries the TOP step with its own label, title and cost note", () => {
    const brief = buildDailyBrief(
      facts({
        nextSteps: [produce, approve],
        nextStepCostNote: "about $0.24",
      }),
    );
    expect(brief.next).toEqual({
      title: produce.title,
      label: "Produce 3",
      costNote: "about $0.24",
      step: produce,
    });
    // It counts as one thing for today.
    expect(brief.summary).toBe("1 thing for today");
  });

  it("has no cost note when none is given, and no next row without a step", () => {
    const brief = buildDailyBrief(facts({ nextSteps: [approve] }));
    expect(brief.next?.costNote).toBeUndefined();
    expect(buildDailyBrief(facts()).next).toBeUndefined();
  });
});

describe("buildDailyBrief: primary (guard brief-primary)", () => {
  it.each([
    ["produce_plan", produce],
    ["approve_plan", approve],
    ["publish_manual", publish],
  ])(
    "is STILL a parsable plan brief send when %s is the top step",
    (_name, top) => {
      const brief = buildDailyBrief(
        facts({ nextSteps: [top], nextStepCostNote: "about $0.24" }),
      );
      expect(brief.primary.action.kind).toBe("send");
      expect(brief.primary.action.kind).not.toBe("next");
      const parsed = parsePlanBrief(sentText(brief.primary.action));
      expect(parsed).not.toBeNull();
      expect(parsed?.start).toBe(TODAY);
      expect(parsed?.channels.map((c) => c.channel)).toEqual([
        "instagram",
        "seo",
      ]);
      expect(parsed?.channels.some((c) => c.channel === "ads")).toBe(false);
      // The step has its own row; the primary label is a planning label.
      expect(brief.next?.step).toBe(top);
      expect(brief.primary.label).toBe("Plan today");
    },
  );

  it("plans only the connected publishing channels (plus seo), never ads", () => {
    const brief = buildDailyBrief(
      facts({
        connections: {
          instagram: { connected: true },
          linkedin: { connected: true },
          tiktok: { connected: false },
          ads: { connected: true },
        },
      }),
    );
    const parsed = parsePlanBrief(sentText(brief.primary.action));
    expect(parsed?.channels.map((c) => c.channel)).toEqual([
      "instagram",
      "linkedin",
      "seo",
    ]);
  });

  it("reads 'Plan today' only when the first slot is today", () => {
    // Thursday 09:30: the 10:00 anchor still fits.
    expect(
      buildDailyBrief(facts({ nowLocalTime: "09:30" })).primary.label,
    ).toBe("Plan today");
    // 17:30: the 18:00 anchor is less than an hour away, nothing fits today.
    const late = buildDailyBrief(facts({ nowLocalTime: "17:30" }));
    expect(late.primary.label).toBe("Plan the week");
    expect(late.primary.action.kind).toBe("send");
    expect(parsePlanBrief(sentText(late.primary.action))?.start).toBe(TODAY);
  });

  it("is the Connect a channel link when nothing is connected", () => {
    const brief = buildDailyBrief(
      facts({
        connections: { ads: { connected: true } },
        nextSteps: [produce],
      }),
    );
    expect(brief.primary).toEqual({
      label: "Connect a channel",
      action: { kind: "link", href: "/projects/p1/integrations" },
    });
  });

  it("starts with a friendly line, then the machine line", () => {
    const text = sentText(buildDailyBrief(facts()).primary.action);
    const [first, second, ...rest] = text.split("\n");
    expect(first).toBe("Plan the week · from Thu 1 Oct");
    expect(second).toMatch(/^\[Plan brief\] /);
    expect(rest).toEqual([]);
  });
});

describe("buildDailyBrief: secondary, yesterday, focus", () => {
  it("offers the performance question only with analytics", () => {
    const without = buildDailyBrief(facts({ hasAnalytics: false }));
    expect(without.secondary).toEqual({
      label: "Connect analytics",
      action: { kind: "link", href: "/projects/p1/integrations" },
    });
    const withAnalytics = buildDailyBrief(facts({ hasAnalytics: true }));
    expect(withAnalytics.secondary).toEqual({
      label: "Check performance",
      action: { kind: "send", text: "How is our performance lately?" },
    });
  });

  it("carries the yesterday counts and the goal as the focus", () => {
    const brief = buildDailyBrief(
      facts({
        yesterdayPublished: 2,
        yesterdayFailed: 1,
        goalTitle: "  Patient enquiries ",
      }),
    );
    expect(brief.yesterday).toEqual({ published: 2, failed: 1 });
    expect(brief.focus).toBe("Patient enquiries");
    expect(buildDailyBrief(facts()).focus).toBeUndefined();
  });
});

describe("buildDailyBrief: site alerts (GA-F3)", () => {
  const ga = {
    id: "site-a1",
    source: "GA4" as const,
    title: "Google Analytics stopped receiving data",
    severity: "CRITICAL" as const,
    href: "/projects/p1/site#measurement-health",
  };

  it("adds site alerts as 'website' link rows after the items and counts them", () => {
    const brief = buildDailyBrief(
      facts({ todayItems: [item("a", "PLANNED", "instagram")], siteAlerts: [ga] }),
    );
    expect(brief.rows.map((row) => row.id)).toEqual(["item-a", "site-a1"]);
    expect(brief.rows[1]).toMatchObject({
      group: "website",
      title: ga.title,
      actionLabel: "Open",
      action: { kind: "link", href: ga.href },
    });
    expect(brief.summary).toBe(
      buildDailyBrief(
        facts({
          todayItems: [item("a", "PLANNED", "instagram"), item("b", "PLANNED")],
        }),
      ).summary,
    );
  });

  it("is unchanged without site alerts", () => {
    const base = facts({ todayItems: [item("a", "PLANNED", "instagram")] });
    expect(buildDailyBrief({ ...base, siteAlerts: [] })).toEqual(
      buildDailyBrief(base),
    );
  });

  it("drops an alert that is already the next step", () => {
    const fix = step(
      { kind: "fix_tracking", checkKey: "MH1", href: ga.href },
      "Fix tracking",
      ga.title,
    );
    const brief = buildDailyBrief(facts({ siteAlerts: [ga], nextSteps: [fix] }));
    expect(brief.rows).toEqual([]);
    expect(brief.next?.step).toBe(fix);
  });
});

describe("buildDailyBrief: search issues (SC-F3)", () => {
  const issue = (id: string) => ({
    id,
    title: `Search issue ${id}`,
    href: `/projects/p/arama?issue=${id}#health`,
  });

  it("puts the first two critical search issues first, counted once", () => {
    const brief = buildDailyBrief(
      facts({
        todayItems: [item("a", "PLANNED", "instagram")],
        searchIssues: [issue("s1"), issue("s2"), issue("s3")],
      }),
    );
    expect(brief.rows.slice(0, 2)).toEqual([
      {
        id: "search-s1",
        group: "seo",
        title: "Search issue s1",
        actionLabel: "Fix",
        action: { kind: "link", href: "/projects/p/arama?issue=s1#health" },
      },
      {
        id: "search-s2",
        group: "seo",
        title: "Search issue s2",
        actionLabel: "Fix",
        action: { kind: "link", href: "/projects/p/arama?issue=s2#health" },
      },
    ]);
    expect(brief.rows).toHaveLength(3);
    expect(brief.summary).toBe("3 things for today");
  });

  it("skips a fix_search_issue step when choosing the next row", () => {
    const search = step(
      { kind: "fix_search_issue", alertId: "s1", count: 1 },
      "Fix",
      "Search issue s1",
    );
    const brief = buildDailyBrief(
      facts({ searchIssues: [issue("s1")], nextSteps: [search, produce] }),
    );
    expect(brief.next?.step).toBe(produce);
    expect(brief.summary).toBe("2 things for today");
  });

  it("is unchanged without search issues", () => {
    const base = facts({ nextSteps: [produce] });
    expect(buildDailyBrief({ ...base, searchIssues: [] })).toEqual(
      buildDailyBrief(base),
    );
  });
});
