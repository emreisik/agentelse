"use server";

import { WorkRepository } from "@/server/repositories/work.repository";
import { isChannelKey } from "@/lib/content-channels";
import { MAX_TARGETS_PER_PRESS } from "@/lib/works/slot-rules";
import {
  authorizeWorks,
  guardedAction,
  idSchema,
  type GuardFail,
} from "@/server/works/guard";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { loadSuggestedSlots } from "@/server/works/free-slot-loader";

// Read-only: the free-slot suggestions of a Work's channels (spec 3.4.4).
// Nothing is written; the Work is looked up WITH the project id.

type SlotPair = { date: string; time: string };

export type SuggestSlotsResult =
  | {
      ok: true;
      timezone: string;
      byChannel: Record<string, SlotPair[]>;
    }
  | GuardFail;

// Its own bucket: suggest runs on every panel open and channel toggle, and
// sharing "slots" with the mutating slot actions would let browsing starve
// Add to calendar, Change time and Remove.
const BUCKET = { bucket: "slots-suggest", limit: 60 } as const;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export async function suggestSlotsAction(
  projectId: string,
  workId: string,
  input: { channels: string[]; startFrom?: string },
): Promise<SuggestSlotsResult> {
  return guardedAction("suggest-slots", async (): Promise<SuggestSlotsResult> => {
    const gate = await authorizeWorks(projectId, BUCKET);
    if (!gate.ok) return gate;
    const id = idSchema.safeParse(workId);
    if (!id.success || !input || !Array.isArray(input.channels)) {
      return { ok: false, code: "INVALID", message: "That didn't work. Try again." };
    }
    const work = await WorkRepository.get(projectId, id.data);
    if (!work) {
      return { ok: false, code: "NOT_FOUND", message: "That Work no longer exists." };
    }
    const wanted = [
      ...new Set(input.channels.filter((c): c is string => typeof c === "string")),
    ]
      .filter((c) => isChannelKey(c))
      .slice(0, MAX_TARGETS_PER_PRESS);
    const startFrom =
      typeof input.startFrom === "string" && DATE_KEY.test(input.startFrom)
        ? input.startFrom
        : undefined;

    const byChannel: Record<string, SlotPair[]> = {};
    let timezone = "";
    for (const channel of wanted) {
      const result = await loadSuggestedSlots(projectId, { channel, startFrom });
      timezone = result.timezone;
      byChannel[channel] = result.slots;
    }
    if (!timezone) timezone = await getProjectTimezone(projectId);
    return { ok: true, timezone, byChannel };
  });
}
