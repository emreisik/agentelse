# Arama sağlığı ve teknik denetim (SC-F3)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.5, §5, §6.1, §6.3, §9 SC-F3. Ambar: [search-analytics.md](search-analytics.md). Bağlantı: [google-connections.md](google-connections.md). Ortak uyarı katmanı (SiteAlerts): [measurement-health.md](measurement-health.md). Bu dosya SC-F3'ün uygulanmış hâlini anlatır.

## Durum (6 Ekim 2026)

| Parça                                                              | Durum                                  |
| ------------------------------------------------------------------ | -------------------------------------- |
| 9 yeni tablo + migration `20261006212000_add_seo_health_and_crawl` | Yapıldı                                |
| Site tarayıcı (haftalık tam tarama) + 6 saatlik gerileme bekçisi   | Yapıldı (`SEO_CRAWL`, canlı denenmedi) |
| robots ve sitemap izleme (taban çizgisi geçişiyle)                 | Yapıldı                                |
| URL Inspection örnekleyici ve kapsam tahmini                       | Yapıldı (`SEO_HEALTH` + `GSC_SYNC`)    |
| GSC sitemaps.list okuması                                          | Yapıldı                                |
| CrUX Core Web Vitals                                               | Yapıldı (`GOOGLE_API_KEY` ister)       |
| Google güncellemeleri takvimi (`/health/search-updates`)           | Yapıldı                                |
| SH1–SH27 + puan + rehberler                                        | Yapıldı                                |
| Search sayfası bölümü, Today satırları ve sıradaki adım            | Yapıldı (tarayıcıda görülmedi)         |
| Gizlilik, veri silme metni ve agentelse.com/bot                    | Yapıldı (bot sayfası deploy edilmedi)  |
| /health sayaçları                                                  | Yapıldı                                |

Bekleyenler: SH2 saatlik erken uyarı, grafik notları, Integrations "Search health" rozeti, inceleme bütçesi ayarı, PSI laboratuvar testleri, Domain mülkünün ikincil hostları, sohbet aracı `inspect_url` (SC-F4), SeoAction kaynaklı P1 (SC-F6).

## Bayraklar ve açılış

- `SEO_HEALTH=true`: `gsc-inspect` adımı (URL Inspection + GSC sitemaps; ayrıca `GSC_SYNC` ve proje başına `gscSyncAllowedFor`), `seo-cwv` (anahtar ya da mock), `seo-health` (kontroller, uyarılar, puan), `search-updates-sync`, `seo-health-retention`, Search sayfasındaki bölüm, Today satırları ve `fix_search_issue` adımı (bu ikisi `GSC_SEARCH_PAGE` de ister), /health kartı ve `/health/search-updates`.
- `SEO_CRAWL=true`: robots ve kendi sitemap okumamız, haftalık tam tarama ve 6 saatlik bekçi (`seo-crawl`). Yalnız `SEO_HEALTH` ile birlikte etkili (`SeoFlags.crawl()` ikisine bakar). Kapsam tahmini, P2/P6 örneklemesi, SH8 ve SH12 de `SEO_CRAWL` ister: sitemap envanterini tarayıcı yazar. Kapalıyken panel "Turn on the site audit to estimate coverage" der ve tarayıcı türleri kapanır.
- `GOOGLE_API_KEY=<anahtar>`: Chrome UX Report. Cloud Console'da yalnız CrUX API'ye kısıtlanmalı. Yalnız `X-Goog-Api-Key` başlığında gider, asla URL'de, mesajda ya da logda değil. Yoksa CWV işi ve kartı uyur (mock kip anahtarsız çalışır).
- `SEO_DEV_PROJECTS=<id,id>`: `NODE_ENV=development` ve yerel olmayan `DATABASE_URL`'de yalnız bu projeler satır, tarama, inceleme, CWV, sağlık turu ve yazma eylemi alır; runner'lar listeyi WHERE'e koyar. O süreç global işi (`search-updates-sync`, saklama, nabızlar, `claimPeriodic`) hiç çalıştırmaz. GSC kotası harcayan iş ayrıca `GSC_SYNC_DEV_PROJECTS` ister.
- `SEO_ROLLOUT_PROJECTS=<id,id>` (isteğe bağlı, her ortamda): kademeli açılış; doluysa yalnız bu projeler denetim işi ve yazma eylemi alır.
- `AGENTELSE_PROVIDER_MODE=mock`: tarayıcı bellek içi mock siteyi kullanır; URL Inspection, CrUX ve olay akışı fixture'dan okunur; doğrulama MOCK olarak başarılı olur; `SeoSite`/`SeoCwv` satırları `isMock`.
- Bayraklar çağrı anında okunur; kapalıyken her adım veritabanına gitmeden 0 döner, okuyucular sorgusuz null verir, markup değişmez. Veri silme yolları (Disconnect, Delete stored data, W1 yetim bağ temizliği) bayraktan bağımsızdır.

