import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdsChain } from "@/lib/module-flows/ads/chain";
import type {
  AdsBrief,
  AdsBriefOptions,
  AdsPlan,
} from "@/lib/module-flows/ads/state";
import type { ModuleFlowCardData } from "@/lib/module-flows/card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));

// Static markup never calls a server action; none may reach a database.
const inert = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "then" || key === "__esModule" ? undefined : () => undefined,
      },
    ),
);
vi.mock("@/server/actions/ads-flow-actions", inert);
vi.mock("@/server/actions/approval-actions", inert);

const { AdsFlow, AdsFlowCard } = await import("./ads-flow");
const { changeOf } = await import("./launch-step");
const { WorkCardHostProvider } =
  await import("@/components/works/work-card-host");

import type {
  WorkCardHostInput,
  WorkCardHostValue,
} from "@/components/works/work-card-host";

const HOST: WorkCardHostInput = {
  projectId: "p1",
  projectName: "Cafe Lale",
  workId: "w1",
  workTitle: "Ads Manager",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const hostValue = (
  over: Partial<WorkCardHostInput> = {},
): WorkCardHostValue => ({
  ...HOST,
  ...over,
  announce: () => undefined,
  requestFocus: () => undefined,
  cancelFocus: () => undefined,
  consumeFocus: () => false,
});

const BRIEF: AdsBrief = {
  objective: "OUTCOME_TRAFFIC",
  dailyBudget: 20,
  days: 7,
  countries: ["TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link: "https://cafelale.com",
  callToAction: "LEARN_MORE",
  source: {
    creativeId: "cr1",
    assetId: "as1",
    title: "Spring menu",
    caption: "Our spring menu is here: fresh herbs and a new lemonade.",
  },
  currency: "TRY",
  pageName: "Cafe Lale",
};

const PLAN: AdsPlan = {
  campaignName: "Spring menu · Traffic",
  adSetName: "TR · 18–65+",
  adName: "Spring menu",
  primaryText: "Fresh herbs and a new lemonade: our spring menu is here.",
};

const OPTIONS: AdsBriefOptions = {
  account: { status: "ready", currency: "TRY", pageName: "Cafe Lale" },
  posts: [
    {
      creativeId: "cr1",
      assetId: "as1",
      title: "Spring menu",
      status: "APPROVED",
      channel: "instagram",
    },
    {
      creativeId: "cr2",
      assetId: "as2",
      title: "Summer terrace",
      status: "PUBLISHED",
    },
  ],
  defaults: { link: "https://cafelale.com", countries: ["TR"] },
};

const LAUNCH = {
  claimId: "c1",
  startedAt: "2026-10-05T10:00:00.000Z",
  campaignTaskId: "t1",
};

function card(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown> = {},
): ModuleFlowCardData {
  return {
    kind: "module-flow",
    module: "ads",
    title: "Ads Manager",
    step,
    data,
  };
}

// base-ui draws its ids from a counter that depends on earlier renders.
const norm = (html: string) =>
  html.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

function render(
  value: ModuleFlowCardData,
  initial?: { options?: AdsBriefOptions; chain?: AdsChain },
  over: Partial<WorkCardHostInput> = {},
): string {
  return norm(
    renderToStaticMarkup(
      createElement(
        WorkCardHostProvider,
        { value: { ...HOST, ...over } },
        createElement(AdsFlowCard, {
          card: value,
          commandId: "cmd1",
          host: hostValue(over),
          initial,
        }),
      ),
    ),
  );
}

const primaries = (html: string) =>
  (html.match(/data-emphasis="primary"/g) ?? []).length;
const currentStep = (html: string) =>
  html.match(/aria-current="step"[^>]*>.*?<span[^>]*>(\d)<\/span>/)?.[1];

describe("AdsFlow", () => {
  it("renders nothing without a Work around it", () => {
    expect(
      renderToStaticMarkup(
        createElement(AdsFlow, { card: card("brief"), commandId: "cmd1" }),
      ),
    ).toBe("");
  });

  it("is a Works card with the module's icon, title and steps", () => {
    const html = render(card("brief"), { options: OPTIONS });
    expect(html).toContain('data-card="module-flow"');
    expect(html).toContain('data-card-id="cmd1"');
    expect(html).toContain("max-w-xl");
    expect(html).toContain("Ads Manager");
    expect(html).toContain('aria-label="Ads Manager steps"');
    expect(html).toContain("Launch");
    expect(currentStep(html)).toBe("1");
  });
});

describe("Brief", () => {
  it("offers Meta, shows Google Ads as coming soon, and reads the posts", () => {
    const html = render(card("brief"), { options: OPTIONS });
    expect(html).toContain("Where to advertise");
    expect(html).toContain("Facebook and Instagram");
    expect(html).toContain("Google Ads");
    expect(html).toContain("Coming soon");
    expect(html).toContain('data-post="cr1"');
    expect(html).toContain("/api/assets/as2?w=320");
    expect(html).toContain("Summer terrace");
    for (const goal of ["Traffic", "Awareness", "Engagement"]) {
      expect(html).toContain(goal);
    }
    expect(html).toContain("Daily budget (TRY)");
    for (const days of ["3 days", "7 days", "14 days", "30 days"]) {
      expect(html).toContain(days);
    }
    // The project's market is the starting country.
    expect(html).toContain("Turkey");
    expect(html).toContain('value="https://cafelale.com"');
    expect(html).toContain("Learn more");
    // Next waits for a post, and says so.
    expect(primaries(html)).toBe(1);
    expect(html).toContain("Pick the post to promote.");
  });

  it("starts from the hinted post (Boost with an ad)", () => {
    const html = render(card("brief", { hint: { sourceCreativeId: "cr2" } }), {
      options: OPTIONS,
    });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-post="cr2"/);
    // The post is picked; the budget is next.
    expect(html).toContain("Enter a daily budget above 0.");
  });

  it("reopens with the saved brief", () => {
    const html = render(card("brief", { brief: BRIEF, plan: PLAN }), {
      options: OPTIONS,
    });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-post="cr1"/);
    expect(html).toContain('value="20"');
    expect(html).toContain("About 140 TRY in total.");
    expect(html).not.toContain("Pick the post to promote.");
  });

  it("is blocked with one way forward until Meta Ads is connected", () => {
    const html = render(card("brief"), {
      options: { ...OPTIONS, account: { status: "needs-connect" } },
    });
    expect(html).toContain("Meta Ads isn&#x27;t connected for this brand.");
    expect(html).toContain("Connect Meta Ads");
    expect(html).toContain(
      'href="/projects/p1/integrations?integration=meta_ads"',
    );
    expect(html).not.toContain('data-post="cr1"');
    expect(primaries(html)).toBe(1);
  });

  it("sends to the Social Media Planner when there is no post yet", () => {
    const html = render(card("brief"), { options: { ...OPTIONS, posts: [] } });
    expect(html).toContain("Make a post in the Social Media Planner first.");
    expect(html).toContain('href="/projects/p1?module=social"');
  });

  it("loads calmly", () => {
    const html = render(card("brief"));
    expect(html).toContain("Loading your posts…");
    expect(html).toContain('role="status"');
  });
});

