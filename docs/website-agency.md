# Google Analytics: ajans ve ileri ölçek (GA-F8)

Plan: [google-analytics-plan.md](google-analytics-plan.md) GA-F8. Bağlantı katmanı: [google-connections.md](google-connections.md). Ambar ve Website sayfası: [website-analytics.md](website-analytics.md). Bu dosya GA-F8'in uygulanmış hâlini, bayrakları ve sahibin yapacağı kod dışı adımları anlatır.

## 1. Durum ve kapsam

Hepsi bayraklı ve varsayılan KAPALI. Bayraklar çağrı anında okunur; kapalıyken davranış değişmez.

| Parça                                                           | Bayrak                         | Dosyalar (özet)                                                                                                             |
| --------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Google token anahtar sürümleme + döndürme                       | `GOOGLE_TOKEN_KEYS`            | `server/integrations/google/secret.ts`, `key-rotation.ts`                                                                   |
| RISC (Cross-Account Protection) alıcısı                         | `GOOGLE_RISC`                  | `lib/google-risc/*`, `server/integrations/google/risc/*`, `app/api/webhooks/google-risc`, `prisma/google-risc-register.ts`  |
| Çoklu mülk (ek mülkler), mülk seçici, `/websites` genel görünüm | `GA_AGENCY`                    | `lib/website-analytics/agency/*`, `server/website-analytics/agency/*`, `components/website-analytics/agency/*`              |
| BigQuery dışa aktarım kontrolü                                  | `GA_BIGQUERY`                  | `lib/website-analytics/bigquery/*`, `server/website-analytics/bigquery/*`                                                   |
| Huni raporu                                                     | `GA_FUNNEL`, `GA_FUNNEL_ALPHA` | `lib/website-analytics/funnel/*`, `server/website-analytics/funnel/*`, `server/integrations/google-analytics/funnel-api.ts` |
| Müşteri raporu (beyaz etiket, paylaşım bağlantısı)              | `GA_AGENCY` (+ SC-F9)          | `server/website-analytics/agency/share*.ts`, `lib/website-analytics/agency/client-report/*`                                 |

Tek bilinçli istisna: günlük `ga-agency-retention` süpürmesi bayraktan bağımsızdır (RISC olayları 30 gün, BigQuery günleri 400 gün, başıboş WEBSITE paylaşımları). Gizlilik saklaması bayrak kapatılınca durmamalıdır.

**SC-F9 ile iş bölümü.** Paylaşımlı birimler SC-F9'undur: BigQuery istemcisi (`server/integrations/google/bigquery`), `ReportBranding`/`ReportShare` modülü (`server/report-share/*`, `lib/report-share/*`), herkese açık `/r/[token]` sayfası, `WhiteLabelFrame`, genel çerçeve (`AgencyOverviewFrame`) ve paylaşım saklama adımı. GA-F8 yalnız tüketir ve `WEBSITE` türünü sağlar. Bir SC-F9 imzası farklı çıkarsa uyarlama tek dosyadadır: `share.ts` / `share-renderer.tsx` / yazdırma sayfası (paylaşım), `bigquery/reader.ts` / `verify.ts` (BigQuery), `app/websites/page.tsx` / `agency/counters.ts` (genel görünüm). SC-F9 dosyalarına GA-F8 dokunmaz.

## 2. Bayrak ve env tablosu

| Env                                                     | Varsayılan   | Anlamı                                                                                                    |
| ------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `GA_AGENCY`                                             | kapalı       | Ek mülkler, seçici, `/websites`, müşteri raporu. `GA_SYNC=true` ister.                                    |
| `GA_BIGQUERY`                                           | kapalı       | BigQuery dışa aktarım kontrolü (`GA_AGENCY` ister).                                                       |
| `GA_BIGQUERY_MAX_BYTES`                                 | 2000000000   | Sorgu başına en çok faturalanacak bayt (1e8 .. 100 GiB).                                                  |
| `GA_BIGQUERY_MONTHLY_BYTES`                             | 100000000000 | Kaynak başına aylık bayt bütçesi.                                                                         |
| `GA_FUNNEL`                                             | kapalı       | Huni raporu (`GA_AGENCY` ister).                                                                          |
| `GA_FUNNEL_ALPHA`                                       | kapalı       | Gerçek `runFunnelReport` (v1alpha) çağrısı için ayrı acil kapatma; kapalıyken yalnız mock kip.            |
| `GOOGLE_RISC`                                           | kapalı       | RISC alıcısı; `GA_AGENCY`'den bağımsız (Search Console bağlantılarını da korur). Kapalıyken uç 404 döner. |
| `GOOGLE_RISC_AUDIENCES`                                 | boş          | Kabul edilen `aud` değerleri (virgülle). Boşsa OAuth istemci kimliği.                                     |
| `GOOGLE_RISC_JWKS_URL`                                  | Google       | Yalnız test/gözlem için JWKS adresi geçersiz kılma.                                                       |
| `GOOGLE_TOKEN_KEYS`                                     | boş          | `k2:<64 hex>,k1:<64 hex>`: ilk anahtar yazmada, hepsi okumada.                                            |
| `GOOGLE_BIGQUERY_SA_KEY`                                | boş          | SC-F9'un çalışma zamanı BigQuery okuyucu anahtarı; GA ve Search Console ortak kullanır.                   |
| `GOOGLE_RISC_ACCESS_TOKEN`, `GOOGLE_RISC_QUOTA_PROJECT` | yok          | YALNIZ `prisma/google-risc-register.ts` için geçici kabuk değişkenleri; sunucuya YAZILMAZ.                |

