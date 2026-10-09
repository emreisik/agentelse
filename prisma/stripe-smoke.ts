// Stripe TEST modu duman testi: ödeme kodunun Stripe'a gönderdiği istekleri ve okuduğu
// nesne şekillerini GERÇEK Stripe test API'sine karşı sınar (src/server/billing/stripe/
// smoke.ts, docs/billing-payments.md "Gerçek Stripe testi").
//
//   npm run billing:stripe-smoke
//   npm run billing:stripe-smoke -- --dispute     itiraz test kartını da dener (~30 sn)
//
// STRIPE_SECRET_KEY .env dosyalarından okunur ve bir TEST anahtarı (sk_test_...) olmalıdır:
// canlı anahtar REDDEDİLİR. Veritabanına dokunmaz; yarattığı abonelik ve müşteriyi siler.

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const file of [".env.development.local", ".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

import { createStripeHttp } from "../src/server/billing/stripe/client";
import { stripeModeOfKey } from "../src/server/billing/stripe/key-mode";
import { runStripeSmoke } from "../src/server/billing/stripe/smoke";

async function main() {
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Put your Stripe TEST secret key (sk_test_...) in .env and run this again.",
    );
    process.exit(1);
  }
  const mode = stripeModeOfKey(secretKey);
  if (mode !== "test") {
    console.error(
      mode === "live"
        ? "This is a LIVE key. The smoke test only runs with a TEST key (sk_test_...); nothing was sent."
        : "STRIPE_SECRET_KEY does not look like a Stripe secret key (sk_test_...); nothing was sent.",
    );
    process.exit(1);
  }

  console.log(
    "Stripe smoke test (TEST mode). Real calls to the Stripe test API; no database is touched.\n",
  );
  const report = await runStripeSmoke({
    http: createStripeHttp({ secretKey }),
    runId: randomUUID().slice(0, 8),
    disputeWaitMs: process.argv.includes("--dispute") ? 30_000 : 0,
    log: (line) => console.log(line),
  });

  const count = (status: string) =>
    report.steps.filter((step) => step.status === status).length;
  console.log(
    `\n${count("PASS")} passed, ${count("WARN")} warning(s), ${count("FAIL")} failed.`,
  );
  if (!report.ok) {
    console.log(
      "Send this whole output to the developer: the FAIL lines say which request or field is wrong.",
    );
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
