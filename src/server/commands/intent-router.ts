import type {
  CapabilityKey,
  CreativeContentFormat,
  DepartmentKey,
  SocialPlatform,
} from "@prisma/client";

export type ParsedIntent =
  | {
      kind: "CAPABILITY";
      capability: CapabilityKey;
      targetPlatform?: SocialPlatform;
      // Which content-format slot (Story/Reel/Feed square/etc — see
      // src/lib/creative-platform-format.ts) a CREATE_SOCIAL_CREATIVE
      // request is for. Omitted = the platform's own default (previously
      // the ONLY behavior: nothing anywhere set this, so asking chat for
      // "an Instagram Story" silently produced a square Feed post every
      // time — see detectContentFormat below and chat-turn.ts's matching
      // LLM-side field).
      contentFormat?: CreativeContentFormat;
      request: string;
    }
  | {
      kind: "APPROVAL_DECISION";
      decision: "APPROVE" | "REJECT" | "REVISE";
      note?: string;
    }
  | { kind: "STATUS_QUERY" }
  // Deep Path (docs/brand-workspace-migration.md §7 Phase 8, spec: "Fast
  // Path vs Deep Path") — a broad, multi-part request ("enter the Russia
  // market", "plan October") that should go through research+planning
  // instead of a single task. Only ever produced by the LLM chat classifier
  // (chat-turn.ts's `strategic` field) — the rule-based fallback parser
  // below never emits this, since that distinction genuinely needs
  // judgment, not keyword matching.
  | {
      kind: "STRATEGIC_REQUEST";
      title: string;
      description: string;
      departments?: DepartmentKey[];
    }
  | { kind: "UNKNOWN" };

const PLATFORM_KEYWORDS: Record<string, SocialPlatform> = {
  instagram: "INSTAGRAM",
  tiktok: "TIKTOK",
  linkedin: "LINKEDIN",
  twitter: "X",
  "x'": "X",
  facebook: "FACEBOOK",
  youtube: "YOUTUBE",
  pinterest: "PINTEREST",
};

function detectPlatform(text: string): SocialPlatform | undefined {
  for (const [keyword, platform] of Object.entries(PLATFORM_KEYWORDS)) {
    if (text.includes(keyword)) return platform;
  }
  return undefined;
}

// Turkish + English keywords for the two content formats a client is
// actually likely to name explicitly in a chat message — reel/story are
// the ones with a clearly different shape (9:16 video/vertical) a client
// would ask for by name; the rest (square/portrait/landscape feed) are
// what "a post" already defaults to, so there's no ambiguity worth
// detecting for those. getCreativePlatformFormat falls back to the
// platform's default for any format it doesn't recognize, so a false
// negative here just means "same as before this existed" — never worse.
const CONTENT_FORMAT_KEYWORDS: [RegExp, CreativeContentFormat][] = [
  [/\breels?\b/, "REEL"],
  [/\bstory\b|\bstories\b|hikaye/, "STORY"],
];

function detectContentFormat(text: string): CreativeContentFormat | undefined {
  for (const [pattern, format] of CONTENT_FORMAT_KEYWORDS) {
    if (pattern.test(text)) return format;
  }
  return undefined;
}

// Deterministic, rule-based intent parser covering the web command examples
// in spec section 7. This is intentionally not an LLM call — no
// external API key is required to exercise the full command pipeline in
// development. A model-backed parser can implement the same return shape
// and slot in without CommandService changes.
export function parseIntent(rawText: string): ParsedIntent {
  // Deliberately NOT toLocaleLowerCase("tr-TR") — under the Turkish locale,
  // ASCII "I" lowercases to dotless "ı" (the classic Turkish-I problem), which
  // turns "Instagram" into "ınstagram" and breaks every platform keyword
  // match. Plain toLowerCase() keeps ASCII brand names intact; our Turkish
  // verb regexes below are already written in their lowercase dotted form.
  const text = rawText.toLowerCase().trim();

  if (/onayl(ı|i)yorum|approve/.test(text)) {
    return { kind: "APPROVAL_DECISION", decision: "APPROVE" };
  }
  if (/reddediyorum|reject/.test(text)) {
    return { kind: "APPROVAL_DECISION", decision: "REJECT" };
  }
  if (/revize et|reviz(e|yon)/.test(text)) {
    return { kind: "APPROVAL_DECISION", decision: "REVISE", note: rawText };
  }
  if (/hangi işler|bekliyor|durumu/.test(text)) {
    return { kind: "STATUS_QUERY" };
  }

  const platform = detectPlatform(text);

  if (/hesa(p|b)(ı)?\s*(oluştur|aç)/.test(text) && platform) {
    return {
      kind: "CAPABILITY",
      capability: "SOCIAL_ACCOUNT_SETUP",
      targetPlatform: platform,
      request: rawText,
    };
  }

  if (
    /(post|görsel|creative|içerik|reels?|hikaye|stories?)/.test(text) &&
    /(hazırla|oluştur|yap)/.test(text)
  ) {
    return {
      kind: "CAPABILITY",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: platform,
      contentFormat: detectContentFormat(text),
      request: rawText,
    };
  }

  if (/rakip/.test(text) && /(analiz|incele|araştır)/.test(text)) {
    return {
      kind: "CAPABILITY",
      capability: "COMPETITOR_RESEARCH",
      request: rawText,
    };
  }

  if (/(performans|analytics|istatistik)/.test(text)) {
    return {
      kind: "CAPABILITY",
      capability: "ANALYTICS_ANALYSIS",
      request: rawText,
    };
  }

  if (platform && /(paylaş|publish|yayınla)/.test(text)) {
    const capability: CapabilityKey =
      platform === "INSTAGRAM"
        ? "INSTAGRAM_PUBLISH"
        : platform === "TIKTOK"
          ? "TIKTOK_PUBLISH"
          : platform === "LINKEDIN"
            ? "LINKEDIN_PUBLISH"
            : "X_PUBLISH";
    return {
      kind: "CAPABILITY",
      capability,
      targetPlatform: platform,
      request: rawText,
    };
  }

  return { kind: "UNKNOWN" };
}
