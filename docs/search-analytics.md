# Search Console ambarı ve Search sayfası (SC-F2)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.3, §3.4, §3.10, §4, §5, SK3/SK8. Bağlantı katmanı: [google-connections.md](google-connections.md). Bu dosya SC-F2'nin uygulanmış hâlini anlatır; desen GA-F2 ile aynıdır ([website-analytics.md](website-analytics.md)): tembel bağlar → CAS kilitli runner → toplu upsert → store/okuyucular → rapor → bayraklı sayfa.

## Durum (6 Ekim 2026)

| Parça                                                                                                                                                                                                 | Durum                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 11 tablo + migration `20261006210500_add_gsc_warehouse`                                                                                                                                               | Yapıldı                                                        |
| GSC istemcisi: PT günleri, `dataState`, sayfalama, kota yöneticisi, mock modu (`src/server/integrations/search-console/`)                                                                             | Yapıldı                                                        |
| Senkron: `gsc-sync` (boşluk tespiti + geri doldurma dahil), `seo-retention` (kırılımların aylık toplanması dahil)                                                                                     | Yapıldı (bayraklı, canlı denenmedi)                            |
| Marka terimleri v1 (otomatik terimler + kullanıcı düzenlemesi)                                                                                                                                        | Yapıldı                                                        |
| Okuyucular: Analytics modülü, sohbet ANALYTICS_ANALYSIS 28 günlük toplamlar, quick wins → fikir motoru                                                                                                | Yapıldı (`GSC_SYNC` açıkken, eksik pencerede canlı yola düşer) |
| Search sayfası v1, Brand sekmesi "Search" kartı, Connectors kartı (arşiv, Delete stored data, marka terimleri)                                                                                        | Yapıldı (`GSC_SEARCH_PAGE` / `GSC_SYNC`)                       |
| Gizlilik ve veri silme metni, /health sayaçları                                                                                                                                                       | Yapıldı                                                        |
| Saatlik erken uyarı, sitemap senkronu (SC-F3), uzlaştırma uyarısı, LLM marka terimi önerisi ve CTR eğrisi (SC-F4), haftalık image özetleri, Analytics modülünde en iyi sayfalar, "All history" dönemi | Bekliyor                                                       |

## Bayraklar ve açılış

- `GSC_SYNC=true`: `gsc-sync` ve `seo-retention` tick adımları, tembel bağ oluşturma (site seçiminde de), Connectors'taki ambar kartı ve saklama notu, Brand sekmesi "Search" kartı (sunucudan `searchOverview` olarak geçer) ve ambar okuyucuları. Kapalıyken adımlar hemen 0 döner, okuyucular veritabanına gitmeden null döner, canlı yollar bugünkü gibi çalışır; hiçbir kart çizilmez, yeni istek yapılmaz.
- `GSC_SEARCH_PAGE=true`: `/projects/[projectId]/arama` sayfası (kapalıyken `notFound()`), Explore'daki "Search" satırı ve Connectors / Brand kartındaki "Open Search report" / "Open" bağlantıları. Veri için `GSC_SYNC` de açık olmalı.
- `GSC_SYNC_DEV_PROJECTS=<id,id>`: `NODE_ENV=development` ve canlı veritabanı paylaşılıyorsa yalnız bu projeler bağ, senkron, Refresh ve yazma eylemleri alır; o süreç `gsc.sync` nabzı yazmaz, `claimPeriodic` anahtarı almaz, `seo-retention` hiç çalışmaz. Yerel tek kullanımlık veritabanında (localhost ya da Unix soketi, `isLocalDatabaseUrl`) her şey çalışır.
- `GSC_ROLLOUT_PROJECTS=<id,id>` (isteğe bağlı, her ortamda): doluysa yalnız bu projeler bağ, senkron, Refresh ve yazma eylemleri alır (plan §9 kademeli açılış). Saklama yine globaldir. Boşsa bütün projeler.
- Mock modu (`AGENTELSE_PROVIDER_MODE=mock`): istemci fonksiyonları belirlenimci yapay veri döner, `fetch` çağrılmaz, token yenilenmez, dakika sınırlayıcısı devre dışı; bağlar `isMock=true` oluşur ve runner yalnız moduna uyan bağları işler.

Açılış sırası:

