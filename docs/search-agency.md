# Search Console: ajans ve büyük site (SC-F9)

Plan: [google-search-console-plan.md](google-search-console-plan.md) SC-F9. Ambar: [search-analytics.md](search-analytics.md). Raporlar: [search-reports.md](search-reports.md). Kardeş iz (Analytics): [website-agency.md](website-agency.md). Bu dosya SC-F9'un uygulanmış hâlini, bayrakları ve sahibin kod dışı adımlarını anlatır.

## 1. Durum (7 Ekim 2026)

Kodlandı; iki bayrağın ikisi de varsayılan KAPALI (`GSC_AGENCY`, `GSC_BIGQUERY`). Migration: `20261006223000_add_gsc_agency` (6 yeni tablo: `GscSiteSetting`, `GscBqSource`, `GscSplitTest`, `GscSplitTestPage`, `ReportBranding`, `ReportShare`; `GscSiteLink.isSecondary`, `GscPeriodFetch.source`). GA-F8'in `20261006222000_add_ga_agency` migration'ı bunun ÖNÜNDEDİR; ikisi de sahibin `migrate deploy`'unu bekler.

Neler var:

- Çoklu site (ek siteler, site değiştirici, "Make primary").
- Sayfa grubu kuralları (PREFIX, GLOB, EXACT).
- BigQuery toplu dışa aktarımı (kurulum, doğrulama, içe aktarım, mock dışa aktarım).
- Bölünmüş SEO testleri (grup başına katmanlı atama, DiD + plasebo).
- Beyaz etiket marka ayarı ve müşteri rapor paylaşım bağlantıları (`/r/<jeton>`), yazdırma görünümü.
- `/search` workspace genel görünümü ve kenar çubuğu girişi, `/health` operatör kartı.

Neler YOK (bkz. bölüm 14): ücretli SERP / sıralama / backlink sağlayıcısı (sahip kararı SK12(a) ve SK19(a)), bölünmüş test öğrenmeleri, logo yükleme, BigQuery hatası için `AdsAlert`, ikincil site motorları.

Paketler: P1 çekirdek (`lib/seo/agency/*`, `server/seo/agency/*`), P2 BigQuery istemcisi ve genel görünüm, P3 BigQuery dışa aktarımı (`*/agency/bq/*`), P4 bölünmüş testler (`*/agency/split/*`), P5 paylaşım ve marka (`lib|server/report-share/*`, `app/r/*`), P6 Search sayfası arayüzü (`components/search-agency/*`). Paylaşımlı birimler (BigQuery istemcisi, `ReportShare`/`ReportBranding`, `/r`, `WhiteLabelFrame`, `AgencyOverviewFrame`, paylaşım saklama adımı) GA-F8 tarafından da kullanılır.

## 2. Bayraklar ve açılış

