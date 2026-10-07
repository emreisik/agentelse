# AI arama görünürlüğü (GEO/AEO, SC-F8)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.9, §9 SC-F8. Uygulama katmanı (aynı fazın öbür yarısı): [website-apply.md](website-apply.md). Site tarayıcısı ve SeoSite: [search-health.md](search-health.md). AI asistan trafiği (GA tarafı, AN7): [website-insights.md](website-insights.md).

## Durum (7 Ekim 2026)

Kodlandı, bayrakla kapalı (`SEO_GEO`), canlıda denenmedi. Migration `20261006221000_add_seo_apply` (`SeoGeoAudit` tablosu). Sonuçlar SC-F4 bulgu tablosuna DEĞİL kendi tablosuna yazılır ve Search sayfasında ayrı bir bölümde görünür.

| Parça                                                       | Durum                          |
| ----------------------------------------------------------- | ------------------------------ |
| 11 kontrol (GEO1-GEO11), puan, "I decided this"             | Yapıldı                        |
| Haftalık denetim (tick adımı `seo-geo`), elle "Check again" | Yapıldı                        |
| llms.txt taslağı ve kopyala düğmesi                         | Yapıldı                        |
| Öneri metinleri (LLM, sabit yedekli)                        | Yapıldı                        |
| AI asistan trafiği kartı (GA ambarından, saklanmaz)         | Yapıldı                        |
| Search sayfası bölümü `#ai-visibility`, /health sayacı      | Yapıldı (tarayıcıda görülmedi) |

## Bayrak

`SEO_GEO=true`. `SEO_HEALTH=true` ve `SEO_CRAWL=true` gerekir (`seoGeoEnabled()`); proje başına `seoGeoEnabledFor(projectId)` ayrıca `SEO_DEV_PROJECTS` / `SEO_ROLLOUT_PROJECTS`'e bakar. AI trafiği kartı ek olarak `GA_SYNC=true` ve aynı projede her iki entegrasyonu ister. Bayrak kapalıyken tick adımı hemen 0 döner, bölüm hiç çizilmez, veritabanına gidilmez. `.env.example` yazılamadı; sahip `SEO_GEO=false` satırını ekler.

## Neyi ölçer

Skor yalnız puanlı ve uygulanabilir kontrollerin ağırlıklı ortalamasıdır: `round(100 * Σ(ağırlık × değer) / Σ(uygulanabilir puanlı kontrollerin ağırlığı))`. `NA` ve `ACK` kontroller paydadan çıkar; GEO3 puansızdır. Metinler hiçbir AI motorunun siteyi alıntılayacağını vaat etmez.

