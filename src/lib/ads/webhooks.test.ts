import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseWebhookBody,
  sameToken,
  verifyWebhookSignature,
  webhookLevel,
} from "./webhooks";

const SECRET = "app-secret";

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const sample = {
  object: "ad_account",
  entry: [
    {
      id: "123456",
      time: 1791300000,
      changes: [
        {
          field: "with_issues_ad_objects",
          value: {
            ad_object_id: "238400001",
            ad_object_type: "AD",
            error_code: 1815694,
            error_summary: "Ad Not Delivering",
          },
        },
        { field: "effective_status", value: { id: "238400002", level: "AD_SET" } },
      ],
    },
  ],
};

describe("verifyWebhookSignature", () => {
  const raw = Buffer.from(JSON.stringify(sample));

  it("accepts Meta's HMAC of the raw body and nothing else", () => {
    expect(verifyWebhookSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyWebhookSignature(raw, sign(raw, "other"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(`${raw} `), sign(raw), SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, "sha1=abc", SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw), "")).toBe(false);
  });

  it("compares the verify token exactly", () => {
    expect(sameToken("token-1", "token-1")).toBe(true);
    expect(sameToken("token-2", "token-1")).toBe(false);
    expect(sameToken(null, "token-1")).toBe(false);
    expect(sameToken("token-1", "")).toBe(false);
  });
});

describe("parseWebhookBody", () => {
  it("reads one event per change with the object and its level", () => {
    const events = parseWebhookBody(sample);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      adAccountExternalId: "act_123456",
      field: "with_issues_ad_objects",
      objectExternalId: "238400001",
      objectLevel: "AD",
    });
    expect(events[1]).toMatchObject({
      field: "effective_status",
      objectExternalId: "238400002",
      objectLevel: "ADSET",
    });
  });

  it("gives a resent event the same key and a different event another one", () => {
    const first = parseWebhookBody(sample);
    const again = parseWebhookBody(JSON.parse(JSON.stringify(sample)));
    expect(again.map((event) => event.dedupeKey)).toEqual(
      first.map((event) => event.dedupeKey),
    );
    expect(first[0]!.dedupeKey).not.toBe(first[1]!.dedupeKey);
    const later = parseWebhookBody({
      ...sample,
      entry: [{ ...sample.entry[0]!, time: 1791300060 }],
    });
    expect(later[0]!.dedupeKey).not.toBe(first[0]!.dedupeKey);
    // Anahtar sırası farklı aynı değer aynı olaydır.
    const reordered = parseWebhookBody({
      object: "ad_account",
      entry: [
        {
          id: "123456",
          time: 1791300000,
          changes: [
            {
              field: "with_issues_ad_objects",
              value: {
                error_summary: "Ad Not Delivering",
                error_code: 1815694,
                ad_object_type: "AD",
                ad_object_id: "238400001",
              },
            },
          ],
        },
      ],
    });
    expect(reordered[0]!.dedupeKey).toBe(first[0]!.dedupeKey);
  });

  it("ignores other objects, malformed entries and non-numeric ids", () => {
    expect(parseWebhookBody({ object: "page", entry: sample.entry })).toEqual([]);
    expect(parseWebhookBody(null)).toEqual([]);
    expect(
      parseWebhookBody({
        object: "ad_account",
        entry: [{ id: "act_x'; drop", changes: [{ field: "effective_status", value: {} }] }],
      }),
    ).toEqual([]);
    const noObject = parseWebhookBody({
      object: "ad_account",
      entry: [{ id: "act_99", time: 1, changes: [{ field: "ad_recommendations", value: { text: "hi" } }] }],
    });
    expect(noObject[0]).toMatchObject({
      adAccountExternalId: "act_99",
      objectExternalId: null,
      objectLevel: null,
    });
  });

  it("normalises level names", () => {
    expect(webhookLevel("ad_set")).toBe("ADSET");
    expect(webhookLevel("Campaign")).toBe("CAMPAIGN");
    expect(webhookLevel(undefined, { adset_id: "5" })).toBe("ADSET");
    expect(webhookLevel("creative")).toBeNull();
  });
});
