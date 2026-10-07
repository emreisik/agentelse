# SEO fırsat motoru (SC-F4)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.6, §4, §5, §6.2, §9 SC-F4, SK8, SK13.
İlgili: ambar [search-analytics.md](search-analytics.md); sağlık ve tarayıcı [search-health.md](search-health.md); bağlantı [google-connections.md](google-connections.md). Google Analytics tarafının eşi: [website-insights.md](website-insights.md).

## Durum (6 Ekim 2026)

Kodlananlar:

- tablolar + migration `20261006214000_add_seo_finding_and_clusters` (+ `GscQuery` `[linkId, clusterId]` indeksi);
- CTR eğrisi;
- marka, niyet ve dil sınıflayıcıları;
- embedding ve konu kümeleri;
- SO1–SO16 kuralları;
- bulgu yaşam döngüsü;
- `seo-opportunities` adımı;
- açıklamalar, sinyaller, fikir akışı;
- marka terimi önerileri;
- beş sohbet aracı;
- Search sayfasında "Opportunities";
- SEO Manager'da CTR eğrili quick wins;
- gölge inceleme + `/health/search-opportunities`;
- eski GSC taramasının motorun projelerinde sorgudan çıkarılması (on).

Hepsi bayraklı, canlıda denenmedi.

Bilerek dışarıda kalanlar: "From your search data" etiketi (sahip onayı bekliyor; fikir kaynağı "Search" kalır), SO12'de Review/Event/LocalBusiness alt türleri, SO9'da pozisyon eğilimi.

## Bayraklar ve açılış

`SEO_INSIGHTS=off|shadow|on` (çağrı anında okunur). `GSC_SYNC` şarttır; liste için `GSC_SEARCH_PAGE` gerekir.

Açılış sırası:

1. ÖNCE gizlilik ve veri silme metinleri canlıya çıkar.
2. Sonra `GSC_ROLLOUT_PROJECTS` yalnız sahibin projesiyle (agentelse.com) shadow açılır. Gölge kip de maskelenmiş sorguları OpenAI'ye gönderir.
3. Sahip 2 hafta içinde 30 bulguyu "Useful / Not useful" ile işaretler.
4. `/health/search-opportunities` isabeti ≥ %70 gösterince on.

Kip değişince (shadow → on) bir sonraki koşuda haftalık aşama yeniden çalışır ve bu haftanın bulguları görünür olur. İzin listeleri GSC'ninkilerdir; `inspect_url` ayrıca SEO listesine bakar. Mock kipte Google'a, siteye ya da OpenAI embedding'e gidilmez.

Migration: sahip `prisma migrate deploy`'u yeni bir terminal sekmesinde tek satırla çalıştırır (GA-F4'ün `20261006213000_add_ga_finding`'i ile birlikte).

Geri alma: `SEO_INSIGHTS=off`; motor hemen 0 döner, tablolar kalır, saklama sürer.

## Tablolar

- `SeoEngineState`: kilit, zamanlama, eğriler, sayaçlar, öneriler, `intentBrandHash`.
- `SeoFinding`: `GaFinding` alanları + `periodKey`, `pageId`/`queryId`/`clusterId`, gölge ve inceleme alanları.
- `SeoCluster`: üyelik `GscQuery.clusterId`'dedir.
- `SeoQueryEmbedding`: 256 boyut, Float32.

Hepsi `GscSiteLink`'e cascade'lidir.

## Zamanlama

- `seo-opportunities` adımı (`agency-wiring.ts`): bağ başına 10 dk kilit, 60 sn süre, tick'te ≤ 2 bağ; ardından motor saklaması (`SeoOpportunityRetention`). Odak ayarı kapatmaz.
- Haftalık aşama `GscSiteLink.lastWeeklyWeek` değişince çalışır. Pencere bu haftaya bağlıdır (son 4 tam hafta, Pazartesi–Pazar).
- Mevcut 4 haftanın query, page ve query_page özetlerinin üçü de yoksa (W1 ağır sorguyu kuyruğa attıysa) koşu `no_data` döner ve 6 saat sonra yeniden dener. Önceki 4 hafta eksikse karşılaştırma kuralları `LOW_HISTORY` ile susar.
- Sıra: sınıflama → embedding → CTR eğrisi → kümeler → kurallar → bulgular → (on) açıklama + sinyal + marka önerisi.
- Çıktılar yalnız süre bitmeden ≥ 20 sn kala çalışır ve sonraki koşularda tamamlanır.
- 6 saatte bir yoklar; hata geri çekilmesi 30 dk'dan 24 saate kadar.
- Günlük toplam anomalisi SC-F3 SH2'dedir.

