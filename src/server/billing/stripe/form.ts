// Stripe istek gövdesi: application/x-www-form-urlencoded, iç içe nesneler köşeli
// parantezle (a[b][c]=v), diziler dizinle (a[0][b]=v). null/undefined alanlar atlanır
// (Stripe'ta alanı SİLMEK için boş dize gönderilir; bu istemci yalnız yaratır/günceller).
// Saf ve birim testli.

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FormValue[]
  | { readonly [key: string]: FormValue };

function pushPairs(
  prefix: string,
  value: FormValue,
  pairs: Array<[string, string]>,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      pushPairs(`${prefix}[${index}]`, item, pairs),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(
      value as Record<string, FormValue>,
    )) {
      pushPairs(`${prefix}[${key}]`, inner, pairs);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${prefix} must be a finite number`);
    }
    pairs.push([prefix, String(value)]);
    return;
  }
  pairs.push([prefix, String(value)]);
}

export function encodeForm(params: Record<string, FormValue>): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    pushPairs(key, value, pairs);
  }
  return pairs
    .map(([key, value]) => `${encodeKey(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

// Parantezler okunur kalsın; diğer her şey yüzde-kodlanır.
function encodeKey(key: string): string {
  return key
    .split(/(\[|\])/)
    .map((part) =>
      part === "[" || part === "]" ? part : encodeURIComponent(part),
    )
    .join("");
}
