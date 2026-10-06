import { describe, expect, it } from "vitest";

import {
  WEBSITE_GOAL_DESCRIPTION,
  WEBSITE_GOAL_KEYS,
  WEBSITE_GOAL_LABEL,
  WEBSITE_GOAL_TITLE,
  goalFormatOf,
  goalMetricOf,
  isWebsiteGoalKey,
  roundGoalValue,
} from "./goal-keys";

// Bu dosyanın kanıtladığı: üç hedef anahtarı doğru ambar metriğine ve
// biçime eşlenir, yuvarlama sayıda tam sayı, parada iki ondalıktır.

describe("goal keys", () => {
  it("recognises only the GA-F4 keys", () => {
    for (const key of WEBSITE_GOAL_KEYS) expect(isWebsiteGoalKey(key)).toBe(true);
    expect(isWebsiteGoalKey("web.pageviews")).toBe(false);
    expect(isWebsiteGoalKey(null)).toBe(false);
    expect(isWebsiteGoalKey(3)).toBe(false);
  });

  it("maps keys to metrics and formats", () => {
    expect(goalMetricOf("web.sessions")).toBe("sessions");
    expect(goalMetricOf("web.key_events")).toBe("keyEvents");
    expect(goalMetricOf("web.revenue")).toBe("revenue");
    expect(goalFormatOf("web.sessions")).toBe("count");
    expect(goalFormatOf("web.key_events")).toBe("count");
    expect(goalFormatOf("web.revenue")).toBe("money");
  });

  it("rounds counts to integers and money to cents", () => {
    expect(roundGoalValue("web.sessions", 1234.5)).toBe(1235);
    expect(roundGoalValue("web.key_events", 9.4)).toBe(9);
    expect(roundGoalValue("web.revenue", 12.3456)).toBe(12.35);
  });

  it("has a label and a title for every key", () => {
    expect(WEBSITE_GOAL_LABEL["web.sessions"]).toBe("Sessions");
    expect(WEBSITE_GOAL_LABEL["web.key_events"]).toBe("Key events");
    expect(WEBSITE_GOAL_LABEL["web.revenue"]).toBe("Revenue");
    expect(WEBSITE_GOAL_TITLE["web.sessions"]).toBe("Website sessions per month");
    expect(WEBSITE_GOAL_TITLE["web.key_events"]).toBe(
      "Website key events per month",
    );
    expect(WEBSITE_GOAL_TITLE["web.revenue"]).toBe("Website revenue per month");
    expect(WEBSITE_GOAL_DESCRIPTION).toBe(
      "Monthly target, measured every day from Google Analytics (property time).",
    );
  });
});