## CTR eğrisi

- Son 13 tam haftanın (sorgu×sayfa özeti olan haftalar) marka dışı satırlarından çıkarılır.
- 15 yarı açık pozisyon kovası kullanılır.
- 500 sözde gösterimle kamuya açık eğriye doğru daraltılır, ağırlıklı isotonik (PAV) ile monoton azalan yapılır.
- 2.000 gösterimin altında kamuya açık eğri kullanılır.
- Marka eğrisi ayrıdır. Cihaz başına eğri ertelendi. Önsel değerler doğrulanmalı.

## Sınıflayıcılar

- Marka: W1 terimleri + bulanık eşleşme. Yalnız bellekte tutulur, `GscQuery.isBrand`'e yazılmaz. Niyet ve eğri de bunu kullanır.
- Niyet: önce kurallar. Kalan ve 13 haftada ≥ 50 gösterimli sorgular lite LLM'e gider: çağrı başına ≤ 20 sorgu, ≤ 5 çağrı, kodlar sabit İngilizce enum. Gönderilemeyenler NULL kalır ve sonraki koşuda denenir; < 50 gösterimliler "informational" olur. Marka terimleri değişince navigational ve marka satırları yeniden sınıflanır.
- Dil: yazı sistemi + durak kelimeler.
- Yerel: "near me/yakınımda" + yerleşik yer adları.

## Konu kümeleri

- Aynı sayfada birlikte sıralanma (≥ %30 pay) + embedding benzerliği (kosinüs ≥ 0,82); en az 3 sorgu.
- Jaccard ≥ 0,5 eşleşmeyle küme kimliği ve adı korunur.
- Adları lite LLM verir (6 küme × 3 sorgu), olmazsa en çok gösterim alan sorgu.

## Kurallar (SO1–SO16)

Kaynak: `src/lib/seo/rules/*` (saf; `index.ts` `evaluateSeoRules`). Q = sorgunun gösterimi; pay = çift gösterimi / Q; "marka dışı" = bulanık marka eşleşmesi değil. Etki: `clicksImpact` (aylık ek tıklama) ya da `reachImpact` (erişim).

