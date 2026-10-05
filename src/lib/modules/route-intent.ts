import { CHANNEL_KEYS, type ChannelKey } from "@/lib/content-channels";
import { MAX_BRIEF_PER_WEEK, MAX_BRIEF_WEEKS } from "@/lib/plan-brief";
import { foldedTokensWithRange } from "@/lib/text-fold";

import { MODULE_KEYS, type ModuleKey } from "./catalog";

// Which module a New Chat's first message is about, and what its Brief can
// start with (plan P4). Pure and instant: weighted English and Turkish words,
// with or without Turkish letters, no model. Anything unsure stays a chat
// (module null): a question, a tie, no module word, a long message. Whether the
// module is ready yet is the UI's call, not this one's.

export type IntentPrefill = {
  // The social channels the text names, in catalog order. A Story with no
  // channel named is Instagram's (Stories are Instagram's here).
  channels?: ChannelKey[];
  story?: boolean;
  // Within the Brief's limits (plan-brief.ts).
  perWeek?: number;
  weeks?: number;
  // What it is about, as typed, when that reads off the text easily.
  topic?: string;
};

export type RoutedIntent = {
  module: ModuleKey | null;
  // Empty when the text stays a chat.
  prefill: IntentPrefill;
};

// A longer message is a conversation: the model reads it better than words do.
const MAX_TOKENS = 50;
// A module needs one real module word: a channel name alone scores 1.
const MIN_SCORE = 2;
const TOPIC_MAX_WORDS = 8;
const TOPIC_MAX_CHARS = 80;
const TOPIC_MIN_LETTERS = 3;
const WEEKS_PER_MONTH = 4;

// ---- words -------------------------------------------------------------------

const POST =
  /^post(?:s|u|un|unu|um|umu|umuz\w*|unuz\w*|lar\w*|ta|tan|ing|ed)?$/;
const STORY = /^(?:story|stories|storys|storyler\w*|hikaye\w*)$/;
const REEL = /^reel(?:s|ler\w*|sler\w*)?$/;
const CAROUSEL = /^(?:carousel\w*|karusel\w*)$/;
const BLOG = /^blog\w*$/;
const ARTICLE = /^(?:makale\w*|articles?)$/;
const VIDEO = /^video\w*$/;
const VISUAL = /^(?:gorsel\w*|visuals?)$/;

type Rule = {
  // Null: a phrase that is NOT a module word ("brand story"). It claims its
  // words so the single-word rules leave them alone, and scores nothing.
  module: ModuleKey | null;
  // Counted once however often the rule matches. 3 and up: a clear module
  // word; below 3 a weak one that can also be part of the topic ("summer
  // campaign").
  weight: number;
  // Consecutive words of one sentence.
  words: readonly RegExp[];
  story?: true;
  // A phrase that is no module word and no topic either (a goal: "boost
  // engagement").
  notTopic?: true;
};

