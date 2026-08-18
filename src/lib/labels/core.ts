import type {
  ApprovalLevel,
  ApprovalStatus,
  ApprovalType,
  BrowserProfileStatus,
  CapabilityKey,
  CreativeStatus,
  ExecutionJobStatus,
  HumanInterventionStatus,
  HumanInterventionType,
  ProjectStatus,
  RiskLevel,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const TASK_STATUS: EnumMap<TaskStatus> = {
  DRAFT: { label: "Taslak", tone: "neutral" },
  READY: { label: "Hazır", tone: "neutral" },
  QUEUED: { label: "Kuyrukta", tone: "waiting" },
  RUNNING: { label: "Çalışıyor", tone: "active" },
  WAITING_INPUT: { label: "Girdi Bekliyor", tone: "waiting" },
  WAITING_HUMAN: { label: "İnsan Bekliyor", tone: "waiting" },
  WAITING_APPROVAL: { label: "Onay Bekliyor", tone: "waiting" },
  WAITING_PROVIDER: { label: "Sağlayıcı Bekliyor", tone: "waiting" },
  VERIFYING: { label: "Doğrulanıyor", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  FAILED: { label: "Başarısız", tone: "danger" },
  BLOCKED: { label: "Engellendi", tone: "danger" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
};

// Kanban column grouping for the İşler (task) board — IDEA_BOARD_COLUMNS'un
// (ideas.ts) görev yaşam döngüsü karşılığı. TaskStatus'un 13 değeri 5 sütuna
// gruplanır ki Fikirler panosuyla aynı görsel yoğunlukta kalsın.
export const TASK_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: TaskStatus[];
}> = [
  {
    key: "hazirlaniyor",
    label: "Hazırlanıyor",
    statuses: ["DRAFT", "READY", "QUEUED"],
  },
  { key: "calisiyor", label: "Çalışıyor", statuses: ["RUNNING", "VERIFYING"] },
  {
    key: "bekliyor",
    label: "Bekliyor",
    statuses: [
      "WAITING_INPUT",
      "WAITING_HUMAN",
      "WAITING_APPROVAL",
      "WAITING_PROVIDER",
    ],
  },
  { key: "tamamlandi", label: "Tamamlandı", statuses: ["COMPLETED"] },
  {
    key: "sorunlu",
    label: "Sorunlu",
    statuses: ["FAILED", "BLOCKED", "CANCELLED"],
  },
];

export const TASK_PRIORITY: EnumMap<TaskPriority> = {
  LOW: { label: "Düşük", tone: "neutral" },
  MEDIUM: { label: "Orta", tone: "neutral" },
  HIGH: { label: "Yüksek", tone: "waiting" },
  URGENT: { label: "Acil", tone: "danger" },
};

export const RISK_LEVEL: EnumMap<RiskLevel> = {
  LOW: { label: "Düşük Risk", tone: "positive" },
  MEDIUM: { label: "Orta Risk", tone: "neutral" },
  HIGH: { label: "Yüksek Risk", tone: "waiting" },
  CRITICAL: { label: "Kritik Risk", tone: "danger" },
};

export const PROJECT_STATUS: EnumMap<ProjectStatus> = {
  CREATED: { label: "Oluşturuldu", tone: "neutral" },
  DISCOVERY: { label: "Keşif", tone: "active" },
  NEEDS_INFORMATION: { label: "Bilgi Gerekli", tone: "waiting" },
  PROFILE_REVIEW: { label: "Profil İncelemesi", tone: "waiting" },
  NEEDS_ASSESSMENT: { label: "Değerlendirme Gerekli", tone: "waiting" },
  STRATEGY: { label: "Strateji", tone: "active" },
  ACTIVE: { label: "Aktif", tone: "positive" },
  PAUSED: { label: "Duraklatıldı", tone: "neutral" },
  CLOSED: { label: "Kapatıldı", tone: "neutral" },
};

export const APPROVAL_STATUS: EnumMap<ApprovalStatus> = {
  PENDING: { label: "Bekliyor", tone: "waiting" },
  APPROVED: { label: "Onaylandı", tone: "positive" },
  REJECTED: { label: "Reddedildi", tone: "danger" },
  REVISION_REQUESTED: { label: "Revizyon İstendi", tone: "waiting" },
  EXPIRED: { label: "Süresi Doldu", tone: "neutral" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
};

export const APPROVAL_TYPE: EnumMap<ApprovalType> = {
  CREATIVE_APPROVAL: { label: "Kreatif Onayı", tone: "active" },
  PUBLISH_APPROVAL: { label: "Yayın Onayı", tone: "waiting" },
  CAMPAIGN_APPROVAL: { label: "Kampanya Onayı", tone: "waiting" },
  ACCOUNT_ACTION_APPROVAL: { label: "Hesap İşlemi Onayı", tone: "waiting" },
  CRITICAL_CHANGE_APPROVAL: {
    label: "Kritik Değişiklik Onayı",
    tone: "danger",
  },
  GENERIC: { label: "Genel Onay", tone: "neutral" },
};

export const APPROVAL_LEVEL: EnumMap<ApprovalLevel> = {
  LEVEL_0_AUTO_OBSERVE: { label: "S0 · Otomatik Gözlem", tone: "neutral" },
  LEVEL_1_INTERNAL_AUTOMATIC: { label: "S1 · İç Otomatik", tone: "neutral" },
  LEVEL_2_AGENCY_DIRECTOR: { label: "S2 · Ajans Direktörü", tone: "active" },
  LEVEL_3_CLIENT: { label: "S3 · Müşteri Onayı", tone: "waiting" },
  LEVEL_4_CRITICAL: { label: "S4 · Kritik Onay", tone: "danger" },
};

export const HUMAN_INTERVENTION_TYPE: EnumMap<HumanInterventionType> = {
  OTP_REQUIRED: { label: "OTP Gerekli", tone: "waiting" },
  MFA_REQUIRED: { label: "MFA Gerekli", tone: "waiting" },
  LOGIN_REQUIRED: { label: "Giriş Gerekli", tone: "waiting" },
  CAPTCHA_REQUIRED: { label: "CAPTCHA Gerekli", tone: "waiting" },
  CONFIRMATION_REQUIRED: { label: "Onay Gerekli", tone: "waiting" },
  MANUAL_BROWSER_REQUIRED: {
    label: "Manuel Tarayıcı Gerekli",
    tone: "waiting",
  },
  ACCOUNT_SELECTION_REQUIRED: {
    label: "Hesap Seçimi Gerekli",
    tone: "waiting",
  },
  FILE_REQUIRED: { label: "Dosya Gerekli", tone: "waiting" },
  INFORMATION_REQUIRED: { label: "Bilgi Gerekli", tone: "waiting" },
  DECISION_REQUIRED: { label: "Karar Gerekli", tone: "waiting" },
};

export const HUMAN_INTERVENTION_STATUS: EnumMap<HumanInterventionStatus> = {
  PENDING: { label: "Bekliyor", tone: "waiting" },
  RESOLVED: { label: "Çözüldü", tone: "positive" },
  EXPIRED: { label: "Süresi Doldu", tone: "neutral" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
};

// Connection health of a project's per-platform browser session — the
// layer CapabilityRouter actually dispatches publish/ads jobs through.
export const BROWSER_PROFILE_STATUS: EnumMap<BrowserProfileStatus> = {
  READY: { label: "Bağlı", tone: "positive" },
  RUNNING: { label: "Çalışıyor", tone: "active" },
  WAITING: { label: "Bekliyor", tone: "waiting" },
  LOGIN_REQUIRED: { label: "Giriş Gerekli", tone: "danger" },
  MFA_REQUIRED: { label: "MFA Gerekli", tone: "danger" },
  OTP_REQUIRED: { label: "OTP Gerekli", tone: "danger" },
  CAPTCHA_REQUIRED: { label: "CAPTCHA Gerekli", tone: "danger" },
  SESSION_EXPIRED: { label: "Oturum Sona Erdi", tone: "danger" },
  USER_ACTION_REQUIRED: { label: "Eylem Gerekli", tone: "danger" },
  PERMISSION_REQUIRED: { label: "İzin Gerekli", tone: "danger" },
  UNHEALTHY: { label: "Sorunlu", tone: "danger" },
  DISABLED: { label: "Devre Dışı", tone: "neutral" },
};

export const EXECUTION_JOB_STATUS: EnumMap<ExecutionJobStatus> = {
  QUEUED: { label: "Kuyrukta", tone: "waiting" },
  RUNNING: { label: "Çalışıyor", tone: "active" },
  WAITING_HUMAN: { label: "İnsan Bekliyor", tone: "waiting" },
  WAITING_PROVIDER: { label: "Sağlayıcı Bekliyor", tone: "waiting" },
  VERIFYING: { label: "Doğrulanıyor", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  FAILED: { label: "Başarısız", tone: "danger" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
};

export const CREATIVE_STATUS: EnumMap<CreativeStatus> = {
  DRAFT: { label: "Taslak", tone: "neutral" },
  IN_REVIEW: { label: "İncelemede", tone: "waiting" },
  APPROVED: { label: "Onaylandı", tone: "positive" },
  REJECTED: { label: "Reddedildi", tone: "danger" },
  PUBLISHED: { label: "Yayınlandı", tone: "positive" },
  ARCHIVED: { label: "Arşivlendi", tone: "neutral" },
};

// Hand-curated Turkish labels for the most visible capabilities; anything
// unlisted falls back to a prettified form of the enum key.
const CAPABILITY_LABELS: Partial<Record<CapabilityKey, string>> = {
  BRAND_DISCOVERY: "Marka Keşfi",
  WEB_RESEARCH: "Web Araştırması",
  PRODUCT_RESEARCH: "Ürün Araştırması",
  MARKET_RESEARCH: "Pazar Araştırması",
  CUSTOMER_INTELLIGENCE: "Müşteri İstihbaratı",
  COMPETITOR_RESEARCH: "Rakip Araştırması",
  COMPETITOR_MONITORING: "Rakip Takibi",
  SEO_RESEARCH: "SEO Araştırması",
  SEO_ANALYSIS: "SEO Analizi",
  SOCIAL_RESEARCH: "Sosyal Medya Araştırması",
  MEDIA_RESEARCH: "Medya Araştırması",
  CULTURAL_RESEARCH: "Kültürel Araştırma",
  CREATOR_RESEARCH: "Üretici Araştırması",
  PARTNERSHIP_RESEARCH: "Ortaklık Araştırması",
  ADVERTISING_RESEARCH: "Reklam Araştırması",
  REVIEW_RESEARCH: "Yorum Araştırması",
  TECHNOLOGY_RESEARCH: "Teknoloji Araştırması",
  SIGNAL_SCAN: "Sinyal Taraması",
  MEASUREMENT_CHECK: "Ölçüm Kontrolü",
  CREATE_SOCIAL_CREATIVE: "Sosyal Kreatif Üretimi",
  CREATE_AD_CREATIVE: "Reklam Kreatifi Üretimi",
  CREATE_COPY: "Metin Yazımı",
  CREATE_CAPTION: "Başlık Yazımı",
  CREATE_CAMPAIGN_BRIEF: "Kampanya Brief'i",
  CREATE_CONTENT_PLAN: "İçerik Planı",
  INSTAGRAM_PUBLISH: "Instagram Yayını",
  TIKTOK_PUBLISH: "TikTok Yayını",
  LINKEDIN_PUBLISH: "LinkedIn Yayını",
  X_PUBLISH: "X Yayını",
  META_ADS_ANALYSIS: "Meta Reklam Analizi",
  META_CAMPAIGN_CREATE: "Meta Kampanya Oluşturma",
  META_CAMPAIGN_UPDATE: "Meta Kampanya Güncelleme",
  WEBSITE_UPDATE: "Web Sitesi Güncellemesi",
  PR_OUTREACH: "PR İletişimi",
  ANALYTICS_ANALYSIS: "Analitik Analizi",
  REPORTING: "Raporlama",
  VERIFY_EXTERNAL_ACTION: "Harici Eylem Doğrulama",
  SOCIAL_ACCOUNT_SETUP: "Sosyal Hesap Kurulumu",
  ASO_ANALYSIS: "Uygulama Mağazası (ASO) Analizi",
  BRAND_SAFETY: "Marka Güvenliği Kontrolü",
  CLAIM_VALIDATION: "İddia Doğrulama",
  COMPETITOR_CHANGE_DETECTION: "Rakip Değişikliği Tespiti",
  CRM_ANALYSIS: "CRM Analizi",
  DATA_EXTRACTION: "Veri Çıkarımı",
  EMAIL_DRAFT: "E-posta Taslağı",
  EMAIL_SEND: "E-posta Gönderimi",
  GOOGLE_ADS_ANALYSIS: "Google Ads Analizi",
  GOOGLE_ADS_CAMPAIGN_CREATE: "Google Ads Kampanya Oluşturma",
  SCREENSHOT_CAPTURE: "Ekran Görüntüsü Alma",
  SOCIAL_PROFILE_AUDIT: "Sosyal Medya Profil Denetimi",
  TREND_RESEARCH: "Trend Araştırması",
  WEB_BROWSING: "Web Tarama",
};

export function capabilityLabel(key: CapabilityKey | string): string {
  const known = CAPABILITY_LABELS[key as CapabilityKey];
  if (known) return known;
  return key.replaceAll("_", " ").toLowerCase();
}

const CAPABILITY_PREFIX_RE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*):\s*/;

// Eski görev başlıkları "CREATE_CAMPAIGN_BRIEF: Güvenin Kriptografik
// Mührü..." gibi ham capability-key önekiyle üretilirdi (task-planner.ts
// artık bunu yapmıyor, ama geçmiş kayıtlarda hâlâ var). Departman rozeti
// zaten hangi ekibin işi olduğunu gösterdiğinden bu önek artık gereksiz ve
// okunaksız — kartlarda/panellerde görev başlığı gösterilen HER yerde bu
// fonksiyonla temizlenir. Yalnızca gerçek bir CapabilityKey'e denk gelen
// önekler sökülür, rastgele "TODO: ..." gibi metinler dokunulmadan kalır.
export function stripCapabilityPrefix(title: string): string {
  const match = CAPABILITY_PREFIX_RE.exec(title);
  const prefix = match?.[1];
  if (!prefix || !(prefix in CAPABILITY_LABELS)) return title;
  return title.slice(match[0].length);
}
