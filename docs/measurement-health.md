# Ölçüm sağlığı denetimi (GA-F3)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §3.5, §3.7, §9 GA-F3. Ambar: [website-analytics.md](website-analytics.md). Bağlantı katmanı: [google-connections.md](google-connections.md). Arama tarafının eşi: [search-health.md](search-health.md). Bu dosya GA-F3'ün uygulanmış hâlini anlatır.

## Durum (6 Ekim 2026)

| Parça                                                                                                           | Durum                                    |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `GaHealthCheck`, `GaHealthRun`, `AdsAlert.source` + migration `20261006211000_add_ga_health_and_alert_source`   | Yapıldı                                  |
| MH1–MH24 + MH1_RT kontrolleri (saf), puan, şüpheli günler                                                       | Yapıldı                                  |
| `ga-health` tick adımı: tam değerlendirme, saatlik realtime yolu, haftalık PII yoklaması ve site taraması       | Yapıldı (`GA_HEALTH`, canlı denenmedi)   |
| SiteAlerts (GA4/GSC/SEO ortak uyarı katmanı), proje Telegram'ı, Meta tarafındaki `source: null` süzgeçleri      | Yapıldı                                  |
| Website sayfası paneli + çip, Integrations satırı, Brand kartı noktası, Today satırları, sıradaki adım, /health | Yapıldı (bayraklı, tarayıcıda görülmedi) |
| Gizlilik metni                                                                                                  | Yapıldı                                  |
| MH25 (Agentelse UTM kapsamı)                                                                                    | GA-F6'da etkin (docs/website-attribution.md) |

## Bayraklar ve açılış

