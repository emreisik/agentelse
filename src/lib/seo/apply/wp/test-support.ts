// SC-F8: WordPress kütüphanesinin testleri için ortak kurulumlar (üretim kodu
// bunu içe aktarmaz). Fixture'lar WordPress REST biçiminden elle yazıldı.

import type {
  SeoFieldsCapability,
  WpCapabilities,
  WpSnapshot,
} from "../types";
import indexPlainJson from "./__fixtures__/wp-index-plain.json";
import indexRankMathJson from "./__fixtures__/wp-index-rankmath.json";
import indexYoastJson from "./__fixtures__/wp-index-yoast.json";
import meAdministratorJson from "./__fixtures__/wp-me-administrator.json";
import meContributorJson from "./__fixtures__/wp-me-contributor.json";
import meEditorJson from "./__fixtures__/wp-me-editor.json";
import pageEditJson from "./__fixtures__/wp-page-edit.json";
import postEditJson from "./__fixtures__/wp-post-edit.json";
import { deriveWpCapabilities } from "./capabilities";
import { parseWpMe } from "./parse";
import { probeSeoFields, SEO_META_KEYS } from "./plugin-fields";
import type { WpMe, WpObject } from "./wp-types";

export const wpFixtures = {
  indexYoast: indexYoastJson as unknown,
  indexRankMath: indexRankMathJson as unknown,
  indexPlain: indexPlainJson as unknown,
  postEdit: postEditJson as unknown,
  pageEdit: pageEditJson as unknown,
  meEditor: meEditorJson as unknown,
  meContributor: meContributorJson as unknown,
  meAdministrator: meAdministratorJson as unknown,
};

export function fixtureMe(
  name: "meEditor" | "meContributor" | "meAdministrator",
): WpMe {
  const me = parseWpMe(wpFixtures[name]);
  if (!me) throw new Error(`Bozuk fixture: ${name}`);
  return me;
}

export function editorCapabilities(): WpCapabilities {
  return deriveWpCapabilities(fixtureMe("meEditor"));
}

export function wpObjectFixture(overrides: Partial<WpObject> = {}): WpObject {
  return {
    id: 42,
    type: "post",
    status: "publish",
    link: "https://example.com/ornek-yazi/",
    slug: "ornek-yazi",
    modified: "2026-09-10T12:30:00Z",
    title: "Örnek yazı",
    excerpt: "",
    content:
      "<!-- wp:paragraph -->\n<p>Bu yazıda yerel SEO rehberi hakkında kısa bir giriş var.</p>\n<!-- /wp:paragraph -->",
    meta: {},
    ...overrides,
  };
}

export type FieldsKind =
  | "yoast"
  | "yoast-hidden"
  | "rankmath"
  | "rankmath-endpoint"
  | "none";

export function fieldsFixture(kind: FieldsKind): SeoFieldsCapability {
  const yoast = Object.values(SEO_META_KEYS.yoast);
  const rank = Object.values(SEO_META_KEYS.rankMath);
  switch (kind) {
    case "yoast":
      return probeSeoFields("YOAST", {
        metaKeys: yoast,
        namespaces: ["wp/v2", "yoast/v1"],
      });
    case "yoast-hidden":
      return probeSeoFields("YOAST", {
        metaKeys: [],
        namespaces: ["wp/v2", "yoast/v1"],
      });
    case "rankmath":
      return probeSeoFields("RANK_MATH", {
        metaKeys: rank,
        namespaces: ["wp/v2", "rankmath/v1"],
      });
    case "rankmath-endpoint":
      return probeSeoFields("RANK_MATH", {
        metaKeys: [],
        namespaces: ["wp/v2", "rankmath/v1"],
      });
    case "none":
      return probeSeoFields("NONE", { metaKeys: [], namespaces: ["wp/v2"] });
  }
}

export function snapshotFixture(overrides: Partial<WpSnapshot> = {}): WpSnapshot {
  return {
    exists: true,
    type: "post",
    id: 42,
    status: "publish",
    link: "https://example.com/ornek-yazi/",
    modified: "2026-09-10T12:30:00Z",
    title: "Örnek yazı",
    excerpt: "",
    seoTitle: null,
    seoDescription: null,
    contentHash: null,
    contentWords: null,
    contentRaw: null,
    ...overrides,
  };
}

// 150+ kelimelik örnek makale (markdown).
export function articleMarkdown(title = "Yerel SEO rehberi"): string {
  const sentence =
    "Yerel işletmeler için görünürlük, doğru başlıklar ve düzenli içerikle başlar";
  const paragraphs = Array.from({ length: 12 }, (_, i) => `${sentence} ${i + 1}.`);
  return [
    `# ${title}`,
    "",
    "## Neden önemli",
    "",
    ...paragraphs.flatMap((text) => [text, ""]),
    "- Birinci madde",
    "- İkinci madde",
  ].join("\n");
}
