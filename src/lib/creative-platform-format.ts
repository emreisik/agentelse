import type { SocialPlatform } from "@prisma/client";

// Real 2026 social ad-creative dimensions per platform. `aspectRatio` is
// the exact string Gemini's image models accept in generationConfig.
// imageConfig; `pixelSize` is what OpenClaw's `--size WxH` flag needs
// (Gemini has no such flag — it infers pixels from aspectRatio itself).
export type CreativePlatformFormat = {
  label: string;
  aspectRatio: string;
  pixelSize: { width: number; height: number };
};

const FORMATS: Record<SocialPlatform, CreativePlatformFormat> = {
  INSTAGRAM: {
    label: "Instagram",
    aspectRatio: "4:5",
    pixelSize: { width: 1080, height: 1350 },
  },
  TIKTOK: {
    label: "TikTok",
    aspectRatio: "9:16",
    pixelSize: { width: 1080, height: 1920 },
  },
  LINKEDIN: {
    label: "LinkedIn",
    aspectRatio: "16:9",
    pixelSize: { width: 1280, height: 720 },
  },
  X: {
    label: "X",
    aspectRatio: "16:9",
    pixelSize: { width: 1200, height: 675 },
  },
  FACEBOOK: {
    label: "Facebook",
    aspectRatio: "4:5",
    pixelSize: { width: 1080, height: 1350 },
  },
  YOUTUBE: {
    label: "YouTube",
    aspectRatio: "16:9",
    pixelSize: { width: 1280, height: 720 },
  },
  PINTEREST: {
    label: "Pinterest",
    aspectRatio: "2:3",
    pixelSize: { width: 1000, height: 1500 },
  },
};

const DEFAULT_FORMAT: CreativePlatformFormat = {
  label: "Genel",
  aspectRatio: "1:1",
  pixelSize: { width: 1024, height: 1024 },
};

export function getCreativePlatformFormat(
  platform?: SocialPlatform | null,
): CreativePlatformFormat {
  if (!platform) return DEFAULT_FORMAT;
  return FORMATS[platform] ?? DEFAULT_FORMAT;
}
