import { describe, expect, it } from "vitest";

import { objectStorySpec } from "@/server/integrations/meta/launch-writes";

import { launchSpecFromFlow, recipeForBrief, whatsappDigits } from "./launch";
import { AdsBriefInputSchema, briefIssue, type AdsBrief } from "./state";

const base = {
  creativeId: "c1",
  objective: "OUTCOME_ENGAGEMENT" as const,
  dailyBudget: 20,
  days: 7 as const,
  countries: ["TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all" as const,
  link: "",
  callToAction: "LEARN_MORE" as const,
};

describe("messages brief (F5a)", () => {
  it("needs no link but a WhatsApp number on WhatsApp", () => {
    expect(
      AdsBriefInputSchema.safeParse({ ...base, messages: { app: "WHATSAPP" } }).success,
    ).toBe(false);
    expect(briefIssue({ ...base, messages: { app: "WHATSAPP" } })).toBe(
      "Enter the WhatsApp number your Facebook Page uses.",
    );
    expect(
      AdsBriefInputSchema.safeParse({
        ...base,
        messages: { app: "WHATSAPP", whatsappNumber: "+90 532 000 00 00" },
      }).success,
    ).toBe(true);
    expect(AdsBriefInputSchema.safeParse({ ...base, messages: { app: "MESSENGER" } }).success).toBe(true);
  });

  it("runs only on the Engagement objective and keeps the link rule elsewhere", () => {
    expect(
      AdsBriefInputSchema.safeParse({
        ...base,
        objective: "OUTCOME_TRAFFIC",
        messages: { app: "MESSENGER" },
      }).success,
    ).toBe(false);
    expect(AdsBriefInputSchema.safeParse({ ...base, objective: "OUTCOME_TRAFFIC" }).success).toBe(false);
  });
});

describe("recipes and spec (F5a)", () => {
  const brief: AdsBrief = {
    ...base,
    source: { creativeId: "c1", assetId: "a1", title: "Spring" },
    messages: { app: "WHATSAPP", whatsappNumber: "+90 (532) 000-0000", replyTime: "hour" },
  };
  const context = {
    adAccountId: "act_1",
    currency: "TRY",
    timezone: "Europe/Istanbul",
    pageId: "9",
    minCampaignSpendCapMinor: null,
    dsaBeneficiary: null,
    dsaPayor: null,
  };

  it("picks the recipe from the goal", () => {
    expect(recipeForBrief(brief).key).toBe("messages_whatsapp");
    expect(recipeForBrief({ objective: "OUTCOME_TRAFFIC", trafficEvent: "LANDING_PAGE_VIEWS" }).key).toBe(
      "traffic_landing_page_views",
    );
    expect(recipeForBrief({ objective: "OUTCOME_TRAFFIC" }).key).toBe("traffic_link_clicks");
  });

  it("builds a conversations ad set and a messaging creative", () => {
    const spec = launchSpecFromFlow({
      brief,
      plan: { campaignName: "Chat", adSetName: "TR", adName: "Ad", primaryText: "Write to us" },
      context,
      activate: true,
    });
    expect(spec.adSets[0]).toMatchObject({
      optimizationGoal: "CONVERSATIONS",
      destinationType: "WHATSAPP",
      promotedObject: { page_id: "9", whatsapp_phone_number: "905320000000" },
    });
    expect(spec.ads[0]?.creative.messaging).toBe("WHATSAPP");
    expect(whatsappDigits("+90 (532) 000-0000")).toBe("905320000000");
  });

  it("sends the chat call to action instead of a website link", () => {
    const story = objectStorySpec({
      pageId: "9",
      imageHash: "h",
      message: "Hi",
      link: "https://www.facebook.com/",
      callToAction: "LEARN_MORE",
      messaging: "MESSENGER",
    });
    expect(story.link_data.call_to_action).toEqual({
      type: "MESSAGE_PAGE",
      value: { app_destination: "MESSENGER" },
    });
    expect(story.link_data.link).toBe("https://fb.com/messenger_doc/");
  });
});
