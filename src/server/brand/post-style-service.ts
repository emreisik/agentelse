import "server-only";

import sharp from "sharp";

import { prisma } from "@/lib/prisma";
import {
  MAX_EXAMPLES,
  MAX_LABEL_CHARS,
  type PostStyleExample,
  type PostStyleExampleSource,
} from "@/lib/post-style";
import { imageUrlFromHtml, isSocialLink } from "@/lib/post-style-links";
import {
  analyzePostStyleImage,
  type PostStyleScope,
} from "@/server/brand/post-style-analyzer";
import {
  countExamples,
  getExample,
  saveExample,
} from "@/server/brand/post-style-store";
import { safeFetch } from "@/server/security/safe-fetch";
import { putAsset, readAsset } from "@/server/storage/asset-storage";

// The Post Style Kit's write path, shared by the Brand Brain actions and the
// chat tool: an example post becomes an Asset (the picture) plus a BrandFact
// (its label, its design recipe, whether it is switched on).

export const MAX_EXAMPLE_UPLOAD_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// Smaller than this is a thumbnail: nothing to rebuild a design from.
const MIN_SIDE = 240;
// Examples are sent to the model on every render: no need for more.
const MAX_SIDE = 1600;
const LINK_PAGE_MAX_BYTES = 1_500_000;
const LINK_IMAGE_MAX_BYTES = MAX_EXAMPLE_UPLOAD_BYTES;

export type AddExampleResult =
  | { ok: true; assetId: string; analyzed: boolean }
  | { ok: false; reason: string };

type Normalized = {
  buffer: Buffer;
  mimeType: string;
  ext: string;
  width: number;
  height: number;
};

// Decodes the picture (anything that is not one is refused), turns it upright,
// fits it inside MAX_SIDE and re-encodes it, so no embedded metadata is kept.
export async function normalizeExampleImage(
  bytes: Buffer,
): Promise<{ ok: true; image: Normalized } | { ok: false; reason: string }> {
  try {
    const source = sharp(bytes, { failOn: "none" });
    const meta = await source.metadata();
    if (!meta.width || !meta.height || !meta.format) {
      return { ok: false, reason: "That file isn't a picture." };
    }
    if (!ACCEPTED_TYPES.has(`image/${meta.format}`)) {
      return { ok: false, reason: "Use a PNG, JPG or WebP picture." };
    }
    if (Math.min(meta.width, meta.height) < MIN_SIDE) {
      return {
        ok: false,
        reason: `The picture is too small (at least ${MIN_SIDE}px on its short side).`,
      };
    }
    const resized = source
      .rotate()
      .resize({
        width: MAX_SIDE,
        height: MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const transparent = meta.hasAlpha === true;
    const { data, info } = await (
      transparent ? resized.png() : resized.jpeg({ quality: 90 })
    ).toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      image: {
        buffer: data,
        mimeType: transparent ? "image/png" : "image/jpeg",
        ext: transparent ? "png" : "jpg",
        width: info.width,
        height: info.height,
      },
    };
  } catch {
    return { ok: false, reason: "That file isn't a picture." };
  }
}

// The row the generation reads brand style from. A brand with none gets the
// column defaults, which reproduce the template it always had.
export async function ensureVisualIdentityRow(
  scope: PostStyleScope,
): Promise<void> {
  await prisma.brandVisualIdentity.upsert({
    where: { brandId: scope.brandId },
    create: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
    },
    update: {},
  });
}