// Phrases first: they claim their words before the single words can.
const RULES: readonly Rule[] = [
  // A told story ("marka hikayesi", "the story of us"), not a Story.
  {
    module: null,
    weight: 0,
    words: [
      /^(?:marka|kurulus|basari|musteri|sirket|firma)\w*$/,
      /^hikaye\w*$/,
    ],
  },
  {
    module: null,
    weight: 0,
    words: [
      /^(?:brand|company|founding|founder|origin|success|customer|love)$/,
      /^stor(?:y|ies)$/,
    ],
  },
  { module: null, weight: 0, words: [/^stor(?:y|ies)$/, /^of$/] },
  // More of something ("boost engagement"), not a paid boost.
  {
    module: null,
    weight: 0,
    words: [
      /^boost\w*$/,
      /^(?:engagement|sales|reach|followers?|awareness|visibility|traffic|growth|conversions?|signups?|revenue|interactions?|likes|views|presence)$/,
    ],
    notTopic: true,
  },
  // Turkish "ad" is also a name ("ürüne ad bul", "ad önerisi").
  {
    module: null,
    weight: 0,
    words: [
      /^ad$/,
      /^(?:bul\w*|oner\w*|koy\w*|sec\w*|ver\w*|degis\w*|fikr\w*)$/,
    ],
  },
  { module: "seo", weight: 3, words: [BLOG, POST] },
  { module: "seo", weight: 3, words: [BLOG, /^yazi\w*$/] },
  { module: "seo", weight: 3, words: [/^anahtar$/, /^kelime\w*$/] },
  { module: "seo", weight: 3, words: [/^arama$/, /^motor\w*$/] },
  { module: "seo", weight: 3, words: [/^search$/, /^engines?$/] },
  { module: "seo", weight: 3, words: [/^meta$/, /^descriptions?$/] },
  { module: "seo", weight: 2, words: [/^search$/, /^console$/] },
  { module: "ads", weight: 5, words: [/^sponsor\w*$/, POST] },
  { module: "ads", weight: 3, words: [/^(?:google|meta)$/, /^ads$/] },
  // How posts or ads did ("post performance", "reklam raporu").
  {
    module: "analytics",
    weight: 3,
    words: [
      /^(?:post(?:s|u|un|lar\w*)?|gonderi\w*|reklam\w*|ads?|kampanya\w*|campaigns?)$/,
      /^(?:performans\w*|performance|rapor\w*|reports?|sonuc\w*|results?|istatistik\w*|statistics?|stats|insights?)$/,
    ],
  },
  { module: "social", weight: 3, words: [/^sosyal$/, /^medya\w*$/] },
  { module: "social", weight: 3, words: [/^social$/, /^media$/] },
  {
    module: "social",
    weight: 3,
    words: [/^icerik\w*$/, /^(?:takvim\w*|plan\w*)$/],
  },
  {
    module: "social",
    weight: 3,
    words: [/^content$/, /^(?:calendar\w*|plan\w*)$/],
  },
  { module: "social", weight: 3, words: [POST] },
  { module: "social", weight: 3, words: [/^gonderi\w*$/] },
  { module: "social", weight: 3, words: [/^paylasim\w*$/] },
  { module: "social", weight: 3, words: [STORY], story: true },
  { module: "social", weight: 3, words: [REEL] },
  { module: "social", weight: 3, words: [CAROUSEL] },
  { module: "social", weight: 2, words: [/^(?:icerik\w*|contents?)$/] },
  { module: "social", weight: 2, words: [/^(?:takvim\w*|calendars?)$/] },
  { module: "social", weight: 2, words: [/^(?:captions?|hashtag\w*)$/] },
  { module: "social", weight: 2, words: [VIDEO] },
  { module: "social", weight: 2, words: [VISUAL] },
  { module: "social", weight: 2, words: [/^(?:threads?|flood\w*)$/] },
  { module: "ads", weight: 5, words: [/^boost\w*$/] },
  { module: "ads", weight: 3, words: [/^reklam\w*$/] },
  {
    module: "ads",
    weight: 3,
    words: [/^(?:ads?|adverts?|advertis\w*|sponsor\w*)$/],
  },
  { module: "ads", weight: 2, words: [/^(?:kampanya\w*|campaigns?)$/] },
  { module: "ads", weight: 2, words: [/^(?:butce\w*|budgets?)$/] },
  {
    module: "analytics",
    weight: 3,
    words: [/^(?:rapor\w*|reports?|reporting)$/],
  },
  {
    module: "analytics",
    weight: 3,
    words: [/^(?:analiz\w*|analitik\w*|analy\w*)$/],
  },
  {
    module: "analytics",
    weight: 3,
    words: [/^(?:istatistik\w*|statistics?|stats)$/],
  },
  { module: "analytics", weight: 3, words: [/^(?:insights?|icgoru\w*)$/] },
  {
    module: "analytics",
    weight: 3,
    words: [/^(?:performans\w*|performance)$/],
  },
  {
    module: "analytics",
    weight: 2,
    words: [/^(?:metrik\w*|metrics?|kpis?|olcum\w*)$/],
  },
  {
    module: "analytics",
    weight: 1,
    words: [/^(?:etkilesim\w*|engagement|erisim\w*|reach)$/],
  },
  { module: "seo", weight: 3, words: [/^seo\w*$/] },
  { module: "seo", weight: 3, words: [BLOG] },
  { module: "seo", weight: 3, words: [ARTICLE] },
  { module: "seo", weight: 3, words: [/^(?:keywords?|backlinks?)$/] },
];

// Channel names. A bare "x" is X only away from numbers ("3 x 2" is not).
const CHANNEL_WORDS: readonly { channel: ChannelKey; words: RegExp[] }[] = [
  {
    channel: "instagram",
    words: [/^(?:instagram\w*|insta|instada|instaya|instadan|ig)$/],
  },
  { channel: "facebook", words: [/^(?:facebook\w*|fb)$/] },
  { channel: "tiktok", words: [/^tiktok\w*$/] },
  { channel: "tiktok", words: [/^tik$/, /^tok\w*$/] },
  { channel: "linkedin", words: [/^linkedin\w*$/] },
  { channel: "x", words: [/^(?:twitter\w*|tweet\w*)$/] },
  { channel: "x", words: [/^x$/] },
];

// What a request reads like: "please", "lütfen", "…hazırlar mısın", "let's".
const REQUEST_WORDS =
  /^(?:please|pls|plz|lets|lutfen|rica\w*|misin|misiniz|musun|musunuz|istiyorum|isterim|istiyoruz|isteriz|lazim|gerek\w*|ihtiyac\w*)$/;
