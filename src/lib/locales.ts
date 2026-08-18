// Proje kurulumunda seçilen dil/ülke — tüm AI research ve reasoning
// çağrılarının hangi dilde ve hangi pazara odaklı çalışacağını belirler.
// Tek kaynak: hem <select> seçenekleri hem server action validasyonu burayı
// kullanır.

export const SUPPORTED_LANGUAGES = [
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "İngilizce" },
  { code: "de", label: "Almanca" },
  { code: "fr", label: "Fransızca" },
  { code: "es", label: "İspanyolca" },
  { code: "it", label: "İtalyanca" },
  { code: "nl", label: "Felemenkçe" },
  { code: "ru", label: "Rusça" },
  { code: "ar", label: "Arapça" },
  { code: "sq", label: "Arnavutça" },
  { code: "mk", label: "Makedonca" },
  { code: "sr", label: "Sırpça" },
  { code: "bg", label: "Bulgarca" },
  { code: "el", label: "Yunanca" },
] as const;

export const SUPPORTED_COUNTRIES = [
  { code: "TR", label: "Türkiye" },
  { code: "MK", label: "Kuzey Makedonya" },
  { code: "AL", label: "Arnavutluk" },
  { code: "XK", label: "Kosova" },
  { code: "RS", label: "Sırbistan" },
  { code: "BG", label: "Bulgaristan" },
  { code: "GR", label: "Yunanistan" },
  { code: "RO", label: "Romanya" },
  { code: "BA", label: "Bosna Hersek" },
  { code: "ME", label: "Karadağ" },
  { code: "HR", label: "Hırvatistan" },
  { code: "DE", label: "Almanya" },
  { code: "AT", label: "Avusturya" },
  { code: "CH", label: "İsviçre" },
  { code: "NL", label: "Hollanda" },
  { code: "BE", label: "Belçika" },
  { code: "FR", label: "Fransa" },
  { code: "IT", label: "İtalya" },
  { code: "ES", label: "İspanya" },
  { code: "PT", label: "Portekiz" },
  { code: "GB", label: "Birleşik Krallık" },
  { code: "IE", label: "İrlanda" },
  { code: "PL", label: "Polonya" },
  { code: "SE", label: "İsveç" },
  { code: "NO", label: "Norveç" },
  { code: "DK", label: "Danimarka" },
  { code: "AE", label: "Birleşik Arap Emirlikleri" },
  { code: "SA", label: "Suudi Arabistan" },
  { code: "US", label: "Amerika Birleşik Devletleri" },
  { code: "CA", label: "Kanada" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];
export type CountryCode = (typeof SUPPORTED_COUNTRIES)[number]["code"];

// Proje kurulum sihirbazında kıta bazlı hızlı pazar seçimi için — sadece bir
// UI kısayolu, backend'de karşılığı yok: seçildiğinde SUPPORTED_COUNTRIES
// içindeki somut ülke kodlarına açılır.
export const COUNTRY_CONTINENTS: {
  id: string;
  label: string;
  countryCodes: CountryCode[];
}[] = [
  {
    id: "europe",
    label: "Avrupa",
    countryCodes: [
      "TR",
      "MK",
      "AL",
      "XK",
      "RS",
      "BG",
      "GR",
      "RO",
      "BA",
      "ME",
      "HR",
      "DE",
      "AT",
      "CH",
      "NL",
      "BE",
      "FR",
      "IT",
      "ES",
      "PT",
      "GB",
      "IE",
      "PL",
      "SE",
      "NO",
      "DK",
    ],
  },
  { id: "asia", label: "Asya (Orta Doğu)", countryCodes: ["AE", "SA"] },
  { id: "north-america", label: "Kuzey Amerika", countryCodes: ["US", "CA"] },
];

export function isSupportedLanguage(value: string): value is LanguageCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === value);
}

export function isSupportedCountry(value: string): value is CountryCode {
  return SUPPORTED_COUNTRIES.some((c) => c.code === value);
}

export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function countryLabel(code: string): string {
  return SUPPORTED_COUNTRIES.find((c) => c.code === code)?.label ?? code;
}