| Env                                        | Varsayılan    | Anlamı                                                                                                                                                                                                  |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GSC_AGENCY`                               | kapalı        | Ek siteler, site değiştirici, sayfa grupları, bölünmüş testler, `/search`, marka + paylaşım, `gsc-agency` tick adımı, operatör sayaçları. `GSC_SYNC=true` ister; proje sayfası `GSC_SEARCH_PAGE` ister. |
| `GSC_BIGQUERY`                             | kapalı        | BigQuery kurulumu, doğrulama, içe aktarım. `GSC_AGENCY` ister; gerçek kipte `GOOGLE_BIGQUERY_SA_KEY` de gerekir.                                                                                        |
| `GOOGLE_BIGQUERY_SA_KEY`                   | boş (SIR)     | Servis hesabı anahtarı JSON'u (ham ya da base64). Asla loglanmaz. GA-F8 de kullanır.                                                                                                                    |
| `GSC_BQ_ROW_CAP`                           | 100000        | Dönem anahtarı başına en çok satır (1000 .. 500000).                                                                                                                                                    |
| `GSC_BQ_HARD_MAX_BYTES`                    | 107374182400  | Sahibin sorgu başına bayt tavanı (müşteri bunun üstüne çıkamaz; mutlak sınır 200 GiB).                                                                                                                  |
| `GSC_BQ_HARD_MONTHLY_BYTES`                | 2199023255552 | Sahibin aylık bayt tavanı.                                                                                                                                                                              |
| `GA_AGENCY` (GA-F8)                        | kapalı        | `reportShareOn()` = `GSC_AGENCY` veya `GA_AGENCY`: `/r/<jeton>` rotaları ve `report-share-retention` adımı ikisinden biriyle çalışır.                                                                   |
| `SEO_REPORTS`, `SEO_APPLY`, `SEO_INSIGHTS` | (mevcut)      | SEARCH paylaşım çizicisi ve "Client reports" kartı `SEO_REPORTS` ister; split testin CMS yolu `SEO_APPLY`, `/search`'teki fırsat sütunu `SEO_INSIGHTS` ister.                                           |

`.env.example` sandbox yüzünden güncellenemedi; sahip bu tabloyu elle taşımalıdır (gerçek değer olmadan: bayraklar `false`, anahtar boş).

**Geliştirme koruması.** Canlı veritabanını paylaşan yerel süreç yalnızca `GSC_SYNC_DEV_PROJECTS` / `GSC_ROLLOUT_PROJECTS` içindeki projelere dokunur (`gscSyncAllowedFor`) ve küresel iş koşmaz (`gscGlobalWorkAllowedHere`).

**Mock kip** (`AGENTELSE_PROVIDER_MODE=mock`): BigQuery istemcisi mock arka uç kullanır (anahtar gerekmez), mock dışa aktarım `mockSearchAnalytics`'i yeniden kullanır, CMS yolu SC-F8 mock'unu, sayfa denetimi `mockSiteTransport`'u kullanır. Google, BigQuery ya da web sitesine çağrı yapılmaz.

**Bayraklar kapalıyken bayt bayt aynı olanlar.** Sync koşucusu aynı iki sorguyu atar (ikincil sorgular yalnız `GSC_AGENCY` açıkken); `dictionary.ts` kayıt yolunda sorgusuz geçer (`pageGroupRulesForLink` bayrak kapalıyken veritabanına gitmez); `primaryGscLink` yalnız bellek içi bir kontrol ekler; `GscAgency.runDue` veritabanına gitmeden 0 döner; Search sayfasında ajans bölümü `null` döner ve `engineViews` true olduğundan JSX aynıdır.

**Açılış sırası.** (1) Migration'ları uygula (222000, sonra 223000). (2) Kod yayında kalsın, bayraklar kapalı. (3) `GSC_AGENCY=true` önce yalnız dev izin listesindeki bir projede; `/projects/<id>/arama?site=<ikincil linkId>` elle denenir (bölüm 15h). (4) Sonra canlıda `GSC_AGENCY`. (5) BigQuery için sahip adımları (bölüm 3), gerçek bir dışa aktarım denendikten sonra `GSC_BIGQUERY=true`.

## 3. Sahip adımları

1. Google Cloud'da (Agentelse'in kendi projesi) bir servis hesabı oluştur, o projede BigQuery API'yi etkinleştir.
2. Servis hesabı için JSON anahtar üret.
3. Railway'de `GOOGLE_BIGQUERY_SA_KEY` olarak yaz (ham JSON ya da base64). Başka hiçbir şey gerekmez: yeni OAuth kapsamı, ikinci Google doğrulaması yok. Hesabın `client_email` adresi müşteriye kurulum kartında gösterilir.
4. Faturalama MÜŞTERİNİN Cloud projesindedir (sorgular onun projesinde koşar); Agentelse faturası yoktur.
5. Gizlilik ve veri silme sayfalarındaki SC-F9 cümleleri (BigQuery, paylaşım bağlantıları) bu özellikler açılırken ya da öncesinde yayında olmalıdır; metin koşullu yazıldı.
6. `report-share-retention` ve `gsc-agency` tick adımları kodla kayıtlıdır; sahip bir şey yapmaz.

## 4. Müşteri adımları (kartta gösterilir)

- Yalnız Search Console mülkünün SAHİBİ "Bulk data export"u açabilir (Settings → Bulk data export; proje/veri kümesi seç).
- İlk bölümlerin oluşması 48 saate kadar sürer.
- Müşteri servis hesabına veri kümesinde BigQuery Data Viewer, Cloud projesinde BigQuery Job User verir; faturalama açık olmalı.
- Geçmiş dışa aktarım gününden başlar (geriye dönük dolum yok); eski geçmiş API'den kalır.

## 5. Güvenlik modeli (BigQuery)

Servis hesabı TÜM müşteriler için tek ortak kimliktir ("confused deputy" riski): bir müşteri başka bir müşterinin veri kümesi adını yazarsa, o müşteri hesaba erişim vermişse veri okunabilirdi. Bu yüzden erişim veri kümesi adına değil, mülk sahipliği kanıtına bağlıdır:

- Kaydetme, doğrulama, açma ve HER senkron çalışması `GscSiteLink.permissionLevel = siteOwner` ister (saklı değer; Google çağrısı yok). Doğrulama, açma ve senkron ayrıca bağın sağlığının `AUTH/NEEDS_PERMISSION/ACCESS_LOST/GONE/API_DISABLED` olmamasını ve Search Console kimlik bilgisinin `ACTIVE` olmasını ister (saklı izin, Google erişimi geri alınınca eski kalır). Aksi hâlde `NOT_OWNER`.
- Site eşleme sorgusu tek bir normalize edilmiş parametreyle süzülür (`LOWER(RTRIM(site_url,'/')) = @site`) ve yalnız o mülkü döndürür: veri kümesindeki başka siteler okunmaz, sayılmaz, listelenmez. Bağın kendi `site_url`'ü yoksa sonuç `SITE_MISMATCH` olur ve hiçbir şey içe aktarılmaz.
- Salt okunur: SQL koruması yalnız `SELECT`/`WITH` kabul eder; müşteri yalnız Data Viewer + Job User verir.
- Sınır: `permissionLevel` bağ yenilemesi kadar tazedir; sahipliğini kaybeden müşteri, değer yenilenene kadar içe aktarımı sürdürür (bölüm 15j). Servis hesabına erişimi yalnız müşteri verir; Agentelse hiçbir şeye kendi kendine erişim vermez.
- Testler bunu sabitler: yabancı `site_url` okunmaz, sahip olmayan reddedilir (`NOT_OWNER`).

## 6. Çoklu site

- Her proje için birincil bağ + en çok 4 ek bağ (`MAX_SITES_PER_PROJECT = 5`, birincil dahil). Ek bağ: `isPrimary=false`, `isSecondary=true`.
- İkincil site YALNIZ ambar senkronu alır. Sağlık, fırsat, rapor, inceleme, site haritası ve yenileme `isPrimary: true` süzdüğü için ikincil siteleri görmez; bu, `AdsAlert (projectId, dedupeKey)` çakışmalarını da önler.
- Kurallar: site bağlı hesabın `searchConsoleSites` listesinde olmalı, doğrulanmamış olmamalı, diğer kipte (mock/canlı) zaten bağlı olmamalı (`OTHER_MODE`). Üyelik `GscSiteSetting(isExtra)` içinde tutulur: "Delete stored data" sonrası bağlar bir sonraki tick'te yeniden kurulur; Disconnect ayarları siler. `GscSiteSetting` kip başına yalnız oluşturulur, başka kipin satırı çevrilmez.
- Koşucu: ikincil adaylar ayrı küçük sorgulardan gelir (6 + 3), tick başına en çok 2 ikincil işlenir ve HER ZAMAN bütün birincil adaylardan sonra gelir (400 bağlık test bunu sabitler). Kota durumu aynı `siteUrl`'in ikincil bağlarına da yazılır.
- **Site değiştirici** bir MUTASYON değil, istek başına GÖRÜNÜMDÜR: sayfa `?site=<linkId>`'yi çözer (`resolveViewedSite`), satırı React `cache()` istek deposuna koyar (`site-context.ts`, `requireUser` ile aynı düzenek) ve `primaryGscLink` önce onu döndürür; ambar okuyucuları değişmeden o sitenin verisini gösterir. Sunucu eylemleri kendi kapsamında gerçek birincili kullanır. `store.ts` işçi sürecine ulaştığı için `site-context.ts`'e (React `cache`) statik bağımlı olamaz (`worker-graph.test.ts`): `site-context` yüklenince kendini `registerViewedGscLinkResolver` ile kaydeder; işçide ve sunucu eylemlerinde çözümleyici olmadığından davranış değişmez. Dönem seçici ve sorgu süzgeci `?site=`'yi korur (`searchHref` düzenlemesi).
- İkincil görünümde motora bağlı ya da proje düzeyindeki bölümler GİZLİDİR (yoksa birincil sitenin verisi ikincil başlık altında görünürdü): sağlık, fırsatlar, "Actions & results", içerik planı, "Reports & goals", uygulama (CMS), AI arama (GEO), marka terimleri formu, yenileme düğmesi, "Client reports". Yerine bir not ve "Make primary" düğmesi gelir. Rapor gövdesi, KPI'lar, tablolar, dönem seçici ve sorgu süzgeci görünür kalır.
- **Make primary** tek işlemdir (kimlik bilgisi `metadata.selectedSearchConsoleSite`, iki bağın bayrakları, iki ayar); ardından eski birincilin motor durumu mevcut "forget" yardımcılarıyla en iyi çabayla temizlenir: `forgetSearchOpportunitiesForLinks([eskiLinkId])`, `deleteSearchConsoleAlertsForProjects([projectId])`, `SeoSite.healthParts/healthComputedAt` sıfırlanır. Eski `SeoReport` anlık görüntüleri geçmiş olarak kalır. Yeni birincilin motorları bir sonraki geçişte soğuk başlar. Integrations sayfasındaki seçim kendi davranışını korur (eski birincil `demotedAt` ile 30 gün sonra silinir; `links.ts` düzenlemesi yalnız `isSecondary`'yi temizler).
- **Silme.** "Delete stored data": paylaşımlar silinir, sayfa grubu uygulama durumu ve BigQuery yeniden hesaplama/kapsam alanları sıfırlanır. Disconnect: kimlik bilgisinin PROJESİ için bütün `GscSiteSetting`, `GscBqSource` ve SEARCH `ReportShare` satırları (iki kip) bağ satırı kalmamış olsa da silinir. Yetim süpürmesi, Project/Workspace'i artık olmayan yapılandırma satırlarını da temizler.
- `/search` genel bakış: yalnız OWNER/ADMIN (üyeye 404); satırlar bağlardır (birincil + ikincil), en çok 200 satır, en çok 7 sorgu; sağlık puanı, açık fırsat ve uyarı sayıları yalnız birincil satırlarda vardır (ikincilde çizgi). Kenar çubuğunda Explore → "Search overview" (yalnız OWNER/ADMIN ve `GSC_AGENCY`); `GA_AGENCY` açıkken sayfada "Websites" bağlantısı vardır.

## 7. Sayfa grupları

- Kural türleri `PREFIX`, `GLOB`, `EXACT`; ilk eşleşen kazanır, büyük/küçük harf duyarsız, `RegExp` YOK (ReDoS yok). En çok 40 kural. Grup adları yol biçimindedir (`/shop/reviews`); eşleşmeyen sayfa varsayılan gruba (ilk yol bölümü) düşer.
- Kurallar `(projectId, siteUrl)` başına `GscSiteSetting`'te tutulur ve İKİ yerde uygulanır: (1) EKLEME anında `dictionary.ts upsertPages` yeni sayfalara grubu verir (API ve BigQuery yazımı aynı yoldan; 30 sn bellek önbelleği; bayrak kapalıyken sorgu yok); (2) mevcut sayfalar için sürdürülebilir bir anahtar-kümesi işi (`regroupDue`) `GscPage.pageGroup`'u yeniden yazar (imleç ve kira ayar satırında, `rulesVersion` ile).
- Kural değişikliği eski sayfalara birkaç dakikada ulaşır; bu pencerede üretilen bulgular ve split test popülasyonları karışık grup kullanabilir.
- Etki: SC-F4 SO9 ve iç linkler, SC-F6 kontrol sayfaları, SC-F5 raporları zaten `GscPage.pageGroup` okur. Bir grubu yeniden adlandırmak o grup için yeni bulgu parmak izi doğurur; eskiler süresi dolunca düşer.

## 8. BigQuery

- Tablolar: `searchdata_site_impression` (site toplamları), `searchdata_url_impression` (sorgu/sayfa), `ExportLog`. Doğrulanmalı alan adları bölüm 15'te. Tüm SQL `lib/seo/agency/bq/sql.ts` içindedir; hepsi `data_date` bölüm süzgeci, `site_url = @site`, adlandırılmış parametreler, seçili sütunlar ve doğrulanmış tanımlayıcılar kullanır.
- **Tekrarsızlaştırma.** `GscDailyTotal` BigQuery'den ASLA yazılmaz; yalnız mutabakat (reconcile) için okunur. BigQuery haftalık (sorgu, sayfa, sorgu×sayfa) ve aylık (sorgu, sayfa) özetleri `writePeriod` ile yazar. Bir dönem yalnızca (a) tamamen dışa aktarım penceresi içindeyse, (b) BQ işareti yoksa ve (c) API getirmesi eksik ya da kesilmişse içe aktarılır (`importAll` tam API dönemlerini de değiştirir). Değiştirme mevcut sil-yeniden-yaz işlemidir; bir dönem kaynakları karıştırmaz. BQ dönemleri `GscPeriodFetch.source = 'BQ'` taşır.
- **Satır sınırı.** SQL `cap+1` satır ister; `truncated` = cap'ten fazla satır geldi. Fazla satır atılır, kesilen dönem `truncated=true` kalır, BQ dönemi kesindir ve yeniden denenmez.
- **Maliyet koruması (5 katman).** (1) Bölüm süzgeci, adlandırılmış parametre, seçili sütun, doğrulanmış tanımlayıcı; (2) her içe aktarım sorgusundan önce kuru çalıştırma; (3) `maximumBytesBilled = min(sorgu tavanı, kalan aylık bütçe)`; (4) kaynak başına aylık bütçe ve BigInt sayaçları (ay dönümünde sıfırlanır; atomik artış, faturalanan bayt yazma başarısız olsa da sayılır); (5) artımlı pencereler: yalnız eksik dönemler, kesilmiş haftalar önce, bağ başına tick'te en çok 6, 20 sn'den az kaldıysa yeni dönem başlamaz. Varsayılanlar: sorgu başına 10 GiB, aylık 300 GiB; sert üst sınırlar 100 GiB ve 2 TiB. Tavanı aşan dönem atlanır (`PERIOD_TOO_BIG`, tavan aşan dönemler 6'lık içe aktarım hakkından düşmez); biten ay durumu `BUDGET` yapar.
- `jobs.query` POST'u `retry:false` ve `requestId` ile gönderilir (taşıma yeniden denemesi ikinci faturalı iş açamaz). İş etiketi (`labels.purpose`) BigQuery kurallarına göre temizlenir (`gsc.period.query` → `gsc_period_query`); mock arka uç HAM amaca göre yönlendirir.
- Doğrulama adımları (sahiplik ilk): sahiplik → servis hesabı → veri kümesi → tablo → site eşleşmesi → kapsam (ExportLog) → kuru çalıştırma → mutabakat. Site eşleşmesinden önce veri kümesine ait hiçbir ayrıntı okunmaz ya da gösterilmez (`NOT_FOUND` o aşamaya kadar `NO_ACCESS` olarak bildirilir; `SITE_MISMATCH`'te veri kümesi adımları gizlenir). Sonuç, doğrulanan proje+veri kümesi hâlâ kayıtlıysa yazılır (doğrulama sürerken kaynak başka hedefe çevrilirse hiçbir şey yazılmaz). Başarılı doğrulama `VERIFIED` yapar; `ACTIVE`/`PAUSED`/`BUDGET` kaynak durumunu korur (yeniden doğrulama çalışan içe aktarımı durdurmaz). Açma (`ON`) yalnız `VERIFIED/PAUSED/BUDGET/ACTIVE` durumundan ve son 24 saatteki doğrulamayla; `ERROR`/`DRAFT`'tan önce yeniden doğrulama gerekir; `BUDGET`'tan açma bütçe doluyken reddedilir. Hata geri çekilmesi 30 dk, 1 sa, 2 sa ... en çok 6 sa.
- Kapsam yenilemesi dışa aktarım verisi bulamazsa kaynak `ERROR (NO_EXPORT_DATA)` olur; dışa aktarım 7 günden uzun ilerlemediyse `lastError = EXPORT_LATE` ve durum `ACTIVE` kalır.
- Mutabakat: site tablosu toplamları API `byProperty` toplamlarıyla %3 toleransta karşılaştırılır (bölüm 15f).
- Operatör sayaçları (`/health` "Search agency"): kaynak durumları, kullanılan bayt, bütçe dolu, bu ay içe aktarılan dönem; yalnız sayılar.
- Google'ın fiyatlandırmasında sorgulanan ilk 1 TiB/ay ücretsizdir (kullanıcıya söylemeden önce doğrula).

## 9. Bölünmüş testler

- **Popülasyon.** Kullanıcı 1 ile 5 sayfa grubu seçer. HER grupta son 8 haftada aramadan trafik alan en az 100 sayfa gerekir (plan 6.4; kol başına >= 50). Eşleştirme HER GRUP İÇİNDE katmanlıdır: önceki tıklamaya göre sıralanır, bitişik çiftlerde tohumlu yazı-tura ile TEST/KONTROL ayrılır. Toplam popülasyon 4000 sayfa ile sınırlıdır; en az 4 kapsanan önceki hafta ve 100 önceki tıklama gerekir. Sayfa başına tek açık test, bağ başına en çok 3 açık test; açık SC-F6 eylemi olan sayfalar dışarıda.
- **Değişiklik türleri:** `TITLE_META`, `SCHEMA`, `INTERNAL_LINKS_BLOCK`, `CONTENT_BLOCK`, `TEMPLATE_CHANGE`, `OTHER`. Başlıklar `{title} {h1} {site} {year}` belirteçli desenlerdendir (başlık deseni <= 120, meta <= 320, not <= 400 karakter).
- **Uygulama yolları.** Elle: "I applied it" (uygulama günü en çok 60 gün geriye, en çok bugün). CMS: yalnız `TITLE_META`, BİRİNCİL bağ ve kolu <= 60 sayfa (`SPLIT_CMS_MAX_ARM`) olan test için; sayfa başına bir `SeoChange` + onay (SC-F8 `proposeSeoChange`). SC-F8'in günlük yazma sınırı büyük kolları günlere yayar; ölçüm çapası SON doğrulanan değişikliktir. Bekleyen değişiklik varken reddedilen ya da başarısız olan test `APPLIED` (`CMS_CHANGE_FAILED`) kalır; bekleyen kalmayınca en az biri doğrulandıysa ölçüm doğrulanan alt kümeyle başlar. Değişikliği hiç yapılmamış (atlanan ya da başarısız) test sayfaları değerlendirmede kolun DIŞINDA tutulur ve `evaluation.excluded`'a sayılır; hiçbiri doğrulanmadıysa test süre aşımına kadar `APPLIED` kalır.
- **Doğrulama.** Tarayıcı denetimi ve taban örneği yalnız BİRİNCİL bağ ve `SeoSite` kapsamındaki URL'ler için (URL başına `sameSite` denetimi) ve yalnız `TITLE_META`/`SCHEMA` (taban örneği veya şema türü varsa) için yapılır; ikincil siteler ve kapsam dışı kökenler `USER` yöntemiyle ("I applied it") doğrulanır, asla çekilmez. Kontrol kolu sızıntısı denetlenir. Başarısız denetim 24 saatte bir yeniden denenir.
- **Değerlendirme.** SC-F6 `differenceInDifferences`: işlem = bütün TEST sayfa serileri, kontrol = bütün KONTROL serileri; her iki kol haftalık toplamlarla girer (denge oranı kaydedilir). SC-F6 işlenen sayfaları yeniden örneklemediği için PLASEBO (A/A) koşusu önceki haftalarda yapılır (ilk yarı önce, ikinci yarı sonra, aynı kollar): mutlak etkisi aralığın iki ucuna dolgu olarak eklenir; plasebonun kendi aralığı sıfırı dışlıyorsa sonuç `INCONCLUSIVE` ve neden `PRE_TREND` olur. Eşikler plan 6.4: `WORKED` low > 0 ve etki >= +%10, `DIDNT` high < +%5; güncelleme/örtüşme/az veri sınırları SC-F6'daki gibi. `SIGNIFICANT` her iki kolda toplam >= 100 sayfa ister, aksi `DIRECTIONAL` (plandan daha sıkı, kayıtlı sapma). Kol başına 20'den az kullanılabilir sayfa `LOW_DATA`, 3'ten az kontrol `NO_DATA`. Ölçüt `didMetricFor(splitFixKind(kind))` ile gelir (tıklama yedeği). `BrandLearning` yazılmaz, LLM yoktur.
- Dokunulmayan `DRAFT` testler 30 gün sonra `EXPIRED` olur; doğrulaması zamanında tamamlanmayan `APPLIED` test de `EXPIRED` olur (SC-F6 doğrulama takvimi). Açık testler iptal edilebilir.
- Önizlemedeki kol sayıları sabit tohumludur; gerçek atama tek sayılı gruplarda bir sayfa farklı olabilir.

## 10. Beyaz etiket ve paylaşım

- **Marka** (`ReportBranding`): iş alanı düzeyindedir, bilerek `projectId` YOKTUR. Alanlar: ad (<= 60), vurgu ön ayarı, alt bilgi (<= 160, boşsa varsayılan "Numbers from Google."), `LOGO` varlık kimliği. Logo kuralları: yalnız iş alanının kendi `LOGO` varlıkları, png/jpeg/webp, SVG ASLA; logo yükleme eylemi ERTELENDİ (boş durum ipucu logonun nereden geldiğini söyler). Marka formu `/search` ve `/websites`'te (`#branding`); kaydetme iki sayfayı ve iki yazdırma sayfasını yeniden doğrular.
- **Paylaşım bağlantısı** (`ReportShare`, tür `SEARCH|WEBSITE`): 32 baytlık gizli parçanın SHA-256'sı saklanır (jeton yalnız oluşturma anında görünür), 7/30/90 gün (varsayılan 30), iptal edilebilir, marka anlık görüntüsü, görüntüleme sayacı (dakikada bir), proje başına en çok 50 etkin. Oluşturma açık bir onay kutusu ister ve denetim kaydı düşer.
- **Herkese açık sayfa** `/r/<jeton>` ve `/r/<jeton>/logo`: oturum yok; saklanan DEĞİŞMEZ `SeoReport` anlık görüntüsünü `readSeoReportView(..., { forShare: true })` ile gösterir (canlı bulgu/sohbet bağlantısı okunmaz; `projectId` istemci prop'larında boşaltılır). Bilinmeyen/süresi dolmuş/iptal edilmiş/silinmiş/bayrak kapalı her durumda AYNI nötr 404 (`app/r/not-found.tsx`, Agentelse sözcüğü yok). IP başına hız sınırı (`getClientIp`; sayfa 429 veremediği için aynı 404), `noindex`, `no-referrer`, uygulama bağlantısı ya da denetim kontrolü yok. Çerçeve açık tema belirteçlerini sabitler.
- **Yazdırma görünümü** `/projects/<id>/arama/client/<reportId>`: yalnız yöneticiler (diğerleri 404), canlı markayı okur.
- Silme: Disconnect SEARCH paylaşımlarını projeye göre siler; "Delete stored data" rapor kimliğine göre siler; `report-share-retention` adımı (bayraktan bağımsız kaydedilir; `reportShareOn()` iken süresi dolmuş/iptal (> 7 gün)/yetim satırları günlük siler; bayraklar kapatıldıktan sonra kalan satırlar için günde bir ucuz bir sorgu) satırları sürekli temizler.
- Markdown/düz metin dışa aktarımlarında SC-F5 oluşturucularının alt bilgisi Agentelse'i anar; gerçek beyaz etiket çıktısı yazdırma görünümü ve paylaşım sayfasıdır (oluşturucu alt bilgisi ertelendi).
- GA-F8 entegrasyonu: `register-all.ts` `WEBSITE` çizicisini içe aktarır, WEBSITE paylaşımlarını kendi forget yolunda siler, `BrandingForm`'u `/websites`'te barındırır; ikinci bir saklama adımı KAYDETMEZ.

## 11. Gizlilik ve Limited Use

LLM kullanılmaz; operatörler yalnız sayaçları görür; Telegram'a hiçbir şey gitmez. Google'dan türeyen veri `GscSiteLink` veya `SeoReport` üzerinde ya da bağlıdır; BigQuery mutabakat/kapsam sayıları ve paylaşımlar açıkça silinir. Silme matrisi:

| Eylem                    | Siler                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnect               | Kimlik bilgisinin projesindeki TÜM `GscSiteSetting`, `GscBqSource`, SEARCH `ReportShare` satırları (iki kip); bölünmüş testler bağla cascade ile. Marka (`ReportBranding`) iş alanı düzeyindedir ve kalır. |
| Delete stored data       | Paylaşımlar, sayfa grubu uygulama durumu, BigQuery yeniden hesaplama/kapsam/doğrulama alanları (kaynak `DRAFT`'a döner; proje/veri kümesi kimlikleri, tavanlar, sayaçlar müşteri ayarı olarak kalır).      |
| `report-share-retention` | Süresi dolmuş, iptal (> 7 gün) ve yetim paylaşımlar.                                                                                                                                                       |
| Yetim süpürmesi          | Project/Workspace'i olmayan, bağı ve kimlik bilgisi kalmayan yapılandırma satırları.                                                                                                                       |

Denetim meta verisi yalnız kimlik ve anahtar taşır. `privacy/page.tsx` ve `data-deletion/page.tsx`'te SC-F9 cümleleri vardır (testlerle sabitli).

## 12. Arayüz işaretleri (nereye bakılır)

- `/projects/<id>/arama` (`GSC_AGENCY`): başlık altında "Sites" çipleri (site değiştirici; tek site varsa yok), yöneticide "All sites" bağlantısı; sayfa sonunda "Search agency" bölümünün kartları: "Sites", "BigQuery export", "Page groups", "Split SEO tests", "Client reports". İkincil görünümde (`?site=<linkId>`) not + "Make primary".
- `/search` ("Search"; yalnız OWNER/ADMIN): "All sites / Needs attention / Secondary sites / BigQuery" süzgeçleri, site tablosu, "Client reports branding" formu; kenar çubuğunda Explore → "Search overview".
- `/r/<jeton>`: herkese açık rapor. `/projects/<id>/arama/client/<reportId>`: yazdırma görünümü.
- `/health` → "Search agency" operatör kartı.

## 13. Testler

Birim: `lib/seo/agency/**`, `server/seo/agency/**`, `server/report-share/*`, `lib/report-share/*`, `app/r/**`, `components/search-agency/*`, `components/search-overview/*`, `components/agency-overview/*`, `components/report-share/*`, `server/integrations/google/bigquery/*`, `server/actions/{gsc-sites,gsc-bigquery,gsc-split-test,report-share}-actions.test.ts`, `server/seo/sync/runner.test.ts` (bayrak kapalı = iki sorgu; açık = 400 bağlık sıralama), `google-disconnect.test.ts`, `proxy.test.ts`, `sidebar-nav.test.ts`, `privacy`/`data-deletion` sayfa testleri.

Entegrasyon (tek kullanımlık Postgres; sandbox'ta atlanır, sahip ya da CI koşar): 20 siteli genel bakış (en çok 7 sorgu), 62.000 satırlık BigQuery kabulü (haftalık sorgu tablosunda 62.000 satır, `source='BQ'`, `truncated=false`), 400 bağlık koşucu sıralaması, atama-önce yükseltilmiş bölünmüş test `WORKED/DIRECTIONAL`, paylaşım yaşam döngüsü, "Delete stored data" sonra Disconnect.

Elle gerçek Google listesi: (1) gerçek bir mülkte bir dışa aktarım ve doğrulama; (2) çalışan dev sunucuda `?site=<ikincil linkId>` (istek kapsamlı geçersiz kılma, bölüm 15h); (3) gerçek `/r/<jeton>` iptal ve süre sonu; (4) servis hesabı ile gerçek `jobs.query` (etiket temizleme dahil).

## 14. Ertelenenler

Ücretli SERP / sıralama / backlink / arama hacmi sağlayıcısı (SK12, SK19); bölünmüş test öğrenmeleri; GA için BigQuery (GA-F8'de yapıldı); site başına rapor takvimi; ikincil site sağlık/fırsat motorları; Integrations sayfasında seçimle otomatik ikincil terfi; logo yükleme; BigQuery hataları için `AdsAlert`; SC-F4/F5 karşılaştırmalarında "karışık kaynak" notu; müşteri raporu görünümünün üye için erişimi (yazdırma sayfası ve "Open client view" bağlantısı yalnız yöneticide); elle bölünmüş testte test sayfalarının listesi (`SplitTestView` yalnız kol sayılarını taşır).

## 15. Doğrulanmalı

(a) Dışa aktarım tablo ve sütun adları (`searchdata_site_impression`, `searchdata_url_impression`, `ExportLog`, `is_anonymized_query`, `sum_top_position` ve `sum_position`, sıfır tabanlı konumlar); (b) `bigquery.readonly` kapsamının servis hesabı için `jobs.query`'ye izin verip vermediği (yoksa tam `bigquery` kapsamı: tek sabit); (c) alan adı ve URL-önekli mülklerde `site_url` biçimleri ve `LOWER(RTRIM(site_url,'/'))`'in bunları eşleştirdiği; (d) BigQuery TiB fiyatı ve ücretsiz katman; (e) `data_date`'in PT tarih anlamı; (f) site tablosu toplamlarının API `byProperty` toplamlarına %3 içinde eşit olduğu; (g) 100.000 satırlık dönemlerde `writePeriod` süresi ve `GSC_BQ_ROW_CAP`; (h) dağıtılan Next sürümünde React `cache()` istek kapsamının site geçersiz kılması için çalıştığı; (i) `jobs.query` `requestId` idempotensi; (j) `permissionLevel`'ın sahiplik değişikliklerini yansıtacak sıklıkta yenilendiği.
