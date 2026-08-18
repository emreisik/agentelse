import "server-only";

import {
  generateGeminiImage,
  isGeminiImageConfigured,
  type GeneratedCreativeImage as GeneratedByGemini,
} from "@/server/reasoning/gemini-image-client";
import {
  generateCreativeImageAsset as generateViaOpenClaw,
  isOpenClawImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenClaw,
} from "@/server/execution/providers/openclaw/openclaw-image-client";

export type GeneratedCreativeImage = GeneratedByGemini | GeneratedByOpenClaw;

// Görsel üretiminin tek giriş noktası. Tercih sırası bilinçli:
//
//   1. Gemini — uygulamanın kendi GEMINI_API_KEY'i, faturası Gemini
//      hesabına gider.
//   2. OpenClaw — `infer image generate`, faturası OpenClaw'da yapılandırılmış
//      OpenAI oturumuna gider (openai/gpt-image-2).
//
// Gemini yapılandırılmışsa OpenClaw'a hiç düşülmez; yalnızca anahtar yoksa
// ya da Gemini çağrısı başarısız olursa yedek yol devreye girer.
export function isCreativeImageConfigured(): boolean {
  return isGeminiImageConfigured() || isOpenClawImageConfigured();
}

export type GenerateCreativeImageOptions = {
  // Verildiğinde görsel sıfırdan üretilmez, mevcut görsel talimata göre
  // düzenlenir. OpenClaw yedeği düzenlemeyi desteklemediği için o yola
  // düşüldüğünde talimat yeni bir üretim istemi olarak kullanılır.
  baseImage?: { data: string; mimeType: string };
  // Sıfırdan üretimde modele markanın gerçek logosunu görsel referans
  // olarak vermek için (bkz. gemini-image-client.ts). Yalnızca Gemini
  // path'inde kullanılır — bkz. aşağıdaki not.
  referenceImage?: { data: string; mimeType: string };
  // Gemini'ye giden en-boy oranı ("4:5" gibi) ve OpenClaw'a giden piksel
  // boyutu — src/lib/creative-platform-format.ts'ten gelir.
  aspectRatio?: string;
  imageSize?: { width: number; height: number };
};

export async function generateCreativeImage(
  prompt: string,
  options?: GenerateCreativeImageOptions,
): Promise<GeneratedCreativeImage | null> {
  const { baseImage, referenceImage, aspectRatio, imageSize } = options ?? {};

  if (isGeminiImageConfigured()) {
    const image = await generateGeminiImage(
      prompt,
      baseImage,
      aspectRatio,
      referenceImage,
    );
    if (image) return image;
    // Gemini başarısız oldu (kota, güvenlik reddi, ağ). Yedek varsa dene —
    // kreatif akışı tek sağlayıcının kötü gününe takılmamalı.
  }

  // OpenClaw yedeği referans görsel kabul etmiyor (CLI'da böyle bir
  // parametre yok) — bu yüzden logo/marka referansı sadece Gemini path'inde
  // kullanılabiliyor, burada sessizce yok sayılır.
  if (isOpenClawImageConfigured())
    return generateViaOpenClaw(prompt, imageSize);
  return null;
}
