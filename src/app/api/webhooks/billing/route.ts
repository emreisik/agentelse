import { NextResponse } from "next/server";

import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/ads/webhooks";
import { readLimitedBody } from "@/lib/http/read-limited-body";
import { processStripeEvent } from "@/server/billing/payments/events";
import { createStripeGateway } from "@/server/billing/stripe/gateway";
import { createStripeHttp } from "@/server/billing/stripe/client";
import { getStripeConfig } from "@/server/billing/stripe/config";
import {
  parseEventEnvelope,
  StripeShapeError,
} from "@/server/billing/stripe/facts";
import { verifyStripeSignature } from "@/server/billing/stripe/signature";

// Stripe webhook ucu (docs/billing-payments.md). Oturum yok: istek yalnız Stripe-Signature
// webhook sırrıyla doğrulanırsa kabul edilir (aksi hâlde 401). Olay işleyiciye verilir ve
// SONUÇ beklenir: başarılıysa 200, işlenemediyse 500 (Stripe 3 güne dek yeniden dener;
// işleyiciler tekrara dayanıklıdır). Ödeme kapalıyken (anahtar yok) 503: Stripe uç
// noktayı sağlıksız görür ve olayları tutup yeniden dener, hiçbiri kaybolmaz.

export async function POST(request: Request) {
  const config = getStripeConfig();
  if (!config) {
    return NextResponse.json(
      { error: "payments_not_configured" },
      { status: 503 },
    );
  }

  // İmza başlığı yoksa gövde hiç okunmaz: kimliksiz istekler 512 KB tamponlatamaz.
  const signatureHeader = request.headers.get("stripe-signature");
  if (!signatureHeader) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const raw = await readLimitedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (raw === null) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const check = verifyStripeSignature({
    rawBody: raw,
    header: signatureHeader,
    secrets: config.webhookSecrets,
  });
  if (!check.ok) {
    console.warn(`[billing-webhook] rejected: ${check.reason}`);
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let envelope;
  try {
    envelope = parseEventEnvelope(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    if (error instanceof StripeShapeError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    }
    throw error;
  }

  try {
    const gateway = createStripeGateway(
      createStripeHttp({ secretKey: config.secretKey }),
    );
    const outcome = await processStripeEvent(envelope, {
      gateway,
      mode: config.mode,
    });
    return NextResponse.json({ received: true, result: outcome.result });
  } catch (error) {
    // 5xx: Stripe yeniden gönderir; olay kimliği gelen kutusunda tekildir.
    console.error(
      `[billing-webhook] ${envelope.type} ${envelope.id} failed:`,
      error instanceof Error ? error.name : error,
    );
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
