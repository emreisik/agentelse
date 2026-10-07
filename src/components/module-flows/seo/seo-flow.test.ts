import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";
import type { WorkCardHostInput } from "@/components/works/work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Canlı kart SSE kancasını kullanır; sınamada aşama elle verilir.
const live = vi.hoisted(() => ({
  phase: null as null | "reading_page" | "researching" | "writing" | "checking",
  fallback: false,
}));
vi.mock("./use-seo-live", () => ({ useSeoLive: () => live }));
vi.mock("@/server/actions/seo-mode-actions", () => ({
  startSeoCardAction: vi.fn(),
  setSeoModeAction: vi.fn(),
  seoTargetPagesAction: vi.fn(),
  suggestSnippetAction: vi.fn(),
  chooseSnippetAction: vi.fn(),
  researchRefreshAction: vi.fn(),
  markSeoAppliedAction: vi.fn(),
  confirmSeoLiveAction: vi.fn(),
  checkSeoNowAction: vi.fn(),
  undoSeoAppliedAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  proposeApplyAction: vi.fn(),
  proposePublishArticleAction: vi.fn(),
  proposeMakeLiveAction: vi.fn(),
  decideSeoChangeAction: vi.fn(),
  undoSeoChangeAction: vi.fn(),
  saveApplySettingsAction: vi.fn(),
  indexNowEnableAction: vi.fn(),
  indexNowVerifyAction: vi.fn(),
  indexNowDisableAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-flow-actions", () => ({
  goToSeoStepAction: vi.fn(),
  markSeoPublishedAction: vi.fn(),
  researchSeoAction: vi.fn(),
  rewriteSeoArticleAction: vi.fn(),
  scheduleSeoArticleAction: vi.fn(),
  seoBriefDefaultsAction: vi.fn(async () => ({ ok: false, message: "" })),
  writeSeoArticleAction: vi.fn(),
}));

const { SeoFlow } = await import("./seo-flow");
const { WorkCardHostProvider } =
  await import("@/components/works/work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "SEO Manager",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  timezone: "Europe/Istanbul",
  openTab: () => undefined,
  runNextStep: () => undefined,
};

function render(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown> = {},
  host: WorkCardHostInput = HOST,
): string {
  const card: ModuleFlowCardData = {
    kind: "module-flow",
    module: "seo",
    title: "SEO Manager",
    step,
    data,
  };
  return renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      { value: host },
      createElement(SeoFlow, { card, commandId: "cmd1" }),
    ),
  );
}

const primaries = (html: string) =>
  (html.match(/data-emphasis="primary"/g) ?? []).length;
const currentStep = (html: string) =>
  /aria-current="step"[\s\S]*?class="text-xs whitespace-nowrap font-semibold"[^>]*>([^<]+)/.exec(
    html,
  )?.[1];

const BRIEF = {
  topic: "Running shoes for beginners",
  siteUrl: "https://www.example.com",
  language: "en",
  audience: "",
};

const PLAN = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare pairs before buying.",
  titleOptions: [
    "How to choose running shoes for your first race",
    "Running shoes: a beginner's guide",
  ],
  titleIndex: 1,
  metaDescription:
    "Pick running shoes that fit: what cushioning, drop and size mean, how to test a pair in the shop, and the mistakes beginners make most often.",
  outline: [
    { h2: "What running shoes do", points: ["cushioning", "drop"] },
    { h2: "How to choose", points: [] },
    { h2: "Where to buy", points: [] },
  ],
  quickWins: {
    state: "ok",
    items: [
      {
        query: "trail running shoes",
        impressions: 1250,
        clicks: 3,
        position: 12.4,
      },
    ],
  },
  researchedAt: "2026-10-05T09:00:00.000Z",
};

const ARTICLE = {
  title: "How to choose running shoes for your first race",
  metaDescription: PLAN.metaDescription,
  markdown:
    "The right running shoes make every run easier.\n\n## How to choose running shoes\n\nLook at **fit** first.\n\n- Cushioning\n- Drop",
  writtenAt: "2026-10-05T09:30:00.000Z",
  rewrites: 0,
};

const DELIVERY = {
  postId: "post-1",
  creativeId: "cr-1",
  scheduledFor: "2026-10-09T07:00:00.000Z",
  timezone: "Europe/Istanbul",
};

