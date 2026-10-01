import {
  channelOfFormatKey,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import { copyText } from "@/lib/works/copy";

type TruthItem = {
  channel?: ChannelKey;
  formatKey?: string;
  // Undefined for a platform outside the catalog: such an item is not counted.
  publish?: PublishMode;
};

// The catalog calls LinkedIn and X posts "auto", but only Instagram is ever
// published by the app (and only with scheduled posting): every other "auto"
// item is a hand-off, so the card must not claim it publishes itself.
export function worksPublishMode(item: TruthItem & { publish: PublishMode }): PublishMode {
  if (item.publish !== "auto") return item.publish;
  const channel =
    item.channel ?? (item.formatKey ? channelOfFormatKey(item.formatKey) : undefined);
  return channel === "instagram" ? "auto" : "manual";
}

const SUMMARY_KEY = {
  auto: "plan.summary.auto",
  manual: "plan.summary.manual",
  approval: "plan.summary.approval",
} as const;

const TONE_KEY = {
  auto: "plan.tone.auto",
  manual: "plan.tone.manual",
  approval: "plan.tone.approval",
} as const;

const MODES: readonly PublishMode[] = ["auto", "manual", "approval"];

// "2 on Instagram, posted once approved · 1 you post yourself": parts only for
// counts above zero, in a fixed order.
export function worksPlanSummary(items: readonly TruthItem[]): string {
  const counts: Record<PublishMode, number> = { auto: 0, manual: 0, approval: 0 };
  for (const item of items) {
    if (item.publish) counts[worksPublishMode({ ...item, publish: item.publish })] += 1;
  }
  return MODES.filter((mode) => counts[mode] > 0)
    .map((mode) => copyText(SUMMARY_KEY[mode], { n: counts[mode] }))
    .join(" · ");
}

export function worksPublishTone(mode: PublishMode): string {
  return copyText(TONE_KEY[mode]);
}