1. Migration canlıya çıkar (Railway başlangıcında `migrate deploy`).
2. `GSC_ROLLOUT_PROJECTS=<agentelse.com projesi>`, sonra `GSC_SYNC=true`.
3. "Doğrulanmalı" listesi gerçek mülkte denetlenir.
4. `GSC_ROLLOUT_PROJECTS` temizlenir.
5. `GSC_SEARCH_PAGE=true`.

İlk sayılar birkaç dakikada gelir. 16 aylık geçmiş KOBİ sitesinde 1-3 dakikalık tick'le (süreç içi işçi) yaklaşık 15 dakika, yalnız 5 dakikalık GitHub cron'uyla yaklaşık 30-35 dakika sürer (≈260 istek, tur başına ≤ 45 istek); büyük sitelerde yük kotası yüzünden günlere yayılabilir.

## Tablolar

- `GscSiteLink`: proje ↔ Search Console sitesi. Seçili sitesi olan ACTIVE `google_search_console` bağlantısından tembel oluşur (`sync/links.ts`). `isPrimary` + `demotedAt` (site değişince eski bağ işaretlenir, yeniden birincil olursa temizlenir; bağlantı yoksa ya da ACTIVE/EXPIRED değilse seçim bilinmediğinden hiçbir bağ düşürülmez, tek proje yolunda EXPIRED bağlantının seçimi de geçerlidir), `isMock`, `archive` (varsayılan açık), `brandTerms` `{v, auto, user, removed, updatedAt}`, `brandSeriesHash`, `brandClassifiedHash`, kota alanları (`rateLimitedUntil`, `loadLimitedUntil`, `heavyLimitedUntil`, …), sağlık, kilit, geri doldurma durumu (`backfill` Json v1, `backfillDoneAt`).
- `GscDailyTotal`: arama türü (web, image, video, news, discover, googleNews) başına gün; tıklama, gösterim, `positionWeighted`; marka kolonları (`brand*`); `fresh`.
- `GscDailySlice`: country (gün başına ilk 50 + "other"), device, searchAppearance günlük satırları; 16 aydan sonra `'<kind>_month'` aylık toplamları.
- `GscQuery` / `GscPage`: PII maskeli sözlükler; `GscQuery.isBrand`; SC-F4 için boş `intent`, `language`, `clusterId`.
- `GscWeeklyQuery`, `GscWeeklyPage`, `GscWeeklyQueryPage`, `GscMonthlyQuery`, `GscMonthlyPage`: haftalık (Pzt-Paz PT) ve aylık özetler (yalnız web).
- `GscPeriodFetch`: hangi (dönem, anahtar) çiftinin çekildiği, `truncated` bayrağı ve satır toplamları; anonim pay = 1 − satır tıklamaları / aynı günlerin günlük toplamı.
- Mevcut modellere ilişki yok; Gsc* tabloları kendi aralarında cascade'li; her tabloda `projectId` var (proje silme onları da temizler).
- Pozisyonlar her yerde `positionWeighted = position × impressions`; CTR = tıklama / gösterim; dönem pozisyonu = Σ positionWeighted / Σ gösterim.

## Günler ve kesinleşme

- Günler Pasifik saatiyle (PT, `lib/seo/dates.ts`), haftalar Pzt-Paz.
- Her günlük çalışmada D-10…dün aralığı için web `dataState=all` ve `dataState=final` istenir. `finalThrough` = son kesin satırın günü; yoksa `first_incomplete_date − 1`, o da yoksa D-3. Önceki `lastFinalDate`'ten geri gitmez, dünden ileri gitmez.
- `finalThrough`'a kadarki günler final yanıttan `fresh=false` yazılır (satır yoksa 0); sonraki günler all yanıtından `fresh=true`. Kesin satırın üzerine taze veri asla yazılmaz (upsert koruması). KPI'lar ve karşılaştırmalar yalnız kesin günleri kullanır.
- Boşluk tespiti: önceki `lastFinalDate` 10 günlük pencerenin gerisinde kalmışsa (kopuk kimlik, DEGRADED bekleme, kapalı API, duraklatılmış proje, bozuk işçi tetikleyicileri) eksik günler geri doldurma durumuna boşluk olarak eklenir; böylece kalıcı arşivde delik kalmaz.
- Sahte sıfır yok (`backfillWriteDays`): parça içinde ilk satırdan sonraki eksik günler 0 yazılır. Ana geçmiş yeniden eskiye yürüdüğü için parçada Google'ın döndürdüğü ilk satırdan önceki günler (ve satırsız parçanın bütün günleri) hemen yazılmaz; anahtar başına bekleyen aralık (`backfill.zeroPendingTo`) olarak kalır ve daha eski bir parçada satır gelince 0 olarak yazılır. Anahtarın tabanına inen parçada bekleyen aralık düşer. Böylece yeni doğrulanmış mülkte doğrulamadan önceki günler ve pencerenin tam kenarı hiç sıfır olarak saklanmaz. Boşluk parçalarında (iki yanında veri var) her eksik gün 0'dır. Optional türlerde (news, discover, googleNews) satırsız pencere sıfırla doldurulmaz.