const runNow = (kind: string) => ({
  id: "r1",
  kind,
  startedAt: new Date().toISOString(),
});

describe("SeoFlow: Brief", () => {
  it("asks for the topic, site, language and audience, with one primary", () => {
    const html = render("brief");
    expect(currentStep(html)).toBe("Brief");
    expect(html).toContain("SEO Manager");
    expect(html).toContain("Find keywords and write articles that rank.");
    expect(html).toContain('placeholder="What should the article be about?"');
    expect(html).toContain('placeholder="example.com"');
    expect(html).toContain(">Turkish</option>");
    expect(html).toContain("Audience or goal (optional)");
    expect(html).toContain("Find keywords");
    expect(primaries(html)).toBe(1);
    // Blocked until there is a topic, and it says why.
    expect(html).toContain("Add a topic of at least 3 characters.");
  });

  it("offers to keep the plan when the person came back to the brief", () => {
    const html = render("brief", { brief: BRIEF, plan: PLAN });
    expect(html).toContain('value="Running shoes for beginners"');
    expect(html).toContain("Research again");
    expect(html).toContain("Keep current plan");
    expect(html).not.toContain("Add a topic of at least 3 characters.");
  });
});

describe("SeoFlow: Plan", () => {
  it("shows the researched plan, editable, with Write article as the primary", () => {
    const html = render("plan", { brief: BRIEF, plan: PLAN });
    expect(currentStep(html)).toBe("Plan");
    expect(html).toContain("running shoes");
    expect(html).toContain("Commercial");
    expect(html).toContain("They compare pairs before buying.");
    expect(html).toContain('aria-label="Remove “best running shoes”"');
    expect(html).toContain("Add “trail running shoes”: 1250 impressions");
    expect(html).toContain("1.3k · #12");
    // The chosen title is the checked radio.
    expect(html).toMatch(/checked=""[^>]*>[\s\S]*?Running shoes: a beginner/);
    expect(html).toContain("141 / 120–160");
    expect(html).toContain('value="What running shoes do"');
    expect(html).toContain("cushioning · drop");
    expect(html).toContain('aria-label="Move section 2 up"');
    expect(html).toContain("Add a section");
    expect(html).toContain("Write article");
    expect(html).toContain(">Back<");
    expect(primaries(html)).toBe(1);
  });

  it("shows the expected monthly gain of curve quick wins (SC-F4)", () => {
    const html = render("plan", {
      brief: BRIEF,
      plan: {
        ...PLAN,
        quickWins: {
          state: "ok",
          items: [{ ...PLAN.quickWins.items[0], position: 6.2, gain: 12 }],
        },
      },
    });
    expect(html).toContain(
      "Queries you rank 4–20 for, sorted by the extra clicks a better position could bring.",
    );
    expect(html).not.toContain("Queries you already rank 8–20 for.");
    expect(html).toContain("+12/mo");
    expect(html).toContain(
      "average position 6.2, about 12 more clicks a month",
    );

    // Kazançsız liste bugünkü gibi kalır.
    const plain = render("plan", { brief: BRIEF, plan: PLAN });
    expect(plain).toContain("Queries you already rank 8–20 for.");
    expect(plain).not.toContain("/mo");
    expect(plain).not.toContain("more clicks a month");
  });

  it("links to Search Console when it is not connected", () => {
    const html = render("plan", {
      brief: BRIEF,
      plan: { ...PLAN, quickWins: { state: "not-connected" } },
    });
    expect(html).toContain(
      'href="/projects/p1/integrations?integration=google_search_console&amp;from=w1"',
    );
  });

  it("says it is researching while the call runs, and offers a retry if it stopped", () => {
    const running = render("plan", { brief: BRIEF, run: runNow("research") });
    expect(running).toContain("Researching keywords and what ranks today.");
    expect(running).toContain("Researching");
    expect(running).not.toContain("Write article");

    const stopped = render("plan", { brief: BRIEF });
    expect(stopped).toContain("The research stopped before it finished.");
    expect(stopped).toContain("Try again");
    expect(primaries(stopped)).toBe(1);
  });
});