function cleanLabel(label: string | undefined): string {
  return (label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

async function keepExample(input: {
  scope: PostStyleScope;
  assetId: string;
  base64: string;
  mimeType: string;
  label?: string;
  source: PostStyleExampleSource;
  url?: string;
}): Promise<boolean> {
  const label = cleanLabel(input.label);
  await ensureVisualIdentityRow(input.scope);
  const analysis = await analyzePostStyleImage({
    scope: input.scope,
    image: { mimeType: input.mimeType, data: input.base64 },
    label,
  });
  const example: PostStyleExample = {
    assetId: input.assetId,
    label,
    source: input.source,
    ...(input.url ? { url: input.url.slice(0, 500) } : {}),
    enabled: true,
    analysis,
    addedAt: new Date().toISOString(),
  };
  await saveExample(input.scope, example);
  return analysis !== null;
}

const FULL = `You can keep up to ${MAX_EXAMPLES} examples. Remove one first.`;

// A picture's bytes become a new example.
export async function addExampleFromBytes(input: {
  scope: PostStyleScope;
  bytes: Buffer;
  label?: string;
  source: PostStyleExampleSource;
  url?: string;
}): Promise<AddExampleResult> {
  if ((await countExamples(input.scope.brandId)) >= MAX_EXAMPLES) {
    return { ok: false, reason: FULL };
  }
  const normalized = await normalizeExampleImage(input.bytes);
  if (!normalized.ok) return normalized;
  const { image } = normalized;

  const { storageKey, filename } = await putAsset(
    image.buffer,
    image.ext,
    image.mimeType,
  );
  const asset = await prisma.asset.create({
    data: {
      workspaceId: input.scope.workspaceId,
      projectId: input.scope.projectId,
      brandId: input.scope.brandId,
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      filename,
      mimeType: image.mimeType,
      storageKey,
      size: image.buffer.byteLength,
      width: image.width,
      height: image.height,
    },
  });
  const analyzed = await keepExample({
    scope: input.scope,
    assetId: asset.id,
    base64: image.buffer.toString("base64"),
    mimeType: image.mimeType,
    label: input.label,
    source: input.source,
    url: input.url,
  });
  return { ok: true, assetId: asset.id, analyzed };
}

// A picture that is already an Asset of the project (an attachment of the chat,
// a finished creative) becomes an example without a second copy of the file.
export async function addExampleFromAsset(input: {
  scope: PostStyleScope;
  assetId: string;
  label?: string;
  source: PostStyleExampleSource;
}): Promise<AddExampleResult> {
  const known = await getExample(input.scope.brandId, input.assetId);
  if (known) {
    return { ok: true, assetId: input.assetId, analyzed: known.analysis !== null };
  }
  if ((await countExamples(input.scope.brandId)) >= MAX_EXAMPLES) {
    return { ok: false, reason: FULL };
  }
  // Looked up WITH the project: an id from another project never matches.
  const asset = await prisma.asset.findFirst({
    where: {
      id: input.assetId,
      projectId: input.scope.projectId,
      type: { in: ["IMAGE", "CREATIVE"] },
    },
    select: { storageKey: true, mimeType: true },
  });
  if (!asset || !ACCEPTED_TYPES.has(asset.mimeType)) {
    return { ok: false, reason: "That picture isn't available." };
  }
  let bytes: Buffer;
  try {
    bytes = await readAsset(asset.storageKey);
  } catch {
    return { ok: false, reason: "That picture isn't available." };
  }
  const analyzed = await keepExample({
    scope: input.scope,
    assetId: input.assetId,
    base64: bytes.toString("base64"),
    mimeType: asset.mimeType,
    label: input.label,
    source: input.source,
  });
  return { ok: true, assetId: input.assetId, analyzed };
}

// Runs the analysis again (a failed one, or after the model changed).
export async function reanalyzeExample(
  scope: PostStyleScope,
  assetId: string,
): Promise<boolean> {
  const example = await getExample(scope.brandId, assetId);
  if (!example) return false;
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId: scope.projectId },
    select: { storageKey: true, mimeType: true },
  });
  if (!asset) return false;
  const bytes = await readAsset(asset.storageKey);
  const analysis = await analyzePostStyleImage({
    scope,
    image: { mimeType: asset.mimeType, data: bytes.toString("base64") },
    label: example.label,
  });
  if (!analysis) return false;
  await saveExample(scope, { ...example, analysis });
  return true;
}

export type LinkImage =
  | { ok: true; bytes: Buffer; url: string }
  | { ok: false; reason: string };

const IMAGE_TYPE = /^image\/(png|jpe?g|webp)/i;
const HTML_TYPE = /^(text\/html|application\/xhtml)/i;

function socialReason(link: string): string {
  return isSocialLink(link)
    ? "That network doesn't hand its posts' pictures to apps. Save the picture (or take a screenshot) and add it as a file."
    : "No picture was found on that page. Add the picture as a file.";
}

// The picture behind a link: the link itself when it is one, else the picture
// the page names for itself. Public addresses only (safeFetch checks every hop).
export async function fetchLinkImage(link: string): Promise<LinkImage> {
  try {
    const first = await safeFetch(link, {
      maxBytes: LINK_PAGE_MAX_BYTES,
      truncate: true,
      timeoutMs: 10_000,
      accept: "text/html,application/xhtml+xml,image/*;q=0.9",
    });
    let imageUrl = first.url;
    let bytes: Buffer | null = null;

    if (IMAGE_TYPE.test(first.contentType)) {
      if (first.truncated) {
        return { ok: false, reason: "That picture is too large." };
      }
      bytes = first.body;
    } else if (HTML_TYPE.test(first.contentType)) {
      const found = imageUrlFromHtml(first.body.toString("utf8"), first.url);
      if (!found) return { ok: false, reason: socialReason(link) };
      imageUrl = found;
    } else {
      return { ok: false, reason: "That link isn't a picture or a page." };
    }

    if (!bytes) {
      const image = await safeFetch(imageUrl, {
        maxBytes: LINK_IMAGE_MAX_BYTES,
        timeoutMs: 12_000,
        accept: "image/png,image/jpeg,image/webp",
        allowedContentTypes: IMAGE_TYPE,
      });
      bytes = image.body;
    }
    return { ok: true, bytes, url: imageUrl };
  } catch {
    return { ok: false, reason: socialReason(link) };
  }
}