`.env.example` dosyasına bu satırlar sandbox yüzünden eklenemedi; sahibin eklemesi gerekir (gerçek değer olmadan, hepsi `false`/boş).

Ön koşullar: `GA_SYNC`, raporlar için `GA_REPORTS`, sağlık/analiz bayrakları ve `GA_WEBSITE_PAGE`. Müşteri rapor bağlantıları `reportShareOn()` ile (`GSC_AGENCY` veya `GA_AGENCY`) açılır. Canlı veritabanını paylaşan yerel süreç yalnız `GA_SYNC_DEV_PROJECTS` listesindeki projeleri işler. Mock kipte (`AGENTELSE_PROVIDER_MODE=mock`) Google ve web siteleri hiç çağrılmaz.

## 3. Çoklu mülk

- Bir projede 1 ana + en çok 4 ek mülk (`GA_MAX_EXTRA_PROPERTIES`). `GaPropertyLink`: ana = `isPrimary`, ek = `isSecondary`; emekli bağ ikisi de değil.
- Ek mülk: senkron, sağlık, içgörü, haftalık ve aylık rapor alır. Eklenti aşaması, LLM yorumu, hedefler, düzeltmeler (GA-F7), UTM/atıf bölümleri YOKTUR; görünüm salt okunurdur.
- Sayfa `?property=<id>` ile seçilen mülkü açar. Seçim tek istek kapsamlıdır (`AsyncLocalStorage`, `selected-link.ts`): `loadSitePropertyScope` kapsamı kurar, bütün mülk okumaları `runInSiteScope` içinde yapılır. İçeride hedef, nabız, uyarı, plan, fikir ya da React `cache()` okuyucuları çağrılmaz.
- Rapor komut kimlikleri bağ kapsamlıdır (`garep_<variant>_<projectId>_s_<linkId>_<period>`).
- "Make main": eski ana ek olur, yeni ana ek olmaktan çıkar; tek dönemlik iki sonuç doğar (yeni ana için çakışıp atlanan kart, eski ana için ikinci kart).
- **Link kapsamlı uyarı çözümü.** `SiteAlerts.resolveMissing` artık `excludeDedupePrefixes` alır: bir bağın değerlendirmesi, diğer motor bağlarının uyarı öneklerini (`ga4:<linkId>:`) çözmez. Emekli bağın uyarıları çözülmeye devam eder. RISC'in açtığı kritik "access was revoked" uyarısı (`GA_MH24`) bu sayede başka bağın değerlendirmesiyle kapanmaz; yalnız yeniden bağlanma kapatır. Önek verilmezse `where` bugünküyle aynıdır.
- **Retired-link süpürmesi.** `GaRetention` 30 günden eski `isPrimary=false` bağları siler; `isSecondary=false` koşulu ek mülkleri korur (bayrak kapalı/duraklatılmış aylarda `updatedAt` eskir).
- Kota: 360 hesaplarda bile senkron hızlanmaz (paylaşımlı yönetici); ek mülklere her tick'te en az bir yuva ayrılır.
- Öğrenmeler (`BrandLearning`) proje düzeyindedir; `GA_AGENCY` açıkken yalnız ana mülkün bulgusu yazar, kapalıyken ek sorgu yoktur.
- Kaldırma temizliği: kartlar, WEBSITE paylaşımları ve uyarılar birlikte gider.

## 4. Workspace "Websites" görünümü

`/websites` (yalnız OWNER/ADMIN, `GA_AGENCY`): bütün projelerin KPI'ları ve ölçüm sağlığı; sol menüde Explore → "Websites" (`AppShell` rolü zaten bildiği için ek sorgu yok). `/health` sayfasında `GaAgencyCountersCard` yalnız sayıları gösterir (`healthy` hesabını etkilemez). Toplu bağlama (`bulk-link.ts`): bir Google bağlantısı seçilen projelere kopyalanır (token kopyalama; ayrı `GoogleGrant` tablosu yok).

