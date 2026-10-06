import { describe, expect, it } from "vitest";

import {
  accountFromUrl,
  appSecretProof,
  familyFromUrl,
  withAppSecretProof,
} from "./graph";

describe("graph core helpers (docs/meta-ads-plan.md F1)", () => {
  it("finds the ad account in a Marketing API path", () => {
    expect(accountFromUrl("https://graph.facebook.com/v26.0/act_123/campaigns?x=1")).toBe(
      "act_123",
    );
    expect(accountFromUrl("https://graph.facebook.com/v26.0/act_9")).toBe("act_9");
    expect(accountFromUrl("https://graph.facebook.com/v26.0/me/accounts")).toBeUndefined();
  });

  it("tells insights calls apart", () => {
    expect(familyFromUrl("https://graph.facebook.com/v26.0/act_1/insights?level=ad")).toBe(
      "ads_insights",
    );
    expect(familyFromUrl("https://graph.facebook.com/v26.0/act_1/adsets")).toBe(
      "ads_management",
    );
    expect(familyFromUrl("https://graph.facebook.com/v26.0/me")).toBe("graph");
  });

  it("adds appsecret_proof next to the token, in the query or the form body", () => {
    const proof = appSecretProof("tok", "secret");
    expect(proof).toMatch(/^[0-9a-f]{64}$/);

    const query = withAppSecretProof(
      "https://graph.facebook.com/v26.0/me?fields=id,name&access_token=tok",
      undefined,
      "secret",
    );
    // The original query keeps its encoding.
    expect(query.url).toBe(
      `https://graph.facebook.com/v26.0/me?fields=id,name&access_token=tok&appsecret_proof=${proof}`,
    );

    const body = withAppSecretProof(
      "https://graph.facebook.com/v26.0/act_1/campaigns",
      { method: "POST", body: "name=x&access_token=tok" },
      "secret",
    );
    expect(new URLSearchParams(String(body.init?.body)).get("appsecret_proof")).toBe(
      proof,
    );
  });

  it("leaves the request alone without an app secret", () => {
    const url = "https://graph.facebook.com/v26.0/me?access_token=tok";
    expect(withAppSecretProof(url, undefined, undefined).url).toBe(url);
  });
});
