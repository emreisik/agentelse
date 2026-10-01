// Text folding for matching (pure, isomorphic): "İNDİRİM", "indirim" and
// "INDIRIM" are the same word, "Görsel" and "gorsel" too.
//
// Same algorithm as the private `fold` in src/server/memory/relevance.ts.
// Deliberately NOT toLocaleLowerCase("tr-TR"): under that locale ASCII "I"
// becomes dotless "ı", which turns "Instagram" into "ınstagram" (see
// src/server/commands/intent-router.ts, parseIntent).
export function foldForMatch(text: string): string {
  return text
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

// Letters and digits of ANY script. relevance.ts's tokenizer splits on
// /[^a-z0-9]+/, which drops every Cyrillic, Greek and Arabic word, so it must
// NOT be reused for matching user text.
export function tokenizeFolded(text: string): string[] {
  return foldForMatch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export type FoldedToken = { token: string; start: number; end: number };

// Same tokens as tokenizeFolded, plus their [start, end) range in the ORIGINAL
// text (folding can change the length, so offsets are taken before folding).
// Combining marks stay inside a word so a decomposed "ç" is not split.
export function foldedTokensWithRange(text: string): FoldedToken[] {
  const out: FoldedToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const token = foldForMatch(match[0]);
    if (!token) continue;
    const start = match.index ?? 0;
    out.push({ token, start, end: start + match[0].length });
  }
  return out;
}