describe("SeoFlow: Create", () => {
  it("waits calmly while the article is written, retries if it stopped", () => {
    const writing = render("create", {
      brief: BRIEF,
      plan: PLAN,
      run: runNow("write"),
    });
    expect(currentStep(writing)).toBe("Create");
    expect(writing).toContain("Writing your article.");
    expect(writing).toContain('role="status"');
    expect(primaries(writing)).toBe(0);

    const stopped = render("create", { brief: BRIEF, plan: PLAN });
    expect(stopped).toContain("The writing stopped before it finished.");
    expect(stopped).toContain("Try again");
    expect(stopped).toContain("Back to plan");
  });
});

describe("SeoFlow: Review", () => {
  it("shows the article, its search snippet and the on-page checks", () => {
    const html = render("review", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
    });
    expect(currentStep(html)).toBe("Review");
    expect(html).toContain("Search preview");
    expect(html).toContain("example.com");
    expect(html).toContain("<h4");
    expect(html).toContain("How to choose running shoes</h4>");
    expect(html).toContain('<strong class="font-semibold">fit</strong>');
    expect(html).toContain("<li>Cushioning</li>");
    expect(html).toContain("On-page checks");
    expect(html).toMatch(/\d of 9 pass/);
    expect(html).toContain("Keyword in title");
    expect(html).toContain("Publish");
    expect(html).toContain("Rewrite");
    expect(html).toContain("Back to plan");
    expect(primaries(html)).toBe(1);
    // Earlier steps can be opened from the stepper.
    expect(html).toMatch(/<button type="button"[^>]*>[\s\S]*?Plan</);
  });

  it("dims the article and says so while it is rewritten", () => {
    const html = render("review", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      run: runNow("rewrite"),
    });
    expect(html).toContain("Rewriting your article.");
    expect(html).toContain("opacity:0.6");
    expect(primaries(html)).toBe(0);
  });
});

describe("SeoFlow: Publish", () => {
  it("hands the article over and offers the calendar", () => {
    const html = render("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
    });
    expect(currentStep(html)).toBe("Publish");
    expect(html).toContain("Copy as Markdown");
    expect(html).toContain("Copy as HTML");
    expect(html).toContain("When does it go live?");
    expect(html).toContain("Add to calendar");
    expect(html).toContain("Mark as published");
    expect(html).toContain("Back to review");
    expect(primaries(html)).toBe(1);
  });

  it("says when it is on the calendar, then that it is published", () => {
    const placed = render("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    expect(placed).toContain("On your calendar for Fri 9 Oct, 10:00.");
    expect(placed).toContain("On calendar");
    expect(placed).toContain("Open calendar");
    expect(placed).not.toContain("Add to calendar");
    expect(primaries(placed)).toBe(1);

    const published = render("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: { ...DELIVERY, publishedAt: "2026-10-09T08:00:00.000Z" },
    });
    expect(published).toContain("Published · Fri 9 Oct");
    expect(published).not.toContain("Mark as published");
    expect((published.match(/, done</g) ?? []).length).toBe(5);
  });

  it("in a completed Work, says why nothing can change; copying still works", () => {
    const html = render(
      "deliver",
      { brief: BRIEF, plan: PLAN, article: ARTICLE },
      { ...HOST, active: false },
    );
    expect(html).toContain("This Work is completed. Reopen it to continue.");
    expect(html).toMatch(
      /aria-disabled="true"[^>]*data-emphasis="primary"|data-emphasis="primary"[^>]*aria-disabled="true"/,
    );
    expect(html).toMatch(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*Copy as Markdown/,
    );
    expect(html).not.toMatch(
      /disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Copy as Markdown/,
    );
  });
});

// ---- SC-F6: kipler ve canlı koşu ----------------------------------------------

const FEATURES = { modes: true, live: true };
const stepLabels = (html: string) =>
  [
    ...html.matchAll(/<span class="text-xs whitespace-nowrap[^"]*"[^>]*>([^<]+)/g),
  ].map((match) => match[1]);

const TARGET = {
  url: "https://www.example.com/blog/running-shoes",
  path: "/blog/running-shoes",
  title: "Running shoes",
  metaDescription: "Our guide to running shoes.",
  h1: "Running shoes",
  h2: ["What running shoes do", "Old section"],
  wordCount: 900,
  textHash: null,
  fetchedAt: "2026-10-07T08:00:00.000Z",
  queryCount: 12,
};

