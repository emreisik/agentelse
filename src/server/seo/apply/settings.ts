import "server-only";

import { prisma } from "@/lib/prisma";
import { seoIndexNowEnabled } from "@/lib/seo/apply/flags";
import { indexNowKeyUrl, isValidIndexNowKey } from "@/lib/seo/apply/indexnow";
import { clampDailyLimit } from "@/lib/seo/apply/validate";
import type { IndexNowView } from "@/lib/seo/apply/view-types";

import { recordSeoApplyAudit } from "./audit";

// SC-F8 proje ayarları (docs/website-apply.md "Ayarlar"): günlük uygulama
// sınırı ve IndexNow durumu SeoApplySetting satırında durur. Okuyucu hiçbir
// zaman yazmaz (satır yoksa varsayılanlar döner); yazıcı yalnız günlük sınırı
// kaydeder ve denetim satırına yalnız sınırı koyar.

type SettingRow = {
  dailyLimit: number;
  indexNowEnabled: boolean;
  indexNowKey: string | null;
  indexNowHost: string | null;
  indexNowVerifiedAt: Date | null;
  indexNowLastPingAt: Date | null;
};

// IndexNow görünümü: anahtar herkese açıktır (dosya adı ve içerik), gizli
// değildir. Anahtar dosyası adresi site kökünün host'undan kurulur.
export function indexNowViewOf(row: SettingRow | null): IndexNowView {
  if (!row) {
    return {
      enabled: false,
      key: null,
      keyFileName: null,
      keyUrl: null,
      verified: false,
      lastPingAt: null,
    };
  }
  const key = isValidIndexNowKey(row.indexNowKey) ? row.indexNowKey : null;
  const host = row.indexNowHost;
  return {
    enabled: row.indexNowEnabled,
    key,
    keyFileName: key ? `${key}.txt` : null,
    keyUrl: key && host ? indexNowKeyUrl(host, key) : null,
    verified: row.indexNowVerifiedAt !== null,
    lastPingAt: row.indexNowLastPingAt
      ? row.indexNowLastPingAt.toISOString()
      : null,
  };
}

export async function readApplySettings(
  projectId: string,
): Promise<{ dailyLimit: number; indexNow: IndexNowView | null }> {
  const row = await prisma.seoApplySetting.findUnique({
    where: { projectId },
    select: {
      dailyLimit: true,
      indexNowEnabled: true,
      indexNowKey: true,
      indexNowHost: true,
      indexNowVerifiedAt: true,
      indexNowLastPingAt: true,
    },
  });
  return {
    dailyLimit: clampDailyLimit(row?.dailyLimit),
    indexNow: seoIndexNowEnabled() ? indexNowViewOf(row) : null,
  };
}

export async function saveApplySettings(input: {
  projectId: string;
  workspaceId: string;
  userId: string;
  dailyLimit: number;
}): Promise<void> {
  const dailyLimit = clampDailyLimit(input.dailyLimit);
  await prisma.seoApplySetting.upsert({
    where: { projectId: input.projectId },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      dailyLimit,
    },
    update: { dailyLimit },
  });
  await recordSeoApplyAudit(
    "seo_apply.settings_saved",
    { dailyLimit },
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
    },
  );
}
