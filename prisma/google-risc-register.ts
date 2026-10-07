// Google RISC (Cross-Account Protection) akış kaydı: Agentelse'in alıcı ucunu
// Google'a bildirir. Otomatik çalışmaz; SAHİP adımıdır (docs/website-agency.md
// "RISC"). Varsayılan KURU ÇALIŞMA: isteği yazdırır, ağa çıkmaz, token istemez.
//
//   npx tsx prisma/google-risc-register.ts                       (kuru çalışma: register)
//   npx tsx prisma/google-risc-register.ts --apply               (akışı kaydeder)
//   npx tsx prisma/google-risc-register.ts --action=status --apply
//   npx tsx prisma/google-risc-register.ts --action=verify --apply
//
// Seçenekler:
//   --action=register|status|verify   (varsayılan register)
//   --url=<alıcı ucu>                 (varsayılan https://<APP_URL>/api/webhooks/google-risc)
//   --access-token=<token>            ya da env GOOGLE_RISC_ACCESS_TOKEN
//   --quota-project=<id>              ya da env GOOGLE_RISC_QUOTA_PROJECT
//   --apply                           gerçekten gönderir (yoksa kuru çalışma)
//
// Kimlik doğrulama: Agentelse'in KENDİ Google Cloud projesinde
// roles/riscconfigs.admin yetkisi olan bir kimliğin KISA ÖMÜRLÜ OAuth bearer
// token'ı (`gcloud auth print-access-token`; isteğe bağlı
// --impersonate-service-account ile). Alternatif kapsam:
// https://www.googleapis.com/auth/risc.configuration.readwrite (doğrulanmalı).
// Bir gcloud kullanıcı token'ı genelde kota projesi ister: verilirse
// X-Goog-User-Project başlığı olarak gönderilir (doğrulanmalı). Uç noktalar
// (risc.googleapis.com/v1beta/stream, stream:update, stream:verify) Google'ın
// RISC belgesine göredir (doğrulanmalı). Token hiçbir yere SAKLANMAZ ve
// yazdırılmaz; anahtar dosyası okunmaz; JWT / servis hesabı kodu yoktur.
// Yalnız saf events modülü göreli yolla içe aktarılır (server-only yok).

import { RISC_EVENT_URIS } from "../src/lib/google-risc/events";

const BASE = "https://risc.googleapis.com/v1beta";
const PUSH_METHOD =
  "https://schemas.openid.net/secevent/risc/delivery-method/push";

type Action = "register" | "status" | "verify";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseAction(): Action {
  const value = flag("action") ?? "register";
  if (value === "register" || value === "status" || value === "verify") {
    return value;
  }
  throw new Error(`Unknown --action "${value}" (register | status | verify)`);
}

function receiverUrl(): string {
  const explicit = flag("url");
  if (explicit) return explicit;
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    throw new Error("Pass --url=<receiver url> (APP_URL is not set)");
  }
  return `${base}/api/webhooks/google-risc`;
}

type Request = { method: "GET" | "POST"; url: string; body: unknown };

function buildRequest(action: Action): Request {
  switch (action) {
    case "register":
      return {
        method: "POST",
        url: `${BASE}/stream:update`,
        body: {
          delivery: {
            delivery_method: PUSH_METHOD,
            url: receiverUrl(),
          },
          // verification akışa istek olarak yazılmaz; verify eylemiyle sınanır.
          events_requested: Object.entries(RISC_EVENT_URIS)
            .filter(([key]) => key !== "verification")
            .map(([, uri]) => uri),
        },
      };
    case "status":
      return { method: "GET", url: `${BASE}/stream`, body: null };
    case "verify":
      return {
        method: "POST",
        url: `${BASE}/stream:verify`,
        body: { state: "agentelse" },
      };
  }
}

async function main(): Promise<void> {
  const action = parseAction();
  const request = buildRequest(action);
  const apply = has("apply");

  if (!apply) {
    console.log("Dry run (no network call). Add --apply to send.");
    console.log(`${request.method} ${request.url}`);
    if (request.body !== null) console.log(JSON.stringify(request.body, null, 2));
    return;
  }

  const token = flag("access-token") ?? process.env.GOOGLE_RISC_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Missing token: pass --access-token or set GOOGLE_RISC_ACCESS_TOKEN (gcloud auth print-access-token)",
    );
  }
  const quotaProject =
    flag("quota-project") ?? process.env.GOOGLE_RISC_QUOTA_PROJECT;
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(request.body !== null ? { "Content-Type": "application/json" } : {}),
      ...(quotaProject ? { "X-Goog-User-Project": quotaProject } : {}),
    },
    ...(request.body !== null ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`${request.method} ${request.url} -> HTTP ${response.status}`);
  const text = await response.text();
  if (text) console.log(text);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
