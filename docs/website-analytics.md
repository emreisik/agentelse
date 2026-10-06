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
| Bölüm 2: Brand sekmesi "Website" kartı, Analytics modül kartında kanal/açılış sayfası/key event bölümleri, /health sayaçları, haftalık dilimler (95-400 gün yüksek kardinalite), `getMetadata`/`checkCompatibility` (google_ads, search_console, site_search raporları), gün içi ve realtime | Bekliyor                                                      |

## Bayraklar ve açılış

- `GA_SYNC=true`: senkron, saklama ve okuyucular. Kapalıyken hiçbir şey değişmez (adımlar hemen 0 döner, okuyucular canlı yolu kullanır).
- `GA_WEBSITE_PAGE=true`: Website sayfası ve Explore'daki "Website" satırı. Veri için `GA_SYNC` de açık olmalı.
- `GA_SYNC_DEV_PROJECTS=<id,id>`: yerel geliştirme süreci canlı veritabanını paylaşırken yalnız bu projeler senkronlanır; saklama temizliği yerelde hiç çalışmaz. Yerel tek kullanımlık veritabanında (localhost ya da Unix soketi) her şey çalışır.
- Sıra: migration canlıya çıkar (Railway başlangıcında `migrate deploy`) → `GA_SYNC=true` → ilk veriler birkaç dakikada, geçmiş birkaç tick'te gelir → `GA_WEBSITE_PAGE=true`.

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

## Okuyucular

- `store.ts` ambarın tek okuma kapısıdır; `readers.ts` eski canlı okuyucuların karşılığıdır: mülk saatiyle dünkü güne kadar `days` gün eksiksizse ambardan, değilse canlı.
- Analytics modülü (`modules/analytics/google.ts`): aynı metrikler (aktif kullanıcı kayan pencereden, oranlar bileşenlerinden).
- ANALYTICS_ANALYSIS (`google-api-provider.ts`) ve günlük tarayıcı (`google-analytics-scanner.ts`): 28 ve 7 günlük pencere.

## Arayüz

- **Website sayfası** (`/projects/[projectId]/site`, Explore → "Website"): başlıkta mülk adı, "Data through Oct 5" ve mülk saat dilimi; dönemler 7/28/90 gün, bu ay, geçen ay; KPI kartları (Users, Sessions, New users, Engagement rate, Avg. engagement time, Key events, gelir varsa Revenue) önceki dönemle; günlük oturum grafiği (kesikli çizgi önceki dönem); Channels, Key events ve Landing pages tabloları ("Other / not shown" satırı ve kalite notları); son 7 günün değişebileceği notu; sağlık uyarısı; Refresh (5 dakikada bir).
- **Connectors → Google Analytics** (bağlıyken, `GA_SYNC` açıkken): "Data through …" (geçmiş yükleniyorsa "older history loading"), saat dilimi · para birimi · ölçüm kimliği · akış adresi, "Open website report" (`GA_WEBSITE_PAGE`). Bağlı değilken: "Agentelse keeps daily summaries of your Google Analytics data to build reports. Disconnecting deletes them."
- **Disconnect** bağı ve bütün ambar verisini hemen siler (`google-disconnect.ts`).
- **Gizlilik**: Google bölümünde günlük özetler, süreleri (400 / 95 gün), bireysel ziyaretçi olmadığı ve maskeleme yazıyor.

## Testler

`src/lib/website-analytics/*.test.ts` (katalog, yanıt ayrıştırma, dilimleme, kota, zamanlama, geri doldurma, dönemler, toplamlar, bayraklar), `google/pii.test.ts`, `sync/requests.test.ts` (toplu çağrı, bozuk rapor, kota bekletmesi, sunucu hatası, 429), `sync/warehouse.integration.test.ts` (gerçek Postgres, mock Google: uçtan uca senkron, yeniden yazımda kopya yok, Website raporu, Disconnect'te silme; CI'da koşar).
