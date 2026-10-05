import "server-only";

import { prisma } from "@/lib/prisma";
import { isSeoLanguage, normalizeSiteUrl } from "@/lib/module-flows/seo/brief";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { findActiveGoogleConnections } from "@/server/integrations/google-connections";

// What the SEO Manager's Brief starts with (docs/modules.md): the project's
// website (its own domain, else the Search Console property) and the brand's
// language. Read fail-open: a missing value leaves the field for the person.

const FALLBACK_LANGUAGE = "en";

export async function loadSeoDefaults(
  projectId: string,
): Promise<{ siteUrl: string; language: string }> {
  const [language, project, google] = await Promise.all([
    brandRuleLanguageOf(projectId),
    prisma.project
      .findUnique({ where: { id: projectId }, select: { domain: true } })
      .catch(() => null),
    findActiveGoogleConnections(projectId).catch(() => null),
  ]);
  const siteUrl =
    [project?.domain, google?.searchConsole?.siteUrl]
      .map((candidate) => (candidate ? normalizeSiteUrl(candidate) : null))
      .find((url): url is string => Boolean(url)) ?? "";
  return {
    siteUrl,
    language: isSeoLanguage(language) ? language : FALLBACK_LANGUAGE,
  };
}