const REQUEST_PAIRS: readonly (readonly [RegExp, RegExp])[] = [
  [/^(?:can|could|would|will)$/, /^(?:you|u|we)$/],
  [/^(?:how|what)$/, /^about$/],
  [/^let$/, /^(?:s|us)$/],
  [/^shall$/, /^we$/],
  [/^(?:i|we)$/, /^(?:need|want|would|d)$/],
  [/^help$/, /^(?:me|us)$/],
];
// Turkish verbs of making something, in a request form: "hazırla",
// "hazırlayın", "hazırlayalım", "hazırlasana", "hazırlayabilir", joined
// "hazırlarmısın" ("hazırlar mısın" is REQUEST_WORDS). Not "hazırladığın" or
// "hazırlanan": a question about what was made is no request. A bare "yaz" is
// "write" only at the end of its clause; elsewhere it is "summer".
const TR_STEMS =
  "hazirla|olustur|planla|uret|tasarla|baslat|guncelle|duzenle|goster|oner|yaz|yap|cikar|kur|ver|paylas|bul|ekle|ayarla|zamanla|et|ed";
const TR_VERBS = new RegExp(
  `^(?:${TR_STEMS})(?:y?(?:in|iniz|un|unuz)|y?(?:alim|elim)|sana|sene|y?(?:abilir|ebilir)\\w*|(?:[aeiu]?r)?(?:misin|misiniz|musun|musunuz))$`,
);
const TR_IMPERATIVE =
  /^(?:hazirla|olustur|planla|uret|tasarla|baslat|guncelle|duzenle|goster|oner|yap|cikar|kur|ver|paylas|bul|ekle|ayarla|zamanla|et)$/;
// English verbs of making something: a request when they open a sentence or
// follow "please", "let's", "can you"... ("Plan 3 posts").
const EN_VERBS =
  /^(?:make|create|plan|prepare|write|draft|generate|schedule|build|set|launch|run|start|design|produce|boost|give|show|find|suggest|get|do|help|analy[sz]e|review|check|research|post|publish|share|send|update|edit|optimi[sz]e|improve)$/;
const EN_VERB_LEAD =
  /^(?:please|pls|plz|lets|s|us|you|u|we|i|to|me|and|then|just)$/;

// Questions: Turkish question words anywhere, English ones opening a sentence.
const TR_QUESTION =
  /^(?:ne|neden|niye|nicin|nasil\w*|kac|kaci|kactir|kacinci|hangi\w*|kim|kimin|kime|kimi|nerede|nereden|nereye|nedir|neler\w*|mi|mu|midir|mudur|miyiz|muyuz|miydi|muydu)$/;
const EN_QUESTION =
  /^(?:what|whats|why|how|which|who|whom|whose|when|where|is|are|was|were|do|does|did|should|has|have|am|isnt|arent|dont|doesnt)$/;

// Where the topic is: after "about", before "hakkında"; "for" / "için" when
// nothing stronger says it.
const AFTER_STRONG =
  /^(?:about|regarding|re|topic|theme|subject|konu|konusu|tema|temasi)$/;
const AFTER_WEAK = /^(?:for|on|around|featuring)$/;
const BEFORE_STRONG =
  /^(?:hakkinda|ilgili|konulu|konusunda|uzerine|uzerinde|temali|odakli)$/;
const BEFORE_WEAK = /^icin$/;

// Joints inside a topic ("launch of our app"); never its first or last word.
const GLUE =
  /^(?:of|the|a|an|our|my|your|their|its|and|ve|ile|with|to|in|at|de|da|this|that|these|those|bu|su|o)$/;
// Never part of a topic.
const STOP =
  /^(?:i|we|you|u|me|us|it|they|ben|sen|biz|siz|bana|bize|beni|bizi|benim|bizim|senin|sizin|bunu|sunu|bunun|thanks|thank|thx|tesekkur\w*|sagol\w*|plan|plani|planlar\w*|plans|planning|brief|olarak|sey\w*|things?|something|tane|adet|some|any|few|birkac|cok|many|much|also|too|just|sadece|only|hemen|now|simdi|tl|try|usd|eur\w*|dolar\w*|dollars?|lira\w*|marka|markam\w*|markan\w*|markamiz\w*|brand|brands|can|could|would|will|shall|should|let|s|d|need|want|like|help|me|fikir\w*|fikr\w*|ideas?|oneri\w*|suggestions?|arastirma\w*|research|cekim\w*|metin\w*|yazi|yazisi|yazilar\w*|texts?|kez|kere|defa|times|sayfa\w*|pages?|hesap|hesab\w*|accounts?|profil\w*|profiles?|every|each|her|per|kadar|until|till|by|once|sonra|gibi|olsun|olsa|olacak|merhaba\w*|selam\w*|gunaydin|hi|hello|hey|hiya|ok|okay|tamam|peki|evet|yes|sure|manager|planner|yonetici\w*|planlayici\w*|modul\w*|modules?)$/;
