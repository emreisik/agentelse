// Brand Memory selection: which of a brand's remembered preferences and
// learnings belong in the agent's context for THIS message. Pure module (no
// database, no clock unless passed in), so the rules can be pinned by tests.
//
// The old context put the newest 20 stated decisions and the 40 most-reinforced
// learnings in front of the model on every turn, whatever was being asked. That
// grows without bound and buries the one rule that matters. Now:
//  - STANDING: what the client explicitly told us. Few, short, and a "never do
//    X" must apply to a request that shares no word with it ("make a post"), so
//    these are always included, newest first, up to a cap.
//  - RELEVANT: everything else (corrections, reactions to past outputs,
//    measured learnings) competes on overlap with what is being asked, and only
//    the best few make it in.
//  - Nothing is ever presented as certain unless the client said it. See
//    isConfirmed.

// Where a memory came from, strongest first. Anything else stored in
// BrandLearning.sourceType (the measurement loop writes its own labels) reads
// as an unrecognised, machine-derived source.
export const MEMORY_SOURCES = [
  "USER_EXPLICIT",
  "USER_CORRECTION",
  "OUTPUT_ACCEPTED",
  "OUTPUT_REJECTED",
  "AI_INFERRED",
] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

// A stated decision from before memories carried a source (UserDecision rows).
export type MemoryItemSource = MemorySource | "LEGACY_DECISION" | "OTHER";

export type MemoryItem = {
  id: string;
  text: string;
  polarity: "WORKS" | "AVOID";
  source: MemoryItemSource;
  // 0..1, as stored.
  confidence: number | null;
  // How many independent times this has been observed.
  seen: number;
  updatedAt: Date;
};

export function memorySourceOf(
  raw: string | null | undefined,
): MemoryItemSource {
  return (MEMORY_SOURCES as readonly string[]).includes(raw ?? "")
    ? (raw as MemorySource)
    : "OTHER";
}

// How much a source outranks another when the same memory is seen again from a
// different one: the stronger source wins the label.
const SOURCE_RANK: Record<MemoryItemSource, number> = {
  USER_EXPLICIT: 5,
  LEGACY_DECISION: 5,
  USER_CORRECTION: 4,
  OUTPUT_ACCEPTED: 3,
  OUTPUT_REJECTED: 3,
  OTHER: 2,
  AI_INFERRED: 1,
};

export function strongerSource(
  a: MemoryItemSource,
  b: MemoryItemSource,
): MemoryItemSource {
  return SOURCE_RANK[b] > SOURCE_RANK[a] ? b : a;
}

// The confidence a source starts with when the caller gives none. A client's
// own words are near-certain; a single approval or revision is a hint (one
// observation must not become a rule); a machine's guess starts low.
export const DEFAULT_CONFIDENCE: Record<MemorySource, number> = {
  USER_EXPLICIT: 0.95,
  USER_CORRECTION: 0.6,
  OUTPUT_ACCEPTED: 0.5,
  OUTPUT_REJECTED: 0.5,
  AI_INFERRED: 0.3,
};

// How many times something must be seen before a memory that is NOT the
// client's own statement counts as confirmed.
export const CONFIRMED_AFTER = 3;

// "Confirmed" = safe to state as a fact about the client:
//  - they said it themselves (USER_EXPLICIT, or a stated decision from before
//    memories had sources); or
//  - it was seen repeatedly from independent signals (corrections, approvals,
//    rejections, measurements) CONFIRMED_AFTER times.
// An AI inference is never confirmed by repetition alone: the same model
// guessing the same thing twice is not evidence. It only becomes a stronger
// source when the client's own action backs it (see MemoryService.remember).
export function isConfirmed(
  item: Pick<MemoryItem, "source" | "seen">,
): boolean {
  if (item.source === "USER_EXPLICIT" || item.source === "LEGACY_DECISION") {
    return true;
  }
  if (item.source === "AI_INFERRED") return false;
  return item.seen >= CONFIRMED_AFTER;
}