| Kural | Etiket ("…")           | Eşik ve gerekli veri (özet)                                                                                                                                                              | Tür / önem                      | Eylem / emek                                                                  | Güven                                      | En çok         |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | -------------- |
| SO1   | Close to the top       | Marka dışı çift, pozisyon 4–20, gösterim ≥ max(100, p75), pay ≥ 0,8; sayfa başına kazanç ≥ 5                                                                                             | OPPORTUNITY / INFO              | iç bağlantı ≤ 2 ise INTERNAL_LINKS/S, değilse CONTENT_REFRESH/M               | SIGNIFICANT: gösterim ≥ 500 ve site eğrisi | 10             |
| SO2   | Low click rate         | Pozisyon 1–10 marka dışı çiftler, sayfada Σgösterim ≥ 500, tıklama < 0,7·beklenen                                                                                                        | OPPORTUNITY / INFO              | TITLE_META/S                                                                  | SIGNIFICANT: ≥ 1.000 ve site eğrisi        | 10             |
| SO3   | Losing clicks          | Aylık sayfa özetleri ≥ 6 ay; son 3 ay önceki 3'e göre ≥ %30 ve ≥ max(30, %10) düşüş; ≥ 15 ayda geçen yıla göre de ≥ %30; neden: INDEX / CANNIBALIZATION / RANKING / DEMAND / CTR / MIXED | RISK / WARN                     | nedene göre (TECH_FIX, CONSOLIDATE, CONTENT_REFRESH, INVESTIGATE, TITLE_META) | SIGNIFICANT: YoY var ve düşüş ≥ 100        | 10 (dönem: ay) |
| SO4   | Competing pages        | Marka dışı Q ≥ 50; ≥ 2 sayfa pay ≥ 0,10; baskın sayfa ≥ 2 kez değişti ya da tıklama < 0,7·beklenen                                                                                       | RISK / INFO                     | CONSOLIDATE/M                                                                 | SIGNIFICANT: Q ≥ 500 ve ≥ 3 değişim        | 10             |
| SO5   | Content gap            | Marka dışı, navigational değil, yerel değil, Q ≥ 100; A: sayfa yok ya da pozisyon > 20; B (tarayıcıyla): başlık/H1/H2 kapsamı < 0,5; aynı kümede ≥ 2 → küme bulgusu                      | OPPORTUNITY / INFO              | A: NEW_CONTENT/L, B: CONTENT_REFRESH/M                                        | DIRECTIONAL                                | 10             |
| SO6   | Rising search          | Marka dışı Q ≥ 50; yeni (12 hafta geçmiş) ya da Q ≥ 3·önceki; önce küme sürümü (Qc ≥ 100, ≥ 3×)                                                                                          | OPPORTUNITY / INFO              | pozisyon ≤ 10 CONTENT_REFRESH/M, değilse NEW_CONTENT/L                        | SIGNIFICANT: Q ≥ 200                       | 10             |
| SO7   | Lost clicks            | Önceki 4 hafta tam; önceki tıklama ≥ 10, şimdi 0 (sayfalar önce, sonra sorgular)                                                                                                         | RISK / WARN                     | indeks sorunu TECH_FIX/S, değilse INVESTIGATE/S                               | SIGNIFICANT: önceki ≥ 30                   | 10             |
| SO8   | Internal links         | Tarayıcı tam; hedef gösterim ≥ 100, iç bağlantı ≤ 2; aynı kümeden ya da bölümden ≤ 3 kaynak, çapa = en iyi sorgu                                                                         | OPPORTUNITY / INFO              | INTERNAL_LINKS/S                                                              | DIRECTIONAL                                | 10             |
| SO9   | Section trend          | Önceki tam; ≥ 5 sayfalı bölüm, tıklama değişimi ≥ %20 ve ≥ 30, geçen yılla tutarlı                                                                                                       | düşüş RISK/WARN, artış WIN/INFO | INVESTIGATE/VARIES                                                            | geçen yıl varsa SIGNIFICANT                | 5              |
| SO10  | Brand demand           | Hazır marka ayrımı ve 8 haftalık marka serisi; son 4 ile ilk 4 hafta ortalaması farkı ≥ %20, P ≥ 100                                                                                     | CHANGE / INFO                   | INVESTIGATE/VARIES                                                            | SIGNIFICANT                                | 1              |
| SO11  | Local search           | Marka dışı yerel sorgu Q ≥ 50; yer adını taşıyan sayfa yok ya da pozisyon > 10                                                                                                           | OPPORTUNITY / INFO              | NEW_CONTENT/L                                                                 | DIRECTIONAL                                | 5              |
| SO12  | Rich results           | Tarayıcı; ana sayfada Organization türü yok, blog/ürün bölümünde Article/Product yok, BreadcrumbList eksik (FAQPage/HowTo asla)                                                          | OPPORTUNITY / INFO              | SCHEMA/S                                                                      | DIRECTIONAL                                | 5              |
| SO13  | International          | Ülke gösterimi ≥ 500 ve dili sitede yok (proje dili, lang, hreflang)                                                                                                                     | OPPORTUNITY / INFO              | LOCALIZE/L                                                                    | DIRECTIONAL                                | 5              |
| SO14  | Image and video search | Tarayıcı; görsel arama ≥ 200 ve alt metinsiz görseller; video ≥ 200 ve VideoObject yok                                                                                                   | OPPORTUNITY / INFO              | TECH_FIX/S, SCHEMA/S                                                          | DIRECTIONAL                                | 2              |
| SO15  | New pages              | 20 hafta geçmiş (ya da backfill bitti); son 28–90 günün ≥ 3 yeni sayfası, medyanın yarısının altındakiler                                                                                | RISK / INFO                     | INVESTIGATE/S                                                                 | DIRECTIONAL                                | 5              |
| SO16  | Technical issues       | Tarayıcı; WARN/CRITICAL denetim sorunlu sayfaların Σgösterimi ≥ 100 (sorun kodu başına)                                                                                                  | RISK / sorunun önemi            | TECH_FIX/VARIES                                                               | SIGNIFICANT                                | 5              |