// Part of a topic only next to a word of it ("new coffee menu", not "3 new").
const SOFT =
  /^(?:new|yeni|fresh|more|daha|extra|ekstra|different|farkli|short|kisa|creative|yaratici|engaging|etkileyici|catchy|best|good|great|iyi|guzel)$/;
// A day or a week: a time, unless it ends a named one ("Black Friday",
// "Anneler Günü", "Moda Haftası"; namesDay).
const DAY =
  /^(?:gun|gunu|day|week|haftasi|(?:mon|tues|wednes|thurs|fri|satur|sun)day|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)$/;
const TIME =
  /^(?:hafta\w*|haftaya|weeks?|weekly|weekend\w*|ay|ayda|ayin|ayki|aya|aylik\w*|months?|monthly|bugun\w*|yarin\w*|today|tomorrow|tonight|gun|gunde|gunluk\w*|gunu|gunler\w*|days?|daily|pazartesi\w*|sali|carsamba\w*|persembe\w*|cuma|cumartesi\w*|pazar|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|gelecek|onumuzdeki|sonraki|next|coming|son|last|gecen)$/;

// Counts: "haftada 3", "3 posts a week", "2 hafta", "2 weeks", "3 post".
const PER_WEEK_LEAD = /^(?:haftada|haftalik|weekly)$/;
const PER_MONTH_LEAD = /^(?:ayda|aylik|monthly)$/;
const EVERY = /^(?:a|per|each|every|her)$/;
const ONE_WEEK = /^(?:hafta|week)$/;
const ONE_MONTH = /^(?:ay|month)$/;
const WEEKS = /^(?:hafta|haftalik\w*|haftada|haftalar\w*|weeks?)$/;
const MONTHS = /^(?:ay|ayda|aylik\w*|months?)$/;
const TIMES = /^(?:times|x|kez|kere|defa)$/;
const COUNT_SKIP =
  /^(?:ve|and|ile|or|veya|adet|tane|yeni|new|farkli|different|kisa|short|more|daha|extra|ekstra|fresh)$/;
// "bu hafta", "next week": one week; "bu ay", "aylık": a month (the Brief's
// longest plan).
const TIME_LEAD = /^(?:bu|gelecek|onumuzdeki|sonraki|next|this|coming)$/;
const WEEK_AHEAD = /^(?:hafta|haftaki|haftanin|haftada|haftaya|week)$/;
const MONTH_AHEAD = /^(?:ay|ayin|ayki|aya|ayda|month)$/;
const CONNECTOR = /^(?:ve|and|ile|or|veya|plus|icin|for)$/;

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["once", 1],
  ["twice", 2],
  ["bir", 1],
  ["iki", 2],
  ["uc", 3],
  ["dort", 4],
  ["bes", 5],
  ["alti", 6],
  ["yedi", 7],
  ["sekiz", 8],
  ["dokuz", 9],
]);

function isItem(word: string): boolean {
  return (
    POST.test(word) ||
    STORY.test(word) ||
    REEL.test(word) ||
    CAROUSEL.test(word) ||
    BLOG.test(word) ||
    ARTICLE.test(word) ||
    VIDEO.test(word) ||
    VISUAL.test(word) ||
    /^(?:gonderi\w*|paylasim\w*|icerik\w*|contents?|tweet\w*|pieces?|items?)$/.test(
      word,
    )
  );
}

// "3", "3x", "üç", "three"; zero and anything else is no count.
function numberOf(word: string): number | undefined {
  const digits = /^(\d{1,3})x?$/.exec(word);
  const value = digits ? Number(digits[1]) : NUMBER_WORDS.get(word);
  return value ? value : undefined;
}

// ---- the scan ----------------------------------------------------------------

type Token = {
  raw: string;
  word: string;
  start: number;
  end: number;
  // The text between the previous word and this one.
  gap: string;
  // Clause-ending punctuation (. ! ? ; : and line breaks) starts the next one.
  sentence: number;
};

// What a word is to the topic: part of it ("free"), part of it only next to a
// free word ("soft": a weak module word), a joint inside it ("glue") or no part
// of it ("taken").
type Role = "free" | "soft" | "glue" | "taken";

type Scan = {
  text: string;
  tokens: Token[];
  roles: Role[];
  // Taken by a channel or a module rule: no other rule may match it.
  claimed: boolean[];
  channelAt: boolean[];
};

const SENTENCE_BREAK = /[.!?;:\n]/;

