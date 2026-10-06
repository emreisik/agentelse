import { describe, expect, it } from "vitest";

import {
  isMetaSpendWrite,
  STALE_APPROVAL_MS,
  STALE_TASK_MS,
  staleWriteReason,
} from "@/lib/execution-backlog";

const NOW = new Date("2026-10-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3600_000;

describe("isMetaSpendWrite", () => {
  it("covers every Meta create/update capability", () => {
    for (const capability of [
      "META_CAMPAIGN_CREATE",
      "META_CAMPAIGN_UPDATE",
      "META_ADSET_CREATE",
      "META_ADSET_UPDATE",
      "META_AD_CREATE",
      "META_AD_UPDATE",
    ]) {
      expect(isMetaSpendWrite(capability)).toBe(true);
    }
  });

  it("leaves reads and other capabilities alone", () => {
    expect(isMetaSpendWrite("META_ADS_ANALYSIS")).toBe(false);
    expect(isMetaSpendWrite("INSTAGRAM_PUBLISH")).toBe(false);
  });
});

describe("staleWriteReason", () => {
  it("cancels a write approved more than 24 hours ago", () => {
    expect(
      staleWriteReason({
        capability: "META_ADSET_CREATE",
        taskCreatedAt: ago(30 * HOUR),
        approvedAt: ago(STALE_APPROVAL_MS + 1),
        now: NOW,
      }),
    ).toBe("approval older than 24 hours");
  });

  it("cancels a write whose task is older than 72 hours, even unapproved", () => {
    expect(
      staleWriteReason({
        capability: "META_AD_CREATE",
        taskCreatedAt: ago(STALE_TASK_MS + 1),
        approvedAt: null,
        now: NOW,
      }),
    ).toBe("task older than 72 hours");
  });

  it("lets a fresh approval of a recent task through", () => {
    expect(
      staleWriteReason({
        capability: "META_CAMPAIGN_CREATE",
        taskCreatedAt: ago(2 * HOUR),
        approvedAt: ago(HOUR),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("never gates a non-Meta capability", () => {
    expect(
      staleWriteReason({
        capability: "INSTAGRAM_PUBLISH",
        taskCreatedAt: ago(10 * 24 * HOUR),
        approvedAt: ago(9 * 24 * HOUR),
        now: NOW,
      }),
    ).toBeNull();
  });
});
