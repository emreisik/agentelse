import type { CreativeContentFormat, SocialPlatform } from "@prisma/client";

// Real 2026 social ad-creative dimensions, per platform AND per content
// type — post/story/reel are NOT interchangeable (e.g. Instagram feed post
// is 1080x1440 but Story/Reel is 1080x1920). `pixelSize` is what both
// OpenAI's image API and OpenClaw's `--size WxH` flag take, and what
// creative-image.ts normalizes every generated image to via sharp
// afterward (best-effort on the provider's side, not a guarantee).
// `aspectRatio` is kept alongside it purely for display/metadata (e.g. the
// "N:M" label shown under a generated image, generationMetadata storage) —
// no generation call consumes it anymore.
export type { CreativeContentFormat };

export type SafeZone = {
  // Approximate px reserved by the platform's own UI chrome (profile
  // icon/username, caption, action buttons) on full-screen vertical
  // formats — varies by app version, treat as a design guideline for the
  // image prompt, not a hard guarantee.
  top?: number;
  bottom?: number;
};

export type CreativePlatformFormat = {
  label: string;
  contentFormat: CreativeContentFormat;
  contentFormatLabel: string;
  aspectRatio: string;
  pixelSize: { width: number; height: number };
  safeZone?: SafeZone;
};

type FormatEntry = Omit<CreativePlatformFormat, "label">;

const INSTAGRAM_LABEL = "Instagram";
const TIKTOK_LABEL = "TikTok";
const LINKEDIN_LABEL = "LinkedIn";
const X_LABEL = "X";
const FACEBOOK_LABEL = "Facebook";
const YOUTUBE_LABEL = "YouTube";
const PINTEREST_LABEL = "Pinterest";

const FORMAT_MATRIX: Record<
  SocialPlatform,
  Partial<Record<CreativeContentFormat, FormatEntry>>
> = {
  INSTAGRAM: {
    // Agency standard: Post = 3:4 (1080x1440, Instagram's native portrait
    // photo ratio), Story/Reel = 9:16 (1080x1920), square stays optional.
    FEED_PORTRAIT: {
      contentFormat: "FEED_PORTRAIT",
      contentFormatLabel: "Post (3:4)",
      aspectRatio: "3:4",
      pixelSize: { width: 1080, height: 1440 },
    },
    FEED_SQUARE: {
      contentFormat: "FEED_SQUARE",
      contentFormatLabel: "Post — square (1:1)",
      aspectRatio: "1:1",
      pixelSize: { width: 1080, height: 1080 },
    },
    FEED_LANDSCAPE: {
      contentFormat: "FEED_LANDSCAPE",
      contentFormatLabel: "Post — landscape (1.91:1)",
      aspectRatio: "1.91:1",
      pixelSize: { width: 1080, height: 566 },
    },
    STORY: {
      contentFormat: "STORY",
      contentFormatLabel: "Story (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 250, bottom: 340 },
    },
    REEL: {
      contentFormat: "REEL",
      contentFormatLabel: "Reel (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 250, bottom: 340 },
    },
  },
  TIKTOK: {
    // TikTok has effectively one format for both video covers and photo-mode
    // posts — always full-screen vertical.
    REEL: {
      contentFormat: "REEL",
      contentFormatLabel: "Video/Photo (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 150, bottom: 320 },
    },
  },
  LINKEDIN: {
    FEED_PORTRAIT: {
      contentFormat: "FEED_PORTRAIT",
      contentFormatLabel: "Post (4:5)",
      aspectRatio: "4:5",
      pixelSize: { width: 1080, height: 1350 },
    },
    FEED_SQUARE: {
      contentFormat: "FEED_SQUARE",
      contentFormatLabel: "Post — square (1:1)",
      aspectRatio: "1:1",
      pixelSize: { width: 1080, height: 1080 },
    },
    LINK_PREVIEW: {
      contentFormat: "LINK_PREVIEW",
      contentFormatLabel: "Link preview (1.91:1)",
      aspectRatio: "1.91:1",
      pixelSize: { width: 1200, height: 627 },
    },
    COVER: {
      contentFormat: "COVER",
      contentFormatLabel: "Cover banner (4:1)",
      aspectRatio: "4:1",
      pixelSize: { width: 1584, height: 396 },
    },
  },
  X: {
    FEED_LANDSCAPE: {
      contentFormat: "FEED_LANDSCAPE",
      contentFormatLabel: "Post (16:9)",
      aspectRatio: "16:9",
      pixelSize: { width: 1200, height: 675 },
    },
    FEED_SQUARE: {
      contentFormat: "FEED_SQUARE",
      contentFormatLabel: "Post — square (1:1)",
      aspectRatio: "1:1",
      pixelSize: { width: 1080, height: 1080 },
    },
    HEADER: {
      contentFormat: "HEADER",
      contentFormatLabel: "Header banner (3:1)",
      aspectRatio: "3:1",
      pixelSize: { width: 1500, height: 500 },
    },
  },
  FACEBOOK: {
    FEED_PORTRAIT: {
      contentFormat: "FEED_PORTRAIT",
      contentFormatLabel: "Post (4:5)",
      aspectRatio: "4:5",
      pixelSize: { width: 1080, height: 1350 },
    },
    FEED_SQUARE: {
      contentFormat: "FEED_SQUARE",
      contentFormatLabel: "Post — square (1:1)",
      aspectRatio: "1:1",
      pixelSize: { width: 1080, height: 1080 },
    },
    STORY: {
      contentFormat: "STORY",
      contentFormatLabel: "Story (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 250, bottom: 340 },
    },
    COVER: {
      contentFormat: "COVER",
      contentFormatLabel: "Cover banner (2.63:1)",
      aspectRatio: "2.63:1",
      pixelSize: { width: 820, height: 312 },
    },
  },
  YOUTUBE: {
    THUMBNAIL: {
      contentFormat: "THUMBNAIL",
      contentFormatLabel: "Thumbnail (16:9)",
      aspectRatio: "16:9",
      pixelSize: { width: 1280, height: 720 },
    },
    SHORTS: {
      contentFormat: "SHORTS",
      contentFormatLabel: "Shorts (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 150, bottom: 320 },
    },
    COVER: {
      contentFormat: "COVER",
      contentFormatLabel: "Channel art (16:9)",
      aspectRatio: "16:9",
      pixelSize: { width: 2560, height: 1440 },
    },
  },
  PINTEREST: {
    PIN: {
      contentFormat: "PIN",
      contentFormatLabel: "Standard Pin (2:3)",
      aspectRatio: "2:3",
      pixelSize: { width: 1000, height: 1500 },
    },
    STORY: {
      contentFormat: "STORY",
      contentFormatLabel: "Story Pin (9:16)",
      aspectRatio: "9:16",
      pixelSize: { width: 1080, height: 1920 },
      safeZone: { top: 250, bottom: 340 },
    },
  },
};

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  INSTAGRAM: INSTAGRAM_LABEL,
  TIKTOK: TIKTOK_LABEL,
  LINKEDIN: LINKEDIN_LABEL,
  X: X_LABEL,
  FACEBOOK: FACEBOOK_LABEL,
  YOUTUBE: YOUTUBE_LABEL,
  PINTEREST: PINTEREST_LABEL,
};

