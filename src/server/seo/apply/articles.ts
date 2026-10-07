import "server-only";

import { prisma } from "@/lib/prisma";
import { validateArticle } from "@/lib/seo/apply/validate";
import { SEO_FORMAT_KEY } from "@/server/modules/seo/calendar";

// Takvimdeki SEO makalesini WordPress'e gidecek biçimde okur. Makale ancak
// SEO Manager kartında incelenip takvime APPROVED olarak yerleşince (ya da
// elle yayınlandı işaretlenince) buraya gelir; SC-F7 dolu olmayan DRAFT
// slotları (sürümsüz) yayınlanamaz.

export type PublishableArticle = {
  creativeId: string;
  versionId: string;
  title: string;
  metaDescription: string;
  markdown: string;
  language: string | null;
  words: number;
};

export type ArticleLoadResult =
  | { ok: true; article: PublishableArticle }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_article"
        | "not_reviewed"
        | "no_version"
        | "too_short";
      // too_short için doğrulayıcının sabit metni (sınır, uzunluk).
      message?: string;
    };

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function loadArticleForPublish(
  projectId: string,
  creativeId: string,
): Promise<ArticleLoadResult> {
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId },
    select: {
      id: true,
      title: true,
      formatKey: true,
      status: true,
      currentVersionId: true,
    },
  });
  if (!creative) return { ok: false, reason: "not_found" };
  if (creative.formatKey !== SEO_FORMAT_KEY) {
    return { ok: false, reason: "not_article" };
  }
  // Yalnız incelenmiş makale: APPROVED (takvimde) ya da PUBLISHED (elle yayında).
  if (creative.status !== "APPROVED" && creative.status !== "PUBLISHED") {
    return { ok: false, reason: "not_reviewed" };
  }
  if (!creative.currentVersionId) return { ok: false, reason: "no_version" };

  const version = await prisma.creativeVersion.findFirst({
    where: { id: creative.currentVersionId, creativeId: creative.id },
    select: { id: true, copy: true, generationMetadata: true },
  });
  if (!version || !version.copy) return { ok: false, reason: "no_version" };

  const meta =
    typeof version.generationMetadata === "object" &&
    version.generationMetadata !== null
      ? (version.generationMetadata as Record<string, unknown>)
      : {};
  const validated = validateArticle({
    title: textOf(meta.title) || creative.title || "",
    metaDescription: textOf(meta.metaDescription),
    markdown: version.copy,
  });
  if (!validated.ok) {
    return { ok: false, reason: "too_short", message: validated.message };
  }
  const language = textOf(meta.language).trim();
  return {
    ok: true,
    article: {
      creativeId: creative.id,
      versionId: version.id,
      title: validated.title,
      metaDescription: validated.metaDescription,
      markdown: validated.markdown,
      language: language || null,
      words: validated.words,
    },
  };
}
