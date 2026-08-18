import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getEnv } from "@/lib/env";

// Gemini görsel üretimi. OpenClaw'un `infer image generate` yolundan farkı:
// çağrı doğrudan uygulamanın kendi GEMINI_API_KEY'i ile yapılır, yani
// faturası da Gemini hesabına gider — OpenClaw'daki OpenAI oturumuna değil.
//
// Görsel modelleri metin modellerinden farklı davranır: yanıt `inlineData`
// içinde base64 gelir, ayrı bir "images" ucu yoktur. Canlı doğrulandı
// (gemini-3.1-flash-image → image/jpeg, ~10 sn).

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Paylaşılan yerel varlık klasörü — OpenClaw görsel istemcisiyle aynı yer,
// böylece iki üretici de aynı `local-asset://` şemasıyla servis edilir.
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

export type GeneratedCreativeImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  // Hangi backend'in ürettiği — creative-image.ts'nin Gemini→OpenClaw sessiz
  // yedek geçişini sonradan (generationMetadata üzerinden) izlenebilir kılmak
  // için. Model adı yanlış/geçersizse Gemini çağrısı 404/400 ile düşer ve bu
  // olmadan hangi backend'in devrede olduğu yalnızca sunucu loglarından
  // anlaşılabilirdi.
  provider: "gemini";
};

type GeminiImageResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isGeminiImageConfigured(): boolean {
  return Boolean(getEnv().GEMINI_API_KEY);
}

export function geminiImageModel(): string {
  return getEnv().GEMINI_IMAGE_MODEL;
}

// Başarısızlıkta null döner — çağıranlar (kreatif üretimi, logo) görsel
// olmadan da işlerini tamamlayabilmeli.
// baseImage verildiğinde model sıfırdan üretmez, verilen görseli talimata
// göre DÜZENLER (Gemini görsel modelleri aynı generateContent ucundan hem
// üretim hem düzenleme yapar; fark, girdiye inlineData eklenmesi).
// referenceImage, baseImage'dan farklı bir senaryo için: sıfırdan üretim
// sırasında modele markanın gerçek logosunu "işte bu, buna sadık kal" diye
// görsel referans olarak vermek. İkisi aynı anda kullanılmaz — baseImage
// varsa (düzenleme modu) referenceImage yok sayılır.
export async function generateGeminiImage(
  prompt: string,
  baseImage?: { data: string; mimeType: string },
  // Gemini-supported ratio string, e.g. "4:5", "9:16" — best-effort: if the
  // exact request field ever changes shape, an unrecognized field is
  // expected to be ignored rather than break generation. Confirm the field
  // name against a live call before relying on it.
  aspectRatio?: string,
  referenceImage?: { data: string; mimeType: string },
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return null;

  const model = env.GEMINI_IMAGE_MODEL;

  try {
    const response = await fetch(`${BASE_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: baseImage
              ? [
                  {
                    inlineData: {
                      mimeType: baseImage.mimeType,
                      data: baseImage.data,
                    },
                  },
                  { text: prompt },
                ]
              : referenceImage
                ? [
                    {
                      inlineData: {
                        mimeType: referenceImage.mimeType,
                        data: referenceImage.data,
                      },
                    },
                    { text: prompt },
                  ]
                : [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
        },
      }),
    });

    const payload = (await response.json()) as GeminiImageResponse;
    if (!response.ok) {
      console.error(
        "[gemini-image] üretim başarısız:",
        response.status,
        payload.error?.message,
      );
      return null;
    }

    const candidate = payload.candidates?.[0];
    const inline = (candidate?.content?.parts ?? []).find(
      (part) => part.inlineData?.data,
    )?.inlineData;
    if (!inline?.data) {
      console.error(
        "[gemini-image] yanıtta görsel yok, finishReason:",
        candidate?.finishReason,
      );
      return null;
    }

    const mimeType = inline.mimeType ?? "image/png";
    const filename = `${randomUUID()}.${EXTENSION_BY_MIME[mimeType] ?? "png"}`;
    const buffer = Buffer.from(inline.data, "base64");

    await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_ASSETS_DIR, filename), buffer);

    return {
      storageKey: `local-asset://${filename}`,
      filename,
      mimeType,
      size: buffer.byteLength,
      provider: "gemini",
    };
  } catch (error) {
    console.error("[gemini-image] üretim başarısız", error);
    return null;
  }
}