const SNIPPET = {
  variants: [
    {
      title: "Running shoes for beginners: how to choose",
      metaDescription: "Pick a pair that fits, step by step.",
      angle: "Benefit",
    },
    {
      title: "Which running shoes should you buy?",
      metaDescription: "Cushioning, drop and size explained.",
      angle: "Question",
    },
  ],
  chosen: null,
  edited: null,
  generatedAt: "2026-10-07T08:05:00.000Z",
};

beforeEach(() => {
  live.phase = null;
  live.fallback = false;
});

describe("SeoFlow: a card without features", () => {
  it("renders none of the SC-F6 parts", () => {
    for (const [step, data] of [
      ["brief", {}],
      ["plan", { brief: BRIEF, plan: PLAN }],
      ["review", { brief: BRIEF, plan: PLAN, article: ARTICLE }],
      ["deliver", { brief: BRIEF, plan: PLAN, article: ARTICLE }],
    ] as const) {
      const html = render(step, data);
      expect(html).not.toContain("What do you want to do?");
      expect(html).not.toContain("Refresh a page");
      expect(html).not.toContain("Write another");
      expect(html).not.toContain("Live page address");
      expect(html).not.toContain("Suggested from Search Console");
      expect(html).not.toContain("Changes to the page");
      expect(stepLabels(html)).toHaveLength(5);
    }
  });

  it("a stale features-less card keeps the Search Console quick wins", () => {
    const html = render("plan", { brief: BRIEF, plan: PLAN });
    expect(html).toContain("Quick wins from Search Console");
  });
});

describe("SeoFlow: modes", () => {
  it("Brief offers the three modes with the article form under it", () => {
    const html = render("brief", { features: FEATURES });
    expect(html).toContain("What do you want to do?");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Write an article");
    expect(html).toContain("Refresh a page");
    expect(html).toContain("Fix a snippet");
    expect(html).toMatch(/aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Write an article/);
    expect(html).toContain('placeholder="What should the article be about?"');
  });

  it("refresh mode asks for the page instead of a topic", () => {
    const html = render("brief", {
      features: FEATURES,
      mode: "refresh",
      target: TARGET,
    });
    expect(html).toContain("Page address");
    expect(html).toContain('value="https://www.example.com/blog/running-shoes"');
    expect(html).toContain("Pick from your pages");
    expect(html).toContain("This page today");
    expect(html).toContain("Ranks for 12 searches");
    expect(html).toContain("Plan the refresh");
    expect(html).not.toContain("What should the article be about?");
    expect(primaries(html)).toBe(1);
  });

  it("snippet mode asks for the page and says 'Suggest titles'", () => {
    const html = render("brief", {
      features: FEATURES,
      mode: "snippet",
      pendingUrl: "https://www.example.com/pricing",
    });
    expect(html).toContain('value="https://www.example.com/pricing"');
    expect(html).toContain("Suggest titles");
    expect(html).not.toContain("Ranks for");
  });

  it("the picker is gone once there is a plan to keep", () => {
    const html = render("brief", {
      features: FEATURES,
      mode: "refresh",
      target: TARGET,
      brief: { ...BRIEF, topic: "Running shoes" },
      plan: PLAN,
    });
    expect(html).not.toContain("What do you want to do?");
    expect(html).toContain("Keep current plan");
  });

  it("snippet mode has three steps", () => {
    const html = render("plan", {
      features: FEATURES,
      mode: "snippet",
      brief: BRIEF,
      target: TARGET,
      snippet: SNIPPET,
    });
    expect(stepLabels(html)).toEqual(["Brief", "Plan", "Publish"]);
    expect(currentStep(html)).toBe("Plan");
  });

  it("refresh mode keeps all five", () => {
    const html = render("brief", {
      features: FEATURES,
      mode: "refresh",
      target: TARGET,
    });
    expect(stepLabels(html)).toHaveLength(5);
  });
});