## 5. Müşteri raporu (beyaz etiket)

- Ajans adı, vurgu rengi, alt bilgi ve logo `ReportBranding` ile (SC-F9) iş alanı düzeyinde tutulur.
- Paylaşım bağlantısı `ReportShare` (kind `WEBSITE`): rapor anının DEĞİŞMEZ görüntüsü, 7/30/90 gün sonra biter, iptal edilebilir; sayfada yalnız rapor görünür (Google hesabı ya da başka veri yok).
- Kapsam: GA-F5 Website kartları. Analytics modülünün Copy/Markdown/Print adımı beyaz etiketli değildir.
- Silme: `ReportShare`'in dış anahtarı yoktur. `reports/cleanup.ts` → `deleteGaReportData` bitince `forgetWebsiteSharesForProject` çalışır (Disconnect ve yetim süpürmesi bu yoldan geçer); günlük `ga-agency-retention` başıboş satırları da süpürür.
- `server/report-share/register-all.ts` (SC-F9 dosyası) `@/server/website-analytics/agency/share-renderer`'ı yan etkiyle içe aktarır (entegrasyonda eklendi); bu içe aktarma olmadan WEBSITE bağlantısı nötr 404 verirdi. Varsayılan paylaşım alt bilgisi artık nötrdür ("Numbers from Google."); `/websites` ve `/search` marka formu kaydı iki yazdırma sayfasını da yeniden doğrular.

## 6. BigQuery dışa aktarım kontrolü

- Müşteri GA4'ün BigQuery dışa aktarımını Agentelse'in salt okunur servis hesabına açar; Agentelse günlük toplamları çeker ve GA'nın verdiği sayılarla karşılaştırır.
- **Bağlama kuralı:** veri kümesi her zaman `analytics_<mülk kimliği>`, faturalama ve sorgu aynı Google Cloud projesinde; tek `gcpProjectId`.
- Sorgu başı bayt tavanı (`GA_BIGQUERY_MAX_BYTES`) ve aylık kaynak bütçesi (`GA_BIGQUERY_MONTHLY_BYTES`); önce kuru çalıştırma. Günlük satırlar 400 gün.
- **Kabul edilen sınır (confused deputy).** Kaydeden kullanıcının, `gcpProjectId` ile adı verilen Google Cloud projesini kontrol ettiği KANITLANMAZ. GA4 mülkünde herhangi bir rolü olan ve sahibin proje kimliğini bilen biri, sahip servis hesabına erişim vermişse, o projede faturalanan sorgular çalıştırabilir ve günlük toplamları kendi projesine çekebilir. Maliyet sorgu ve aylık tavanlarla sınırlıdır; tavan kaynak satırı başınadır ve kaynağı silip yeniden eklemek `usageBytes`'ı sıfırlar. Bilinçli olarak kabul edildi: servis hesabına erişimi SAHİP verir (kendi projesinde), veri yalnız toplamdır, çıktı aynı mülke bağlıdır. Sertleştirme seçenekleri (sahip kararı): GA Administrator rolünü doğrulamak, veri kümesine Agentelse'in ürettiği bir doğrulama etiketi koydurmak, `gcpProjectId` başına silmeden etkilenmeyen aylık bayt sayacı.

## 7. Huni raporu

`GA_FUNNEL` + `GA_FUNNEL_ALPHA` (v1alpha). Bağ başına en çok 5 kayıtlı huni, mülk başına günde 20 gerçek çalıştırma, art arda çalıştırmada kısa bekleme. Kaydetme ve silme yalnız OWNER/ADMIN; çalıştırmayı proje üyesi yapabilir (sıklık ve günlük sınır sunucuda). Eylem hataları istemciye aynen gitmez: yalnız sabit iletiler, günlüğe yalnız hata adı.

## 8. RISC (Cross-Account Protection)

- Uç: `POST /api/webhooks/google-risc` (`public-paths.ts` içinde herkese açık; oturum yok). Google'ın RS256 imzalı jetonu uçta doğrulanır (`jwt.ts`, `jwks.ts`; issuer, audience, 2048 bit alt sınır). `GOOGLE_RISC` kapalıyken 404, geçersiz jetonda 400.
- Olaylar: `tokens-revoked`, `account-disabled`, `account-purged` (bağlantıyı EXPIRED yapar; veri SİLİNMEZ, sahip kararı), `token-revoked` (tek token; şifreli metinlerle sayfa sayfa karşılaştırılır, tarama yarıda kalırsa sonuç `RECHECK`, asla sessiz `NO_MATCH` değil), `verification`.
- GA bağları `AUTH`'a çekilir ve kritik `GA_MH24` uyarısı açılır; Search Console için `GSC_CONNECTION`. Google `sub` değeri hiçbir yere yazılmaz; yalnız bağlantı metadata'sındaki `googleSub` ile eşlenir. Uygulama idempotenttir.
- Olay kayıtları (`GoogleRiscEvent`) 30 gün saklanır (`ga-agency-retention`).

