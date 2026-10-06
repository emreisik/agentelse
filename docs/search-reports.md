# Search raporları ve planlama (SC-F5)

Kaynak: docs/google-search-console-plan.md §3.4, §3.7, §3.10, §5, §9 SC-F5, §11 SK9/SK20.

## Durum (6 Ekim 2026)

Kodlandı. `SEO_REPORTS=true` ve `GSC_SYNC=true` ile açılır. Canlıda denenmedi.

Migration: `20261006216000_add_seo_reports`. Yeni tablolar: `SeoReport`, `SeoReportState`, `SeoGoalProgress`.

## Plandan sapmalar

- **Migration var.** Plan "Migration: Yok" diyordu. Gönderilen raporların değişmez ve silinebilir anlık görüntü olması için 3 tablo eklendi.
- **Tek tick adımı.** Planın `seo-pulse` / `seo-weekly-report` / `seo-monthly-report` işleri tek `seo-reports` tick adımında birleşti.
- **Teşhis ağacı.** Adım 2 (teknik) ikiye bölündü: indeks (URL Inspection, indeksleme olayları) ve teknik (tarayıcı).
- **Rapor günleri.** §3.10'daki ayar ertelendi. Şimdilik sabit: Çarşamba 09:00 ve ayın 4'ü 09:00 (proje saati).
- **Uyarılar.** Sohbete yalnız bir sonraki kesin gündeki nabız kartında sayı olarak gelir. Anlık uyarı W2 SiteAlerts'tedir.

## Bayraklar ve açılış

- `SEO_REPORTS=true` şunları açar:
  - tick adımı `seo-reports`: hedefler, nabız, haftalık rapor, aylık rapor ve yol haritası;
  - sohbet sorgusundaki `seo-report` kartı;
  - Search sayfasında "Reports & goals" bölümü (sayfanın kendisi `GSC_SEARCH_PAGE` ister);
  - rapor API'si;
  - üç sohbet aracı;
  - Brand Brain → Goals'taki tempo rozeti;
  - /health sayaç kartı.
- Bayrak kapalıyken:
  - tick 0 döner ve veritabanına dokunmaz;
  - sohbet sorgusu, araç listesi ve Search sayfası bugünküyle birebir aynıdır;
  - saklama temizliği süreç başına günde en çok bir kez "kalan veri var mı" diye bakar.
- Bölümler mevcut bayraklara bağlıdır:
  - `SEO_HEALTH`: sağlık bölümü, teşhisin indeks/teknik/güncelleme adımları, `seo.indexedShare`;
  - `cwvEnabled`: CWV;
  - `SEO_INSIGHTS=on`: fırsatlar, kararlar, Accept/Dismiss ve yol haritasındaki fırsat eylemleri; haftalık rapor fırsat motorunu en geç Perşembe 09:00'a kadar bekler.
- Geliştirme ortamı:
  - `GSC_SYNC_DEV_PROJECTS` / `GSC_ROLLOUT_PROJECTS` izin listesi geçerlidir;
  - canlı veritabanını paylaşan geliştirme süreci `seo.reports` heartbeat'ini almaz ve saklama temizliğini çalıştırmaz;
  - böyle bir süreçte mock bağın raporu yalnız arşive yazılır, sohbete kart düşmez.
- Mock modu:
  - yalnız `isMock` bağlar ve `isMock` hedefler kullanılır (ProjectGoal.isMock);
  - raporlar "Sample data" rozetiyle saklanır;
  - mock bağ için LLM anlatısı hiç yazılmaz.

## Raporlar

| Rapor | Zaman | LLM |
| --- | --- | --- |
| Search pulse | Kesinleşen yeni gün ambara yazılınca; yalnız dikkat çekiciyse | 0 |
| Weekly SEO report | Hafta kesinleşip haftalık özetler çekilince; Çarşamba 09:00'dan sonra (proje saati) | 1 |
| Monthly SEO report | Ayın 4'ü 09:00'dan sonra | 1 |
| SEO roadmap | Aylık raporun hemen ardından (gelecek ay için) | 0 |

Raporların içeriği:

- **Search pulse:**
  - günün (kesin) markasız tıklaması ile son 8 haftanın aynı gününün medyanı;
  - yeni CRITICAL uyarılar (açık/onaylanmış, susturulmamış);
  - ülke/cihazda en büyük değişim.
- **Weekly SEO report:**
  - KPI'lar, önceki hafta ve geçen yıl ile;
  - düşüşte teşhis;
  - kazanan ve kaybeden sorgu/sayfalar, yükselen aramalar;
  - sağlık;
  - en çok 5 fırsat;
  - haftanın kararları ve değerlendirilen eylemleri (sonuçlarıyla);
  - Google güncellemeleri ve olayları;
  - anonim pay notu.