// The format used when a platform is known but no explicit content type was
// requested — kept close to each platform's previous single-format default
// so existing callers (see below) don't silently change behavior.
const DEFAULT_CONTENT_FORMAT: Record<SocialPlatform, CreativeContentFormat> = {
  INSTAGRAM: "FEED_PORTRAIT",
  TIKTOK: "REEL",
  LINKEDIN: "FEED_PORTRAIT",
  X: "FEED_LANDSCAPE",
  FACEBOOK: "FEED_PORTRAIT",
  YOUTUBE: "THUMBNAIL",
  PINTEREST: "PIN",
};

const DEFAULT_FORMAT: CreativePlatformFormat = {
  label: "General",
  contentFormat: "FEED_SQUARE",
  contentFormatLabel: "Square (1:1)",
  aspectRatio: "1:1",
  pixelSize: { width: 1024, height: 1024 },
};

// Backward-compatible: existing callers passing only `platform` keep
// getting that platform's default format (was previously the platform's
// only format). Passing `contentFormat` picks a specific slot in the
// matrix (falls back to the platform default if that combination isn't
// defined — e.g. a not-yet-modeled content type).
export function getCreativePlatformFormat(
  platform?: SocialPlatform | null,
  contentFormat?: CreativeContentFormat | null,
): CreativePlatformFormat {
  if (!platform) return DEFAULT_FORMAT;

  const wanted = contentFormat ?? DEFAULT_CONTENT_FORMAT[platform];
  const entry =
    FORMAT_MATRIX[platform]?.[wanted] ??
    FORMAT_MATRIX[platform]?.[DEFAULT_CONTENT_FORMAT[platform]];
  if (!entry) return DEFAULT_FORMAT;

  return { label: PLATFORM_LABEL[platform], ...entry };
}

// All content-type slots defined for a platform — powers the format
// selector in creative-image-studio.tsx. Always returns at least one
// entry (the platform's default) for every SocialPlatform value.
export function getAvailableContentFormats(
  platform: SocialPlatform,
): CreativePlatformFormat[] {
  const entries = FORMAT_MATRIX[platform] ?? {};
  const label = PLATFORM_LABEL[platform];
  return Object.values(entries).map((entry) => ({ label, ...entry }));
}