describe("SeoFlow: Fix a snippet", () => {
  it("Plan shows today's snippet and the options as search results", () => {
    const html = render("plan", {
      features: FEATURES,
      mode: "snippet",
      brief: BRIEF,
      target: TARGET,
      snippet: SNIPPET,
    });
    expect(html).toContain("Now");
    expect(html).toContain("example.com");
    expect(html).toContain("Option 1");
    expect(html).toContain("Option 2");
    expect(html).toContain("Benefit");
    expect(html).toContain("Running shoes for beginners: how to choose");
    expect(html).toContain("Title fits");
    expect(html).toContain("Description fits");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain("42 / 60");
    expect(html).toContain("36 / 155");
    expect(html).toContain("Use this");
    expect(html).toContain("Suggest again");
    expect(primaries(html)).toBe(1);
  });

  it("says it is suggesting while the call runs", () => {
    const html = render("plan", {
      features: FEATURES,
      mode: "snippet",
      brief: BRIEF,
      target: TARGET,
      run: runNow("snippet"),
    });
    expect(html).toContain("Reading your page and writing three title options.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Use this");
  });

  it("Publish hands over the chosen text and asks 'I've updated my site'", () => {
    const html = render("deliver", {
      features: FEATURES,
      mode: "snippet",
      brief: BRIEF,
      target: TARGET,
      snippet: { ...SNIPPET, chosen: 1 },
    });
    expect(currentStep(html)).toBe("Publish");
    expect(html).toContain("Which running shoes should you buy?");
    expect(html).toContain("Cushioning, drop and size explained.");
    expect(html).toContain("I&#x27;ve updated my site");
    expect(html).not.toContain("Add to calendar");
    expect(html).not.toContain("Copy as Markdown");
    expect(primaries(html)).toBe(1);
  });

  it("after it is applied: the day, the next cards, no more primary", () => {
    const html = render("deliver", {
      features: FEATURES,
      mode: "snippet",
      brief: BRIEF,
      target: TARGET,
      snippet: { ...SNIPPET, chosen: 0 },
      applied: { at: "2026-10-08T08:00:00.000Z" },
    });
    expect(html).toContain("Updated · Thu 8 Oct");
    expect(html).not.toContain("I&#x27;ve updated my site");
    expect(html).toContain("Write another");
    expect(html).toContain("Refresh a page");
    expect(html).toContain("Fix a snippet");
    expect(primaries(html)).toBe(0);
    expect((html.match(/, done</g) ?? []).length).toBe(3);
  });
});

describe("SeoFlow: Refresh a page", () => {
  const REFRESH = {
    features: FEATURES,
    mode: "refresh",
    brief: { ...BRIEF, topic: "Running shoes" },
    target: TARGET,
    refresh: {
      missing: ["How to test a pair in the shop"],
      keep: ["What running shoes do"],
    },
  };

  it("Plan says what changes and leaves the quick wins out", () => {
    const html = render("plan", { ...REFRESH, plan: PLAN });
    expect(html).toContain("What changes");
    expect(html).toContain("How to test a pair in the shop");
    expect(html).toContain("What running shoes do");
    expect(html).toContain(
      "This page already gets search traffic for 12 searches.",
    );
    expect(html).not.toContain("Quick wins from Search Console");
    expect(html).not.toContain("trail running shoes");
    expect(html).toContain("Rewrite the page");
  });

  it("Review puts the diff above the checks", () => {
    const html = render("review", { ...REFRESH, plan: PLAN, article: ARTICLE });
    expect(html).toContain("Changes to the page");
    expect(html).toContain("Title changes");
    expect(html).toContain("900 → ");
    expect(html.indexOf("Changes to the page")).toBeLessThan(
      html.indexOf("On-page checks"),
    );
    // The article form is not touched.
    expect(html).toMatch(/\d of 9 pass/);
  });

  it("Publish copies the page and asks 'I've updated my site', no calendar", () => {
    const html = render("deliver", { ...REFRESH, plan: PLAN, article: ARTICLE });
    expect(html).toContain("Copy as Markdown");
    expect(html).toContain("I&#x27;ve updated my site");
    expect(html).not.toContain("When does it go live?");
    expect(html).not.toContain("Add to calendar");
    expect(html).toContain("Back to review");
  });
});

