import "server-only";

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  instagramStyleDef,
  type InstagramStyleSuggestion,
} from "@/server/reasoning/prompts/instagram-style";

const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_MIME_TYPE = "image/jpeg";

export type ImageAttachment = { mimeType: string; data: string };

// The media URLs Instagram's API returns for the account's own posts are
// signed CDN links that need no further auth — a plain fetch + base64 is
// enough, no asset-storage round trip. Best-effort: a failed download drops
// that one image rather than failing the whole import.
export async function downloadImageAsAttachment(
  imageUrl: string,
): Promise<ImageAttachment | null> {
  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type") || DEFAULT_MIME_TYPE;
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mimeType, data: buffer.toString("base64") };
  } catch {
    return null;
  }
}

export async function analyzeInstagramStyle(
  images: ImageAttachment[],
  captions: (string | null)[],
  scope: { workspaceId: string; projectId: string; brandId: string },
): Promise<InstagramStyleSuggestion> {
  const result = await ReasoningService.run(instagramStyleDef, {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    brandId: scope.brandId,
    attachments: images,
    context: { captions },
  });
  return result.output;
}