## Senkron (`src/server/seo/sync/`)

- Aşamalar ve zamanlama (`lib/seo/schedule.ts`): günlük aşama 06:00 ve 18:00 PT pencerelerinde (`lastDailySlot`); yeni bağ pencere beklemez. Günlük aşamadan sonra haftalık/aylık/geri doldurma yeniden okunan bağdan hesaplanır, yeni bir bağ hepsine ilk turunda başlar. Haftalık aşama `lastFinalDate` bir Pazar'ı geçince, aylık aşama bir ay sonunu geçince; metadata (`sites.get`, alan adı eşleşmesi, otomatik marka terimleri) 24 saatte bir.
- İstek bütçesi: zamanlanmış turda 45, Refresh'te 12 istek (Refresh'te bütçe biterse yazılan veri kalır, sonuç yine "refreshed"; kalan sonraki turda; hata "failed"); bir `runDue` çağrısı için 90 sn ortak süre (bağlar paylaşır), Refresh 25 sn. Tick başına en çok 3 bağ; en eski günlük 25 aday yanında `backfillDoneAt` boş en çok 10 aday (ajans ölçeğinde geri doldurma aç kalmaz).
- Geri doldurma (`lib/seo/backfill.ts`, durum v1, kaldığı yerden sürer). Sıra: boşluklar → totals:web → brand → isteğe bağlı türlerin toplamları → aylık (yeniden eskiye) → kırılımlar (30 günlük parçalar) → haftalık (en çok 70 hafta). Taban `googleWindowStart(today)`, istek anında yeniden kırpılır. Toplam ve marka parçaları ≤ 90 gün, kırılımlar 30 gün, boşluklar 90 günlük parçalarla. Haftalık ve aylık parçalar `GscPeriodFetch` satırı olan (dönem, anahtar) çiftlerini atlar; bütçe ortada biterse bitmiş anahtarlar korunur. `backfillDoneAt` her ana anahtar tabanına inince yazılır; boşluklar ve ağır kuyruk sonra boşaltılır ve aşamayı due tutar.
- Ağır kuyruk: plan tanımıyla "heavy" yalnız query×page'dir (her şey ≤ 90 gün). Haftalık query×page `heavyBlocked()` ile önceden denetlenir, blokluyken `backfill.heavyPending`'e girer. Güvenlik ağı: runner `GscQuotaDeferred(HEAVY)`'yi aşama başına yakalar ve sonraki aşamaya geçer; kilit hiçbir zaman `now + GSC_SYNC_LEASE_MS`'ten uzağa konmaz. Toplamlar, kırılımlar ve hafif özetler hep sürer.
- searchAppearance gün başına geri dönüşü: Google `['date','searchAppearance']`'ı reddederse (VALIDATION) bağ `searchTypes.appearancePerDay=true` olur; günlük aşama eksik kesin günler için gün başına `['searchAppearance']` ister (turda en çok 7, geri doldurmasız). O da reddedilirse `appearance` `disabledSlices`'a düşer. Country/device için VALIDATION o türü kapatır. Kapalı türler ve gün başına appearance tek atlama kümesindedir (`gscBackfillSkipKeys`), geri doldurma takılmaz.
- Arama türleri: web, image, video, news, discover, googleNews toplamları tutulur (discover/googleNews `auto` toplama, diğerleri `byProperty`). Son iki 90 günlük parçasında satırı olmayan isteğe bağlı tür `searchTypes.empty`'ye gider ve ayda bir yeniden yoklanır.
- Tekrar ve sağlık: AUTH, SCOPE_MISSING, PERMISSION, NOT_FOUND, API_DISABLED bağın sağlığını yazar ve senkronu durdurur (STOPPING haritası); geçici hatalarda üstel geri çekilme, art arda hatada DEGRADED. HEAVY ertelemesi bağı asla kilitlemez.
- Mock/canlı ayrımı: runner yalnız `isMock` değeri o anki moda eşit bağları alır; `links.ts` diğer modun bağına dokunmaz; mock olmayan modda saklama `isMock` bağları siler (yalnız global iş izinliyse).
- Dev koruması: `!gscGlobalWorkAllowedHere()` iken `runDue` nabız yazmaz, `claimPeriodic` almaz, yalnız `GSC_SYNC_DEV_PROJECTS` projelerini doğrudan uzlaştırır (süreç içi 2 dk) ve yalnız onların bağlarını senkronlar.
- Tick adımları `gsc-sync` (`GscSync.runDue(3)`) ve `seo-retention` (`GscRetention.runDue()`), `agency-wiring.ts`'te; nabız `SystemHeartbeat("gsc.sync")`, periyodik anahtarlar `gsc.links` (2 dk) ve `gsc.retention` (24 sa). Odak ayarı (AGENCY_FOCUS) bunları kapatmaz.