function scanOf(text: string): Scan {
  let sentence = 0;
  let last = 0;
  const tokens = foldedTokensWithRange(text).map((token, index): Token => {
    const gap = text.slice(last, token.start);
    if (index > 0 && SENTENCE_BREAK.test(gap)) sentence += 1;
    last = token.end;
    return {
      raw: text.slice(token.start, token.end),
      word: token.token,
      start: token.start,
      end: token.end,
      gap,
      sentence,
    };
  });
  return {
    text,
    tokens,
    roles: tokens.map((): Role => "free"),
    claimed: tokens.map(() => false),
    channelAt: tokens.map(() => false),
  };
}

// The word at `index` when it is in `sentence`, else "".
function wordIn(scan: Scan, index: number, sentence: number): string {
  const token = scan.tokens[index];
  return token && token.sentence === sentence ? token.word : "";
}

function sentenceOf(scan: Scan, index: number): number {
  return scan.tokens[index]?.sentence ?? -1;
}

// The last word of its clause (before , . ! ? ; : or the end).
function endsClause(scan: Scan, index: number): boolean {
  const next = scan.tokens[index + 1];
  return !next || /[.,!?;:\n]/.test(next.gap);
}

// A Turkish suffix or an English "'s" after an apostrophe ("Instagram'da",
// "Mother's"): part of the word before it.
function isSuffix(scan: Scan, at: number): boolean {
  const token = scan.tokens[at];
  return (
    at > 0 &&
    token !== undefined &&
    /^['\u2019]$/.test(token.gap) &&
    token.word.length <= 7
  );
}

function take(scan: Scan, ...indexes: number[]): void {
  for (const index of indexes) {
    if (index >= 0 && index < scan.roles.length && !scan.claimed[index]) {
      scan.roles[index] = "taken";
    }
  }
}

function matchesAt(scan: Scan, words: readonly RegExp[], at: number): boolean {
  const sentence = sentenceOf(scan, at);
  return words.every((pattern, offset) => {
    const index = at + offset;
    return !scan.claimed[index] && pattern.test(wordIn(scan, index, sentence));
  });
}

// Claims every match of `words`, left to right; `accept` may turn one down.
// True when anything was claimed.
function claimAll(
  scan: Scan,
  words: readonly RegExp[],
  role: Role,
  accept: (at: number) => boolean = () => true,
): boolean {
  let any = false;
  for (let at = 0; at + words.length <= scan.tokens.length; at += 1) {
    if (!matchesAt(scan, words, at) || !accept(at)) continue;
    for (let offset = 0; offset < words.length; offset += 1) {
      scan.claimed[at + offset] = true;
      scan.roles[at + offset] = role;
    }
    any = true;
    at += words.length - 1;
  }
  return any;
}

function readChannels(scan: Scan): Set<ChannelKey> {
  const channels = new Set<ChannelKey>();
  for (const entry of CHANNEL_WORDS) {
    const found = claimAll(scan, entry.words, "taken", (at) => {
      if (entry.channel !== "x" || entry.words.length !== 1) return true;
      const sentence = sentenceOf(scan, at);
      return (
        numberOf(wordIn(scan, at - 1, sentence)) === undefined &&
        numberOf(wordIn(scan, at + 1, sentence)) === undefined
      );
    });
    if (found) channels.add(entry.channel);
  }
  // Channels are read first: every word claimed so far is a channel name.
  scan.claimed.forEach((claimed, index) => {
    scan.channelAt[index] = claimed;
  });
  return channels;
}

function readModules(scan: Scan): {
  scores: Record<ModuleKey, number>;
  story: boolean;
} {
  const scores: Record<ModuleKey, number> = {
    social: 0,
    ads: 0,
    analytics: 0,
    seo: 0,
  };
  let story = false;
  for (const rule of RULES) {
    const role: Role =
      rule.module === null
        ? rule.notTopic
          ? "taken"
          : "free"
        : rule.weight >= 3
          ? "taken"
          : "soft";
    if (!claimAll(scan, rule.words, role)) continue;
    if (rule.module) scores[rule.module] += rule.weight;
    if (rule.story) story = true;
  }
  return { scores, story };
}

type Counts = {
  perWeek?: number;
  perMonth?: number;
  weeks?: number;
  // How many pieces the text asks for in all ("3 posts").
  total?: number;
};

type Rate = { end: number; per: "week" | "month" };

// "3 posts a week", "3x a week", "3/week", "3 post haftada"; "10 posts a
// month", "12 post ayda": the rate words after a count (and its item).
function rateTail(scan: Scan, from: number, sentence: number): Rate | null {
  let index = from;
  if (TIMES.test(wordIn(scan, index, sentence))) index += 1;
  const word = wordIn(scan, index, sentence);
  const unit = wordIn(scan, index + 1, sentence);
  if (scan.tokens[index]?.gap.includes("/")) {
    if (ONE_WEEK.test(word)) return { end: index, per: "week" };
    if (ONE_MONTH.test(word)) return { end: index, per: "month" };
  }
  if (EVERY.test(word) && ONE_WEEK.test(unit)) {
    return { end: index + 1, per: "week" };
  }
  if (EVERY.test(word) && ONE_MONTH.test(unit)) {
    return { end: index + 1, per: "month" };
  }
  if (/^(?:weekly|haftada)$/.test(word)) return { end: index, per: "week" };
  if (/^(?:monthly|ayda)$/.test(word)) return { end: index, per: "month" };
  return null;
}

// The item a count is of ("3 instagram postu", "5 new posts"), within a few
// words; its index or -1.
function itemAfter(scan: Scan, at: number, sentence: number): number {
  for (let index = at + 1; index <= at + 4; index += 1) {
    const word = wordIn(scan, index, sentence);
    if (!word) return -1;
    if (isItem(word)) return index;
    if (!COUNT_SKIP.test(word) && !scan.channelAt[index]) return -1;
  }
  return -1;
}

// The item right before a count ("IG story 3 tane"); its index or -1.
function itemBefore(scan: Scan, at: number, sentence: number): number {
  for (let index = at - 1; index >= at - 3; index -= 1) {
    const word = wordIn(scan, index, sentence);
    if (!word) return -1;
    if (isItem(word)) return index;
    if (!scan.channelAt[index]) return -1;
  }
  return -1;
}

function readCounts(scan: Scan): Counts {
  let perWeek: number | undefined;
  let perMonth: number | undefined;
  let weeks: number | undefined;
  let total: number | undefined;
  let storyTotal: number | undefined;
  for (let at = 0; at < scan.tokens.length; at += 1) {
    const value = numberOf(scan.tokens[at]?.word ?? "");
    if (value === undefined) continue;
    take(scan, at);
    const sentence = sentenceOf(scan, at);
    const before = wordIn(scan, at - 1, sentence);
    const next = wordIn(scan, at + 1, sentence);
    // "haftada 3", "haftalık 3", "weekly 3"; "her hafta 3", "every week 3".
    if (PER_WEEK_LEAD.test(before)) {
      perWeek ??= value;
      take(scan, at - 1);
      continue;
    }
    if (ONE_WEEK.test(before) && EVERY.test(wordIn(scan, at - 2, sentence))) {
      perWeek ??= value;
      take(scan, at - 1, at - 2);
      continue;
    }
    // "ayda 10", "aylık 10", "monthly 10"; "her ay 10", "every month 10".
    if (PER_MONTH_LEAD.test(before)) {
      perMonth ??= value;
      take(scan, at - 1);
      continue;
    }
    if (ONE_MONTH.test(before) && EVERY.test(wordIn(scan, at - 2, sentence))) {
      perMonth ??= value;
      take(scan, at - 1, at - 2);
      continue;
    }
    // "2 hafta", "2 haftalık", "2 weeks", "2-week"; "3/week" is per week.
    if (WEEKS.test(next)) {
      if (scan.tokens[at + 1]?.gap.includes("/")) perWeek ??= value;
      else weeks ??= value;
      take(scan, at + 1);
      continue;
    }
    // "1 ay", "2 months": four weeks each.
    if (MONTHS.test(next)) {
      weeks ??= value * WEEKS_PER_MONTH;
      take(scan, at + 1);
      continue;
    }
    // "3 instagram postu"; "story 3 tane" says it the other way round.
    const after = itemAfter(scan, at, sentence);
    const item =
      after < 0 && /^(?:tane|adet)$/.test(next)
        ? itemBefore(scan, at, sentence)
        : after;
    const rate = rateTail(scan, Math.max(item, at) + 1, sentence);
    if (rate) {
      if (rate.per === "week") perWeek ??= value;
      else perMonth ??= value;
      for (let index = at + 1; index <= rate.end; index += 1) take(scan, index);
      continue;
    }
    if (item >= 0) {
      if (STORY.test(scan.tokens[item]?.word ?? "")) storyTotal ??= value;
      else total ??= value;
    }
  }
  return {
    perWeek,
    perMonth,
    weeks: weeks ?? impliedWeeks(scan),
    total: total ?? storyTotal,
  };
}

// "bu hafta", "next week", "haftaya": one week; "bu ay", "aylık": four.
function impliedWeeks(scan: Scan): number | undefined {
  for (let at = 0; at < scan.tokens.length; at += 1) {
    const sentence = sentenceOf(scan, at);
    const word = wordIn(scan, at, sentence);
    const next = wordIn(scan, at + 1, sentence);
    if (word === "haftaya") return 1;
    if (/^(?:aylik\w*|monthly)$/.test(word)) return WEEKS_PER_MONTH;
    if (!TIME_LEAD.test(word)) continue;
    if (WEEK_AHEAD.test(next)) return 1;
    if (MONTH_AHEAD.test(next)) return WEEKS_PER_MONTH;
  }
  return undefined;
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(value)));
}

