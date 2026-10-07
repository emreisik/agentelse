import { NextResponse } from "next/server";

import {
  gaAgencyMockMode,
  googleRiscEnabled,
} from "@/lib/website-analytics/agency/flags";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { processRiscToken } from "@/server/integrations/google/risc/handler";

// Google RISC (Cross-Account Protection) alıcı ucu (docs/website-agency.md).
// Oturum yok: Google ham JWT'yi gövde olarak gönderir (Content-Type:
// application/secevent+jwt), JSON DEĞİL; bu yüzden request.text() okunur ve
// request.json() hiç çağrılmaz. İmza, iss, aud ve jti denetimi handler'dadır.
// 202: uygulandı / yinelenen / yok sayıldı; 400: geçersiz jeton; 413: büyük
// gövde; 500: yalnız depo (ya da uygulama) hatası, Google yeniden dener.
// Loglara jeton metni ya da kimlik yazılmaz.

const MAX_BODY_BYTES = 64 * 1024;

// Oturumsuz uçta en çok MAX_BODY_BYTES okunur.
async function readLimitedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

export async function POST(request: Request): Promise<Response> {
  if (!googleRiscEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Mock kip ve canlı veritabanını paylaşan yerel süreç: hiçbir şey yapılmaz.
  if (gaAgencyMockMode() || !gaGlobalWorkAllowedHere()) return accepted();

  const token = await readLimitedText(request);
  if (token === null) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  try {
    const outcome = await processRiscToken(token);
    if (outcome.status === "invalid") {
      console.warn(`[google-risc] rejected: ${outcome.reason ?? "invalid"}`);
      return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }
    console.info(
      `[google-risc] ${outcome.status}: ${outcome.events} event(s), ${outcome.matched} matched`,
    );
    return accepted();
  } catch (error) {
    console.error(
      "[google-risc] processing failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
