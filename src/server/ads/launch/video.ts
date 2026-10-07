import "server-only";

import type { AdsLaunchSpec } from "@/lib/ads/launch-spec";
import { videoSlots } from "@/lib/ads/launch-images";
import { prisma } from "@/lib/prisma";
import {
  checkMetaVideoStatus,
  uploadMetaAdVideo,
} from "@/server/integrations/meta-client";
import {
  readAsset,
  resolveDirectPublicUrl,
} from "@/server/storage/asset-storage";

import type { LaunchProgress } from "./store";

// Video reklam (META_ADS_VIDEO, docs/meta-ads-plan.md F5b): Library videosu
// Meta'ya bir kez yüklenir (advideos), Meta onu arka planda işler (dakikalar
// sürebilir) ve işlenmeden kreatife konamaz. Review (validate.ts) ve yürütücü
// (executor.ts) aynı yardımcıyı kullanır: bir çağrıda en çok bir yükleme ve
// slot başına tek durum sorgusu; bekleme çağrılar arasında (kart yoklaması ve
// işçi turu) yapılır, hiçbir yerde uyunmaz. Eski sihirbazın yolu aynı Meta
// çağrılarını kullanır.

export type VideoStep =
  | { state: "ready" }
  | { state: "processing" }
  | { state: "failed"; message: string };

type Input = {
  spec: AdsLaunchSpec;
  progress: LaunchProgress;
  projectId: string;
  adAccountId: string;
  accessToken: string;
};

export async function ensureVideos(input: Input): Promise<VideoStep> {
  const slots = videoSlots(input.spec.ads);
  if (slots.length === 0) return { state: "ready" };
  input.progress.videos = input.progress.videos ?? {};
  input.progress.videoReady = input.progress.videoReady ?? {};
  let processing = false;
  for (const slot of slots) {
    if (input.progress.videoReady[slot.key]) continue;
    if (!input.progress.videos[slot.key]) {
      const asset = await prisma.asset.findFirst({
        where: {
          id: slot.assetId,
          projectId: input.projectId,
          mimeType: { startsWith: "video/" },
        },
        select: { storageKey: true, mimeType: true },
      });
      if (!asset) {
        return {
          state: "failed",
          message: "The video is gone from your Library. Pick another one.",
        };
      }
      const uploaded = await uploadMetaAdVideo({
        adAccountId: input.adAccountId,
        accessToken: input.accessToken,
        videoBuffer: await readAsset(asset.storageKey),
        mimeType: asset.mimeType,
      });
      input.progress.videos[slot.key] = uploaded.videoId;
    }
    try {
      const ready = await checkMetaVideoStatus({
        videoId: input.progress.videos[slot.key]!,
        accessToken: input.accessToken,
      });
      if (ready) input.progress.videoReady[slot.key] = true;
      else processing = true;
    } catch (error) {
      // Meta işleme hatası bildirdi: yüklenen video bu reklamda kullanılamaz.
      delete input.progress.videos[slot.key];
      return {
        state: "failed",
        message:
          error instanceof Error
            ? `Meta couldn't process the video: ${error.message}`
            : "Meta couldn't process the video.",
      };
    }
  }
  return processing ? { state: "processing" } : { state: "ready" };
}

// Kapak görselinin herkese açık adresi (video_data.image_url bir adres ister,
// hash kabul etmez: eski sihirbazın bulgusu). Bulut depolama kapalıysa null.
export async function coverUrl(
  projectId: string,
  assetId: string,
): Promise<string | null> {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId },
    select: { storageKey: true },
  });
  return asset ? resolveDirectPublicUrl(asset.storageKey) : null;
}