Açılış sırası:

1. Migration (GA-F3'ün `20261006211000_add_ga_health_and_alert_source`'u da; `AdsAlert.source` oradan gelir).
2. agentelse.com/bot'u yayınla (marketing servisi elle deploy edilir).
3. `SEO_ROLLOUT_PROJECTS=<agentelse.com projesi>`, `SEO_HEALTH=true`, `SEO_CRAWL=true`.
4. Cloudflare arkasındaki agentelse.com'da yanlış `SEO_KEY_PAGE_ERROR` çıkmadığını doğrula.
5. Tatbikat: önce mock'ta `setMockSiteOverrides` ile ana sayfaya noindex ve robots `Disallow: /`. Canlıda tatbikat sayfası ANA SAYFA ya da bir KİLİT SAYFA olmalı (SH3 yalnız kilit sayfalara bakar; başka sayfadaki noindex haftalık TA7 WARN olur). Beklenen: ≤ 6 saat + bir tick içinde CRITICAL.
6. Chrome UX Report API'ye kısıtlı `GOOGLE_API_KEY`.
7. Açılış listesini boşalt.

## Tablolar

- `SeoSite`: proje + kip başına tek satır. Kapsam (`scopeKey`), doğrulama, robots kopyası ve hükmü, sitemap özeti ve taban çizgisi (`sitemapBaselineAt`), tarama kilidi ve zamanlaması (`crawlNextAt`, null = boşta), bekçi zamanı, inceleme bütçesi ve kuyruğu, puan (`healthScore`, `healthParts`).
- `SeoCrawl` (tam tarama turu, devam ettirilebilir `frontier`), `SeoPage` (envanter + son durum + `fetchError` + `previous`/son iyi durum), `SeoLink` (iç bağlantılar ve bağlantı metni), `SeoCwv`.
- `SearchUpdate` (global, olay kimliğiyle).
- `GscUrlInspection`, `GscSitemap`, `GscCoverageWeek` (`GscSiteLink`'ten cascade).

Silme kuralları:

- Disconnect: Gsc* cascade + GSC uyarıları + `forgetSearchConsoleData(resetScope: true)`; bayraktan bağımsız.
- Delete stored data (W1): aynısı, `resetScope: false` (tarama verisi sitenin kendisinden geldiği için kalır).
- W1 yetim bağ temizliği: aynısı, `resetScope: true`.
- Delete audit data (panel): alt satırlar ve durum silinir; doğrulama ve ayarlar kalır (meta etiketi / TXT kaydı geçerli kalır).
- Kapsam değişimi, alan adının kaldırılması, PAUSED/CLOSED proje: sıfırlama (alt satırlar silinir, zamanlamalar null, `healthDueAt = now` ki uyarılar kapansın).
- Silinen proje: `SeoSite` hemen silinir.
- Saklama (`seo-health-retention`, günde bir, global): 90 günden eski `SeoCrawl` ve kaybolan `SeoPage`, 730 günden eski `SeoCwv`, canlıda mock siteler, projesi olmayan siteler (hemen), alan adı ve GSC bağı olmayan 30 günlük siteler, `GscSiteLink`'i kalmamış projelerin GSC uyarıları, 180 günden eski çözülmüş (RESOLVED) GSC ve SEO uyarıları.

## Kapsam ve doğrulama

- Kapsam önce projenin geçerli kipteki birincil `GscSiteLink`'inden (sağlık GONE/ACCESS_LOST değilse): `sc-domain:` → kök + alt alan adları, URL önekli mülk → o önek. Yoksa `Project.domain`'in Agentelse doğrulaması: `https://<domain>/` üzerinde `<meta name="agentelse-site-verification" content="TOKEN">` ya da DNS TXT `agentelse-site-verification=TOKEN` (node:dns). İkisi de yoksa tarayıcı boşta, panel doğrulama kartını gösterir.
- Yalnız ana host (ana sayfanın son URL'sinin host'u) taranır. www/apex eşi yalnız bir yönlendirme adımı olarak ve kendi robots.txt'siyle (tur başına bir kez, bellekte; 4xx = serbest, 5xx/ulaşılamaz = yasak) kabul edilir. Başka host'lar `stats.otherHosts`'ta sayılır, getirilmez.
- Kapsam değişince sıfırlama; tarayıcı her yazım grubundan önce `scopeKey`'i yeniden okur, değiştiyse ya da satır gittiyse turu bırakır (P2003 de sessizce bırakır).
- 30 günde bir yeniden doğrulama; başarısız deneme 1 gün sonra tekrarlanır, art arda 2 başarısızlıkta doğrulama düşer.
- Sayfa görüntülemesi yalnız eksik satırı oluşturur (`ensureForProject(..., { reset: false })`), asla sıfırlamaz; izin listesi dışında `ensureVerifyToken` yazmadan null döner.

## Tarayıcı (`src/server/seo/crawl/`)

- UA `AgentelseSiteAudit` (tam metin `SEO_CRAWLER_USER_AGENT`), agentelse.com/bot sayfasında anlatılır. `guarded-transport.ts` safe-fetch'in SSRF korumasını (URL + bağlantı anı DNS) tekrarlar; yönlendirmeleri kendisi izlemez.
- robots: önce bizim token'ın grubu, yoksa `*`. Kontroller Googlebot'a ve `*` grubuna ayrı bakar. 4xx = her şey serbest; 5xx/429/ağ hatası = turda dur, 10 sn sonra tek deneme; ikisi de başarısızsa `robotsFailures` artar ve geri çekilme 30 dk'dan 6 saate katlanır (`robotsRetryAt`). Eşleştirici dosya içeriğinden RegExp kurmaz.
- Host başına saniyede en çok 1 istek (süreç çapında pacer) ve 10 sn'ye kadar Crawl-delay.
- Sayfa başına 2 MB (kesilir), 12 sn, yalnız HTML gövdesi indirilir; tam taramada `etag`/`lastModified` ile koşullu GET (304 eski bilgileri korur).
- Her yönlendirme adımında kapsam ve robots yeniden kontrol edilir; en çok 4 yönlendirme. `fetchError`: TIMEOUT, NETWORK, UNSAFE, LOOP, TOO_MANY_REDIRECTS, LEFT_SCOPE, ROBOTS_HOP (yanıt geldiyse null). TIMEOUT/NETWORK sayfanın saklı bilgilerini silmez.
- Tohumlar: ana sayfa, kilit sayfalar, en çok 200 GSC sayfası, sitemap URL'leri (lastmod azalan), ardından derinliğe göre BFS. İzleme parametreleri (utm_*, gclid, fbclid, msclkid, mc_cid, mc_eid, _ga) atılır. Haftada en çok `min(pageLimit, 500)` getirme (304 dahil). İlk tam tarama hemen, sonrakiler proje saatiyle 01:00–06:00 penceresinde. Devam ettirilebilir kuyruk (`SeoCrawl.frontier`, ≤ 2.000 öğe; 512 karakterden uzun URL sayılır ama saklanmaz). Site başına tick'te 45 sn; en çok 3 site paralel.
- 429/503: site `clamp(Retry-After ?? 30 dk, 30 dk, 6 sa)` bekler; 3 ardışık kısıtlanmış tur ya da ana sayfada 403 → `crawlBlocked` (INFO uyarı, tam tarama durur). Çıkış: bekçi blocked iken de çalışır; ana sayfadan 2xx ya da "Check again now" `crawlBlocked`'ı temizler.
- Zamanlama (`nextCrawlAt`): boştaki sitelerde `crawlNextAt = null`; aday sorgusu `crawlNextAt ≤ now` ve `scopeKey` dolu ister. Her bırakış ≥ now + 1 dk bir zaman yazar: duraklatılmışsa `crawlPausedUntil`; robots başarısızsa `robotsRetryAt`; yoksa min(bekçi, robots + 24 sa, sitemap + 24 sa, tam tarama terimi). Böylece hiçbir site kuyruğu tıkayamaz; runner'lar izin listesini WHERE'e koyar.
- Saklananlar: adres, durum kodu, başlık, meta description, başlıklar, dil, Open Graph, yapılandırılmış veri türleri, hreflang, iç bağlantılar ve bağlantı metni, boyut ve yanıt süresi, robots.txt kopyası. Sayfa metni saklanmaz; yalnız yinelenen sayfa için simhash parmak izi.
- Mock site: her host için aynı belirlenimci sayfalar (`mock-site.ts`), `setMockSiteOverrides` ile tatbikat.

## Gerileme bekçisi

- 6 saatte bir (blocked iken de): robots.txt (24 saatlik önbelleği yok sayarak), kilit sayfalar (koşulsuz GET), günde bir `http://<host>/` (HTTPS yönlendirmesi).
- Durumu, noindex'i, canonical'ı, başlığı ya da `fetchError`'u değişen kilit sayfa atomik P1 inceleme kuyruğuna girer (yalnız birincil GSC bağı varsa).
- `seo-crawl` adımı `seo-health`'ten önce kayıtlıdır ve bekçi `healthDueAt = now` yazar: ana sayfa noindex'i ya da `Disallow: /` ≤ 6 saat + bir tick içinde uyarıya döner.
- 429/503 bekçiyi 30 dk erteler; uzun Crawl-delay'li siteler birkaç tick'te tamamlanır.

## Sitemap ve robots

- Kendi okumamız (robots'taki Sitemap satırları + `/sitemap.xml`; en çok 20 dosya, 10 MB, `.gz` dahil; site başına en çok 10.000 saklanan URL). İlk eksiksiz geçiş TABAN ÇİZGİSİDİR: URL'ler `inSitemap=true` alır ama `sitemapFirstSeenAt` null kalır; yalnız sonra eklenenler "yeni" sayılır. Kapsam sıfırlaması taban çizgisini de siler.
- GSC `sitemaps.list` günde bir (`GscSitemap`; hatalar, uyarılar, bekleyen, son indirme), kendi geri çekilmesiyle: başarı +24 sa; yetki/izin/bulunamadı/API kapalı +6 sa; günlük kota → sonraki PT gece yarısı; RATE/LOAD +15 dk; diğer +1 sa. Hiçbir yerde gönderim (submit) yok.
- robots farkı panelde gösterilir; AI tarayıcı erişim tablosu (arama ve eğitim tarayıcıları ayrı; SH26 yalnız arama tarayıcıları engelliyse).

## URL Inspection

- Site başına PT günü 200 (SeoSite üzerinde atomik SQL CAS), tur başına en çok 10, turlar arası ≥ 60 sn (`inspectLastRunAt`) → dakikada ≤ 10. Kota hataları: DAILY (ya da "minute" geçmeyen 429/quota) → sonraki PT gece yarısı; RATE/LOAD → 15 dk.
- `gscSyncAllowedFor` koruması: SEO için izinli bir geliştirme süreci GSC'ye izinli olmayan projenin kotasını harcayamaz.
- Öncelikler: P1 kuyruk (kullanıcı + bekçi; P6 rezervine takılmaz), P2 taban çizgisi sonrası ≤ 14 gün önce görülen sitemap URL'leri (≤ 3 kez, ≥ 3 gün arayla), P3 tıklamaya göre ilk 50 (7 günde bir), P4 tıklaması %50'den fazla düşenler (önceki 4 hafta ≥ 10 tıklama, 3 günde bir), P5 tarayıcı şüphelileri (TA7/TA8, 7 günde bir), P6 sitemap URL'lerinden haftalık belirlenimci örnek (hedef min(100, havuz), günlük payla).
- P1 kuyruğu yalnız atomik jsonb SQL yardımcılarıyla değişir (`inspect-queue.ts`); eşzamanlı bekçi, kullanıcı tıklaması ve tüketici giriş kaybetmez.
- Saklanan alanlar: hüküm, kapsam durumu, indeksleme/robots durumu, Google ve kullanıcı canonical'ı, son tarama zamanı, mobil ve zengin sonuç özetleri, `previous` ve `verdictChangedAt`.
- Kapsam tahmini: P6 örneğinde (son 4 hafta, n ≥ 20) PASS payı, Wilson %95 aralığıyla ("~82% (±6%) of your sitemap pages are indexed"); haftalık `GscCoverageWeek` satırı. SH9 düşüşü: nokta ≥ 10 puan aşağı VE aralıklar örtüşmüyor.

## Core Web Vitals

- CrUX kaydı ve History API; origin + kilit sayfalar, PHONE ve DESKTOP; haftada bir. Değerler Google'ın döndürdüğü gibi saklanır; 404 = veri yok (kart gizli).
- Anahtar yalnız başlıkta, asla logda; anahtarsız iş uyur. Dakikada 120 istek sınırı işte; sınırdaysa site sonraki tick'e kalır.
- CrUX herkese açık veri olduğu için CWV uyarıları `SEO` kaynaklıdır.

## Google güncellemeleri

- `search-updates-sync` günde bir `https://status.search.google.com/incidents.json` okur (6 Ekim 2026'da doğrulanan biçim: `[{id, begin, end?, external_desc, service_name, uri, …}]`, son ~10 olay). Ayrıştırıcı savunmacıdır; biçim değişirse yalnız otomatik senkron durur (loglanır).
- Türler: core, spam, ranking, serving ve diğer. Operatörler `/health/search-updates`'te elle satır ekler/siler (tek tarih seçici kuralı: `DatePicker`).
- SH23: düşüş penceresiyle `[ilk düşüş günü − 7 g, son düşüş günü]` örtüşen güncelleme SH2 detayına "Started during the <ad> rollout." ekler ve `GSC_UPDATE_OVERLAP` INFO açar.

## Kontroller (SH1–SH27) ve teknik denetim (TA1–TA24)

| Kod  | Tür(ler)                                                | Kaynak    | Önem                                                        | Eşik / ne zaman                                                                                                                                                         |
| ---- | ------------------------------------------------------- | --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SH1  | GSC_SYNC_STALE                                          | GSC       | WARN                                                        | Bağ > 48 sa ve (son kesin gün < GSC bugünü − 5 ya da ≥ 3 ardışık hata ve son çekim > 36 sa)                                                                             |
| SH2  | GSC_SEARCH_DROP                                         | GSC       | < %50 CRITICAL, < %75 WARN                                  | Yalnız kesin günler; aynı hafta günü 8 hafta medyanı (≥ 6 değer, ≥ 20 tıklama/gün); iki ardışık gün; veri bayat değilse                                                 |
| SH3  | SEO_KEY_PAGE_NOINDEX                                    | SEO       | CRITICAL                                                    | Taze (≤ 12 sa) kontrolde kilit sayfada noindex (meta ya da X-Robots-Tag)                                                                                                |
| SH4  | SEO_ROBOTS_BLOCK / SEO_ROBOTS_ERROR / SEO_ROBOTS_ASSETS | SEO       | CRITICAL / CRITICAL / WARN                                  | `/` ya da kilit sayfa Googlebot'a yasak, ya da `*` grubunda `Disallow: /`; robots 5xx yalnız tur içi yeniden denemeden sonra; sitemap/ana sayfa varlığı yasak; 404 asla |
| SH5  | SEO_KEY_PAGE_ERROR                                      | SEO       | CRITICAL                                                    | Taze kilit sayfa: ≥ 500, 404/410, LOOP/TOO_MANY_REDIRECTS; TIMEOUT/NETWORK yalnız iki ardışık kontrolde; ana sayfa 403 SH5 değil (crawlBlocked)                         |
| SH6  | GSC_CANONICAL_MISMATCH / SEO_CANONICAL_OFFSITE          | GSC / SEO | WARN / CRITICAL                                             | Google ≠ kullanıcı canonical'ı; kilit sayfanın canonical'ı kapsam ve kök alan adı dışında                                                                               |
| SH7  | GSC_INDEX_LOST                                          | GSC       | CRITICAL                                                    | Kilit sayfanın önceki hükmü PASS, şimdi FAIL/NEUTRAL                                                                                                                    |
| SH8  | GSC_NEW_PAGES_NOT_INDEXED                               | GSC       | WARN                                                        | 14–45 gün önce görülen yeni sitemap URL'lerinden ≥ 5 incelenmiş ve > %30 indekste değil (SEO_CRAWL)                                                                     |
| SH9  | GSC_COVERAGE_DROP                                       | GSC       | WARN                                                        | Örnek ≥ 20 ve (nokta < %70 ya da anlamlı düşüş) (SEO_CRAWL)                                                                                                             |
| SH10 | GSC_CRAWLED_NOT_INDEXED                                 | GSC       | WARN                                                        | İki hafta da ≥ 20 örnek, pay ≥ %10 ve ≥ 2×                                                                                                                              |
| SH11 | GSC_SITEMAP_ERRORS / SEO_SITEMAP_MISSING                | GSC / SEO | WARN                                                        | GSC sitemap hatası, 7 günden uzun bekleyen ya da 14 gündür indirilmeyen; kendi okumamızda hiçbir sitemap OK değil                                                       |
| SH12 | SEO_SITEMAP_HYGIENE                                     | SEO       | WARN                                                        | Sitemap'teki taranmış sayfa ≥ 20 ve kötü pay > %5 (SEO_CRAWL)                                                                                                           |
| SH13 | GSC_STALE_CRAWL                                         | GSC       | INFO                                                        | Kilit sayfanın son taranması > 60 gün                                                                                                                                   |
| SH14 | SEO_STRUCTURED_DATA / GSC_RICH_RESULTS                  | SEO / GSC | WARN                                                        | Kilit sayfada JSON-LD hatası; inceleme zengin sonuç hatası                                                                                                              |
| SH15 | SEO_CWV_POOR                                            | SEO       | poor/kötüleşme WARN, NI INFO                                | Origin CrUX (telefon ve masaüstünün kötüsü)                                                                                                                             |
| SH16 | SEO_HTTPS                                               | SEO       | WARN                                                        | http:// üzerinden 200, http→https yönlendirmesi yok ya da karışık içerik                                                                                                |
| SH17 | SEO_REDIRECT_CHAINS                                     | SEO       | WARN                                                        | İç bağlantısı olan TA11 sayfaları                                                                                                                                       |
| SH18 | SEO_BROKEN_LINKS                                        | SEO       | WARN                                                        | TA12 > 0                                                                                                                                                                |
| SH19 | SEO_ORPHAN_PAGES / GSC_ORPHAN_PAGES                     | SEO / GSC | INFO                                                        | Yalnız tamamlanmış (DONE) tam taramadan sonra; GSC tarafı son 4 haftanın ilk 200 sayfasından                                                                            |
| SH20 | SEO_TITLES_META                                         | SEO       | INFO                                                        | TA1–TA5 > 0                                                                                                                                                             |
| SH21 | SEO_HREFLANG                                            | SEO       | WARN                                                        | TA20 > 0                                                                                                                                                                |
| SH22 | SEO_RENDER_RISK                                         | SEO       | WARN                                                        | Kilit sayfada JavaScript'e bağlı içerik riski                                                                                                                           |
| SH23 | GSC_UPDATE_OVERLAP                                      | GSC       | INFO                                                        | SH2 düşüşü bir Google güncellemesiyle örtüşüyor                                                                                                                         |
| SH24 | GSC_SITE_MISMATCH                                       | GSC       | WARN                                                        | Seçili site projenin sitesini kapsamıyor                                                                                                                                |
| SH25 | GSC_CONNECTION                                          | GSC       | WARN                                                        | Bağ AUTH/NEEDS_PERMISSION/ACCESS_LOST/GONE/API_DISABLED                                                                                                                 |
| SH26 | SEO_AI_CRAWLERS_BLOCKED                                 | SEO       | INFO                                                        | Bir AI arama tarayıcısı robots'ta engelli                                                                                                                               |
| SH27 | GSC_LOST_URLS / SEO_SITE_MIGRATION                      | GSC / SEO | kilit sayfa ya da > %10 tıklama CRITICAL, yoksa WARN / WARN | Kaybolan URL'ler (301 haritası istekle hesaplanır, saklanmaz); yeni URL ≥ 20 ve ≥ %30, bilinenlerin ≥ %20'si artık yönleniyor                                           |
| —    | SEO_CRAWL_BLOCKED                                       | SEO       | INFO                                                        | Site denetimimizi engelliyor (crawlBlocked)                                                                                                                             |

- TA kataloğu (`lib/seo/technical-audit.ts`), plan §6.3 önemleri: WARN TA1, TA2, TA8, TA9, TA11, TA12, TA16, TA18, TA19, TA20, TA21, TA22, TA24; INFO TA3, TA4, TA5, TA6, TA13, TA14, TA15, TA17, TA23; TA7 ve TA10 kilit sayfada CRITICAL, diğerlerinde WARN. Sapma: TA18 3 MB sayfa ağırlığı yerine 2 MB HTML (kesilmiş) ya da TTFB > 1,5 sn (varlıklar hiç getirilmez).
- Değerlendirilen türler kuralı: bayat ya da geçici olarak eksik girdi bir uyarıyı KAPATMAZ (tür değerlendirilmemiş sayılır); kaynağı kapanan tür (tarama kapalı, kapsam yok, GSC bağı yok) taslaksız değerlendirilir ve kapanır; PAUSED/CLOSED proje her şeyi kapatır.

## Uyarılar

- GA-F3'ün SiteAlerts katmanı (`AdsAlert.source`): `GSC` = Search Console verisinden hesaplanan her şey; `SEO` = kendi tarayıcımız, robots, kendi sitemap okumamız ve CrUX. dedupeKey `<kaynak küçük harf>:<TÜR>`, tür ve site başına bir. Bu track'te site-alerts'i içe aktaran tek dosya `server/seo/health/alerts.ts`. Her tur kaynak başına, yalnız değerlendirebildiği türler için `resolveMissing` çağırır.
- Telegram: operatör sohbetine ASLA (`notifyIfDue` `source` dolu satırda döner). SiteAlerts CRITICAL `SEO` uyarılarını projenin kendi Telegram'ına türe göre sabit bir ifadeyle (`seoTelegramPhrase`; rakam, URL, sorgu, tırnak yok; test edilir) ve `/projects/<id>/arama#health` bağlantısıyla gönderir. `GSC` uyarıları yalnız genel ifadeyi (`SEARCH_TELEGRAM_FALLBACK`) taşır, bulgu sözcüğü yok. `telegramTextFor`'daki kaynak dalı yalnız savunma amaçlıdır.
- Google sınırı: Google kökenli içerik (tıklama sayıları ya da oranları, GSC sayfa yolları, indeks hükümleri) yalnız Gsc* tablolarında ve `GSC` uyarılarında durur; üç silme yolu (Disconnect, Delete stored data, W1 yetim temizliği) bayraktan bağımsızdır. `SEO` uyarıları yalnız kendi taramamızın herkese açık yollarını ve sayıları taşır. Kilit sayfa seçiminde GSC tıklama sırası yalnız sıralama için kullanılır.
- 7 gün susturma (her üye; yalnız o projenin GSC/SEO uyarıları).

## Puan

- Ağırlıklar: Indexing 35, Technical 25, Sitemaps & robots 15, CWV 15, Data 10. Girdisi olmayan parça dışarıda kalır, ağırlıklar yeniden normalleştirilir.
- Taban: Indexing = kapsam nokta tahmini (yoksa tam), Technical = WARN/CRITICAL TA sorunu olmayan taranmış 200-HTML sayfaların payı (yoksa tam), diğerleri tam.
- Cezalar parça başına açık taslak için: CRITICAL ağırlığın tamamı, WARN %40, INFO %10 (taban 0). Herhangi bir CRITICAL puanı 40'ta keser. Hiç parça yoksa null. `SeoSite.healthScore` / `healthParts`'a yazılır.

## Arayüz

- **Search sayfası** (`/projects/[projectId]/arama`): "Index & technical health" bölümü (`<section id="health">`) üç durumda da (bağlı değil, bekliyor, hazır) sayfanın sonunda, `Suspense` içinde; W1 raporu onu beklemez, Search Console'u olmayan proje de site denetimini görür. `?issue=<alertId>` ilgili sorunu açık getirir. Kartlar: puan, sorunlar ve rehberler, kilit sayfalar (Inspect), sitemap'ler, robots, kapsam, CWV, tarama ayarları, doğrulama, 301 haritası.
- Eylemler (hepsi `seoWorkAllowedFor` ister ve `seo_site.*` denetim kaydı yazar): tarama aç/kapat ve sayfa sınırı 100/250/500 (OWNER/ADMIN), "Check again now" (son tam tarama ≥ 24 sa; crawlBlocked'ı da temizler), "Delete audit data" (OWNER/ADMIN), doğrulama kontrolü, Inspect (P1), "Mute 7 days".
- **Today özeti**: açık CRITICAL arama uyarılarından en çok 2 "seo" satırı, en önde (kesilmesinler diye), "Fix" → `/projects/<id>/arama?issue=<alertId>#health`. Özet "next" satırını seçerken `fix_search_issue` adımını atlar; çift sayım yok.
- **Sıradaki adım**: `fix_search_issue` engel adımı iki yolda da ilk; `+N more search issues`. Gizleme ağırlığı `action.count`: gizlenen adım yeni kritik sorun açılınca geri gelir.
- `loadSearchAttention` React cache'li; `SEO_HEALTH && GSC_SEARCH_PAGE && seoWorkAllowedFor` değilse veritabanına hiç gitmez.
- **/health** (operatör): "Search health" kartı (izlenen siteler, bugünkü incelemeler, duraklatılan siteler, süren taramalar, …; `healthy`'ye sayılmaz) ve `/health/search-updates`.
- **Bot sayfası**: agentelse.com/bot iki kimliği (AgentelseSiteAudit, AgentelseSiteCheck) anlatır; güvenlik duvarında UA ile izin verilmesini önerir, IP iddiası yok. Footer'da "Our bots", sitemap'te `/bot`.

## Gizlilik

- Ne getirilir: yalnız doğrulanmış sitenin herkese açık sayfaları, robots.txt ve sitemap'ler; saniyede ≤ 1 istek, haftada ≤ 500 sayfa + 6 saatte bir birkaç kilit sayfa; robots.txt'ye uyulur.
- Ne saklanır: adres, durum kodu, başlık, meta description, başlıklar, dil, Open Graph, yapılandırılmış veri türleri, hreflang, iç bağlantılar ve bağlantı metni, boyut ve yanıt süresi, robots.txt kopyası. Sayfa metni saklanmaz.
- Doğrulama yöntemleri: ana sayfada meta etiketi ya da DNS TXT kaydı.
- Limited Use: Google verisi operatöre gitmez; CRITICAL bir `GSC` uyarısı projenin kendi Telegram'ına yalnız genel ifadeyi (`SEARCH_TELEGRAM_FALLBACK`; rakam, sayfa ya da bulgu yok) gönderir. SC-F3'te LLM kullanımı yok: sohbet modeline giden sıradaki adım listesinde GSC/GA4 uyarı başlıkları sabit bir cümleyle değiştirilir (`nextStepTitlesForPrompt`). Gizlilik ve veri silme sayfalarına SC-F3 paragrafları eklendi.

## Testler

- A (saf ayrıştırıcılar): `lib/seo/{health-flags,crawl-url,robots-parser,sitemap-parser,html-audit,jsonld,technical-audit,redirect-map}.test.ts`.
- B1: `server/security/guarded-transport.test.ts`, `server/seo/crawl/{pacer,mock-site,fetcher}.test.ts`.
- B2: `server/seo/crawl/{schedule,frontier}.test.ts`, `server/seo/site/{sites,verify}.test.ts` + `server/seo/crawl/crawl.integration.test.ts`.
- C: `lib/seo/{inspection,inspection-plan,coverage,cwv,search-updates}.test.ts`, `server/integrations/search-console/url-inspection.test.ts`, `server/integrations/crux/crux-api.test.ts`, `server/seo/health/inspection.test.ts`, `server/actions/search-updates-actions.test.ts` + `server/seo/health/inspection.integration.test.ts`.
- D: `lib/seo/health/{alert-kinds,checks,search-drop,score,guides}.test.ts`, `server/seo/health/{runner,attention,alerts}.test.ts` + `server/seo/health/health.integration.test.ts`.
- E: `server/seo/health/panel.test.ts`, `server/actions/search-health-actions.test.ts`, `components/search-health/{health-panel-view,seo-operator-card}.test.ts`.
- Paylaşılan: Ads uyarıları (arama uyarısı metni), Disconnect sırası ve hata toleransı, W1 "Delete stored data" (GSC uyarısı silinir), daily brief, next steps, journey-dismissal, gizlilik ve veri silme metinleri.
- Paralel kural: paketler birbirinin modüllerini birim testlerinde mock'ladı; tsc ve entegrasyon testleri birleşmeden sonra koşar.

## Doğrulanmalı

- `siteRestrictedUser` yetkisiyle URL Inspection davranışı.
- URL Inspection kota hata metinleri (DAILY/RATE ayrımı).
- CrUX'un `X-Goog-Api-Key` başlığını kabulü ve TTFB metrik adı.
- Status dashboard akışının kalıcılığı.
- Uç durumlarda Google robots eşleşmesiyle aynılık.
- WAF'ların (Cloudflare bot fight mode) Retry-After ve 403/503 davranışı.
- SiteAlerts.raise'in bildirimi kendisi yaptığı; GSC uyarılarının operatöre hiç gitmediği ve CRITICAL olanın projenin kendi Telegram'ına yalnız genel ifadeyi taşıdığı (GA-F3 birleşmesinde doğrulandı; `site-alert-text.test.ts`).
