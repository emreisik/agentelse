import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_CRITICAL_AFTER_MS,
  HEARTBEAT_WARN_AFTER_MS,
  heartbeatLevel,
  lastSignOfLife,
  maxGapMs24h,
  recordGap,
} from "@/lib/heartbeat";

const NOW = new Date("2026-10-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

describe("heartbeatLevel", () => {
  it("is ok while the last tick is fresh", () => {
    expect(
      heartbeatLevel({ lastBeatAt: ago(MIN), lastOkAt: ago(2 * MIN) }, NOW),
    ).toBe("ok");
  });

  it("warns after 5 minutes and is critical after 10", () => {
    expect(
      heartbeatLevel(
        { lastBeatAt: ago(HEARTBEAT_WARN_AFTER_MS + 1), lastOkAt: null },
        NOW,
      ),
    ).toBe("warn");
    expect(
      heartbeatLevel(
        { lastBeatAt: ago(HEARTBEAT_CRITICAL_AFTER_MS + 1), lastOkAt: null },
        NOW,
      ),
    ).toBe("critical");
  });

  it("uses the newer of tick start and tick end", () => {
    const snapshot = { lastBeatAt: ago(30 * MIN), lastOkAt: ago(MIN) };
    expect(lastSignOfLife(snapshot)).toEqual(ago(MIN));
    expect(heartbeatLevel(snapshot, NOW)).toBe("ok");
  });

  it("reports never when no heartbeat was ever written", () => {
    expect(heartbeatLevel(null, NOW)).toBe("never");
    expect(heartbeatLevel({ lastBeatAt: null, lastOkAt: null }, NOW)).toBe(
      "never",
    );
  });
});

describe("recordGap / maxGapMs24h", () => {
  it("keeps the longest gap of the last 24 hours", () => {
    let data = recordGap(null, ago(70 * 1000), ago(10 * MIN));
    data = recordGap(data, ago(10 * MIN), NOW);
    expect(maxGapMs24h(data, NOW)).toBe(10 * MIN);
  });

  it("drops gaps older than a day", () => {
    const old = recordGap(null, ago(26 * 60 * MIN), ago(25 * 60 * MIN));
    expect(maxGapMs24h(old, NOW)).toBe(0);
    expect(recordGap(old, ago(MIN), NOW).gaps).toHaveLength(1);
  });

  it("records nothing for the very first beat", () => {
    expect(recordGap(null, null, NOW).gaps).toEqual([]);
  });
});
