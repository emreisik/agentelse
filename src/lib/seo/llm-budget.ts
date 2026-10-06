// Google dizgisi bütçesi (docs/google-search-console-plan.md SC-F4): bir LLM
// çağrısına ya da sohbet aracı sonucuna giden farklı Google dizgisi (sorgu
// metni, sayfa yolu) sayısı en çok 20'dir. Öğeler sırayla yürünür; öğenin yeni
// dizgileri sığıyorsa öğe olduğu gibi kalır, sığmıyorsa ya düşer ya da
// (strip verilmişse) yalnız zaten kabul edilmiş dizgileriyle kalır. Boş
// dizgiler sayılmaz. Saf ve izomorfik.

export const LLM_GOOGLE_STRING_LIMIT = 20;

export function limitGoogleStrings<T>(
  items: readonly T[],
  stringsOf: (item: T) => readonly string[],
  options: {
    limit?: number;
    strip?: (item: T, allowed: ReadonlySet<string>) => T | null;
  } = {},
): { items: T[]; used: number; dropped: number } {
  const limit = Math.max(0, options.limit ?? LLM_GOOGLE_STRING_LIMIT);
  const accepted = new Set<string>();
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const fresh = new Set(
      stringsOf(item).filter(
        (value) => value.length > 0 && !accepted.has(value),
      ),
    );
    if (accepted.size + fresh.size <= limit) {
      for (const value of fresh) accepted.add(value);
      kept.push(item);
      continue;
    }
    if (!options.strip) {
      dropped += 1;
      continue;
    }
    const stripped = options.strip(item, new Set(accepted));
    if (stripped === null) {
      dropped += 1;
      continue;
    }
    // Güvenlik ağı: strip sözleşmeye uymayıp yeni dizgi bıraktıysa sığanlar
    // sayılır, sığmıyorsa öğe düşer (sınır asla aşılmaz).
    const leftover = new Set(
      stringsOf(stripped).filter(
        (value) => value.length > 0 && !accepted.has(value),
      ),
    );
    if (accepted.size + leftover.size > limit) {
      dropped += 1;
      continue;
    }
    for (const value of leftover) accepted.add(value);
    kept.push(stripped);
  }
  return { items: kept, used: accepted.size, dropped };
}

// Sırası korunmuş, boş olmayan farklı dizgilerin ilk `limit` tanesi.
export function takeDistinct(
  strings: readonly string[],
  limit: number = LLM_GOOGLE_STRING_LIMIT,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of strings) {
    if (out.length >= limit) break;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
