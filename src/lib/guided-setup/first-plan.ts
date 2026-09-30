import { CHANNELS, type ChannelKey, type PlanGoal } from "@/lib/content-channels";
import { addDaysToKey } from "@/lib/content-plan-view";
import {
  parsePlanBrief,
  serializePlanBrief,
  type PlanBrief,
} from "@/lib/plan-brief";

import { FIRST_PLAN } from "./contract";

// A brief may carry many channels; the first draft stays small.
const MAX_FIRST_PLAN_CHANNELS = 3;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Calendar math is shared with the plan views (addDaysToKey): one implementation
// of "tomorrow". The key is validated first, and a round trip through the date
// rejects a day that does not exist ("2026-02-30" would roll over to March).
function nextDay(today: string): string | null {
  const match = DATE_RE.exec(today);
  if (!match || Number(match[1]) < 1000) return null;
  if (addDaysToKey(today, 0) !== today) return null;
  return addDaysToKey(today, 1);
}

// Builds the message-ready brief for the optional first plan draft. Only
// closed vocabulary and numbers go in; null when there is nothing safe to plan.
export function buildFirstPlanBrief({
  goal,
  channels,
  today,
}: {
  goal: PlanGoal | null | undefined;
  channels: readonly ChannelKey[];
  today: string;
}): PlanBrief | null {
  if (!goal) return null;
  const start = nextDay(today);
  if (!start) return null;

  const picked: ChannelKey[] = [];
  for (const key of channels) {
    if (FIRST_PLAN.excludedChannels.includes(key)) continue;
    if (picked.includes(key)) continue;
    picked.push(key);
    if (picked.length === MAX_FIRST_PLAN_CHANNELS) break;
  }
  if (picked.length === 0) return null;

  const channelFormats: PlanBrief["channels"] = [];
  for (const channel of picked) {
    const first = CHANNELS[channel].formats[0];
    if (!first) return null;
    channelFormats.push({ channel, formats: [first.key] });
  }

  const brief: PlanBrief = {
    goal,
    channels: channelFormats,
    perWeek: FIRST_PLAN.perWeek,
    weeks: FIRST_PLAN.weeks,
    start,
  };

  // Round trip: what the agent parses must be exactly what we meant.
  const parsed = parsePlanBrief(serializePlanBrief(brief));
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(brief)) return null;
  return brief;
}
