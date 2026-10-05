import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";
import type { WorkCardHostInput } from "@/components/works/work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
