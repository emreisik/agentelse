import "server-only";

import { prisma } from "@/lib/prisma";
import {
  adsFlowData,
  parseAdsFlowState,
  type AdsFlowState,
} from "@/lib/module-flows/ads/state";
import {
  isModuleFlowCard,
  type ModuleFlowCardData,
  type ModuleFlowStep,
} from "@/lib/module-flows/card";
import { updateModuleFlowCard } from "@/server/modules/flow-card";
import { idSchema } from "@/server/works/guard";

// Ads Manager kartının okuma / yazma yardımcıları: ads-flow-actions ve lansman
// v2 eylemleri (ads-launch-actions) ortak kullanır. Sunucuya özeldir; "use
// server" modülünde dışa açılmaz (her dışa açık fonksiyon bir uç olurdu).

export type AdsCard = {
  commandId: string;
  card: ModuleFlowCardData;
  workId: string | null;
};

export type AdsCardDecision =
  { step: ModuleFlowStep; state: AdsFlowState } | { reject: string };

// The card of this Command, only when it is an Ads Manager card of this
// project.
export async function readAdsCard(
  projectId: string,
  commandId: unknown,
): Promise<AdsCard | null> {
  const id = idSchema.safeParse(commandId);
  if (!id.success) return null;
  const row = await prisma.command.findFirst({
    where: { id: id.data, projectId },
    select: { parsedIntent: true, workId: true },
  });
  const card = (row?.parsedIntent as { card?: unknown } | null)?.card;
  if (!row || !isModuleFlowCard(card) || card.module !== "ads") return null;
  return { commandId: id.data, card, workId: row.workId };
}

// One write of the card: `decide` reads the stored state and returns the next
// step and state, or refuses.
export function writeAdsCard(
  projectId: string,
  commandId: string,
  decide: (card: ModuleFlowCardData, state: AdsFlowState) => AdsCardDecision,
) {
  return updateModuleFlowCard({
    commandId,
    projectId,
    module: "ads",
    update: (card) => {
      const decided = decide(card, parseAdsFlowState(card.data));
      if ("reject" in decided) return decided;
      return { ...card, step: decided.step, data: adsFlowData(decided.state) };
    },
  });
}