| Kontrol | Başlık                              | PASS                                                     | WARN                                                | INFO                                                                                                  | NA                                                 | Ağırlık     |
| ------- | ----------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------- |
| GEO1    | llms.txt file                       | var, `# ` başlık satırı, boş değil, HTML değil           | var ama geçersiz (boş, başlıksız, `<` ile başlıyor) | yok (kural isteğe bağlı ve yeni)                                                                      | robots engelliyor ya da bilinmiyor                 | 5           |
| GEO2    | AI search crawlers                  | tümü izinli (robots.txt yoksa da)                        | engelli olanlar listelenir                          |                                                                                                       | robots okunamadı                                   | 20          |
| GEO3    | AI training crawlers                | -                                                        | -                                                   | izinli/engelli sayıları: "Allowing or blocking training is your decision; Agentelse only reports it." | robots okunamadı                                   | 0 (puansız) |
| GEO4    | Content in the page HTML            | ana sayfa metni HTML'de                                  | metin yalnız betikle geliyor (render riski)         |                                                                                                       | ana sayfa verisi yok                               | 10          |
| GEO5    | Organization markup on the homepage | Organization/LocalBusiness (alt türleri) JSON-LD var     | yok                                                 |                                                                                                       | ana sayfa verisi yok                               | 12          |
| GEO6    | Links to your official profiles     | en az 2 ayrı https alan adı `sameAs` içinde              | 0-1 alan adı                                        | 2+ alan adı var ama bağlı hesap tutamaçlarından hiçbiri `sameAs`'te geçmiyor                          | GEO5 yok                                           | 10          |
| GEO7    | FAQ or how-to markup                | en az bir sayfada FAQPage/HowTo var                      | -                                                   | yok (Google çoğu site için FAQ zengin sonucunu göstermiyor ama işaretleme makineye yardım eder)       | indekslenebilir sayfa < 5                          | 8           |
| GEO8    | Question-style headings             | içerik sayfalarının en az %20'sinde soru biçiminde H2    | altında                                             |                                                                                                       | içerik sayfası (indekslenebilir, ≥ 300 kelime) < 5 | 12          |
| GEO9    | Snippet controls                    | hiçbir sayfada `nosnippet` / `max-snippet:0` yok         | var (sayı facts'te)                                 |                                                                                                       | indekslenebilir sayfa yok                          | 10          |
| GEO10   | Page structure                      | uzun sayfaların (≥ 600 kelime) %20'sinden azında H2 yok  | aksi                                                |                                                                                                       | uzun sayfa yok                                     | 8           |
| GEO11   | Consistent brand name               | Organization adı, ana sayfa başlığı ve marka adı tutarlı | -                                                   | Organization adı marka adıyla ya da başlık markayla uyuşmuyor                                         | bunlardan biri eksik                               | 5           |

Her kontrolün sabit İngilizce "neden önemli" ve "ne yapılmalı" metni `src/lib/seo/geo/catalog.ts` içindedir. GEO2 ve GEO9'a ek olarak `ACK` durumu vardır ("You decided").

## Veri kaynakları

- `SeoSite.robotsBody` (W2 ayrıştırıcısı; `AI_CRAWLERS` ve `aiCrawlerAccess` `src/lib/seo/robots-parser.ts`'ten yeniden kullanılır, belirteçler yeniden tanımlanmaz) ve en çok 300 `SeoPage` satırı (yalnız gereken sütunlar).
- İki canlı, kendi siteye GET: `/llms.txt` ve ana sayfa (JSON-LD için W2 `tokenizeHtml`). Her ikisi `SEO_CRAWLER_TOKEN` ile saklı robots'a uyar; robots engelliyorsa ya da bilinmiyorsa hiç alınmaz (GEO1 `NA`). Mock kipte W2 mock site taşıması kullanılır (`llms.txt` 404 = yok).
- Hiçbir şey siteye yazılmaz; hiçbir üçüncü taraf çağrısı yoktur.

## robots.txt: karar kullanıcının

Agentelse robots.txt hakkında yalnız bilgi verir, onu asla düzenlemez. AI arama tarayıcılarını engellemek bir iş kararı olabilir; bu yüzden GEO2 ve GEO9 yönetici (OWNER/ADMIN) tarafından "I decided this" ile işaretlenebilir (`SeoGeoAudit.acknowledged`, `["GEO2","GEO9"]`'dan biri). Onaylanan WARN `ACK` olur ve puandan düşer; yeni denetim gerekmeden saf yeniden puanlamayla uygulanır. GEO3 yalnız bilgidir.

## llms.txt

Mevcudiyet denetimi ve sabit, deterministik bir taslak (LLM yok; en çok 40 anahtar sayfadan: ana sayfa önce, sonra en çok iç bağlantı alanlar; site adı ana sayfa başlığının ilk parçası). Taslak yalnız dosya yokken (state "missing") gösterilir ve "Copy" düğmesi vardır: "Create a file named llms.txt at the root of your site with this text. Agentelse does not change your site for this." Siteye hiçbir şey yazılmaz.

## Puan ve haftalık takvim

Her site için haftada bir (`nextAuditAt`), elle "Check again" en az 6 saat arayla (`GEO_MANUAL_GAP_MS`). İlk denetim, tarama verisi (en az bir tam tarama, kapsam, kaynak ve 200 SeoPage) varsa, kira ile birlikte yer tutucu bir `SeoGeoAudit` satırı (`result: {v: 0}`) alır; `siteId` tekil olduğundan ikinci süreç P2002 alır ve atlar. Panel `v !== 1` için "waiting" der. Kapsam anahtarı değişmişse sonuç bayat sayılır. Runner: `SeoGeo.runDue(2)`; global kilit `claimPeriodic('seo.geo-scan', 60 sn)` yalnız `seoApplyGlobalWorkAllowedHere()` iken; dev süreci boş izin listesiyle veritabanına gitmeden 0 döner, `SEO_DEV_PROJECTS` varsa global kilit almaz.

## LLM kullanımı

Yalnız kontrol başına öneri metni LLM tarafından yazılır (amaç `seo.geo-recommend`, katman lite, proje içerik dili). Bağlamı yalnız sabit kontrol kimlikleri ve başlıkları ile sitenin kendi sayıları/booleanlarını taşır; GEO3, `ACK` ve `NA` hiçbir zaman öneri almaz. Cümleler `keepSupportedSentences(allowedNumbersOf(context))` geçer. Mock mod, `BUDGET_EXCEEDED` ya da varsayılan marka yokluğunda kataloğun sabit İngilizce "ne yapılmalı" metni (kaynak `template`) kullanılır. GA ve Search Console verisi LLM'e hiç gitmez.

## AI trafiği köprüsü

GA ambarından canlı okunur (`primaryGaLink` + iki `loadGaWindowTables`, 28 gün ve önceki 28 gün) ve YALNIZ ortak `assistantTotals` yardımcısıyla (AN7, `src/lib/website-analytics/analysis/ai-referrals.ts`'te dışa açıldı; toplama yeniden yazılmadı) toplanır. Yalnız sayaç olarak gösterilir; saklanmaz, LLM'e gitmez, Telegram'a gitmez. Yalnız iki entegrasyon aynı projedeyse ve GA akış alan adı kapsamla eşleşiyorsa (ya da bilinmiyorsa) görünür. GA ambarı 95 gün tutulduğundan daha eski pencere yoktur. GA Disconnect'in bu yüzden ek temizliği yoktur.

## Arayüz

- Search > "AI search visibility" (`/projects/{id}/arama#ai-visibility`): puan, kontrol tablosu (durum çipi, neden, ne yapılmalı, öneri), "Your decision" etiketli tarayıcı tablosu ve GEO2/GEO9 için "I decided this", llms.txt taslağı + kopyala, AI trafiği kartı, "Check again". Bölüm yalnız `SeoSite`'a bağlıdır; Search Console bağlı olmasa da görünür (sayfa kendi `GSC_SEARCH_PAGE` bayrağına tabidir).
- /health: "AI search visibility" sayaç kartı (yalnız sayılar).

## Silme

`SeoGeoAudit` bir yabancı anahtara sahip değildir; `SeoSites.resetSite` içindeki işlemde silinir. Bu iki yolu kapsar: kapsam sıfırlaması ve Search > Index & technical health > "Delete audit data". Proje silinince de silinir. Satırlar yalnız sitenin kendi verisini taşır.

## Operatör sayaçları

`loadSeoGeoCounters`: izlenen site sayısı, son 30 gündeki denetimler, puan dağılımı (50 altı / 50-79 / 80 ve üstü), kontrol başına WARN sayısı, `llms.txt` bulunan site sayısı ve GA bağlı proje sayısı. Proje adı, adres, sayfa ya da kurum adı yok; GA verisi de yok.

## Testler

`src/lib/seo/geo/*.test.ts` (katalog, llms, varlıklar, tarayıcılar, sorular, değerlendirme sınırları, puan aritmetiği, rescore = taze değerlendirme), `src/server/seo/geo/*.test.ts` (collect, recommend, runner, ai-traffic, panel), `seo-geo-recommend.test.ts`, `seo-geo-actions.test.ts`, `geo-panel-view.test.ts`, `geo-counters-card.test.ts`; `geo.integration.test.ts` mock kipte `SeoGeo.runDue` ve `auditNow` için tek kullanımlık Postgres ister. `worker-graph.test.ts` runner'ın `tenant-context`/`next-auth` içe aktarmadığını pinler.

## Ertelenenler

GEO bulgularını fikir/Signal'e çevirme, rakip karşılaştırması, marka anma taraması, sohbet araçları, Search & SEO sohbetine GEO sonuçları, GA sayılarının GEO anlatılarında kullanımı.

## Doğrulanmalı

- Eşikler sezgiseldir ve değişebilir: %20 soru başlığı, ≥ 2 `sameAs` alan adı, 600 kelimelik uzun sayfa, 5 sayfalık FAQ kuralı.
- Soru sözcükleri listesi (`src/lib/seo/geo/questions.ts`).
- AI tarayıcı belirteçlerinin güncelliği (`AI_CRAWLERS`).
- llms.txt bir olgunlaşan kuraldır; hiçbir büyük AI motoru bunu zorunlu tutmaz.
