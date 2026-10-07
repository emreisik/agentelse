// Ajans müşterisine giden (white-label) rapor belgesi: GA-F5 kartından
// dönüştürülen, yalnız düz metin taşıyan blok listesi. Markdown dışa aktarma,
// yazdırma sayfası ve paylaşım sayfası aynı belgeyi çizer; hiçbir blokta
// bağlantı (href) yoktur. Saf ve izomorfik.

export type ClientDocTone = "up" | "down" | "flat";

export type ClientDocKpi = {
  label: string;
  value: string;
  delta: string | null;
  tone: ClientDocTone | null;
};

export type ClientDocBlock =
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "paragraph"; text: string; muted?: boolean }
  | { type: "bullets"; items: string[] }
  | { type: "kpis"; items: ClientDocKpi[] }
  | {
      type: "table";
      title: string | null;
      columns: string[];
      rows: string[][];
      note: string | null;
    };

export type ClientDoc = {
  title: string;
  subtitle: string | null;
  periodLabel: string;
  clientName: string;
  builtAt: string;
  isDemo: boolean;
  blocks: ClientDocBlock[];
  footnotes: string[];
};
