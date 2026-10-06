import "server-only";

import type { AdsDecision } from "@prisma/client";

import { autoActionTitle, type AutoKind } from "@/lib/ads/autopilot";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { prisma } from "@/lib/prisma";
import { postToAdsChat } from "@/server/ads/ads-chat";
import { AdsAlerts } from "@/server/ads/guard/alerts";

// Otomatik eylemin sonradan bildirimi (docs/meta-ads-plan.md §1.2, F7): Ads
// kartında "Auto-paused · <reklam>" uyarısı (kartın Undo düğmesi geri alır)
// ve Ads sohbetinde tek mesaj. Başarısız otomatik eylem CRITICAL'dır.

function autoKind(kind: string): AutoKind | null {
  return kind === "PAUSE" || kind === "BUDGET_DOWN" || kind === "BUDGET_UP"
    ? kind
    : null;
}

export function autoDedupeKey(decisionId: string): string {
  return `auto:${decisionId}`;
}

async function objectName(decision: AdsDecision): Promise<string> {
  const object = await prisma.adsObject.findFirst({
    where: {
      adsAccountId: decision.adsAccountId,
      externalId: decision.externalId,
    },
    select: { name: true },
  });
  return object ? nameWithoutTag(object.name) : decision.externalId;
}

async function brandOf(projectId: string): Promise<string | null> {
  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  return brand?.id ?? null;
}

export const AutopilotNotify = {
  async applied(decision: AdsDecision, now: Date = new Date()): Promise<void> {
    const kind = autoKind(decision.kind);
    if (!kind || decision.autonomy === "SUGGEST") return;
    const name = await objectName(decision);
    const title = autoActionTitle(kind, name);
    await AdsAlerts.raise(
      {
        workspaceId: decision.workspaceId,
        projectId: decision.projectId,
        adsAccountId: decision.adsAccountId,
        externalId: decision.externalId,
        kind: "AUTO_ACTION",
        severity: "WARN",
        dedupeKey: autoDedupeKey(decision.id),
        title,
        detail: `${decision.explanation} Undo it from the Ads card if you want it back.`,
        data: { decisionId: decision.id },
      },
      now,
    );
    const brandId = await brandOf(decision.projectId);
    if (!brandId) return;
    await postToAdsChat({
      projectId: decision.projectId,
      brandId,
      commandId: `adsauto_${decision.id}`,
      text: `${title}\n${decision.explanation}\nAgentelse did this on its own because Ads autopilot is on. Press Undo on the Ads card to change it back.`,
      summary: title,
      now,
    }).catch(() => false);
  },

  async failed(decision: AdsDecision, now: Date = new Date()): Promise<void> {
    const kind = autoKind(decision.kind);
    if (!kind || decision.autonomy === "SUGGEST") return;
    const name = await objectName(decision);
    await AdsAlerts.raise(
      {
        workspaceId: decision.workspaceId,
        projectId: decision.projectId,
        adsAccountId: decision.adsAccountId,
        externalId: decision.externalId,
        kind: "AUTO_ACTION_FAILED",
        severity: "CRITICAL",
        dedupeKey: autoDedupeKey(decision.id),
        title:
          kind === "PAUSE"
            ? `Couldn't pause ${name} automatically`
            : `Couldn't change the budget of ${name} automatically`,
        detail: `${decision.explanation} Check it in Ads Manager or press Pause on the Ads page.`,
        data: { decisionId: decision.id },
      },
      now,
    );
  },

  // Geri alınınca otomatik eylem uyarısı kapanır.
  async undone(
    originalDecisionId: string,
    projectId: string,
    now: Date = new Date(),
  ) {
    await AdsAlerts.resolve(projectId, autoDedupeKey(originalDecisionId), now);
  },
};