describe("Plan", () => {
  it("starts from the post's own words until the AI has written", () => {
    const html = render(card("plan", { brief: BRIEF }));
    expect(currentStep(html)).toBe("2");
    expect(html).toContain("Not written with AI yet");
    expect(html).toContain('value="Spring menu · Traffic"');
    expect(html).toContain("Campaign name");
    expect(html).toContain("Ad set name");
    expect(html).toContain("Primary text");
    expect(html).toContain("Write with AI");
    expect(html).toContain("Back");
    expect(primaries(html)).toBe(1);
  });

  it("shows the written ad, editable, with the brand-rule note", () => {
    const html = render(
      card("plan", { brief: BRIEF, plan: { ...PLAN, flags: ["en iyi"] } }),
    );
    expect(html).toContain("Rewrite with AI");
    expect(html).toContain(PLAN.primaryText);
    expect(html).toContain(`${PLAN.primaryText.length}/125`);
    expect(html).toContain("“en iyi” is on your brand&#x27;s avoid list.");
    expect(html).not.toContain("Not written with AI yet");
  });
});

describe("Create and Review", () => {
  it("Create shows the ad: the post's picture, the text, the link, the button", () => {
    const html = render(card("create", { brief: BRIEF, plan: PLAN }));
    expect(currentStep(html)).toBe("3");
    expect(html).toContain("Your ad");
    expect(html).toContain("Sponsored");
    expect(html).toContain("/api/assets/as1?w=768");
    expect(html).toContain(PLAN.primaryText);
    expect(html).toContain("cafelale.com");
    expect(html).toContain("Learn more");
    expect(html).toContain("nothing new is drawn");
    expect(primaries(html)).toBe(1);
  });

  it("Review sums up the spend and the audience, and launches", () => {
    const html = render(card("review", { brief: BRIEF, plan: PLAN }));
    expect(currentStep(html)).toBe("4");
    expect(html).toContain("Traffic · link clicks");
    expect(html).toContain("20 TRY a day × 7 days = 140 TRY");
    expect(html).toContain("Turkey · 18–65+ · All genders");
    expect(html).toContain("cafelale.com · Learn more");
    expect(html).toContain("created paused in your Meta Ads account");
    expect(html).toContain("runs until you pause it (planned: 7 days)");
    expect(html).toMatch(/data-emphasis="primary"[^>]*>(<[^>]+>)*Launch/);
    expect(primaries(html)).toBe(1);
  });

  it("a completed Work blocks every change and says why", () => {
    const html = render(
      card("review", { brief: BRIEF, plan: PLAN }),
      undefined,
      {
        active: false,
      },
    );
    expect(html).toContain("This Work is completed. Reopen it to continue.");
    expect(html).toContain('aria-disabled="true"');
  });
});