// --- matching -----------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "are",
  "you",
  "your",
  "our",
  "not",
  "but",
  "can",
  "will",
  "please",
  "make",
  "want",
  "need",
  "about",
  "into",
  "how",
  "what",
  "when",
  "which",
  "some",
  // Turkish (folded: no diacritics, dotless i as i)
  "bir",
  "icin",
  "ile",
  "gibi",
  "daha",
  "cok",
  "ama",
  "veya",
  "bunu",
  "sunu",
  "olan",
  "olarak",
  "lutfen",
  "benim",
  "bize",
  "bana",
  "yap",
  "yapar",
  "istiyorum",
  "lazim",
  "olsun",
  "misin",
  "musun",
]);

// Lowercased, diacritics folded, Turkish dotless i handled, so "Görsel" and
// "gorsel" and "GÖRSEL" are the same word.
function fold(text: string): string {
  return text
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const word of fold(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

// Turkish is agglutinative ("renkleri", "renklerde"), so a shared 5-letter stem
// counts as the same word; shorter words must match exactly.
const STEM = 5;
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return (
    a.length >= STEM &&
    b.length >= STEM &&
    a.slice(0, STEM) === b.slice(0, STEM)
  );
}

// How many distinct query words appear (as words or stems) in the memory.
export function overlapCount(query: string[], memory: string[]): number {
  let count = 0;
  for (const word of query) {
    if (memory.some((other) => tokensMatch(word, other))) count += 1;
  }
  return count;
}

// --- selection ----------------------------------------------------------------

export type SelectedMemory = {
  // Always in context: what the client explicitly told us.
  standing: MemoryItem[];
  // In context because it matches what is being asked.
  relevant: MemoryItem[];
};

export const STANDING_LIMIT = 12;
export const RELEVANT_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

function isStanding(item: MemoryItem): boolean {
  return item.source === "USER_EXPLICIT" || item.source === "LEGACY_DECISION";
}

export function selectMemory(
  items: readonly MemoryItem[],
  query: string,
  options: { now?: Date; standingLimit?: number; relevantLimit?: number } = {},
): SelectedMemory {
  const now = (options.now ?? new Date()).getTime();
  const newestFirst = [...items].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );

  const explicit = newestFirst.filter(isStanding);
  const standing = explicit.slice(0, options.standingLimit ?? STANDING_LIMIT);
  const standingIds = new Set(standing.map((item) => item.id));

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { standing, relevant: [] };

  const scored = newestFirst
    .filter((item) => !standingIds.has(item.id))
    .map((item) => {
      const overlap = overlapCount(queryTokens, tokenize(item.text));
      if (overlap === 0) return null;
      const ageDays = Math.max(0, (now - item.updatedAt.getTime()) / DAY_MS);
      const score =
        overlap * 2 +
        (isConfirmed(item) ? 1.5 : 0) +
        Math.log2(1 + item.seen) * 0.5 +
        // Up to +1 for something touched in the last month, fading to 0.
        Math.max(0, 1 - ageDays / 30) +
        (item.confidence ?? 0.5) * 0.5;
      return { item, score };
    })
    .filter(
      (entry): entry is { item: MemoryItem; score: number } => entry !== null,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, options.relevantLimit ?? RELEVANT_LIMIT)
    .map((entry) => entry.item);

  return { standing, relevant: scored };
}

// --- what the model sees --------------------------------------------------------

export type PromptMemory = {
  text: string;
  // Present only for a "never / avoid" memory.
  avoid?: true;
  // True only when it is safe to say as a fact about the client: they said it
  // themselves, or it has been seen repeatedly. Everything else is a hint.
  confirmed: boolean;
  // Only when it was seen more than once.
  seen?: number;
};

const PROMPT_TEXT_CHARS = 200;

function forPrompt(item: MemoryItem): PromptMemory {
  const text =
    item.text.length > PROMPT_TEXT_CHARS
      ? `${item.text.slice(0, PROMPT_TEXT_CHARS).trimEnd()}…`
      : item.text;
  return {
    text,
    ...(item.polarity === "AVOID" ? { avoid: true as const } : {}),
    confirmed: isConfirmed(item),
    ...(item.seen > 1 ? { seen: item.seen } : {}),
  };
}

export function memoryForPrompt(selected: SelectedMemory): {
  standing: PromptMemory[];
  relevant: PromptMemory[];
} {
  return {
    standing: selected.standing.map(forPrompt),
    relevant: selected.relevant.map(forPrompt),
  };
}
