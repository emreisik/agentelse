// "Mülkü adından otomatik seç" (GA-F8, toplu bağlama): bir projenin adı ve
// alan adı ile Google hesabının GA4 mülk listesini karşılaştırır. YALNIZ tek ve
// net kazananı döndürür: yanlış eşleşme başka müşterinin analitiğini gösterir,
// bu yüzden belirsizlikte null döner (kullanıcı elle seçer). Saf modül.

type Property = { propertyId: string; propertyName: string; accountName: string };

const MIN_BEST = 0.5;
const MIN_LEAD = 0.2;
// Kısa dizgilerin tesadüfen içermesi eşleşme sayılmasın.
const MIN_CONTAINED_LENGTH = 4;

// Eşleşmeye bilgi katmayan sözcükler.
const NOISE = new Set([
  "www",
  "com",
  "net",
  "org",
  "co",
  "io",
  "app",
  "site",
  "web",
  "website",
  "ga",
  "ga4",
  "ua",
  "analytics",
  "property",
  "the",
  "and",
  "ltd",
  "inc",
  "llc",
  "gmbh",
  "https",
  "http",
]);

// Küçük harf, aksan düşürülmüş, harf/rakam dışı boşluk.
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return fold(value)
    .split(" ")
    .filter((token) => token.length > 0 && !NOISE.has(token));
}

function compact(value: string): string {
  return tokens(value).join("");
}

// Alan adından etiket: "https://www.Acme-Shop.co.uk/x" -> "acme-shop".
function domainLabel(domain: string): string {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return host;
  // İkinci düzey genel eklentiler (co.uk, com.tr, org.au ...) birlikte düşer.
  const secondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
  const last2 = parts[parts.length - 2] ?? "";
  const cut = parts.length >= 3 && secondLevel.has(last2) ? 2 : 1;
  return parts.slice(0, parts.length - cut).join(".");
}

// İki ad arasındaki benzerlik, 0..1.
function similarity(a: string, b: string): number {
  const ca = compact(a);
  const cb = compact(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  let best = 0;
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= MIN_CONTAINED_LENGTH && long.includes(short)) {
    best = 0.6 + 0.3 * (short.length / long.length);
  }
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const shared = [...ta].filter((token) => tb.has(token)).length;
  const union = new Set([...ta, ...tb]).size;
  if (union > 0 && shared > 0) {
    best = Math.max(best, 0.95 * (shared / union));
  }
  return best;
}

function scoreOf(keys: readonly string[], property: Property): number {
  let best = 0;
  for (const key of keys) {
    best = Math.max(
      best,
      similarity(key, property.propertyName),
      // Hesap adı daha zayıf kanıttır (bir hesapta birçok mülk olur).
      0.8 * similarity(key, property.accountName),
    );
  }
  return best;
}

// Tek ve net kazanan (en iyi >= 0.5 ve ikinciyle fark >= 0.2) ya da null.
export function suggestGaProperty(
  project: { name: string; domain: string | null },
  properties: readonly Property[],
): string | null {
  if (properties.length === 0) return null;
  const keys = [project.name];
  if (project.domain) {
    const label = domainLabel(project.domain);
    if (label) keys.push(label);
  }
  const scored = properties
    .map((property) => ({
      propertyId: property.propertyId,
      score: scoreOf(keys, property),
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < MIN_BEST) return null;
  const runnerUp = scored[1];
  // Kayan nokta payı: 1 - 0.8 tam 0.2 sayılır.
  if (runnerUp && best.score - runnerUp.score < MIN_LEAD - 1e-9) return null;
  return best.propertyId;
}
