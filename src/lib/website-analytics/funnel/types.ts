// Huni raporu tipleri (GA-F8, docs/website-agency.md "Huni raporu"). Saf
// modül: sunucu içe aktarmaz, testlerde ve tsx altında güvenle yüklenir.

export type FunnelStepKind = "event" | "page";

// Kullanıcının tanımladığı adım: görünen ad + olay adı ya da sayfa yolu.
export type FunnelStep = {
  name: string;
  kind: FunnelStepKind;
  value: string;
};

export type FunnelDefinition = {
  name: string;
  // Açık huni: kullanıcı herhangi bir adımdan girebilir; kapalıda ilk adımdan.
  isOpen: boolean;
  periodDays: number;
  steps: FunnelStep[];
};

// Mülkün saat diliminde "YYYY-MM-DD" (iki uç dahil).
export type FunnelRange = { startDate: string; endDate: string };

// Saklanan sonuç: yalnız toplulaştırılmış sayılar.
export type FunnelStepResult = {
  name: string;
  users: number;
  // 0..1 aralığında; Google'ın yanıtında yoksa null.
  completionRate: number | null;
  abandonments: number | null;
  abandonmentRate: number | null;
};

export type FunnelResult = {
  // Verinin son günü (mülkün saat diliminde).
  through: string;
  steps: FunnelStepResult[];
};