// The Brief's rhythm from what the text counted: a total spreads over as few
// weeks as it fits in ("10 posts" = 2 weeks of 5); a month is four weeks ("12
// posts a month" = 3 a week for 4 weeks).
function rhythmOf(counts: Counts): { perWeek?: number; weeks?: number } {
  let { perWeek, weeks } = counts;
  if (perWeek === undefined && counts.perMonth !== undefined) {
    perWeek = Math.ceil(counts.perMonth / WEEKS_PER_MONTH);
    weeks ??= WEEKS_PER_MONTH;
  }
  if (perWeek === undefined && counts.total !== undefined) {
    weeks = clamp(
      weeks ?? Math.ceil(counts.total / MAX_BRIEF_PER_WEEK),
      MAX_BRIEF_WEEKS,
    );
    perWeek = Math.ceil(counts.total / weeks);
  }
  return {
    ...(perWeek !== undefined
      ? { perWeek: clamp(perWeek, MAX_BRIEF_PER_WEEK) }
      : {}),
    ...(weeks !== undefined ? { weeks: clamp(weeks, MAX_BRIEF_WEEKS) } : {}),
  };
}

type Shape = "request" | "question" | "statement";

// Marks the request and question words taken, and says which the text is.
function readShape(scan: Scan): { request: boolean; question: boolean } {
  let request = false;
  let question = false;
  scan.tokens.forEach((token, at) => {
    if (scan.claimed[at]) return;
    const { word, sentence } = token;
    const before = wordIn(scan, at - 1, sentence);
    const next = wordIn(scan, at + 1, sentence);
    const opens = before === "";
    if (REQUEST_WORDS.test(word)) {
      request = true;
      take(scan, at);
      // "hazırlar mısın", "yapar mısın": the verb is no topic either.
      if (/^m[iu]s[iu]n(?:[iu]z)?$/.test(word)) take(scan, at - 1);
    } else if (REQUEST_PAIRS.some(([a, b]) => a.test(word) && b.test(next))) {
      request = true;
      take(scan, at, at + 1);
    } else if (
      TR_VERBS.test(word) ||
      TR_IMPERATIVE.test(word) ||
      (word === "yaz" && endsClause(scan, at))
    ) {
      request = true;
      take(scan, at);
    } else if (EN_VERBS.test(word) && (opens || EN_VERB_LEAD.test(before))) {
      request = true;
      take(scan, at);
    } else if (/^(?:mi|mu)$/.test(word) && /(?:alim|elim)$/.test(before)) {
      // "yapalım mı", "hazırlayalım mı": a suggestion, not a question.
      request = true;
      take(scan, at);
    } else if (TR_QUESTION.test(word) || (opens && EN_QUESTION.test(word))) {
      question = true;
      take(scan, at);
    }
  });
  return { request, question };
}