- **Monthly SEO report:**
  - ay, önceki ay ve YoY;
  - SEO hedefleri ve tahmin;
  - teşhis, KPI'larla aynı takvim ayları üzerinden;
  - kazanan ve kaybeden sayfa ve sorgular;
  - sağlık ve kararlar;
  - bu ayın ve gelecek ayın SEO makaleleri;
  - güncellemeler.
- **SEO roadmap:**
  - ilk 10 eylem (önce CRITICAL uyarılar, sonra fırsatlar);
  - teknik borç;
  - planlı makaleler, hedefler ve tahmin.

Diğer kurallar:

- **Yalnız kesin veri.** `fresh=false` olmayan gün varsa rapor yazılmaz. Tablolar W1'in `final` özetlerinden gelir.
- **Zamanlama.** Karşılaştırma proje saatinde "gün + saat" olarak yapılır. Bekleme anı `SeoReportState`'e yazılır, böylece bekleyen bağ her 10 dakikada bir işlenmez. 20 günden eski bir hafta ya da ayın 27'sinden sonraki bir ay atlanır.
- **Değişmez anlık görüntü.** Rapor `SeoReport.snapshot`'a bir kez yazılır; güncelleme yolu yoktur. Silme yalnız şu durumlarda olur:
  - Disconnect, "Delete stored data" ve W1 saklama temizliği (cascade);
  - saklama süresi: nabız 90 gün, diğerleri 36 ay; "yalnız son 16 ay" seçen bağlarda (`archive=false`) 487 gün.
- **Komut kimliği.** `seo<tür>_<linkId>_<dönem>`. Mock/canlı bağlar ve yeniden bağlanma ayrı kimlik alır. Bir dönem, rapor satırı ve komutu birlikte varsa gönderilmiş sayılır.
- **Anlatı.**
  - LLM'e yalnız toplu sayılar ve en çok 20 maskeli dizge gider.
  - Çıktı `checkSummaryNumbers` ile denetlenir. İzinli sayılar işaretsiz de eklenir, böylece "%12,3 düştü" cümlesi korunur.
  - Dil `Project.language || "tr"` (ReasoningService ile aynı).
  - Günlük AI sınırında (daily-budget / daily-reasoning) "daily AI limit" notu, diğer hatalarda "couldn't be written" notu çıkar. Rapor yine zamanında gider.

## "Search & SEO" sohbeti

- Proje başına tek Work vardır: `wkseo_<projectId>`, modül `seo`. İlk kartla açılır ve hiçbir zaman "en yeni seo sohbeti"ne yazılmaz.
- Kart (`seo-report`) yalnız rapora işaret eder. Kart raporu ekrana girince `GET /api/projects/[projectId]/search/reports/[reportId]` ile okur (`Cache-Control: private, no-store`). Silinmiş raporda "This report is no longer stored." yazar.
- Nabız kartları sohbeti Recents'te öne taşımaz. Arşivlenmiş sohbette komut yazılır ama öne çıkarılmaz.
- Fırsat ve yol haritası maddelerinde Accept/Dismiss vardır (W3 eylemleri). Durum canlı okunur.
- Sohbet araçları (yalnız okuma; Google dizgileri en çok 20):
  - `diagnose_search_drop`;
  - `get_seo_report`;
  - `get_seo_goals`.

## Teşhis ağacı

Sıra şöyledir: veri/bağlantı → indeks → teknik → Google güncellemesi → talep/mevsim → sıralama → CTR → yamyamlaşma.

- **Düşüş:** değişim ≤ −%15 ve önceki dönemde en az 30 tıklama. Birincil neden, düşüşte ilk "yes" olan adımdır.
- **Sıralama ve CTR:** sıralama, pozisyon ≥ 1 kötüleşince "yes" olur. CTR adımı, pozisyon değişimi < 1 iken CTR ≤ −%15 olunca "yes" olur. Arada boşluk kalmaz.
- **Google olayları:** INDEXING/CRAWLING olayları indeks adımında, SERVING olayları veri adımında kanıt olarak görünür.
- **Kanıt sayıları:** her adım `metrics` taşır. Kanıttaki her sayı girdiden ya da bu metriklerden gelir; testler bunu doğrular.
- **Kayıp sayfalar:** W2'nin `gscPageKey` eşleşmesiyle tarayıcı ve URL Inspection verisine bağlanır.
- **Kapalı kaynak:** kaynağı kapalı adım "unknown" döner.
- **Kullanıcıya sorulanlar:** "Manual actions" ve "Security issues" her düşüşte sorulur.
- **Tablolar:** hizalı haftalar çekilmemişse son çekilen haftalarla çalışılır ve bu, kanıtta belirtilir.

