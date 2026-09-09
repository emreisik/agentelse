import { z } from "zod";

import type { ReasoningDef } from "../types";

// Meta Marketing API objective/optimization enums (stable, well-known
// values — https://developers.facebook.com/docs/marketing-api/campaign-structure).
// billingEvent is deliberately NOT part of this schema: it's always
// "IMPRESSIONS" (the one billing event valid for every optimizationGoal
// below), so the caller sets it directly rather than asking the model to
// repeat a constant.
export const MetaCampaignBriefSchema = z.object({
  campaignName: z.string().min(3).max(120),
  objective: z.enum([
    "OUTCOME_TRAFFIC",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_AWARENESS",
    "OUTCOME_LEADS",
    "OUTCOME_SALES",
  ]),
  // The caller clamps this to AutonomyPolicy.maxCampaignDailyBudgetUsd
  // before it ever reaches a Task payload — this schema range is just a
  // sanity bound, not the real safety limit.
  dailyBudgetCents: z.number().int().min(500).max(100_000),
  optimizationGoal: z.enum([
    "LINK_CLICKS",
    "REACH",
    "IMPRESSIONS",
    "LANDING_PAGE_VIEWS",
  ]),
  targetCountries: z.array(z.string().length(2)).min(1).max(5),
  adName: z.string().min(3).max(120),
  adMessage: z.string().min(10).max(500),
  adLink: z.string().url(),
});

export type MetaCampaignBriefOutput = z.infer<typeof MetaCampaignBriefSchema>;

export const metaCampaignBriefDef: ReasoningDef<MetaCampaignBriefOutput> = {
  purpose: "meta-ads.campaign-brief",
  schema: MetaCampaignBriefSchema,
  maxTokens: 1024,

  buildPrompt(context) {
    const idea = (context.idea ?? {}) as {
      title?: string;
      description?: string;
      lens?: string;
    };
    const brand = (context.brand ?? {}) as {
      name?: string;
      domain?: string;
      country?: string;
    };
    const creative = (context.creative ?? {}) as {
      caption?: string;
      copy?: string;
    };
    const maxDailyBudgetUsd = (context.maxDailyBudgetUsd as number) ?? 10;

    return {
      system:
        "You write a Meta (Facebook/Instagram) ad campaign brief promoting " +
        "an already-approved, already-published social creative. Propose a " +
        "campaign name, objective, a conservative daily budget in US cents " +
        `(never exceed ${maxDailyBudgetUsd * 100} cents/day), an optimization ` +
        "goal consistent with that objective, 1-5 target country ISO-3166 " +
        "alpha-2 codes matching the brand's actual market (its primary " +
        "market's country code is given below — start from that unless the " +
        "idea clearly targets somewhere else), and the ad's own " +
        "name/message/link. The ad message should read as a short, punchy " +
        "ad — reuse the creative's caption/copy as inspiration, don't just " +
        "repeat it verbatim. adLink must be a real, absolute URL — the " +
        "brand's own domain if nothing more specific is known.",
      user:
        `Idea:\n${JSON.stringify(idea, null, 2)}\n\n` +
        `Brand:\n${JSON.stringify(brand, null, 2)}\n\n` +
        `Approved creative:\n${JSON.stringify(creative, null, 2)}\n\n` +
        "Write the campaign brief.",
    };
  },

  buildMock(context) {
    const idea = (context.idea ?? {}) as { title?: string };
    const brand = (context.brand ?? {}) as {
      name?: string;
      domain?: string;
      country?: string;
    };
    const creative = (context.creative ?? {}) as {
      caption?: string;
      copy?: string;
    };
    const maxDailyBudgetUsd = (context.maxDailyBudgetUsd as number) ?? 10;
    const title = idea.title ?? "Campaign";
    const domain = brand.domain ?? "example.com";

    return {
      campaignName: `${title} — ${brand.name ?? "Brand"}`.slice(0, 120),
      objective: "OUTCOME_TRAFFIC",
      // Clamped to the schema's own [500, 100_000] sanity bound — a
      // misconfigured policy value (e.g. below $5/day) must not produce a
      // mock output that fails its own schema.
      dailyBudgetCents: Math.min(
        100_000,
        Math.max(500, Math.round(maxDailyBudgetUsd * 100)),
      ),
      optimizationGoal: "LINK_CLICKS",
      targetCountries: [brand.country?.toUpperCase().slice(0, 2) || "US"],
      adName: `${title} — Ad`.slice(0, 120),
      // Prefixed rather than falling back bare — guarantees >=10 chars
      // (the schema's adMessage floor) even if caption/copy is a short
      // real string, without ever silently discarding it.
      adMessage:
        `${title}: ${creative.caption || creative.copy || "Şimdi keşfedin"}`.slice(
          0,
          500,
        ),
      adLink: domain.startsWith("http") ? domain : `https://${domain}`,
    };
  },
};
