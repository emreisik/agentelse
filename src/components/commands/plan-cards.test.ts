import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/content-plan-actions", () => ({
  saveContentPlanAction: vi.fn(),
}));
vi.mock("@/server/actions/command-actions", () => ({
  submitChatMessageAction: vi.fn(),
}));

const { ContentPlanCard } = await import("./content-plan-card");
const { PlanBriefWizard } = await import("./plan-brief-wizard");

import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type BriefCard = Extract<IdeaEventCardData, { kind: "plan-brief" }>;

const plan: PlanCard = {
  kind: "content-plan-draft",
  title: "Web Health weekly plan",
  timezone: "Europe/Istanbul",
  state: "draft",
  goal: "leads",
  connections: {
    instagram: { connected: true, accountLabel: "@webhealth" },
    ads: { connected: false },
  },
  items: [
    {
      date: "2026-09-29",
      time: "10:00",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.carousel",
      topic: "How a website builds clinic trust",
      captionIdea: "Slides on services and contact ease",
    },
    {
      date: "2026-09-30",
      time: "10:00",
      channel: "seo",
      formatKey: "seo.article",
      topic: "Health tourism SEO guide",
      captionIdea: "Target keyword: health tourism website",
    },
    {
      date: "2026-10-01",
      time: "10:00",
      channel: "ads",
      formatKey: "ads.campaign",
      topic: "Booking campaign",
      captionIdea: "Offer and audience",
    },
    {
      date: "2026-10-02",
      time: "10:00",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      topic: "Clinic tour",
      captionIdea: "A look inside the clinic",
    },
  ],
};

const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element);

describe("ContentPlanCard", () => {
  const html = render(createElement(ContentPlanCard, { card: plan, commandId: "cmd-1" }));

  it("shows the plan's purpose, its channels and how each is connected", () => {
    expect(html).toContain("Web Health weekly plan");
    expect(html).toContain("Leads &amp; bookings");
    expect(html).toContain("@webhealth");
    // Ads is not connected: the chip links to the integrations page.
    expect(html).toContain("Connect Meta Ads");
    expect(html).toContain('href="/projects/proj-1/integrations"');
    // Blog/SEO is always a hand-off.
    expect(html).toContain("You publish");
  });

  it("is a compact week view with tabs, not a long list of captions", () => {
    expect(html).toContain("Week");
    expect(html).toContain("List");
    expect(html).toContain("28 Sept – 4 Oct");
    // The mini grid has one chip per piece; only the selected piece's caption
    // is expanded.
    expect(html).toContain("Slides on services and contact ease");
    expect(html).not.toContain("Target keyword: health tourism website");
  });

  it("summarizes what happens to the pieces and offers Save", () => {
    expect(html).toContain("Save to calendar");
    // Instagram post = auto (account connected); carousel and the blog
    // article are hand-offs; the ad brief always waits for approval.
    expect(html).toContain("1 auto-publish");
    expect(html).toContain("2 you publish");
    expect(html).toContain("1 needs approval");
  });

  it("renders a saved plan with a calendar link and no Save button", () => {
    const saved = render(
      createElement(ContentPlanCard, {
        card: { ...plan, state: "saved" },
        commandId: "cmd-1",
      }),
    );
    expect(saved).toContain("Saved");
    expect(saved).toContain('href="/projects/proj-1/takvim"');
    expect(saved).not.toContain("Save to calendar");
  });

  it("still renders a plan drafted before channels existed", () => {
    const legacy: PlanCard = {
      kind: "content-plan-draft",
      title: "Old plan",
      timezone: "Europe/Istanbul",
      state: "draft",
      items: [
        {
          date: "2026-10-01",
          time: "10:00",
          platform: "INSTAGRAM",
          format: "Reel",
          topic: "Launch teaser",
          captionIdea: "Behind the scenes",
        },
        {
          date: "2026-10-02",
          time: "10:00",
          platform: "FACEBOOK",
          topic: "Live Q&A",
          captionIdea: "Ask us anything",
        },
      ],
    };
    const legacyHtml = render(createElement(ContentPlanCard, { card: legacy, commandId: "c" }));
    expect(legacyHtml).toContain("Old plan");
    expect(legacyHtml).toContain("Instagram");
    expect(legacyHtml).toContain("Reel");
    // No connection snapshot on an old plan: no publish claims are made.
    expect(legacyHtml).not.toContain("auto-publish");
  });
});

describe("PlanBriefWizard", () => {
  const card: BriefCard = {
    kind: "plan-brief",
    projectId: "proj-1",
    today: "2026-09-29",
    connections: { instagram: { connected: true, accountLabel: "@webhealth" } },
    theme: "Kommo CRM",
  };
  const html = render(createElement(PlanBriefWizard, { card }));

  it("starts on the goal step with every goal offered", () => {
    expect(html).toContain("What is this plan for?");
    for (const label of [
      "Awareness",
      "Leads &amp; bookings",
      "Sales",
      "Engagement",
      "Traffic &amp; SEO",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("does not show later steps yet", () => {
    expect(html).not.toContain("Where should it go?");
    expect(html).not.toContain("Create plan");
  });
});