## 9. Anahtar sürümleme (`GOOGLE_TOKEN_KEYS`)

`decryptGoogleSecret` / `encryptGoogleSecret` Google token şifrelemesinin TEK giriş noktasıdır (`google-token.ts`, `google-disconnect.ts` ve OAuth callback bunları kullanır). Anahtar kimliği şifreli metnin önekindedir (`gk1:<keyId>:<iv.tag.data>`); sütun eklenmez, "Use existing connection" kopyaları eşit kalır, önekli olmayan eski kayıtlar olduğu gibi okunur. Env boşken çıktı eski biçimle bayt bayt aynıdır. `google-key-rotation` tick adımı satırları tembel olarak güncel anahtara yeniden şifreler; çözülemeyen gruplar sonraki sayfalara geçilerek atlanır, sağlıklı satırların döndürülmesini engellemez.

**İKİ DEPLOY SIRASI (zorunlu).** (1) Önce bu sürümü `GOOGLE_TOKEN_KEYS` OLMADAN yayınla: okuma/yazma yolları `gk1:` önekini tanır. (2) Sonra env'e yeni anahtarı ekle; döndürme başlar. Eski anahtarı yalnız `GoogleKeyRotation.status()` onda 0 satır gösterince listeden çıkar. Sıra tersine çevrilirse eski kod `gk1:` metinlerini çözemez ve bütün Google bağlantıları kırılır.

## 10. Sahip adımları (kod dışı)

1. `GOOGLE_BIGQUERY_SA_KEY`: Agentelse'in kendi Google Cloud projesinde salt okunur servis hesabı oluştur (BigQuery Job User + veri kümesi okuma müşteri tarafında verilir), anahtarı Railway'e yaz. Hesap e-postası müşteriye kurulum ekranında gösterilir.
2. RISC akış kaydı: `gcloud auth print-access-token` ile kısa ömürlü token al; `GOOGLE_RISC_ACCESS_TOKEN` (ve gerekirse `GOOGLE_RISC_QUOTA_PROJECT`) yalnız o kabukta tanımla; `npx tsx prisma/google-risc-register.ts` (kuru çalışma), sonra `--apply`; `--action=verify --apply` ile doğrula. Sonra Railway'de `GOOGLE_RISC=true` (ve gerekirse `GOOGLE_RISC_AUDIENCES`).
3. `GOOGLE_TOKEN_KEYS`: 64 hex anahtar üret (`openssl rand -hex 32`), bölüm 9'daki iki deploy sırasını uygula.
4. `.env.example`'a bölüm 2'deki bayrak satırlarını elle ekle.
5. Gizlilik ve veri silme metinleri (GA-F8 paragrafları) bu adımlarla birlikte ya da sonra yayınlanmalıdır; metin koşullu yazıldı (özelliği açık tutan yoksa yanlış bir şey iddia etmez).
6. Sahip kararları: paylaşım bağlantısı 7/30/90 günlük DEĞİŞMEZ görüntüdür (kendini güncelleyen LATEST bağlantı, uzatma ve yenileme KALDIRILDI); `account-purged` yalnız EXPIRE eder; beyaz etiket yalnız Website kartlarını kapsar; BigQuery bağlama kuralının sınırı (bölüm 6).

## 11. Testler

Birim: `lib/website-analytics/agency/*.test.ts`, `lib/website-analytics/{bigquery,funnel}/*.test.ts`, `lib/google-risc/*.test.ts`, `server/integrations/google/{secret,key-rotation}.test.ts`, `server/integrations/google/risc/*.test.ts`, `server/website-analytics/{agency,bigquery,funnel}/*.test.ts`, `server/actions/{funnel,bigquery,website-property,website-agency,website-client-report}-actions.test.ts`, `monitoring/site-alerts.test.ts` (`excludeDedupePrefixes`), `website-analytics/retention.test.ts`, `proxy.test.ts`, `sidebar-nav.test.ts`, `privacy/page.test.ts`, `data-deletion/page.test.ts`. Entegrasyon (tek kullanımlık Postgres): `*.integration.test.ts` dosyaları.