describe("SeoFlow: Publish with features", () => {
  it("article mode can name the live page, before it is marked published", () => {
    const html = render("deliver", {
      features: FEATURES,
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
    });
    expect(html).toContain("Live page address (optional)");
    expect(html).toContain("Mark as published");
    // Nothing to write another of until it is on the calendar.
    expect(html).not.toContain("Write another");
  });

  it("on the calendar: next cards are offered, the address field stays until published", () => {
    const placed = render("deliver", {
      features: FEATURES,
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    expect(placed).toContain("Write another");
    expect(placed).toContain("Live page address (optional)");

    const published = render("deliver", {
      features: FEATURES,
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: { ...DELIVERY, publishedAt: "2026-10-09T08:00:00.000Z" },
    });
    expect(published).toContain("Write another");
    expect(published).not.toContain("Live page address");
  });

  it("only modes (no live) shows no next row and no status", () => {
    const html = render("deliver", {
      features: { modes: true, live: false },
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    expect(html).not.toContain("Write another");
  });
});

// SC-F8: "Publish to WordPress (draft)" yalnız features.apply damgasıyla çıkar.
describe("SeoFlow: Publish with the apply feature", () => {
  it("shows nothing about WordPress without the apply stamp", () => {
    const html = render("deliver", {
      features: FEATURES,
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    expect(html).not.toContain("WordPress");
  });

  it("asks to schedule first, then offers the draft block once it is on the calendar", () => {
    const before = render("deliver", {
      features: { ...FEATURES, apply: true },
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
    });
    expect(before).toContain(
      "Schedule the article first; then you can send a draft to WordPress.",
    );
    const placed = render("deliver", {
      features: { ...FEATURES, apply: true },
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    expect(placed).not.toContain("Schedule the article first");
  });
});

describe("SeoFlow: live runs", () => {
  it("shows the live phase in the pill and in the working note", () => {
    live.phase = "reading_page";
    const html = render("plan", {
      features: FEATURES,
      brief: BRIEF,
      run: runNow("research"),
    });
    expect(html).toContain("Reading page");
    expect(html).toContain("Reading your page…");
    expect(html).not.toContain("Researching keywords and what ranks today.");
  });

  it("without a live phase the kind's own words stay", () => {
    const html = render("plan", {
      features: FEATURES,
      brief: BRIEF,
      run: runNow("research"),
    });
    expect(html).toContain("Researching keywords and what ranks today.");
    expect(html).toContain("Researching");
  });

  it("a card without features ignores the live phase", () => {
    live.phase = "writing";
    const html = render("plan", { brief: BRIEF, run: runNow("research") });
    expect(html).toContain("Researching keywords and what ranks today.");
    expect(html).not.toContain("Writing…");
  });

  it("a stopped run says why and offers Try again where the step has none", () => {
    const lastError = {
      runId: "r1",
      kind: "rewrite",
      message: "The rewrite came back empty.",
      at: "2026-10-07T08:00:00.000Z",
    };
    const html = render("review", {
      features: FEATURES,
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      lastError,
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The rewrite came back empty.");
    expect(html).toContain("Try again");
  });

  it("where the step retries itself, the message is shown once without a second button", () => {
    const html = render("plan", {
      features: FEATURES,
      brief: BRIEF,
      lastError: {
        runId: "r1",
        kind: "research",
        message: "The research came back empty.",
        at: "2026-10-07T08:00:00.000Z",
      },
    });
    expect(html).toContain("The research came back empty.");
    expect((html.match(/Try again/g) ?? []).length).toBe(1);
  });

  it("no error banner while a run is going, or without the live feature", () => {
    const lastError = {
      runId: "r1",
      kind: "rewrite",
      message: "The rewrite came back empty.",
      at: "2026-10-07T08:00:00.000Z",
    };
    expect(
      render("review", {
        features: FEATURES,
        brief: BRIEF,
        plan: PLAN,
        article: ARTICLE,
        lastError,
        run: runNow("rewrite"),
      }),
    ).not.toContain("The rewrite came back empty.");
    expect(
      render("review", {
        brief: BRIEF,
        plan: PLAN,
        article: ARTICLE,
        lastError,
      }),
    ).not.toContain("The rewrite came back empty.");
  });
});
