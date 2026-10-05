// Sunucunun hazırladığı, istemci bileşenine düz veri olarak geçen takvim
// öğeleri. Prisma tipleri sızmaz: her şey JSON'a serileştirilebilir.

import type { FormatGlyph } from "@/lib/content-channels";
import type { CalendarStage } from "./stage";

// Parçanın "nereye gidiyor" kimliği: simge, etiket ve süzgeç anahtarı.
export type CalendarSource = {
  // Süzgeç anahtarı: instagram | facebook | tiktok | linkedin | x | youtube |
  // pinterest | seo | ads | other
  key: string;
  label: string;
  // Gerçek marka simgesi varsa anahtarı (BrandIcon), yoksa null: rozet kullanılır.
  brand: "instagram" | "facebook" | "tiktok" | "linkedin" | "x" | null;
  // Marka simgesi olmayanlar için kısa kod ve renk (Blog/SEO, Ads...).
  short: string;
  color: string;
};

// Durumu istemcide yeniden hesaplamaya yetecek ham olgular. Bir parça başka
// güne taşınınca sunucuya gidip sayfayı yeniden render ettirmek yerine
// (kenar çubuğu, journey snapshot... onlarca sorgu) durum bu olgulardan
// yeniden türetilir.
export type ItemFacts = {
  // CreativeStatus
  status: string;
  hasContent: boolean;
  platform: string | null;
  channel: string | null;
  formatKey: string | null;
  // Parçanın platformunda aktif bir bağlantı var mı.
  connected: boolean;
  // Son yayın görevi (yoksa null); `at` görevin bittiği an (UTC ISO).
  task: { state: "running" | "failed" | "done"; error: string | null; at: string } | null;
};

export type CalendarItem = {
  id: string;
  title: string | null;
  // "Instagram · Carousel" ya da yalnız platform adı.
  label: string;
  source: CalendarSource;
  glyph: FormatGlyph | null;
  // UTC ISO; atanmamışsa null.
  scheduledFor: string | null;
  // Proje saat dilimindeki gün ("YYYY-MM-DD") ve saat ("HH:mm").
  localDay: string | null;
  localTime: string | null;
  stage: CalendarStage;
  reason: string | null;
  overdue: boolean;
  movable: boolean;
  assetId: string | null;
  // Metnin kısaltılmış önizlemesi (başlık yoksa kartta kullanılır).
  preview: string | null;
  // Yayınlanmışsa, yayın görevinin tamamlandığı an (UTC ISO).
  publishedAt: string | null;
  // Bir postun mecra teslimatıysa o post (docs/works.md "Posts"); aynı postun
  // parçaları takvimde birlikte taşınır.
  postId: string | null;
  facts: ItemFacts;
};

// Takvim verisinin tamamı: sayfa ilk yüklemede ve hafif yoklama ucu aynı şekli verir.
export type CalendarPayload = {
  items: CalendarItem[];
  connections: CalendarConnection[];
  scheduleEnabled: boolean;
  // Verinin okunmaya başladığı an (ms). İstemci, kendi yazmasından ESKİ bir
  // yanıtın yerel değişikliği ezmesini bununla önler.
  loadedAt: number;
};

// Detay panelinin tembel yüklenen ağır kısmı (tam metin, künye, bekleyen onay).
export type CalendarDetail = {
  caption: string | null;
  copy: string | null;
  goal: string | null;
  createdAt: string;
  version: number | null;
  platform: string | null;
  contentFormat: string | null;
  filename: string | null;
  // Bekleyen onay kaydı (varsa).
  approvalId: string | null;
};

// Bağlı hesap şeridi: bir platformun bağlantı durumu ve görünür aralıktaki payı.
export type CalendarConnection = {
  source: CalendarSource;
  connected: boolean;
  // "@marka", sayfa adı vb.
  account: string | null;
};
