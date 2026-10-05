"use client";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";

import { AdsFlow } from "./ads/ads-flow";
import { AnalyticsFlow } from "./analytics/analytics-flow";
import { SeoFlow } from "./seo/seo-flow";

// One module flow card in the chat (docs/modules.md): each module renders its
// own steps; this only picks the module.
export function ModuleFlowCard({
  card,
  commandId,
}: {
  card: ModuleFlowCardData;
  commandId?: string;
}) {
  switch (card.module) {
    case "ads":
      return <AdsFlow card={card} commandId={commandId} />;
    case "analytics":
      return <AnalyticsFlow card={card} commandId={commandId} />;
    case "seo":
      return <SeoFlow card={card} commandId={commandId} />;
  }
}