- `GA_HEALTH=true`: denetimin tamamı. `GA_SYNC` de açık olmalı (`gaHealthEnabled()` ikisine bakar, çağrı anında okunur). Kapalıyken adım hemen 0 döner, her okuyucu sorgusuz null/[] verir.
- Yüzeyler ayrıca kendi bayraklarına bakar: panel, çip ve `/site` bağlantıları `GA_WEBSITE_PAGE` ister (kapalıysa bağlantılar Integrations'taki GA diyaloğuna gider); Brand kartı noktası `GA_BRAND_CARD` + `GA_WEBSITE_PAGE` ister; MH16 `GA_CATALOG_CHECKS`'in yazdığı katalog durumunu okur.
- `GA_SYNC_DEV_PROJECTS` (var olan): canlı veritabanını paylaşan geliştirme süreci yalnız bu projeleri değerlendirir, ev işini (housekeeping) hiç çalıştırmaz ve proje Telegram'ına yazmaz (`ALLOW_DEV_NOTIFICATIONS=true` hariç).
- Bayrak kapalıyken değişen tek sorgu: Meta'nın `AdsAlerts.listOpen`, `resolveMissing`, agency-overview `groupBy`, autopilot `TRACKING_STALE` sayımı ve Ads saklama temizliği artık `source: null` süzer. Bu yüzden migration koddan ÖNCE canlıya çıkmalı.

Açılış sırası (kesin):

1. `migrate deploy` (sahip, terminalde).
2. Kodu deploy et (Meta `source: null` süzgeçleri sütunu ister).
3. `GA_HEALTH=true`, önce izinli projelerde (`GA_SYNC_DEV_PROJECTS` / izin listesi).
4. /health'teki "Google Analytics measurement checks" kartını 48 saat izle.
5. Herkese aç.

- Geri alma: bayrağı kapat. Tablolar ve açık GA4 uyarıları kalır ama okunmaz; Meta ekranları onları zaten görmez. Bayrak yeniden açılınca kaldığı yerden sürer, `resolveMissing` ve ev işi temizler.
- agentelse.com/bot sayfası (AgentelseSiteCheck ve AgentelseSiteAudit kimliklerini anlatır) canlıya çıkmadan önce yayında olmalı; marketing servisi elle deploy edilir.

## Kontroller

Kaynak: `lib/website-analytics/health/registry.ts` (başlık, kategori, ağırlık, varsayılan önem), neden kodları `GA_CHECK_REASONS` (sözleşme; B yalnız bunları üretir). C = `completeThrough`. "Önem" FAIL/WARN sonucunun önemidir; PASS ve UNKNOWN varsayılan önemle saklanır.

| Kod    | Başlık                                       | Kaynak      | Kategori / ağırlık  | Eşik (özet)                                                                                                                                        | Önem                               | Neden kodları                                                                                                                       |
| ------ | -------------------------------------------- | ----------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MH1    | Data is arriving                             | DATA        | data_flow / 3       | [C-6, C] günleri (≥ bugün-7), aynı hafta günü 8 haftalık medyan (≥4 değer, ≥20): oran < 0,10 FAIL, < 0,50 WARN; medyan < 20 → hafta kipi           | FAIL CRITICAL, WARN WARN           | ok, stopped, dropped, low_volume, no_data, not_ready, sync_late, error                                                              |
| MH1_RT | Live visitors today                          | DATA        | data_flow / 1       | Aynı mülk gününde 3 ardışık sıfır realtime okuması                                                                                                 | CRITICAL                           | ok, no_live_visitors, not_checked, error                                                                                            |
| MH2    | Yesterday's data is in                       | INTEGRATION | data_flow / 0,5     | Mülk saati ≥ 21 ve en yeni gerçek gün < dün                                                                                                        | INFO                               | ok, late, not_checked, error                                                                                                        |
| MH3    | Tag on your website                          | SITE        | site_tag / 2        | Beklenen G- kimliği herhangi bir sayfada → PASS; yalnız başka G- → other_id; hiç yok + MH1 PASS değil → missing; asla FAIL                         | WARN                               | ok, not_checked, no_site, robots, fetch_failed, no_measurement_id, other_id, gtm_only, google_tag_only, client_side, missing, error |
| MH4    | No double counting                           | SITE        | site_tag / 1        | Sitede gtag iki kez yüklü; ya da son 7 gün görüntüleme/oturum ≥ 2× taban ve etkileşim > %95 (≥50 oturum)                                           | WARN                               | ok, double_load, double_count_data, low_volume, not_ready, error                                                                    |
| MH5    | Key events are set up                        | ADMIN       | configuration / 3   | Key event yok ya da yalnız gelirsiz `purchase`                                                                                                     | WARN                               | ok, not_read, no_key_events, only_purchase, error                                                                                   |
| MH6    | Key events are arriving                      | DATA        | data_flow / 2       | Son 7 gün 0 key event, önceki günlük ≥ 1 ve oturumlar normal → FAIL; günlük ≥ 3× ve oturum başına > 1 → double_fire                                | FAIL CRITICAL, WARN WARN           | ok, no_key_events, low_history, stopped, double_fire, not_ready, error                                                              |
| MH7    | Visits have a channel                        | DATA        | attribution / 2     | Unassigned payı > %5 (≥21 gün kapsam, ≥200 oturum)                                                                                                 | WARN                               | ok, low_volume, high_unassigned, error                                                                                              |
| MH8    | UTM tags are consistent                      | DATA        | attribution / 0,5   | Yalnız büyük/küçük harfle ayrılan kaynak/ortam ya da standart dışı ortam                                                                           | INFO                               | ok, low_volume, utm_variants, error                                                                                                 |
| MH9    | No self-referrals                            | DATA        | attribution / 1     | Kendi alan adından referral payı > %2                                                                                                              | WARN                               | ok, no_domain, low_volume, self_referral, error                                                                                     |
| MH10   | No payment-page referrals                    | DATA        | attribution / 1     | Ödeme ağ geçidi referral payı > %0,5                                                                                                               | WARN                               | ok, low_volume, gateway_referrals, error                                                                                            |
| MH11   | Visits have a landing page                   | DATA        | attribution / 1     | `(not set)` açılış sayfası payı > %5 (payda açılış tablosunun kendi toplamı)                                                                       | WARN                               | ok, low_volume, not_set_landing, error                                                                                              |
| MH12   | No personal data in page addresses           | DATA        | privacy / 3         | Yoklamada e-posta/telefon/izinli parametre adı → pii_in_url; son 7 günün ambar maskeleri → pii_in_path; temiz yeni yoklama → recent_history (INFO) | FAIL CRITICAL, recent_history INFO | ok, pii_in_url, pii_in_path, recent_history, not_checked, error                                                                     |
| MH13   | Time zone matches                            | ADMIN       | configuration / 1   | Mülk ve proje (INSTAGRAM_PUBLISH takvimi) saat dilimi ofsetleri farklı; para birimi yok                                                            | INFO                               | ok, no_project_tz, not_read, invalid_tz, timezone_mismatch, error                                                                   |
| MH14   | Data retention                               | ADMIN       | configuration / 1   | Saklama TWO_MONTHS                                                                                                                                 | INFO                               | ok, not_read, two_months, error                                                                                                     |
| MH15   | Google Ads is linked                         | ADMIN       | configuration / 1   | 28 günde `google / cpc` ≥ 10 oturum ve Google Ads bağı 0 (gclid görünmediği için vekil)                                                            | INFO                               | ok, not_read, ads_not_linked, no_paid_search, error                                                                                 |
| MH16   | Search Console is linked in Google Analytics | DATA        | configuration / 0,5 | GA-F2b katalog durumunda search_console kapalı                                                                                                     | INFO                               | ok, not_linked, catalog_off, error                                                                                                  |
| MH17   | Enhanced measurement                         | DATA        | configuration / 1   | Ambarın `events` dilimlerinde hiçbir gelişmiş ölçüm olayı yok (≥200 oturum)                                                                        | INFO                               | ok, enhanced_off, low_volume, error                                                                                                 |
| MH18   | Little data hidden by Google                 | DATA        | other / 1           | Eşiklenen rapor anahtarı payı > %20                                                                                                                | INFO                               | ok, no_data, thresholding, error                                                                                                    |
| MH19   | Few rows grouped as (other)                  | DATA        | attribution / 0,5   | Herhangi bir rapor anahtarında (other) satırı                                                                                                      | INFO                               | ok, no_data, other_row, error                                                                                                       |
| MH20   | No bot or spam waves                         | DATA        | other / 1           | Ülke/kaynak günü ≥ max(3× 28 günlük medyan, 30) oturum ve etkileşim < %5                                                                           | WARN                               | ok, low_history, bot_wave, error                                                                                                    |
| MH21   | Property matches your website                | ADMIN       | configuration / 2   | Akış host'u ile Project.domain eşit değil ve alt alan adı değil                                                                                    | WARN                               | ok, no_domain, no_stream, domain_mismatch, error                                                                                    |
| MH22   | Engagement time is recorded                  | DATA        | data_flow / 1       | Son 7 gün oturum başına etkileşim < 1 sn (≥50 oturum)                                                                                              | WARN                               | ok, low_volume, no_engagement_time, not_ready, error                                                                                |
| MH23   | Cookie consent signal                        | SITE        | privacy / 1         | AB/AEA payı > %20 ve sitede consent default ya da CMP yok                                                                                          | INFO                               | ok, few_eu, low_volume, not_checked, gtm_only, no_consent_default, error                                                            |
| MH24   | Connection is healthy                        | INTEGRATION | data_flow / 3       | Kimlik ACTIVE değil ya da bağ AUTH/NEEDS_PERMISSION/ACCESS_LOST/GONE/API_DISABLED → FAIL; DEGRADED ya da veri 2 günden eski (saat ≥ 12) → WARN     | FAIL CRITICAL, WARN WARN           | ok, credential, auth, needs_permission, access_lost, gone, api_disabled, sync_failing, sync_late, no_data, error                    |

- MH8–MH11, MH7 gibi diliminin ≥ 21 günlük kapsamını ister. MH18/MH19 rapor anahtarı başına `GaReportSlice.quality` bayraklarını okur (ayrı `otherRow` Json sütununu değil).
- MH25: Agentelse links carry tracking. GA-F6'dan gelen UZANTI kontrolüdür (INFO): `GA_UTM` + `GA_SYNC` açıkken okuma anında hesaplanır, saklanmaz, puanlanmaz, uyarı üretmez; `GA_CHECK_KEYS`'te değildir (bayrak kapalıyken saklanan satırlar, puan ve kontrol listesi aynı kalsın). Nedenler: `ok`, `no_ads`, `no_data`, `low_coverage` (kapsam < %90), `not_seen` (≥ 20 tıklamadan 48 sa sonra etiketli ziyaret yok). Panelin altında "Code MH25" kartı; ayrıntı [website-attribution.md](website-attribution.md).
- Admin API v1alpha çağrısı yok (plan §10); MH17 ambardaki olaylardan, MH13 yalnız saat diliminden, MH15 `google/cpc` vekilinden.

## Çalışma

- **completeThrough**: `lastDailyDate ? lastDailyDate - 1 : null`, yani günlük çekimin tamamladığı son mülk günü. MH1, MH4, MH6, MH12, MH20 ve MH22'nin "son N gün" pencereleri buraya kadar uzanır, yarım bir düne asla. Neden: GA-F2'de `pendingEnd` günü yazılmaz (Google satır döndürmezse write.ts son günü atlar) ve `lastDailyDate` 21:00 penceresinde dün hiç gelmese de ilerler. D, `[ilk gün, completeThrough]` içindeki eksik günleri `synthetic: true` sıfır günler olarak üretir; böylece etiket kaldırıldığında dün, kesinti bilindiği akşam 0 oturumlu gün olur ve MH1 o gün CRITICAL'a döner. 16:00'dan önceki ilk bağlantı ya da Refresh `lastDailyDate`'i önceki günde bırakır, yarım dün yargılanmaz. `completeThrough` null → MH1/MH4/MH6/MH22 UNKNOWN `not_ready`.
- **`ga-health` adımı** (`ga-sync`'ten sonra): tick başına en çok 5 birincil bağ, veritabanında `GaHealthRun.evaluatedAt` sırasıyla (null önce), PAUSED/CLOSED projeler atlanır. Bir bağ parmak izi (mülk günü, `lastDailyDate`, metadata günü) değişince, 6 saatte bir ve "I fixed it" ile due olur. Her tur `GaHealthRun` üzerinde 3 dakikalık CAS kilidi tutar. Nabız `ga.health`.
- **"Check again" / "I fixed it"**: server action; `GaHealth.recheckNow` kilidi alıp `recheckRequestedAt`'i aynı `updateMany`'de yazar, değerlendirmeyi satır içinde `force` ile koşar (site taraması, bugünün PII yoklaması P1 şeridinde, pencere uygunsa realtime). 10 dakikada bir. Başarısız satır içi tur `recheckRequestedAt > evaluatedAt` bırakır, `runDue` onu alır.
- **Saatlik yalnız-realtime yolu (MH1_RT)**: aynı hafta günü medyanı ≥ 240 oturum, mülk saati 09:00–21:00 ve son okuma ≥ 50 dk önce. Yalnız `GaHealthRun.realtime`, MH1_RT satırı, puan ve `GA_MH1_RT` uyarısı değişir. `force` yalnız 50 dakikalık aralığı atlar, tabanı ve pencereyi asla.
- **PII yoklaması**: haftalık tek runReport (sabit filtre JSON'u, `pagePathPlusQueryString`); yalnız sayılar ve izinli parametre adları saklanır. Zamanlanmış aralık `[max(bugün-7, önceki temiz yoklamanın başı), dün]`; zorlanmış yoklama `[bugün, bugün]`. Google RE2 filtresini reddederse sonuç `error` olur ve MH12 ambar maskelerine düşer.
- **Site taraması**: yalnız `normalizeDomain(Project.domain)` (geçerliyse; GA akış host'u asla, çünkü yanlış mülk tam olarak MH21'in yakaladığı şey). robots.txt `AgentelseSiteCheck` (yoksa `*`) için okunur; robots eşleştirmesi SC-F3'ün RegExp'siz `robotsPatternMatches`'iyle (ReDoS yok); ana sayfa + en çok 5 düz açılış sayfası (açılış yolları yalnız GA akışının `streamUri` host'u Project.domain ile aynı siteyse, www ikizi dahil; değilse yalnız ana sayfa); istekler arası 1 sn, istek başına 8 sn, 45 sn bütçe, 1,5 MB kesilmiş HTML, `maxRedirects 2` ama yalnız aynı siteye (safe-fetch `allowRedirect`; başka host'a yönlendirmeye hiç istek atılmaz), sayfa başına en çok 256 KB betik metni taranır, etiket regex'lerinde sorgu parametreleri sınırlı. UA `AgentelseSiteCheck/1.0 (+https://agentelse.com/bot)` (safe-fetch `userAgent` seçeneği). El yazımı tokenizer + regex: `gtag/js?id=G-…`, GT-/AW-, `gtag('config','G-…')`, GTM, consent default, CMP izleri, key event ipuçları. Haftada bir ya da "I fixed it" ile; tick başına en çok 1 tarama. UNKNOWN durumları: GTM ya da GT- birleşik etiket (`gtm_only`, `google_tag_only`), istemci tarafı ekleme (`client_side`), robots engeli, getirme hatası, alan adı yok. WAF'lar UA'yı engellerse de UNKNOWN.
- **Mock kip** (`AGENTELSE_PROVIDER_MODE=mock`): site taraması `mockSiteTagResult` (ağ yok), PII yoklaması mock GA istemcisinden (`runGaRequests → mockGaReport`), realtime GA-F2b mock'undan, erişim token'ı `mock-access-token`.

## Puan

- Kategori ağırlıkları: Data flow 30, Configuration 20, Attribution hygiene 20, Privacy 15, Site tag 10, Other 5; kategori içinde kontrol ağırlıkları (registry).
- Kredi: PASS 1; WARN INFO 0,75, WARN WARN 0,4, WARN CRITICAL 0,2; FAIL 0; UNKNOWN sayılmaz (ağırlıklar yeniden normalleştirilir).
- Açık bir FAIL+CRITICAL puanı 40'ta keser. Bilinen kontrol 8'den azsa puan null ("Checking…"), CRITICAL varsa yine 40 tavanlı puan verilir.
- Ton: null → unknown; CRITICAL ya da < 50 → error; < 80 ya da WARN → warning; yoksa ok. `GaPropertyLink.healthScore`'a yazılır.

## Uyarılar

- Ortak `AdsAlert` tablosu, yeni `source` sütunu (null = Meta Ads; "GA4" | "GSC" | "SEO"). Katman: `src/server/monitoring/site-alerts.ts` (SiteAlerts). Yeniden açılma, önem artışı ve `notifiedAt` CAS anlamı AdsAlerts'ten kopyadır.
- dedupeKey `ga4:<linkId>:<checkKey>`, kind `GA_<checkKey>`, başlık `gaIssueTitle(...)` (rakamsız), detail null, data `{checkKey, linkId}`. Yalnız WARN/FAIL ve önemi WARN/CRITICAL olan sonuçlar uyarı açar; INFO yalnız sayfada.
- Her tam değerlendirmeden sonra `SiteAlerts.resolveMissing({source: "GA4", kinds: GA_ALERT_KINDS})` proje çapında koşar: mülk değişince eski bağın uyarıları yeni bağın ilk turunda kapanır.
- UNKNOWN bir uyarıyı en çok 48 saat açık tutar (`unknownKeepsAlertOpen`: önceki satır WARN/FAIL ya da UNKNOWN'un `lastChangedAt`'ten bu yana < 48 sa). MH1_RT hiç açık tutmaz (gün içidir).
- Ev işi (günde bir, global ve yalnız canlı): birincil bağı kalmamış projelerin açık GA4 uyarıları kapanır, 180 günden eski RESOLVED GA4 uyarıları silinir. Meta saklaması artık yalnız `source: null` satırları siler.
- Telegram:
  - yalnız projenin kendi sohbetine (`notifyProjectTelegram`), operatöre ASLA;
  - geliştirme koruması: `ALLOW_DEV_NOTIFICATIONS !== "true"` ve `metaWorkExcludedHere` ise hiç gönderilmez;
  - düz, sabit metin: `Website tracking alert for <proje>: <ifade>. Open Agentelse: <bağlantı>`; rakam, yol, sorgu, kampanya adı yok (test edilir);
  - açılış, yeniden açılış ve CRITICAL'a yükselişte; açık kaldıkça en çok 24 saatte bir yeniden; `GA_MH24` hiç yeniden gönderilmez (Integrations zaten "Needs reconnect" gösterir);
  - `notifyChannels` yalnız ACTIVE ve `chatId`'li proje Telegram kimliği varsa `["in_app","telegram"]`, yoksa `["in_app"]`.
- GA-F5 (`GA_REPORTS=true`): projenin Settings → Autonomy → "Website reports" kartı kritik GA uyarılarını Telegram'dan uzak tutabilir ("Send a short Telegram message…" anahtarı; `SiteAlerts.notifyIfDue` yalnız `source: "GA4"` için tercihi okur) ve bunları, WARN → CRITICAL yükselişleri dahil, Website analytics sohbetine kart olarak yazar ([website-reports.md](website-reports.md)).
- Meta tarafındaki düzenlemeler (`src/server/ads/guard/alerts.ts` vb.): `AlertInput.source`; `listOpen` varsayılan `source: null`; `resolveMissing` yalnız `source: null`; `notifyIfDue` `source` dolu satırda hemen döner; `telegramTextFor` site kaynakları için `siteAlertTelegramText`'e düşer (savunma amaçlı, proje adı HTML'e kaçışlanır); agency-overview `groupBy`, autopilot `TRACKING_STALE` sayımı ve saklama `source: null`.
- SC-F3 aynı SiteAlerts sözleşmesini kullanır (GSC/SEO; bkz. [search-health.md](search-health.md)). Today özetine giren kaynaklar `siteAlertSourcesForBrief()`'te (bugün yalnız GA4; arama sorunları kendi `searchIssues` alanıyla gelir).
- Disconnect: `deleteGaHealthAlertsForCredential` kimliğin kendi `projectId`'sini okur (yalnız Google Analytics kimliğinde), bağ kalmasa da çalışır; `GaHealthCheck`/`GaHealthRun` bağla cascade gider.

## Şüpheli günler

- `GaHealthRun.suspectDays` = `{gün: kontrolAnahtarları[]}`; MH1, MH4, MH6 ve MH20'nin FAIL/WARN günleri.
- Her turda yalnız `[bugün-7, bugün-1]` penceresi yeniden kurulur; daha eskiler donar. 400 gün saklanır.
- MH1'in aynı hafta günü medyanı şüpheli günleri dışarıda bırakır.
- GA-F4 (anomali ve atıf) `readGaSuspectDays` ile okur (bayrağa bağlı değil).

## Arayüz

- **Website sayfası** (`/projects/[projectId]/site`, `GA_WEBSITE_PAGE`): başlıkta "Tracking 72/100" çipi (`#measurement-health`'e gider) ve rapor gövdesinin altında "Measurement health" paneli (`id="measurement-health"`): dikkat isteyenler, kontrol edilemeyenler, geçenler; her satırda İngilizce düzeltme rehberi; "Check again", "I fixed it", "Mute 7 days".
- `GA_FIXES` açıkken MH5, MH14 ve MH17 rehberin altında "Fix it for me (needs approval)" gösterir; MH9 ve MH10 yalnız rehber kalır çünkü Google'da bunlar için API yok ([website-fixes.md](website-fixes.md)).
- **Integrations** GA diyaloğu: mülk kartının altında "Measurement health 72/100 · …" satırı ve "View checks".
- **Brand sekmesi Website kartı**: altbilgide "Tracking 72/100" noktası.
- **Today özeti**: açık CRITICAL GA4 uyarıları, en çok 2, yeni "Website" grubunda öğelerden sonra; sıradaki adım aynı uyarının `fix_tracking` adımıysa satır gösterilmez.
- **Sıradaki adım**: alan adı olup GA bağlamamış projeye sessiz "Connect Google Analytics"; açık CRITICAL GA4 uyarısı için engel "Fix tracking" (gecikmiş paylaşımdan sonra), MH5 `no_key_events`/`only_purchase` için sonuçlardan sonra "next" adımı.
- **/health** (yalnız operatör): "Google Analytics measurement checks" kartı; denetlenen/due bağlar, başarısız/uyarı/bilinmeyen kontroller, önem başına açık GA4 uyarıları, puan kovaları (≥80, 50–79, <50, yok), son `ga.health` nabzından bu yana dakika. `healthy`'ye sayılmaz.

## Gizlilik ve Limited Use

- Kanıt (`evidence`) adres ya da değer taşımaz; Google'dan gelen etiketler `maskGoogleText`'ten geçer, 80 karakter, kontrol başına en çok 5. PII yoklaması yalnız sayıları ve izinli parametre adlarını saklar. Uyarı başlıkları sabittir.
- Operatörler yalnız sayaçları görür; Google verisi operatör sohbetine ya da Telegram'ına gitmez.
- Disconnect her şeyi hemen siler (bağ cascade + GA4 uyarıları).
- Gizlilik sayfasında Google bölümüne ölçüm kontrolleri paragrafı eklendi (haftalık PII yoklaması, AgentelseSiteCheck ziyareti, robots.txt, yalnız projenin kendi Telegram'ı).

## Testler

- Saf: `lib/website-analytics/health/*.test.ts` (flags, stored, registry, score, suspect, schedule, baseline, known-values, data/admin/site-checks, evaluate, html-parts, tag-scan, robots, site-targets, pii-probe, realtime-state, guides, copy), `lib/monitoring/site-alert-{href,text,brief}.test.ts`.
- Sunucu: `server/monitoring/site-alerts.test.ts`, `server/website-analytics/health/{inputs,read,site-tag,probes}.test.ts`, `server/actions/measurement-health-actions.test.ts`.
- UA kapısı: `server/website-analytics/health/site-tag-ua.test.ts` (sayfa ve robots istekleri `GA_SITE_CHECK_UA` ile gider) ve safe-fetch'in `userAgent` testi.
- Bileşen: `components/website-analytics/{measurement-health-panel,measurement-score,ga-measurement-counters-card}.test.ts`, Website kartı ölçüm noktası.
- Paylaşılan: Ads uyarıları (site uyarıları operatöre gitmez, `listOpen` yalnız Meta), Disconnect sırası, daily brief, next steps, gizlilik metni.
- Entegrasyon (tek kullanımlık Postgres): `server/monitoring/site-alerts.integration.test.ts`, `server/website-analytics/health/runner.integration.test.ts` (kesinti tatbikatı: etiket kaldırılınca ertesi gün CRITICAL ve proje Telegram'ı tam bir kez; MH12 tatbikatı: ham değer hiçbir yerde saklanmaz; Disconnect silme).

## Açık konular

- GA-F7 "Fix it for me" (Admin API yazma).
- Rehberlerdeki Google yardım bağlantıları canlıda doğrulanmadı.
- /bot sayfası SEO tarayıcısıyla ortak; canlıya çıkmadan önce yayında olmalı.
- Eşikler (MH7 %5, MH9 %2, MH10 %0,5, MH20 3×/%5) 48 saatlik izinli çalışmadan sonra ayarlanmalı.
- SC-F3 kendi robots ayrıştırıcısını yazdı (`lib/seo/robots-parser.ts`); GA'nın `lib/website-analytics/health/robots.ts`'i artık onun eşleştiricisini kullanır, ayrıştırıcılar ileride tekleştirilebilir.
- Satır içi yeniden kontrol (~45 sn'ye kadar) Railway'de yavaş kalırsa zorlanmış tarama sonraki tick'e taşınmalı.