- Tarayıcı kapalıyken SO8, SO12, SO14 ve SO16 değerlendirilmez; SO5 yalnız "pozisyon > 20" dalıyla çalışır.
- SO6 "yeni sorgu" dalı 12 hafta, SO15 20 hafta (ya da backfill bitmiş), SO10 hazır marka ayrımı ister.
- Az veri modu: 28 günde 1.000 gösterimin altında sorgu kuralları susar.
- Kurallar sınırdan önceki konuları da bildirir (seen); sınır yüzünden listeye girmeyen bir fırsat çözüldü sayılmaz.
- Bir koşuda en çok 25 bulgu (önceliğe göre); bir kuralın hatası diğerlerini durdurmaz.

## Önceliklendirme

etki (aylık ek tıklama ya da erişim) × güven (SIGNIFICANT 1, DIRECTIONAL 0,5) ÷ emek (S 1, M 2, L 4, VARIES 2). GA köprüsü ertelendi.

## Bulgu yaşam döngüsü

- Parmak izi = kural + konu + dönem (hafta; SO3'te ay).
- OPEN → ACCEPTED | DISMISSED; OPEN/ACCEPTED → DONE.
- Yeni hafta eskisini SUPERSEDED yapar. Açıklama, sinyal ve fikir bağları yeni satıra taşınır; eski bağlantı yeni satırı vurgular.
- Kural değerlendirildi ve konu artık görülmüyorsa RESOLVED.
- Kural değerlendirilemiyor ve 35 gündür görülmüyorsa EXPIRED.
- Yeniden açılmama: reddedilen konu 56 gün; DONE değerlendirme penceresi boyunca (başlık 28, içerik yenileme 56, yeni içerik 90 gün); ACCEPTED 90 gün.
- EVALUATED SC-F6'da yazılır (eylem değerlendirilince; [search-actions.md](search-actions.md)). Bulgular 24 ay saklanır; saklama bayrak kapatılsa da sürer.

## Fix this (SC-F6)

`SEO_ACTIONS` + `SEO_HEALTH` + `SEO_CRAWL` açıkken fırsat satırlarında (Accept / Dismiss'in yanında) "Fix this" çıkar; ayrıntı [search-actions.md](search-actions.md).

- `actionKind` TITLE_META → SEO Manager "Fix the snippet" Work'ü, CONTENT_REFRESH → "Refresh a page", NEW_CONTENT ve LOCALIZE → makale modu. INTERNAL_LINKS, CONSOLIDATE, TECH_FIX ve SCHEMA "Actions & results"ta kontrol listesi maddesine ("Mark as done") dönüşür. INVESTIGATE'te Fix this yoktur.
- Bulgunun anahtar kelimesi karta yazılmaz: kullanıcıya "Suggested from Search Console" önerisi olarak sunulur, tek dokunuşla benimsenir.
- "Mark done" (SEO_ACTIONS) ölçümü başlatır: her Done bir `SeoAction` doğurur ya da uygular. Bulgunun `evaluateAfter`'ı eylem değerlendirilebilene dek uzatılır; böylece aynı sayfa için ikinci fırsat ya da ikinci Fix this çıkmaz.

## LLM kullanımı ve Limited Use

- Açıklamalar: haftada ≤ 5 bulgu, tek çağrı, projenin içerik dilinde. number-check'ten geçer; oranlar yüzde biçimiyle de izinlidir. Mock yanıt saklanmaz.
- Üretken istemlere ≤ 20 maskelenmiş sorgu/yol gider. Fikir isteminde quick wins + fırsatlar birlikte ≤ 20.
- Sohbet aracı sonuçlarında ≤ 20 Google dizgisi bulunur.
- Embedding'e maskelenmiş sorgu metni, sorgu başına bir kez gider (SK13).
- Operatör yalnız sayaç görür.
- Telegram'a hiçbir şey gitmez; sinyal metinleri genel ve sayısızdır.
- AuditLog'a sorgu, yol ya da terim yazılmaz.

## Brand Brain ve fikirler

- Sinyal: SO3, SO6, SO7 (sayfa), SO9, SO10, SO13; hafta başına en çok 3; kaynak `search-console-opportunities`; tarihli uygulama içi `externalRef`.
- Fikirler: SO3 (sıralama/CTR), SO5, SO6 ve SO11 `generateSeoIdeas` istemine kanıtla girer (`idea-seo.ts`; fırsat yokken istem bayt bayt aynı). Eşleşen fikir "search" kaynağıyla, sabit gerekçe ve ≤ 3 kanıtla kaydedilir; fikir kimliği bulgunun `ideaIds`'ine yazılır.

## Marka terimi önerileri (SK8)

- Search sayfasındaki Brand terms formunda "Suggest terms".
- lite LLM, ≤ 20 sorgudan ≤ 8 terim önerir. Terim aynen kopyalanmalıdır; sorgularda ya da marka/alan adında geçmiyorsa atılır.
- Kullanıcı Add ile onaylar (`saveBrandTerms`), Dismiss ile gizler.
- Mod on iken veri 4 haftayı bulunca bir kez kendiliğinden çalışır.

## Sohbet araçları

- `get_search_overview`, `query_search_performance` (≤ 20 satır), `get_page_seo`, `inspect_url` (`SEO_HEALTH`; hassas: kirli turda reddedilir), `get_seo_opportunities`.
- Hepsi okumadır, `external: true` ve yalnız ambara bakar. `toolsForPhase` onları yalnız `SEO_INSIGHTS=on` ve proje izinliyken ekler (`projectId` seçeneği; verilmezse eklenmez). Proje izin listesi dışındaki projelerde araç listesi değişmez.
- "Which pages should I improve first?" `get_seo_opportunities` ile yanıtlanır.

## Arayüz

- **Search sayfası** (`/projects/[id]/arama`): rapor gövdesinin hemen altında "Opportunities" bölümü: etki, güven, emek; Accept / Dismiss (neden seçimi) / Mark done; `?opportunity=<id>` satırı vurgular ve "Why this matters"ı açar.
- Gölge kipte yalnız platform operatörüne "Shadow review — only platform operators see this" (Useful / Not useful).
- Brand terms formunun altında "Suggest terms" (yalnız `on`).
- Bayrak kapalıyken sayfanın HTML'i bugünküyle aynıdır (sarmalayıcılar hiç çizilmez).
- **SEO Manager** quick wins: pozisyon 4–20, tahmini ek tıklamaya göre sıralı, "+N/mo".
- **/health** → "Search opportunities" kartı (Findings (14 days), Reviewed, Precision, Failing sites, "Open") ve **/health/search-opportunities**: yalnız sayaçlar ve kural başına isabet; `healthy`'ye sayılmaz.

## Silme

- Kapsam: Disconnect, "Delete stored data" (yalnız bu kipin bağları) ve W1 bağ temizliği (sahipsiz ve seçimi değişmiş bağlar).
- Tablolar cascade ile gider.
- Motorun sinyalleri ve havuzdaki kullanılmamış fikirleri silinir (`ideaIds` ya da kanıt bağlantısındaki `opportunity=<id>` ile bulunur); kullanılmış fikirlerin kanıtı çıkarılır (`forget.ts`).
- Hepsi bayraktan bağımsızdır; temizlik hatası bağ silmeyi durdurmaz.

## Testler

- Kural başına sınır testleri ve seen (`src/lib/seo/rules/*.test.ts`).
- Monoton eğri (özellik testi, `ctr-curve.test.ts`).
- Marka sınıflayıcı ≥ %90 (fikstür, `brand-fuzzy.test.ts`).
- Yaşam döngüsü (sınır, ret, DONE penceresi, taşıma; `finding-lifecycle.test.ts`).
- Kapsam (query_page eksik → no_data; `snapshot.test.ts`, `runner.test.ts`).
- İstem: `idea-seo.test.ts` (fırsatsız istem bayt bayt aynı).
- Silme: `google-disconnect.test.ts`, `links.test.ts`, `forget.test.ts`.
- Entegrasyon testi (`opportunities.integration.test.ts`, gerçek Postgres): gölge → on, yeniden koşu, Disconnect.

## Doğrulanmalı

- Kamuya açık CTR önseli.
- Sahibin sitesinde marka sınıflayıcısının ≥ %90 elle örneklemi.
- Gölge isabeti.
- OpenAI embedding maliyeti.
- Yer adları listesinin kapsamı.
- SEO makale görev başlıklarının Telegram'a sorgu taşıyıp taşımadığı: kanıtlı fikrin anahtar sözcüğü (bir Search Console sorgusu) makale ya da görev başlığına girebilir ve görev bildirimi ("Task completed: <title>") Telegram'a ulaşabilir. Bu bugün quick wins için de var; ulaşıyorsa ayrı bir iş olarak maskelenmeli.