// ---- the topic ---------------------------------------------------------------

type Run = { start: number; end: number; from: number; to: number };

function runsOf(scan: Scan): Run[] {
  const { roles, tokens } = scan;
  const runs: Run[] = [];
  let at = 0;
  while (at < tokens.length) {
    if (roles[at] === "taken") {
      at += 1;
      continue;
    }
    let end = at;
    while (
      end + 1 < tokens.length &&
      roles[end + 1] !== "taken" &&
      tokens[end + 1]?.sentence === tokens[at]?.sentence
    ) {
      end += 1;
    }
    let from = at;
    let to = end;
    while (from <= to && roles[from] === "glue") from += 1;
    while (to >= from && roles[to] === "glue") to -= 1;
    if (roles.slice(from, to + 1).includes("free")) {
      runs.push({ start: at, end, from, to });
    }
    at = end + 1;
  }
  return runs;
}

function topicText(scan: Scan, run: Run): string | undefined {
  const first = scan.tokens[run.from];
  const last = scan.tokens[run.to];
  if (!first || !last || run.to - run.from + 1 > TOPIC_MAX_WORDS) {
    return undefined;
  }
  const letters = scan.tokens
    .slice(run.from, run.to + 1)
    .filter((_, offset) => scan.roles[run.from + offset] === "free")
    .reduce((sum, token) => sum + token.word.length, 0);
  const text = scan.text
    .slice(first.start, last.end)
    .replace(/\s+/g, " ")
    .trim();
  return letters >= TOPIC_MIN_LETTERS && text.length <= TOPIC_MAX_CHARS
    ? text
    : undefined;
}

