# Google Analytics ambarı ve Website sayfası (GA-F2)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §3.3, §3.4, §3.9, §4, §5. Bağlantı katmanı: [google-connections.md](google-connections.md). Bu dosya GA-F2'nin uygulanmış hâlini anlatır.

## Durum (6 Ekim 2026)

| Parça                                                                                                                                                                                                                                                                                        | Durum                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Ambar tabloları + migration `20261006190000_add_ga_warehouse`                                                                                                                                                                                                                                | Yapıldı                                                       |
| GA istemcisi (Data API toplu istek, Admin API, mock modu), kota yöneticisi, PII süzgeci                                                                                                                                                                                                      | Yapıldı                                                       |
| Senkron: bağlar, metadata, günlük çekim + revizyon, kesinleşme, 400 günlük geri doldurma, ay özetleri, saklama                                                                                                                                                                               | Yapıldı (`ga-sync`, `ga-retention` tick adımları)             |
| Okuyucuların ambara geçişi: Analytics modülü, ANALYTICS_ANALYSIS, tarayıcı                                                                                                                                                                                                                   | Yapıldı (`GA_SYNC` açıkken, eksik pencerede canlı yola düşer) |
| Website sayfası v1 (`/projects/[projectId]/site`), Explore girişi, Refresh                                                                                                                                                                                                                   | Yapıldı (`GA_WEBSITE_PAGE`)                                   |
| Integrations: "Data through …", mülk kartı, saklama beyanı; gizlilik metni                                                                                                                                                                                                                   | Yapıldı                                                       |
| Bölüm 2: haftalık dilimler + site_search (`GA_WEEKLY`), katalog denetimi + google_ads/search_console (`GA_CATALOG_CHECKS`), Today so far / Right now (`GA_LIVE`), Analytics modülünde kanal/açılış sayfası/key event listeleri (`GA_MODULE_SECTIONS`), Brand sekmesi Website kartı (`GA_BRAND_CARD`), /health sayaçları | Yapıldı (bayraklı, canlı denenmedi) |
| GA-F3 ölçüm sağlığı (`GA_HEALTH`) | Yapıldı, bkz. [measurement-health.md](measurement-health.md) |
| GA-F6 UTM, atıf, AN13/AN14, MH25 (`GA_UTM`) | Yapıldı (canlı denenmedi), bkz. [website-attribution.md](website-attribution.md) |

## Bayraklar ve açılış

- `GA_SYNC=true`: senkron, saklama ve okuyucular. Kapalıyken hiçbir şey değişmez (adımlar hemen 0 döner, okuyucular canlı yolu kullanır).
- `GA_WEBSITE_PAGE=true`: Website sayfası ve Explore'daki "Website" satırı. Veri için `GA_SYNC` de açık olmalı.
- `GA_HEALTH=true` (GA-F3): ölçüm sağlığı denetimi, uyarılar ve puan; `GA_SYNC` ister. Ayrıntılar ve açılış sırası (migration koddan önce) [measurement-health.md](measurement-health.md)'de.
- `GA_SYNC_DEV_PROJECTS=<id,id>`: yerel geliştirme süreci canlı veritabanını paylaşırken yalnız bu projeler senkronlanır; saklama temizliği yerelde hiç çalışmaz. Yerel tek kullanımlık veritabanında (localhost ya da Unix soketi) her şey çalışır.
- Sıra: migration canlıya çıkar (Railway başlangıcında `migrate deploy`) → `GA_SYNC=true` → ilk veriler birkaç dakikada, geçmiş birkaç tick'te gelir → `GA_WEBSITE_PAGE=true`.

Bölüm 2 bayrakları (hepsi `GA_SYNC` ister; şema değişikliği ve migration yok):