describe("Launch", () => {
  const launched = card("deliver", {
    brief: BRIEF,
    plan: PLAN,
    launch: LAUNCH,
  });

  it("reads the chain calmly first", () => {
    const html = render(launched);
    expect(currentStep(html)).toBe("5");
    expect(html).toContain("Checking Meta…");
  });

  it("an approval waits right on the card", () => {
    const html = render(launched, {
      chain: {
        links: [
          { key: "campaign", state: "approval", approvalId: "ap1" },
          { key: "adset", state: "waiting" },
          { key: "ad", state: "waiting" },
        ],
        complete: false,
        stopped: false,
      },
    });
    expect(html).toContain("Waiting for you");
    expect(html).toContain("Waiting for your approval");
    expect(html).toContain("Approve campaign");
    expect(html).toContain("Waits for the step before");
    expect(html).toContain("Refresh");
    expect(primaries(html)).toBe(1);
  });

  it("all created: paused in Meta, with the way to Ads Manager", () => {
    const html = render(launched, {
      chain: {
        links: [
          { key: "campaign", state: "created", metaId: "c-1" },
          { key: "adset", state: "created" },
          { key: "ad", state: "created" },
        ],
        complete: true,
        stopped: false,
        campaignId: "c-1",
      },
    });
    expect(html).toContain("Created paused in your Meta Ads account.");
    expect(html).toContain('href="/projects/p1/ads?campaignDetail=c-1"');
    expect(html).toContain("Open Ads Manager");
    // Every step done: none is current any more.
    expect(html).not.toContain('aria-current="step"');
    expect(html.match(/, done/g)).toHaveLength(5);
  });

  it("a failure says why and offers to launch again", () => {
    const html = render(launched, {
      chain: {
        links: [
          { key: "campaign", state: "created" },
          { key: "adset", state: "failed", reason: "Daily budget is too low." },
          { key: "ad", state: "blocked" },
        ],
        complete: false,
        stopped: true,
      },
    });
    expect(html).toContain("Stopped");
    expect(html).toContain("Daily budget is too low.");
    expect(html).toContain("Not created");
    expect(html).toContain("Edit and launch again");
    expect(primaries(html)).toBe(1);
  });
});

describe("changeOf", () => {
  const chain = (states: [string, string, string]): AdsChain => ({
    links: (["campaign", "adset", "ad"] as const).map((key, at) => ({
      key,
      state: states[at] as AdsChain["links"][number]["state"],
    })),
    complete: false,
    stopped: false,
  });

  it("speaks a link that moved on its own, never the first read", () => {
    expect(
      changeOf(null, chain(["approval", "waiting", "waiting"])),
    ).toBeNull();
    expect(
      changeOf(
        chain(["running", "waiting", "waiting"]),
        chain(["created", "preparing", "waiting"]),
      ),
    ).toBe("Campaign: Created, paused");
    expect(
      changeOf(
        chain(["created", "preparing", "waiting"]),
        chain(["created", "approval", "waiting"]),
      ),
    ).toBe("Ad set: Waiting for your approval");
    expect(
      changeOf(
        chain(["created", "running", "waiting"]),
        chain(["created", "running", "waiting"]),
      ),
    ).toBeNull();
  });
});
