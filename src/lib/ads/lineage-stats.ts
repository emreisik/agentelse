// Nitelik etkilerinin istatistiği (docs/meta-ads-autonomy.md): hangi kanca
// tipi, teklif, biçim ya da uzunluk sonuçları daha ucuza getiriyor? Saf ve
// belirleyici. Karşılaştırma yalnız aynı tarif (aynı sonuç türü) içinde yapılır:
// lead maliyetiyle tıklama maliyeti kıyaslanamaz.

export type LineageAdRow = {
  recipe: string;
  adId: string;
  tags: Record<string, string>;
  spendMinor: number;
  results: number;
};

export type TagFinding = {
  recipe: string;
  key: string;
  value: string;
  // WORKS: bu niteliğin reklamları diğerlerinden ucuz; AVOID: pahalı.
  polarity: "WORKS" | "AVOID";
  // Niteliğin sonuç başına maliyeti / diğerlerininki (0,7 = %30 ucuz).
  ratio: number;
  resultsIn: number;
  resultsRest: number;
  adsIn: number;
  adsRest: number;
  z: number;
};

// Her iki tarafta en az bu kadar sonuç ve en az iki reklam: tek bir reklamın
// başarısı "nitelik" sayılmaz, küçük örnekte gürültü kural olmaz.
export const MIN_SIDE_RESULTS = 10;
export const MIN_SIDE_ADS = 2;
// %95 güven (iki yönlü) ve en az %15 fark: ikisi birden gerekir.
export const MIN_Z = 1.96;
export const MIN_EFFECT = 0.15;

type Side = { spend: number; results: number; ads: Set<string> };

function sideOf(rows: readonly LineageAdRow[]): Side {
  const side: Side = { spend: 0, results: 0, ads: new Set() };
  for (const row of rows) {
    side.spend += row.spendMinor;
    side.results += row.results;
    side.ads.add(row.adId);
  }
  return side;
}

export function findTagEffects(rows: readonly LineageAdRow[]): TagFinding[] {
  const findings: TagFinding[] = [];
  const recipes = [...new Set(rows.map((r) => r.recipe))];
  for (const recipe of recipes) {
    const inRecipe = rows.filter(
      (r) => r.recipe === recipe && r.spendMinor > 0 && r.results >= 0,
    );
    const keys = [...new Set(inRecipe.flatMap((r) => Object.keys(r.tags)))];
    for (const key of keys) {
      const withKey = inRecipe.filter((r) => r.tags[key] !== undefined);
      const values = [...new Set(withKey.map((r) => r.tags[key]!))];
      if (values.length < 2) continue;
      for (const value of values) {
        const inSide = sideOf(withKey.filter((r) => r.tags[key] === value));
        const rest = sideOf(withKey.filter((r) => r.tags[key] !== value));
        if (
          inSide.results < MIN_SIDE_RESULTS ||
          rest.results < MIN_SIDE_RESULTS ||
          inSide.ads.size < MIN_SIDE_ADS ||
          rest.ads.size < MIN_SIDE_ADS ||
          inSide.spend <= 0 ||
          rest.spend <= 0
        ) {
          continue;
        }
        // Sonuç oranı (harcama başına): yüksek = ucuz.
        const rateIn = inSide.results / inSide.spend;
        const rateRest = rest.results / rest.spend;
        const ratio = rateRest / rateIn; // maliyet oranı
        const z =
          Math.log(rateIn / rateRest) /
          Math.sqrt(1 / inSide.results + 1 / rest.results);
        if (Math.abs(z) < MIN_Z || Math.abs(1 - ratio) < MIN_EFFECT) continue;
        findings.push({
          recipe,
          key,
          value,
          polarity: ratio < 1 ? "WORKS" : "AVOID",
          ratio,
          resultsIn: inSide.results,
          resultsRest: rest.results,
          adsIn: inSide.ads.size,
          adsRest: rest.ads.size,
          z,
        });
      }
    }
  }
  // En güçlü kanıt önce.
  return findings.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

const SUBJECT: Record<string, Record<string, string>> = {
  hook: {
    question: "Ads that open with a question",
    number: "Ads that open with a number",
    urgency: "Ads that open with urgency",
    proof: "Ads that open with social proof",
    "how-to": "How-to ads",
    benefit: "Ads that open with a benefit",
    statement: "Ads that open with a plain statement",
  },
  offer: {
    discount: "Ads with a discount",
    free: "Ads offering something free",
    price: "Ads that show a price",
    none: "Ads with no offer",
  },
  format: {
    image: "Single-image ads",
    video: "Video ads",
    carousel: "Carousel ads",
  },
  length: {
    short: "Ads with short copy",
    medium: "Ads with medium-length copy",
    long: "Ads with long copy",
  },
};

const KEY_NOUN: Record<string, string> = {
  hook: "hooks",
  offer: "offers",
  format: "formats",
  length: "copy lengths",
  cta: "buttons",
  pillar: "topics",
  ideaSource: "idea sources",
};

export function findingSubject(finding: Pick<TagFinding, "key" | "value">): string {
  const known = SUBJECT[finding.key]?.[finding.value];
  if (known) return known;
  if (finding.key === "cta") {
    return `Ads with the "${finding.value.replace(/_/g, " ")}" button`;
  }
  if (finding.key === "pillar") {
    return `Ads on the "${finding.value.replace(/-/g, " ")}" topic`;
  }
  if (finding.key === "ideaSource") {
    return `Ads from ${finding.value} ideas`;
  }
  return `Ads tagged ${finding.key}=${finding.value}`;
}

export function findingText(
  finding: TagFinding,
  resultLabel: string,
): string {
  const pct = Math.round(Math.abs(1 - finding.ratio) * 100);
  const cheaper = finding.polarity === "WORKS";
  const noun = KEY_NOUN[finding.key] ?? "variants";
  return `${findingSubject(finding)} cost ${pct}% ${cheaper ? "less" : "more"} per ${resultLabel} than the other ${noun} (${finding.resultsIn} vs ${finding.resultsRest} results, ${finding.adsIn} and ${finding.adsRest} ads, 95% confidence).`;
}

// Aynı bulgu her hafta aynı kimlikle güncellenir (yeni satır eklenmez).
export function findingRef(finding: Pick<TagFinding, "recipe" | "key" | "value">): string {
  return `lineage:${finding.recipe}:${finding.key}:${finding.value}`;
}