- `GA_CATALOG_CHECKS=true`: haftalık `getMetadata` + `checkCompatibility` denetimi (katalog v2) ve isteğe bağlı google_ads ile search_console raporları.
- `GA_WEEKLY=true`: 95-400 gün arası haftalık dilimler, haftalık site_search raporu, DAY+WEEK birleşik okuma, ay özetlerinde haftalık açılış sayfaları ve Website sayfasındaki "Site search" tablosu.
- `GA_MODULE_SECTIONS=true`: Analytics modülünün Google Analytics bölümünde Channels, Top landing pages ve Key events listeleri (yalnız ambardan).
- `GA_BRAND_CARD=true`: sağ dokun Brand sekmesindeki "Website" kartı ve `GET /api/projects/[projectId]/website/overview`. `GA_WEBSITE_PAGE` da gerekir.
- `GA_LIVE=true`: Website sayfasında "Today so far" ve "Right now" ile `GET /api/projects/[projectId]/website/live`. `GA_WEBSITE_PAGE` da gerekir.
- Açılış sırası: `GA_SYNC` zaten açık → `GA_CATALOG_CHECKS` → `GA_WEEKLY` (haftalık geçmiş, temel geri doldurma bitmişse birkaç tick'te P2_BACKFILL şeridinde gelir) → `GA_MODULE_SECTIONS`, `GA_BRAND_CARD`, `GA_LIVE`.
- Her bayrak çağrı anında okunur; hepsi kapalıyken hiçbir şey değişmez (`GA_SYNC` açıkken yalnız /health sayaç kartı ve WEEK satırı saklaması çalışır, ikisi de veri yoksa iş yapmaz).
- Geri alma notu: `GA_CATALOG_CHECKS` katalog v2 yazdıktan sonra eski bir sürüm onu yanlış okur (`v`, `disabled`, `check`, `optional` anahtarlarını kapalı rapor sanar, gerçekten kapalı raporları yeniden dener). Yeni sürümler iki biçimi de okur ve eski sürümün eklediği düz anahtarları `disabled`'a taşır. Geri alınacaksa önce `GA_CATALOG_CHECKS` kapatılır; düşürülen her rapor bir kez daha hata verir.

## Tablolar

- `GaPropertyLink`: proje ↔ GA4 mülkü. Seçili mülkü olan ACTIVE `google_analytics` bağlantısından tembel oluşur (`sync/links.ts`, iki dakikada bir + mülk seçiminde hemen). Seçim değişince eski bağ birincilliğini kaybeder ve 30 gün sonra silinir. Mülk metadata'sı, sağlık, kota durumu, kilit ve geri doldurma durumu buradadır.
- `GaDailyTotal`: mülk günü başına toplam (KPI'ların tek kaynağı). Para mikro birim; oturum süresi toplam olarak (ortalama × oturum) tutulur.
- `GaReportSlice`: katalog raporunun bir günü, kompakt satırlar (`[boyutlar…, metrikler…]`), kırpılan satırların toplamı (`otherRow`), kalite bayrakları.
- `GaMonthlySummary`: bütün günleri kesinleşmiş ayların özeti (toplamlar, kanallar, ilk 50 açılış sayfası, tekil kullanıcılar).
- Mevcut modellere ilişki yok: proje silme `projectId` kolonlu her tabloyu kendisi temizler; Ga* tabloları kendi aralarında cascade'lidir.

## Rapor kataloğu (`src/lib/website-analytics/catalog.ts`)

totals (10 metrik) + channel, source_medium, campaign, landing_page, page, events, key_events_channel, attribution, device_country, new_returning + `rolling_users` (7/28/90 günlük tekil kullanıcı, her gün). Dönem kullanıcıları günlüklerden toplanamadığı için kayan pencereden okunur; özel dönemlerde (bu ay, geçen ay) "Users" gösterilmez.

- Satırlar ana metriğe göre bütün aralıkta sıralanır, gün başına kırpma yerelde yapılır (gün sırası sınıra takılınca son günleri düşürürdü).
- Google bir raporu geçersiz sayarsa (400) toplu çağrı tek tek denenir ve yalnız o rapor bağın `catalog` alanına düşer; diğerleri sürer.
- Sayfa yolu ve başlıklar `google/pii.ts`'ten geçer: sorgu dizesi atılır, e-posta, telefon ve anahtar benzeri parçalar maskelenir, aynılaşan satırlar birleşir.

## Senkron (`src/server/website-analytics/sync/`)

- `ga-sync` tick adımı: tick başına en çok 3 bağ, bağ başına 5 dakikalık CAS kilidi (`syncLeaseUntil` aynı zamanda geri çekilme ve kota bekletmesi). Sıra: metadata (günde bir) → günlük çekim → kesinleşme → geri doldurma → ay özetleri. PAUSED/CLOSED projede yalnız metadata. Odak ayarı adımı kapatmaz. Nabız: `SystemHeartbeat("ga.sync")`.
- Günlük çekim mülk saatiyle 16:00, 18:00 ve 21:00 pencerelerinde; dünün verisi gelince ya da son pencerede gün tamamlanır. Yeni bağlantı saati beklemez; 16:00'dan önceki deneme günü tamamlamaz. Her çekim D-1…D-7'yi (atıf D-1…D-13) yeniden yazar; pencereden çıkan gün `isFinal` olur.
- Geri doldurma: revizyon penceresinin hemen öncesinden geriye, mülkün açıldığı günden eskiye inmeden; günlük raporlar 400, yüksek kardinaliteli raporlar 95 gün. Tur başına en çok 10 istek, kota yöneticisinin geri doldurma payıyla; kesilirse kaldığı yerden sürer.
- Kota yöneticisi (`lib/website-analytics/governor.ts`): yanıttaki `propertyQuota` mülkün bütün bağlarına yazılır. Arka plan işi saatlik payın %20'si, günlüğün %10'u altında durur; geri doldurma saatlik payın yarısını kullanmaz; Refresh %5'e kadar sürer. Saatte 3 sunucu hatasından sonra arka plan o saat durur. 429 → `rateLimitedUntil`; günlük kota → Pasifik gece yarısı. Mülk başına süreç içinde en çok 2 eşzamanlı istek.
- Hatalar: AUTH, SCOPE_MISSING, PERMISSION, NOT_FOUND, API_DISABLED → bağın sağlığı yazılır ve senkron 6 saat bekler; geçici hatalarda üstel geri çekilme (5 dk → 6 sa), 3 ardışık hatada DEGRADED.
- `ga-retention` (günde bir, global kilit): süresi dolan dilim/toplam/ay satırları, birincilliğini kaybetmiş eski bağlar ve bağlantısı kalmamış bağlar silinir.
- Mock modu (`AGENTELSE_PROVIDER_MODE=mock`): Google'a ve token ucuna çağrı yok, istekten belirlenimci yapay veri; bağlar `isMock` işaretli.

## Haftalık dilimler (`GA_WEEKLY`)

- `GaReportSlice` satırları, grain `WEEK`; `periodStart` mülk saatiyle ISO haftasının pazartesisi, boyut `isoYearIsoWeek` (`lib/website-analytics/weeks.ts`, `weekly.ts`).
- Raporlar: source_medium, campaign, landing_page, page, device_country (gecikme 8 gün, yalnız kesinleşmiş haftalar yani Pazar ≤ D-8, bir kez çekilir; parça 6 hafta landing_page/page için, 13 hafta diğerleri için, yanıt başına ≤ 6.000 satır) ve site_search (`searchTerm`, `eventName == view_search_results`, hafta başına 200 satır, gecikme 3 gün, arama sözcükleri `maskGoogleText`'ten geçer).
- Kapsam: mülkün açıldığı haftadan ya da 400 gün öncesinden (hangisi yeniyse) son kesinleşmiş haftaya kadar; 95 günlük DAY aralığıyla bilerek örtüşür.
- İlerleme `GaPropertyLink.backfill.addons`'ta (ileri + geri; tur başına en çok 10 istek; yalnız temel geçmiş bittikten ve bağ en az bir kez günlük senkronlandıktan sonra). `backfillDoneAt` değişmez; "Older data is still loading" notu eski anlamını korur. Başlatılmamış anahtar "bitmedi" sayılır ve aşama due olur.
- Birleştirme kuralı (`planSliceSources`, okuyucu `readMergedSlices`): bir haftanın aralık içindeki bütün günlerinin DAY dilimi varsa günler; yoksa aralığın tam içindeki hafta WEEK diliminden; yoksa var olan günler, kalanı eksik sayılır. Kenar haftalar varsayılan dışarıda; ay özetleri `edgeWeeks: "majority"` ile ≥ 4 günü aralıkta kalan kısmi haftayı alır ve planı yaklaşık işaretler. Her hafta tam bir aya düşer.
- Ay özetleri topPages'i haftalık veriden alır; `week:landing_page` etkin ama geçmişi bitmemişse (başlatılmamış dahil) eksik günlü ay bekler. Ay özetleri 36 ay saklanır; kesinleşmiş aylar yeniden hesaplanmaz.
- Saklama: WEEK satırı Pazar'ı pencereden çıkınca silinir (400 gün; search_console 95 gün). Bayrak kapalıyken de çalışır ki bayrak kapandıktan sonra da 400 gün sözü tutsun.

## Katalog denetimi (`GA_CATALOG_CHECKS`)

- Haftalık `getMetadata` (`metadata-api.ts`), çekirdek kota kapısı yok (runReport jetonu harcamaz). Hata (429 dahil) `check.error` yazar ve 24 saat sonra yeniden denenir; AUTH, SCOPE_MISSING, PERMISSION, NOT_FOUND, API_DISABLED yeniden fırlatılır ve runner'ın sağlık yolu işler. Tur sırası: metadata → katalog denetimi → günlük (+ google_ads) → kesinleşme → temel geri doldurma → eklentiler → ay özetleri.
- `GaPropertyLink.catalog` v2: `{v: 2, disabled, check: {at, missing, deprecated, blocked, error}, optional}` (`catalog-state.ts`). Eski düz biçim (`{[key]: {reason, at}}`) okunmaya devam eder; `withDisabledReport` aldığı biçimi korur, v2'yi yalnız `syncCatalogChecks` yazar.
- Kapatma anahtarları: `'<rapor>'` günlük ve haftalık çekimi durdurur; `'week:<k>'` (5 haftalık kırılım) yalnız haftalık çekimi; site_search, google_ads ve search_console kendi düz anahtarlarıyla kapanır (`week:site_search` yazılmaz).
- `FIELD_MISSING: a, b` alan geri gelince yeniden açılır; diğer düşürmeler (ve bilinmeyen anahtarlar) 7 gün sonra bir kez yeniden denenir. Yeniden açılan raporun kapalı kaldığı günler doldurulmaz (bilinen boşluk; modül listeleri o raporu boşluk yaşlanana kadar atlar, Website tabloları eksik gösterir).
- Yalnız `deprecatedApiNames` altında görünen alanlar `check.deprecated`'a gider (bir `console.warn`). Kısıtlı maliyet/gelir metrikleri (NO_COST_METRICS, NO_REVENUE_METRICS) Google'dan sıfır döner, istek hata vermez: `check.blocked`'a yazılır.
- google_ads: Admin API'deki Google Ads bağı (`linkedProducts.googleAds > 0`) + metadata alanları + uyumluluk; yoksa NO_ADS_LINK, FIELD_MISSING ya da INCOMPATIBLE ile kapalı. Günlük rapor (tarih × `sessionGoogleAdsCampaignName`; maliyet, tıklama, oturum, key event, gelir; günde 100 satır, `(not set)` hariç), 7 günlük revizyon, 400 gün, 90 günlük parçalarla geri doldurma. Bu bölümde onu okuyan yüzey yok.
- search_console: yalnız uyumluluk sinyali; hedef haftanın Pazar'ında biten 28 günlük pencere tek WEEK diliminde (`isFinal`), açılış sayfası başına tıklama, gösterim ve gösterim ağırlıklı pozisyon (CTR ve pozisyon okuyucuda hesaplanır), 95 gün, geri doldurma yok.

## Gün içi ve Right now (`GA_LIVE`)

- **Today so far**: mülk saatiyle bugün için tek runReport (sessions, activeUsers, newUsers, keyEvents, screenPageViews), P1 şeridinde `runGaRequests` ile. Bağ başına süreç belleğinde en çok 2 saat, veritabanına hiç yazılmaz; sayfada "Partial" etiketli. Proje bağlantısı koptuğunda (not_connected / reconnect) önbellekten atılır. Canlı veritabanını paylaşan dev süreci yalnız izinli projelere hizmet eder.
- **Right now**: `runRealtimeReport`, activeUsers, son 30 dakika (`realtime.ts`). Mülk ve bağlantı başına süreç belleğinde 60 sn (aynı mülke bağlı başka projeler kaydı paylaşmaz: her proje kendi Google yetkisiyle okur); süreç başına bağlantı başına dakikada en çok bir istek. Realtime 429'u kendi 15 dakikalık geri çekilmesini başlatır, `rateLimitedUntil`'e ve çekirdek kota yöneticisine dokunmaz.
- İstemci (`website-live-strip.tsx`) yalnız sayfa görünürken 60 sn'de bir yoklar; Today so far açılışta ve 15 dakikada bir (sunucu önbelleğinden).
- Uç: `GET /api/projects/[projectId]/website/live?part=today|now` (`Cache-Control: private, no-store`).

## Brand sekmesi Website kartı (`GA_BRAND_CARD`)

- Pencere veriye bağlı: bitiş = min(dün, son saklanan gün), mülk saatiyle 28 tam gün; önceki = ondan önceki 28 gün. Son 28 günün satırı eksikse kart görünmez.
- Oturumlar ve key event'ler, oturuma göre trend oku (±%3; önceki dönem eksik ya da 0 ise yok), sağlık noktası (Up to date / Checking / Updates are failing / Reconnect needed · Can't read the property / Data is late), "Open" → `/site`.
- Veriyi `GET /api/projects/[projectId]/website/overview`'dan (`private, max-age=120`) sayfa çizildikten sonra kendisi çeker; bayraklar kapalıyken kart da istek de yok.

## Analytics modülü

- `GA_MODULE_SECTIONS` açıkken Google Analytics bölümüne Channels (en çok 6), Top landing pages (5) ve Key events (5) eklenir (`modules/analytics/ga-sections.ts`, `lib/website-analytics/breakdowns.ts`). Yalnız ambar penceresi dalından ve raporun DAY dilimleri pencerenin her gününü kapsıyorsa; canlı yol bu listeleri hiç doldurmaz.
- Alanlar `OkSection`'da isteğe bağlıdır ve yalnız satır varken yazılır: saklanmış raporlar ve bayrak kapalı çıktı bayt bayt aynı kalır.
- AI olguları (`facts.ts`) listeleri taşır, böylece sayı denetimi bu sayılara izin verir. Prompt yalnız listeler varken değişir (uzun DATA satırı + "Channel shares are already in DATA; do not add them up.").
- Etiketler `cleanWorksText`'ten geçmez (topSearches ile aynı; ambarda zaten maskeli, DATA-talimat-değildir kuralı geçerli). Plan §3.11'den bilinçli sapma.
- Düz metin dışa aktarım ("Copy summary") tabloları içermez; Markdown ve yazdırma HTML'i üç tabloyu içerir.

## /health

- "Google Analytics" sayaç kartı (`GA_SYNC` açıkken, `ga-health-card.tsx`, `health-counters.ts`): sağlığa göre mülkler; senkronu başarısız / hız sınırında / geciken / geçmişi yüklenen; kota payları; son 24 saatin API çağrıları ve sınıfa göre hataları (Data API + Admin API, `SystemHeartbeat("ga.api")`; canlı veritabanını paylaşan dev süreci yazmaz); düşürülen raporlar, kullanımdan kalkan alanlar, açık isteğe bağlı raporlar.
- Yalnız sayılar: mülk kimliği, ad ya da müşteri verisi yok (Limited Use). Sayfanın `healthy` hesabını etkilemez.

## Okuyucular

- `store.ts` ambarın tek okuma kapısıdır; `readers.ts` eski canlı okuyucuların karşılığıdır: mülk saatiyle dünkü güne kadar `days` gün eksiksizse ambardan, değilse canlı.
- Analytics modülü (`modules/analytics/google.ts`): aynı metrikler (aktif kullanıcı kayan pencereden, oranlar bileşenlerinden).
- ANALYTICS_ANALYSIS (`google-api-provider.ts`) ve günlük tarayıcı (`google-analytics-scanner.ts`): 28 ve 7 günlük pencere.

## Arayüz

- **Website sayfası** (`/projects/[projectId]/site`, Explore → "Website"): başlıkta mülk adı, "Data through Oct 5" ve mülk saat dilimi; dönemler 7/28/90 gün, bu ay, geçen ay; KPI kartları (Users, Sessions, New users, Engagement rate, Avg. engagement time, Key events, gelir varsa Revenue) önceki dönemle; günlük oturum grafiği (kesikli çizgi önceki dönem); Channels, Key events ve Landing pages tabloları ("Other / not shown" satırı ve kalite notları); son 7 günün değişebileceği notu; sağlık uyarısı; Refresh (5 dakikada bir).
- **Connectors → Google Analytics** (bağlıyken, `GA_SYNC` açıkken): "Data through …" (geçmiş yükleniyorsa "older history loading"), saat dilimi · para birimi · ölçüm kimliği · akış adresi, "Open website report" (`GA_WEBSITE_PAGE`). Bağlı değilken: "Agentelse keeps daily, weekly and monthly summaries of your Google Analytics data to build reports. Disconnecting deletes them."
- **Disconnect** bağı ve bütün ambar verisini hemen siler (`google-disconnect.ts`).
- **Gizlilik**: Google bölümünde günlük özetler, süreleri (400 / 95 gün), 400 güne kadar haftalık özetler, 36 aya kadar ay özetleri (ilk 50 açılış sayfası dahil), site içi arama sözcükleri, Google Ads ve Search Console özetleri, maskeleme ve saklanmayan "Today so far" / "Right now" sayıları yazıyor; bayraklardan bağımsız olarak saklayabileceğimiz en çoğu anlatır.
- **Website sayfası** (bölüm 2): `GA_WEEKLY` ile Landing pages'in altında "Site search" tablosu (dönemin içindeki çekilmiş tam haftalar, ilk 10 + "Other"); `GA_LIVE` ile sağlık uyarısının altında "Today so far" (Partial) ve "Right now" kartları.

## Website insights (GA-F4)

Ambarın üstünde çalışan analiz motoru [website-insights.md](website-insights.md)'de anlatılır. `GA_INSIGHTS=off|shadow|on` (`GA_SYNC` gerekir) açıkken Website sayfasının (`/projects/[id]/site`) rapor gövdesinin altında "Insights" bölümü "What changed" ve "Opportunities" listelerini gösterir (Accept / Dismiss / Mark done). `GA_INSIGHTS=on` iken (ya da gölge kipte `GA_INSIGHTS_PROJECTS`'teki projelerde) eski `google-analytics-scanner.ts`'in GA kısmı (`DECLINING_TRAFFIC`) çalışmaz; düşüşleri AN1/AN2 bulur.

## From Agentelse and your ads (GA-F6)

`GA_UTM=true` + `GA_SYNC=true` açıkken Website sayfası (`/projects/[id]/site`) rapor gövdesinin hemen altında "From Agentelse" (Agentelse'in etiketlediği linklerden gelen ziyaretler: reklamlar ve bio linki) ve "Your ads on your website" (Meta reklamlarının harcama, tıklama, sonuçlarıyla GA4 oturum ve key event'leri; her sütun kaynağı başlıkta taşır) bölümlerini, `google_ads` raporu varsa "Google Ads (from GA4)" tablosunu gösterir. Ölçüm sağlığı panelinin altında "Code MH25" kartı (Agentelse UTM kapsamı) çıkar. AN13/AN14 `GA_INSIGHTS` içinde koşar; haftalık rapor `GA_REPORTS` ile "From Agentelse" bölümü taşır. Ayrıntı ve bayrak tablosu: [website-attribution.md](website-attribution.md).

## Website reports (GA-F5)

Ambarın üstünde çalışan raporlama ve planlama katmanı [website-reports.md](website-reports.md)'de anlatılır. `GA_REPORTS=true` (`GA_SYNC` gerekir) açıkken:

- projede "Website analytics" sohbeti (`wkga_<projectId>`) açılır; nabız, haftalık, aylık, "Next month plan" ve kritik ölçüm uyarısı kartları oraya, değişmeyen anlık görüntü olarak yazılır;
- Website sayfasının (`/projects/[id]/site`) altında "Reports" arşivi (son 12 haftalık, aylık ve plan kartı; Copy / Markdown / "Print / PDF") görünür;
- Brand Brain → Goals'ta `web.*` hedeflerinin bu ayki temposu ve "Progress this month" satırı çıkar;
- Settings → Autonomy → "Website reports" kartı açılır.

Bayrak kapalıyken bunların hiçbiri çalışmaz ve sorgu atmaz.

## Ek mülkler ve /websites (GA-F8)

Bir projede 1 ana + en çok 4 ek GA4 mülkü (`GA_AGENCY`). Website sayfası `?property=<id>` ile seçilen mülkü salt okunur gösterir (mülk seçici, tek istek kapsamlı seçili bağ). Uyarı çözümü bağ kapsamlıdır: `SiteAlerts.resolveMissing` `excludeDedupePrefixes` ile diğer motor bağlarının uyarılarına dokunmaz. Workspace genelinde OWNER/ADMIN için `/websites` görünümü vardır. Ayrıntı: [website-agency.md](website-agency.md).

## Testler

`src/lib/website-analytics/*.test.ts` (katalog, yanıt ayrıştırma, dilimleme, kota, zamanlama, geri doldurma, dönemler, toplamlar, bayraklar), `google/pii.test.ts`, `sync/requests.test.ts` (toplu çağrı, bozuk rapor, kota bekletmesi, sunucu hatası, 429), `sync/warehouse.integration.test.ts` (gerçek Postgres, mock Google: uçtan uca senkron, yeniden yazımda kopya yok, Website raporu, Disconnect'te silme; CI'da koşar).

Bölüm 2:

- A (temel): `lib/website-analytics/{flags,catalog,catalog-state,weeks,weekly,slices,addon-backfill,api-counters}.test.ts`, `server/website-analytics/api-counters.test.ts`, `google-analytics/data-api.test.ts` (sayaçlar), `sync/requests.test.ts`, `sync/weekly.integration.test.ts` (haftalık geçmiş, site_search, google_ads, ay özetleri; gerçek Postgres).
- B (katalog + /health): `lib/website-analytics/{catalog-fields,health-counters}.test.ts`, `components/website-analytics/ga-health-card.test.ts`, `sync/catalog-checks.integration.test.ts`.
- C (Website yüzeyleri): `lib/website-analytics/{live,overview}.test.ts`, `components/website-analytics/website-live-strip.test.ts`, `components/workspace/website-overview-card.test.ts`, `server/website-analytics/live.integration.test.ts`.
- D (Analytics modülü): `lib/module-flows/analytics/{facts,export,state,number-check}.test.ts`, `lib/website-analytics/breakdowns.test.ts`, `server/modules/analytics/{summary,collect}.test.ts`, `components/module-flows/analytics/analytics-flow.test.ts`, `server/modules/analytics/ga-sections.integration.test.ts`.
