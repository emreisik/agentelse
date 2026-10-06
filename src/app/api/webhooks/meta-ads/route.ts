import { NextResponse } from "next/server";

import { AdsFlags } from "@/lib/ads/flags";
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseWebhookBody,
  sameToken,
  verifyWebhookSignature,
} from "@/lib/ads/webhooks";
import { getEnv } from "@/lib/env";
import { AdsWebhookInbox } from "@/server/ads/webhooks";

// Meta Ads webhook ucu (docs/meta-ads-plan.md F7). Oturum yok: GET yalnız
// doğrulama jetonu tutarsa hub.challenge döner; POST yalnız X-Hub-Signature-256
// uygulama sırrıyla doğrulanırsa kabul edilir. Olaylar kutuya yazılır ve hemen
// 200 dönülür; işleme ajans tick'indedir (yoklama yedek kalır).

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = params.get("hub.challenge");
  const expected = getEnv().META_ADS_WEBHOOK_VERIFY_TOKEN;
  if (
    params.get("hub.mode") === "subscribe" &&
    challenge &&
    sameToken(params.get("hub.verify_token"), expected)
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
}

// Oturumsuz uçta en çok MAX_WEBHOOK_BODY_BYTES okunur.
async function readLimitedBody(request: Request): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES)
    return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request) {
  const raw = await readLimitedBody(request);
  if (raw === null) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (
    !verifyWebhookSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      getEnv().META_APP_SECRET,
    )
  ) {
    console.warn("[meta-ads-webhook] rejected: missing or invalid signature");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  // Bayrak kapalıyken de 200: Meta başarısız teslimatlarda aboneliği düşürür.
  if (!AdsFlags.webhooks()) return NextResponse.json({ ok: true });
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    await AdsWebhookInbox.store(parseWebhookBody(body));
  } catch (error) {
    // 5xx: Meta yeniden gönderir; dedupeKey çift kaydı önler.
    console.error("[meta-ads-webhook] store failed:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
