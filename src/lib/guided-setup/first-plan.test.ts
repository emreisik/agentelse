import { describe, expect, it } from "vitest";

import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOALS,
  type ChannelKey,
} from "@/lib/content-channels";
import { parsePlanBrief, serializePlanBrief } from "@/lib/plan-brief";

import { FIRST_PLAN } from "./contract";
import { buildFirstPlanBrief } from "./first-plan";

const goal = PLAN_GOALS[0];
const TODAY = "2026-09-30";

describe("buildFirstPlanBrief (G46)", () => {
  it("round-trips through serialize/parse", () => {
    const brief = buildFirstPlanBrief({
      goal,
      channels: ["instagram", "linkedin"],
      today: TODAY,
    });
    expect(brief).not.toBeNull();
    expect(parsePlanBrief(serializePlanBrief(brief!))).toEqual(brief);
    expect(brief!.perWeek).toBe(FIRST_PLAN.perWeek);
    expect(brief!.weeks).toBe(FIRST_PLAN.weeks);
  });

  it("excludes ads and returns null when only ads is left", () => {
    const mixed = buildFirstPlanBrief({
      goal,
      channels: ["ads", "instagram"],
      today: TODAY,
    });
    expect(mixed!.channels.map((c) => c.channel)).toEqual(["instagram"]);
    expect(
      buildFirstPlanBrief({ goal, channels: ["ads"], today: TODAY }),
    ).toBeNull();
  });

  it("needs a goal and a channel", () => {
    expect(
      buildFirstPlanBrief({ goal: null, channels: ["instagram"], today: TODAY }),
    ).toBeNull();
    expect(buildFirstPlanBrief({ goal, channels: [], today: TODAY })).toBeNull();
  });

  it("uses the first format of each channel", () => {
    for (const key of CHANNEL_KEYS) {
      if (FIRST_PLAN.excludedChannels.includes(key)) continue;
      const brief = buildFirstPlanBrief({ goal, channels: [key], today: TODAY });
      expect(brief!.channels).toEqual([
        { channel: key, formats: [CHANNELS[key].formats[0]?.key] },
      ]);
    }
  });

  it("starts tomorrow, including month, year and leap rollover", () => {
    const start = (today: string) =>
      buildFirstPlanBrief({ goal, channels: ["instagram"], today })?.start;
    expect(start("2026-09-30")).toBe("2026-10-01");
    expect(start("2026-09-15")).toBe("2026-09-16");
    expect(start("2026-12-31")).toBe("2027-01-01");
    expect(start("2028-02-28")).toBe("2028-02-29");
    expect(start("2027-02-28")).toBe("2027-03-01");
    expect(start("2100-02-28")).toBe("2100-03-01");
  });

  it("rejects malformed or impossible dates", () => {
    for (const today of ["", "2026-9-30", "2026-02-30", "2026-13-01", "x"]) {
      expect(
        buildFirstPlanBrief({ goal, channels: ["instagram"], today }),
      ).toBeNull();
    }
  });

  it("has no theme", () => {
    const brief = buildFirstPlanBrief({
      goal,
      channels: ["instagram"],
      today: TODAY,
    })!;
    expect(brief.theme).toBeUndefined();
    expect(serializePlanBrief(brief)).not.toContain("theme=");
  });

  it("keeps at most 3 channels and drops duplicates", () => {
    const all = CHANNEL_KEYS.filter((k) => k !== "ads");
    const brief = buildFirstPlanBrief({ goal, channels: all, today: TODAY })!;
    expect(brief.channels.length).toBeLessThanOrEqual(3);
    const dup: ChannelKey[] = ["instagram", "instagram"];
    expect(
      buildFirstPlanBrief({ goal, channels: dup, today: TODAY })!.channels,
    ).toHaveLength(1);
  });
});