## Kota yöneticisi (`lib/seo/governor.ts`)

- Site başına dakikada en çok 30 istek (süreç içi kayan pencere, mock'ta devre dışı): sınıra takılan istek, slot süre dolmadan boşalacaksa bekler, yoksa tur `GscRunBudgetSpent` ile yumuşak biter. Süreç içinde site başına en çok 2 eşzamanlı istek.
- RATE hatası ≥ 60 sn bekletir; DAILY PT gece yarısına kadar. PT gününün ilk LOAD hatası her şeyi 15 dk durdurur; ikinci ve sonrakiler ağır istekleri de PT gece yarısına kadar bloklar. Var olan bekleme asla kısaltılmaz.
- "Heavy" tanımı: query×page ya da 90 günden uzun aralık. query×page dışında her istek ≤ 90 gün olduğu için heavy blok toplamları hiç durdurmaz.
- Kota durumu aynı moddaki aynı `siteUrl`'li bütün birincil bağlara yazılır (`{siteUrl, isPrimary: true, isMock}`); geri plana düşmüş bağlara yazılmaz (yaşatmasın diye).
- Yük kotası hata metni (`/\bload\b/i`) doğrulanmalı.

## Marka terimleri (`lib/seo/brand-terms.ts`, `server/seo/brand-terms.ts`)

- Kaynaklar: varsayılan Brand adı, proje adı, alan adının kök etiketi (otomatik, sıkıştırılmış uzunluk ≥ 3) + kullanıcının eklediği ve çıkardığı terimler (`GscSiteLink.brandTerms`).
- Eşleşme: katlanmış (aksan ve büyük/küçük harf bağımsız) ve sıkıştırılmış metinde alt dize; kısa terimler Unicode sınırlarıyla tam kelime (`(?:^|[^\p{L}\p{N}])term(?:$|[^\p{L}\p{N}])`, RE2'de yalnız ASCII olan `\b` asla). Aynı kural hem `isBrandQuery`'de hem Google'a giden RE2 regex'inde; Türkçe ve Kiril (.mk) terimler iki tarafta aynı eşleşir. Regex'teki aksan sınıfları `foldForMatch`'ten kurulur (Latin-1, Latin Extended-A, ș/ț, Kiril): bizde tek harfe katlanan her harf Google tarafında da eşleşir. Regex 4000 karakteri aşamaz: etkin terimler (`effectiveBrandTerms`) regex'e sığan baştaki terimlerdir ve sınıflama, özet ve regex hep bu listeyi kullanır; sığmayan terimler kaydedilirken reddedilir ("These brand terms are too long together…").
- Günlük marka serisi: web toplamları Google tarafında `includingRegex` süzgeciyle istenir, `GscDailyTotal.brand*`'a yazılır; marka dışı = toplam − marka (anonim sorgular marka dışı sayılır, arayüz bunu söyler).
- Serinin yaşam döngüsü `GscBackfillState.brandHash`'te: her senkronun başında `retargetBrand` terim hash'i değiştiyse brand anahtarını yeni hash'le [Google penceresi, D-11] aralığına sıfırlar (90 günlük parçalarla yeniden çekilir). Terim yoksa seri temizlenir (`none`); VALIDATION `error` yazar (aynı hatalı regex'le döngü olmaz, yeni terimler yeniden açar). `brandSeriesHash` brand anahtarı tabanına inince yazılır, yani ayrım web toplamlarından hemen sonra görünür. Google penceresinden eski arşiv günleri eski terimlerle hesaplanmış değerleri korur.
- `brandClassifiedHash`: `GscQuery.isBrand`'ın en son hangi terimlerle hesaplandığı. `saveBrandTerms` arayüz için hemen yeniden sınıflar ve hash'i null yapar; sonraki senkronda `brandContextForLink` bir kez daha sınıflar (eski terimlerle koşan senkronun `isBrand`'ı geri çevirme yarışını kapatır).
- Düzenleme Search sayfasında ve Connectors > Google Search Console kartında (kapalı katlanır); `GSC_SEARCH_PAGE` kapalıyken de ulaşılır ve `error` durumundan çıkış yolu verir. LLM önerisi SC-F4'te.

## Saklama (SK3, `server/seo/retention.ts`)

- `archive` açık (varsayılan): günlük toplamlar ve aylık özetler bağ yaşadıkça; haftalık sorgu/sayfa özetleri 36 ay; query×page 16 ay; günlük kırılımlar 16 ay, sonra aylık kırılım satırlarına toplanır (`'<kind>_month'`, ay başı) ve kalıcı tutulur. Toplama ilk geri doldurma bitmeden (`backfillDoneAt` boşken) yapılmaz: pencere başındaki yarım ay iki 30 günlük parçaya bölünebilir, erken toplanırsa eski parçanın günleri kaybolurdu.
- `archive` kapalı: Google'ın 16 aylık penceresinden eski her şey silinir (Connectors'ta "Keep only 16 months" önce bunun geri alınamayacağını söyler, düğme açıklamanın içindedir) (toplamlar, kırılımlar ve toplamları, özetler, `GscPeriodFetch`, `lastSeenWeek`'i pencereden eski sözlük satırları). Bu hem günlük saklamada hem anahtar kapatılınca hemen çalışan `pruneLink`'te uygulanır.
- Geri plana düşmüş bağlar `demotedAt` + 30 gün sonra silinir (`updatedAt` kullanılmaz; kota yazımları bağı yaşatamaz). Bağlantısı kalmamış bağlar ve (canlı modda) mock bağlar da silinir. `GSC_SYNC` sonradan kapatılsa da ambarda bağ varsa saklama sürer (gizlilik metnindeki süreler geçerli kalır); bağ yoksa hiçbir şey yazmaz.
- "Delete stored data" (OWNER/ADMIN, denetim `search_console.data_deleted`): projenin bu kipteki (mock/canlı) bütün `GscSiteLink`'leri silinir (cascade; canlı veritabanını paylaşan mock süreç canlı bağa dokunamaz) ve bağ aynı arşiv ayarı ve kullanıcı/çıkarılmış terimlerle yeniden kurulur; son 16 ay Google'dan yeniden yüklenir. Disconnect her şeyi hemen siler (`google-disconnect.ts`).

## Okuyucular (`server/seo/readers.ts`)

- Analytics modülü (`modules/analytics/google.ts`): ambar önce, token yenilemeden önce okunur; `period` kesin gün eksiksizse Google'a gidilmez. Metrikler: tıklama, gösterim, CTR, pozisyon ve marka ayrımı hazırsa `sc.nonBrandClicks` / `sc.brandClicks` (yeni `METRIC_DEFS` anahtarları); ilk 5 sorgu pencerenin içindeki tam haftalardan. Eksikse canlı yol aynen.
- Sohbet ANALYTICS_ANALYSIS sağlayıcısı (`google-api-provider.ts`): 28 günlük toplamlar önce `readSearchConsoleTotals`'tan.
- SEO Manager quick wins (`modules/seo/research.ts`): son 4 tam haftanın marka dışı sorguları, gösterime göre ilk 1000 satır, sonra değişmeyen `pickQuickWins` → `generateSeoIdeas`.
- `google-analytics-scanner` SC-F4'e kadar canlı kalır.
- SC-F5 raporları ([search-reports.md](search-reports.md)) ambardan yalnız kesin günleri okur; gönderilen rapor `SeoReport`'ta değişmez anlık görüntüdür.

## Arayüz

- **Search sayfası** (`/projects/[projectId]/arama`, `GSC_SEARCH_PAGE`): başlıkta "Final data through …" ve "Search Console days (Pacific Time)"; dönemler 7 gün, 28 gün, 3 ay (91 g), 12 ay (364 g), hepsi `finalThrough`'ta biter ve eşit uzunluktaki önceki dönemle karşılaştırılır; KPI'lar (marka ayrımı hazırsa marka dışı tıklamalar önde); trend ve "Fresh (may change)" çizgisi; Queries ve Pages tabloları dönemin içindeki tam Pzt-Paz haftalarından, başlıkta hafta aralığı ve "By property" / "By page"; Domain mülkünde sayfa etiketi host + yol; anonim pay (hafta kapsamı eksiksiz ve hiçbir hafta kırpılmamışsa), notlar, arşiv notu; Refresh ve Brand terms.
- **Explore** → "Search" (Connectors'tan hemen önce; Website açıksa ondan sonra).
- **Brand sekmesi "Search" kartı**: sunucu kapısı (`searchOverview={GscFlags.sync()}`), son 28 kesin günün (marka dışı) tıklamaları (28 günün hepsi yoksa `not_synced`), önceki 28 güne göre değişim (yalnız önceki 28 gün eksiksizse; GA kartıyla aynı kural), küçük trend, sağlık; veri `GET /api/projects/[projectId]/search/overview`'dan. Kart metni İngilizce.
- **Connectors → Google Search Console** (bağlıyken, `GSC_SYNC`): kesin veri günü satırı, mülk türü, "Open Search report" (`GSC_SEARCH_PAGE`); OWNER/ADMIN için arşiv anahtarı ("Only the last 16 months are kept now" / "Full history is kept now"), "Delete stored data" ve marka terimleri. Bağlı değilken saklama notu: "Agentelse keeps your Search Console history, including data older than the 16 months Google keeps. You can delete it anytime."
- **Gizlilik ve veri silme**: Google bölümünde Search Console özetleri, 16 ayın ötesindeki saklama süreleri, "keep only the last 16 months", "delete the stored history anytime", site değişince 30 gün, maskeleme; veri silme sayfasında Disconnect'in sildiği arama geçmişi ve "Delete stored data" yolu.
- **/health**: "Search Console data" kartı (dikkat isteyen siteler, geçmişi yüklenen siteler, Google kotası bekleyen siteler); yalnız biri > 0 iken görünür, `healthy`'yi etkilemez.

## Testler

- P1 (istemci ve lib): `lib/seo/{flags,dates,catalog,response,governor}.test.ts`, `integrations/search-console/{search-analytics,sites,sitemaps,errors,mock}.test.ts` (`__fixtures__/` Google yanıtları).
- P2 (senkron): `lib/seo/{schedule,backfill,normalize,slices}.test.ts`, `server/seo/sync/{requests,runner}.test.ts`, `server/seo/sync/warehouse.integration.test.ts` (gerçek Postgres, mock Google: uçtan uca senkron, boşluk, terim değişikliği, saklama, Disconnect'te silme).
- P3 (store ve okuyucular): `lib/seo/{brand-terms,periods,totals}.test.ts`, `modules/seo/research.test.ts`, `server/seo/report.integration.test.ts`.
- P4 (arayüz ve eylemler): `components/search-analytics/{search-report-view,search-overview-card,search-console-warehouse-card}.test.ts`, `server/seo/overview.test.ts`, `server/actions/search-analytics-actions.test.ts`.
- Ortak düzenlemeler: `google-disconnect.test.ts`, `sidebar-nav.test.ts`, `brand-summary-panel.test.ts`, `privacy/page.test.ts`, `data-deletion/page.test.ts`, `modules/analytics/collect.test.ts`.
- Entegrasyon testleri sandbox'ta atlanır; CI'da ya da yerel tek kullanımlık Postgres'le koşar.

## Doğrulanmalı

- `searchAppearance` + `date` birleşimi (gün başına geri dönüş hazır).
- Yük kotası hata metni.
- `includingRegex` içinde RE2 `(?i)`, `\p{L}` ve çok baytlı karakter sınıfları (VALIDATION → `brandSeriesHash` `error`, KPI'lar toplamlara düşer, terimler düzenlenebilir).
- `first_incomplete_date` anlamı ve varlığı.
- discover/googleNews toplama türü.
- Google'ın 16 aylık penceresinin tam başlangıcı.