function isTopicMarker(word: string): boolean {
  return [AFTER_STRONG, AFTER_WEAK, BEFORE_STRONG, BEFORE_WEAK].some(
    (pattern) => pattern.test(word),
  );
}

// A day word that ends a name ("Black Friday", "Anneler Günü", "Mother's
// Day"): right after a word of the topic, not after a time, a count or a topic
// marker ("on Friday", "next week", "3 gün").
function namesDay(scan: Scan, at: number): boolean {
  let before = at - 1;
  while (isSuffix(scan, before)) before -= 1;
  const token = scan.tokens[before];
  return (
    token !== undefined &&
    token.sentence === scan.tokens[at]?.sentence &&
    scan.roles[before] === "free" &&
    !isTopicMarker(token.word)
  );
}

// The phrase next to a topic word ("about X", "X hakkında"; "for X", "X için"
// when nothing stronger says it); else the one phrase left, if there is one.
function readTopic(scan: Scan): string | undefined {
  const markers = scan.tokens.map((token, at) => {
    if (scan.claimed[at] || isSuffix(scan, at)) return null;
    for (const [pattern, after, strong] of [
      [AFTER_STRONG, true, true],
      [BEFORE_STRONG, false, true],
      [AFTER_WEAK, true, false],
      [BEFORE_WEAK, false, false],
    ] as const) {
      if (pattern.test(token.word)) return { at, after, strong };
    }
    return null;
  });
  for (const marker of markers) if (marker) take(scan, marker.at);
  const runs = runsOf(scan);
  for (const strong of [true, false]) {
    for (const marker of markers) {
      if (!marker || marker.strong !== strong) continue;
      const run = runs.find((candidate) =>
        marker.after
          ? candidate.start === marker.at + 1
          : candidate.end === marker.at - 1,
      );
      const text = run ? topicText(scan, run) : undefined;
      if (text) return text;
    }
  }
  const only = runs.length === 1 ? runs[0] : undefined;
  return only ? topicText(scan, only) : undefined;
}

// ---- routing -------------------------------------------------------------------

function chat(): RoutedIntent {
  return { module: null, prefill: {} };
}

export function routeIntent(text: string): RoutedIntent {
  const scan = scanOf(text);
  const count = scan.tokens.length;
  if (count === 0 || count > MAX_TOKENS) return chat();

  const channels = readChannels(scan);
  const { scores, story } = readModules(scan);
  if (channels.size > 0) scores.social += 1;
  const rhythm = rhythmOf(readCounts(scan));
  const shape = readShape(scan);
  const briefCue =
    story || rhythm.perWeek !== undefined || rhythm.weeks !== undefined;
  const asks: Shape = shape.request
    ? "request"
    : shape.question || (/\?\s*$/.test(text) && !briefCue)
      ? "question"
      : "statement";
  if (asks === "question") return chat();

  const [top, second] = [...MODULE_KEYS].sort((a, b) => scores[b] - scores[a]);
  if (!top || !second) return chat();
  if (scores[top] === 0 || scores[top] === scores[second]) return chat();
  if (scores[top] < MIN_SCORE) {
    // A channel name alone: Social, when the text also says how much or is
    // nothing but channel names ("Instagram and Facebook").
    const onlyChannels = scan.tokens.every(
      (token, at) => scan.channelAt[at] || CONNECTOR.test(token.word),
    );
    if (
      top !== "social" ||
      channels.size === 0 ||
      !(briefCue || onlyChannels)
    ) {
      return chat();
    }
  }

  for (const [at, token] of scan.tokens.entries()) {
    if (scan.claimed[at] || scan.roles[at] === "taken") continue;
    const { word } = token;
    if (GLUE.test(word) || isSuffix(scan, at)) {
      scan.roles[at] = "glue";
    } else if (SOFT.test(word)) {
      scan.roles[at] = "soft";
    } else if (DAY.test(word) && namesDay(scan, at)) {
      // Stays in the topic: "Black Friday", "Anneler Günü".
    } else if (STOP.test(word) || TIME.test(word)) {
      take(scan, at);
    } else if (word === "yaz" && endsClause(scan, at)) {
      take(scan, at);
    }
  }
  const topic = readTopic(scan);
  const named = CHANNEL_KEYS.filter((key) => channels.has(key));
  const prefill: IntentPrefill = {
    ...(named.length > 0
      ? { channels: named }
      : story
        ? { channels: ["instagram"] }
        : {}),
    ...(story ? { story: true } : {}),
    ...rhythm,
    ...(topic ? { topic } : {}),
  };
  return { module: top, prefill };
}
