import { NextResponse } from "next/server";
import { z } from "zod";

import { ARCHETYPES } from "@/lib/auto-layout";
import {
  PREVIEW_FORMAT_KEYS,
  previewLookKey,
  renderDesignPreview,
} from "@/server/brand/design-preview";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// A post design drawn on a real picture with the brand's own logo, font and
// colours (server/brand/design-preview.ts). The brand always comes from the
// project the caller can open, never from the query.
const Query = z.object({
  design: z.enum(ARCHETYPES),
  format: z.enum(PREVIEW_FORMAT_KEYS as [string, ...string[]]),
  photo: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  // The look the page was drawn for (previewLookKey). While it is still the
  // brand's look, the picture can be kept by the browser for good.
  v: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = Query.safeParse({
    design: url.searchParams.get("design"),
    format: url.searchParams.get("format"),
    photo: url.searchParams.get("photo") ?? undefined,
    v: url.searchParams.get("v") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  try {
    const access = await requireProjectAccess(userId, projectId);
    const image = await renderDesignPreview({
      projectId,
      brandId: access.defaultBrandId,
      design: parsed.data.design,
      format: parsed.data.format as (typeof PREVIEW_FORMAT_KEYS)[number],
      photo: parsed.data.photo ?? null,
    });
    const current = await previewLookKey(projectId, access.defaultBrandId);
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control":
          parsed.data.v && parsed.data.v === current
            ? "private, max-age=31536000, immutable"
            : "private, max-age=60",
      },
    });
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("[api/design-preview] failed:", error);
    return NextResponse.json({ error: "Preview failed" }, { status: 500 });
  }
}