## SEO hedefleri ve tahmin

| metricKey | Değer | Not |
| --- | --- | --- |
| `gsc.nonBrandClicks` | Son 30 kesin günün markasız tıklaması | Marka ayrımı ister |
| `gsc.clicks` | Son 30 kesin günün tıklaması | |
| `gsc.top10Queries` | Ortalama pozisyonu ≤ 10 olan markasız sorgu sayısı | Son 4 haftanın ortalaması |
| `seo.indexedShare` | URL Inspection kapsam tahmini (%) | `SEO_HEALTH` |
| `seo.cwvGoodShare` | "good" CWV oranı (%) | `cwvEnabled` |

- **Anahtarlar.** Yalnız bu beş anahtar SEO hedefidir. Önek eşleşmesi yoktur, AI'nin önerdiği serbest anahtarlara dokunulmaz.
- **Güncelleme.** `currentValue` her kesin günle güncellenir; tempo `SeoGoalProgress`'tedir. Mock bağ gerçek hedefe yazmaz.
- **Tempo.** 13 haftalık doğrusal eğilim ve %90 aralık: "Reached" / "On track" / "At risk" / "Behind" / "Not enough data". Sözlük web (GA) tempo çipleriyle aynıdır: "At risk" sarı (aralık hedefi kapsıyor), "Behind" kırmızı (aralığın tamamı hedefin altında).
- **Bağ kalmazsa.** Projede o modda bağ kalmazsa günlük saklama işi hedef değerini boşaltır.
- **Tahmin.**
  - En az 15 ay geçmiş varsa mevsimsel: geçen yılın aynı ayı × son 3 ayın, bir yıl önceki aynı 3 aya oranı.
  - Yoksa sönümlü eğilim.
  - Aralık geriye dönük testten gelir (en az %15). Yeni içerik ayrı ve "directional" gösterilir.
- **Doğrulanmalı.**
  - Tahmin hatası canlı veride ölçülmeli (hedef ≤ %20).
  - top10 sayımı küçük sitede gürültülü olabilir.

## Dışa aktarma

- Markdown kopyala, `.md` indir ve "Print / PDF".
- Saf üreticiler `src/lib/seo/reports/export.ts`'tedir.

## Gizlilik ve Limited Use

- Telegram'a rapor gitmez. Brand Brain sinyali yazılmaz. Operatör yalnız sayaç görür.
- Disconnect ve "Delete stored data": raporlar, durum ve ilerleme cascade ile silinir. Beş SEO hedefinin `currentValue` değeri boşaltılır.
- API yanıtı tarayıcıda saklanmaz (`no-store`).

## Dosyalar

- Saf kod: `src/lib/seo/reports/*`. Sunucu: `src/server/seo/reports/*`.
- Araçlar: `src/server/chat/search-report-tools.ts`. Prompt: `src/server/reasoning/prompts/seo-report-narrative.ts`.
- Arayüz: `src/components/search-reports/*`. Eylemler: `src/server/actions/seo-report-actions.ts`.

## Testler

- Birim testleri: zamanlama (gün + saat), KPI, teşhis tatbikatları ve kanıt sayıları, tahmin (15 ay), tempo, işaretsiz number-check, dışa aktarma.
- Entegrasyon testleri:
  - KPI'ların ambar satırlarına eşitliği;
  - hedef yazımı ve mod ayrımı;
  - idempotent gönderim;
  - yeniden bağlanmada yeni kimlik;
  - değişmez rapor;
  - Disconnect silmesi;
  - saklama (archive=false dahil).

## Açılış (sahip adımları)

1. Yeni bir terminal sekmesinde (dev sunucu sekmesinde değil), tek satır: `npx prisma migrate deploy`; çıktıyı yapıştır.
2. Deploy.
3. Railway'de `SEO_REPORTS=true` (zaten `GSC_SYNC=true` ister; Search sayfası için `GSC_SEARCH_PAGE`).
4. Geri alma: `SEO_REPORTS=false`. Veri kalır; kartlar listelenmez, API 404 verir.

`.env.example` bu oturumda yazılamadı; eklenecek satır: `SEO_REPORTS=false` (açıklama: SC-F5 Search raporları, "Search & SEO" sohbeti, SEO hedefleri; `GSC_SYNC=true` gerekir; docs/search-reports.md).
