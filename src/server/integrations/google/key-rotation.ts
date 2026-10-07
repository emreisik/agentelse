import "server-only";

import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { prisma } from "@/lib/prisma";
import { claimPeriodic } from "@/server/observability/periodic";

import {
  decryptGoogleSecret,
  encryptGoogleSecret,
  googleKeyRingConfigured,
  googleSecretPrefixFor,
  parseGoogleKeyRing,
  GOOGLE_SECRET_PREFIX,
} from "./secret";

// Google yenileme token'larının anahtar döndürmesi (docs/website-agency.md).
// Tick adımı kayıtları tembel olarak güncel anahtarla yeniden şifreler: her
// ayrı şifreli metin için bir kez çözülür, bir kez şifrelenir ve o şifreli
// metni taşıyan bütün satırlar tek updateMany ile yazılır (aynı şifreli metin
// "Use existing connection" kopyalarında eşit kalır). Boş şifreli metinli
// (kesilmiş) satırlara dokunulmaz. Bir anahtar GOOGLE_TOKEN_KEYS'ten yalnız
// status() onda 0 satır gösterince çıkarılmalıdır.

const PROVIDERS = ["google_analytics", "google_search_console"];
const EVERY_MS = 10 * 60_000;
const DEFAULT_LIMIT = 25;
// Bir turda taranacak en çok sayfa (çözülemeyen gruplar sayfaları doldursa bile).
const MAX_SCAN_PAGES = 20;

export type GoogleKeyStatus = {
  currentKeyId: string | null;
  legacyRows: number;
  currentRows: number;
  otherRows: number;
  totalRows: number;
};

export type GoogleKeyRotationResult = {
  groups: number;
  rows: number;
  failed: number;
};

function currentKeyId(): string | null {
  try {
    return parseGoogleKeyRing(process.env.GOOGLE_TOKEN_KEYS)?.current ?? null;
  } catch {
    return null;
  }
}

export const GoogleKeyRotation = {
  // Tick adımı: halka yoksa, yerel süreç canlı DB'yi paylaşıyorsa ya da
  // periyot dolmadıysa sorgusuz 0. Dönen sayı yeniden şifrelenen satırlardır.
  async runDue(
    limit: number = DEFAULT_LIMIT,
    now: Date = new Date(),
  ): Promise<number> {
    if (!googleKeyRingConfigured()) return 0;
    if (!gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("google.key-rotation", EVERY_MS, now))) return 0;
    const result = await GoogleKeyRotation.rotateOnce(limit);
    if (result.failed > 0) {
      console.error(
        `[google-key-rotation] ${result.failed} ciphertext group(s) could not be re-encrypted`,
      );
    }
    return result.rows;
  },

  async rotateOnce(limit: number): Promise<GoogleKeyRotationResult> {
    const current = currentKeyId();
    const result: GoogleKeyRotationResult = { groups: 0, rows: 0, failed: 0 };
    if (!current || limit <= 0) return result;
    // Çözülemeyen gruplar sıradaki turlarda yeniden seçilip sağlıklı satırların
    // önünü tıkamasın diye şifreli metne göre sıralı, anahtar kümeli sayfalama
    // yapılır; başarısızlar atlanıp sonraki sayfaya geçilir.
    let after = "";
    for (let page = 0; page < MAX_SCAN_PAGES && result.groups < limit; page += 1) {
      const stale = await prisma.integrationCredential.findMany({
        where: {
          provider: { in: PROVIDERS },
          AND: [
            { encryptedSecret: { not: "" } },
            { NOT: { encryptedSecret: { startsWith: googleSecretPrefixFor(current) } } },
            ...(after ? [{ encryptedSecret: { gt: after } }] : []),
          ],
        },
        select: { encryptedSecret: true },
        distinct: ["encryptedSecret"],
        orderBy: { encryptedSecret: "asc" },
        take: limit,
      });
      for (const { encryptedSecret } of stale) {
        after = encryptedSecret;
        if (result.groups >= limit) break;
        let next: string;
        try {
          next = encryptGoogleSecret(decryptGoogleSecret(encryptedSecret));
        } catch {
          result.failed += 1;
          continue;
        }
        result.groups += 1;
        // Eşzamanlı bir yeniden bağlanma şifreli metni değiştirdiyse eşleşmez.
        const updated = await prisma.integrationCredential.updateMany({
          where: { provider: { in: PROVIDERS }, encryptedSecret },
          data: { encryptedSecret: next },
        });
        result.rows += updated.count;
      }
      if (stale.length < limit) break;
    }
    return result;
  },

  async status(): Promise<GoogleKeyStatus | null> {
    const current = currentKeyId();
    if (!current) return null;
    const base = {
      provider: { in: PROVIDERS },
      encryptedSecret: { not: "" },
    };
    const [total, currentRows, prefixed] = await Promise.all([
      prisma.integrationCredential.count({ where: base }),
      prisma.integrationCredential.count({
        where: {
          ...base,
          encryptedSecret: { startsWith: googleSecretPrefixFor(current) },
        },
      }),
      prisma.integrationCredential.count({
        where: { ...base, encryptedSecret: { startsWith: GOOGLE_SECRET_PREFIX } },
      }),
    ]);
    return {
      currentKeyId: current,
      legacyRows: total - prefixed,
      currentRows,
      otherRows: prefixed - currentRows,
      totalRows: total,
    };
  },
};
