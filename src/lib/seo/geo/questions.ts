// Soru biçimli başlık tespiti (SC-F8 GEO8). Başlık "?" taşıyorsa ya da bu
// dillerden birinde bir soru sözcüğüyle başlıyorsa (en, tr, de, fr, es, it,
// nl, pt) sorudur. Sezgiseldir (doğrulanmalı): "Who we are" gibi bir başlık da
// soru sayılabilir. Saf modül.

const MAX_LENGTH = 200;

// Aksan ve noktasız ı atılmış, küçük harf, ilk sözcükle karşılaştırılan listeler.
const INTERROGATIVES: ReadonlySet<string> = new Set([
  // en
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "which",
  "can",
  "could",
  "should",
  "would",
  "will",
  "is",
  "are",
  "do",
  "does",
  "did",
  "was",
  "were",
  "has",
  "have",
  "may",
  "might",
  // tr
  "ne",
  "nasil",
  "neden",
  "nicin",
  "niye",
  "nerede",
  "nereye",
  "nereden",
  "kim",
  "kimler",
  "kimin",
  "hangi",
  "kac",
  "kaca",
  // de
  "was",
  "wie",
  "warum",
  "wieso",
  "weshalb",
  "wann",
  "wo",
  "wohin",
  "woher",
  "wer",
  "wen",
  "wem",
  "welche",
  "welcher",
  "welches",
  "welchen",
  "ist",
  "sind",
  "kann",
  "konnen",
  "gibt",
  "darf",
  "muss",
  // fr
  "que",
  "quoi",
  "qui",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "quand",
  "ou",
  "comment",
  "pourquoi",
  "combien",
  "est-ce",
  "peut-on",
  // es
  "como",
  "cuando",
  "donde",
  "quien",
  "quienes",
  "cual",
  "cuales",
  "cuanto",
  "cuantos",
  "cuanta",
  "cuantas",
  "es",
  "puedo",
  "puede",
  // it
  "cosa",
  "che",
  "come",
  "perche",
  "quando",
  "dove",
  "chi",
  "quale",
  "quali",
  "quanto",
  "quanti",
  "quanta",
  "quante",
  // nl
  "wat",
  "waarom",
  "waarvoor",
  "wanneer",
  "waar",
  "hoe",
  "welke",
  "welk",
  "kan",
  "kun",
  "moet",
  "zijn",
  "heeft",
  "hebben",
  "wordt",
  // pt
  "qual",
  "quais",
  "quem",
  "onde",
  "porque",
  "quanto",
  "quantos",
  "quantas",
  "posso",
  "pode",
]);

// "qu'est-ce que", "qu'est" gibi kesmeli başlangıçlar.
const APOSTROPHE_PREFIXES = ["qu'", "qu’", "l'", "d'"];

function foldWord(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase();
}

// "1.", "Q:", "•" gibi numara ve imleri başlıktan atar.
function stripMarkers(text: string): string {
  return text
    .replace(/^\s*(?:[-•*·]|\d+[.)]|q\s*[:.)])\s*/i, "")
    .replace(/^["'“”‘’«»\s]+/, "");
}

export function isQuestionHeading(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  if (!flat) return false;
  if (/[?？¿]/.test(flat)) return true;
  const words = stripMarkers(flat).split(" ").filter(Boolean);
  // Soru işareti yoksa tek sözcüklük başlık ("Nasıl") soru sayılmaz.
  if (words.length < 2) return false;
  const first = foldWord(words[0] ?? "").replace(/[,:;.!]+$/, "");
  if (!first) return false;
  if (INTERROGATIVES.has(first)) return true;
  return APOSTROPHE_PREFIXES.some((prefix) => first.startsWith(prefix));
}
