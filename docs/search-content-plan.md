# Aylık SEO içerik planı (SC-F7)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §9 SC-F7, §6.5, SK14 (a), SK20. Girdiler: [search-opportunities.md](search-opportunities.md) (kümeler, bulgular), [search-reports.md](search-reports.md) (yol haritası kartı), [search-actions.md](search-actions.md) (ölçüm). Takvim: [content-calendar.md](content-calendar.md). SEO Manager: [modules.md](modules.md).

## Durum (7 Ekim 2026)

Kodlandı, `SEO_CONTENT_PLAN` arkasında; canlı denenmedi. Migration `20261006220000_add_seo_content_plan` (iki tablo). Plan: [google-search-console-plan.md](google-search-console-plan.md) §9 SC-F7, §6.5, SK14 (a), SK20.

## Bayraklar ve açılış

`SEO_CONTENT_PLAN=true`; yalnız `GSC_SYNC=true`, `SEO_INSIGHTS=on` ve `GSC_SEARCH_PAGE=true` ile birlikte etkin (kontroller Search sayfasında), proje izin listesi (`GSC_ROLLOUT_PROJECTS` / `GSC_SYNC_DEV_PROJECTS`) geçerli, SEO Manager için `MODULES_UI` + Works açık olmalı. Sınır ve slot tüketimi ayrıca projenin birincil Search Console bağı olmasını ister. Her proje kapısı `seoContentPlanActiveFor(projectId)`'tir (tick adımı, `placeSeoArticle`, üretim ön kontrolü, haftalık taslak, `/arama` bölümü, sohbet araçları, API, kart ipucu); yalnız küresel işler (saklama, `/health` sayaçları) `SeoContentPlanFlags.on()` kullanır.

Kapalıyken: tick adımı 0 döner (sorgusuz), takvim ve `placeSeoArticle` bugünkü gibi çalışır (ek sorgu ve sınır yok), üretim ön kontrolü eklenmez, sohbet araçları listede yok, API 404, bölüm hiç render edilmez (Suspense sarmalayıcısı da yok), `weeklySeoNote` `''` döner, haftalık taslak sorgusu aynı kalır. **Silme hiçbir zaman bayrağa bağlı değildir.**

Açılış sırası: gizlilik + veri silme metni yayında → `SEO_INSIGHTS=on` gözlemi → sahibin kendi projesinde `SEO_CONTENT_PLAN` (`GSC_ROLLOUT_PROJECTS`) → bir plana ve `/takvim`'e bak → genişlet.

## Tablolar

`SeoContentPlan` (bağ + ay başına bir satır, `GscSiteLink`'e cascade; `data`: slotlar, pillar haritası, gerekçe) ve `SeoContentSetting` (proje başına sınır + otomatik plan; Google verisi değil, Disconnect'te kalır, yalnız proje silinirken gider). Plandaki "Migration: Yok" satırından sapma: Google'dan türeyen plan Disconnect'te silinmeli ve sınır ayarı kalıcı olmalı.

## Plan nasıl kurulur

1. **Zamanlama:** projenin yerel ayı; ayın 2'si 09:00'dan ayın son 7 gününe kadar bir kez (roadmap raporu 4'ünde çıkar). Elle "Plan this month" son 2 güne kadar açık. Slot günleri: hafta içi, 10:00, en az 2 gün arayla, yarından itibaren, o gün başka SEO parçası yoksa. Önceki ayın dokunulmamış slotları yeni ay planlanırken arşivlenir (anahtar kelime reddedilmez, yeniden planlanabilir).
2. **Girdi:** W3 `RuleSnapshot` (sorgular, sorgu×sayfa, sayfalar, tarayıcı gerçekleri ve link grafiği, `SeoCluster`'lar). SO5/SO6 bulguları yalnız not düşer; reddedilen (DISMISSED) bulgu konusu planlanmaz. Adaylar saklanmaz: oluşturma, Replace ve Refresh her seferinde taze snapshot'tan yeniden hesaplanır. Motor geride kalmışsa (`lastWeeklyWeek` ile kümeler uyuşmuyor) plan `ENGINE_BEHIND` ile sonraya kalır.
3. **Adaylar:** marka dışı, navigasyonel olmayan, yerel olmayan, 28 günde ≥100 gösterimli sorgular; ilk 10'da sayfası olan konu yeni makale değildir (yenileme SC-F6'nın işi). Zayıf pillar'lı küme (pillar sayfası yok, ya da kümenin sorguları için ağırlıklı sırası 20'den kötü, ya da başlık+h1 konunun anahtar sözcüklerinin yarısından azını içeriyor) → bir `PILLAR` adayı (`NO_PILLAR`) ve alt konular; güçlü pillar'lı kümede yalnız alt konular → `SUPPORT` (`NO_PAGE`). Alt konu gruplaması token benzerliği ≥0.6. 1.000'den az web gösteriminde plan boş (`NO_DATA`). Not: W3'ün `pillarPageId`'si "en çok gösterimli sayfa"dır ve neredeyse hiç null olmaz; bu yüzden "pillar yok" ölçütü pillar kalitesidir (metinde "no strong main page").
4. **Puan:** pay (marka dışı gösterim payı) × boşluk ağırlığı (`NO_PILLAR` 1.3, `NO_PAGE` 1.0) × niyet (ticari/işlem 1.2) × yükselen 1.25 × güven (kanıtlı bulgu 1/0.85, bulgusuz 0.8; kümesiz sorgu ek çarpan almaz).
5. **Dağıtım:** kümeler arasında D'Hondt (puan/(1+kümede seçilen)); küme başına en çok `max(1, ⌊sınır/3⌋)`; en çok 1 PILLAR (sınır ≥ 8 ise 2); zayıf pillar'lı kümede SUPPORT yalnız PILLAR seçildikten sonra (PILLAR doorway korumasıyla elendiyse SUPPORT'lar bekletilmez); kümesiz adaylar tek kova; aday kovaları sınırı doldurup kapasite artarsa sınır bir kez 1 artırılır (not düşülür); başka dolgu yok.
6. **Kapı sayfası koruması:** yakın kopya anahtar kelimeler (≥0.6), yer adı değiştirilmiş şablonlar (pratikte başlık aşamasında), aynı kalıpta 3. başlık, var olan sayfa/başlık/fikir/post ile ≥0.8 örtüşme, marka sorguları, daha önce atlanan konular elenir. Yerel sorgular plana girmez (SO11).
7. **Aylık sınır (SK14 a):** varsayılan 4, ayar 1–12; ayda o aya düşen TÜM `seo.article` parçalarını (elle yazılanlar dahil) sayar. Uygulandığı yerler: planlayıcı (aynı Serializable işlemde yeniden sayar), `placeSeoArticle` (`SeoMonthlyCapError`), AI yazım öncesi ön kontrol (yalnız slotsuz makale ve içinde bulunulan ay doluysa), takvime koymadan önce ön kontrol. Muaf: "Mark as published", slotun kendi planlı ayında yazılması, aynı `commandId`'nin tekrarı. Birincil Search Console bağı olmayan projelerde sınır yoktur. Takvimde sürükleme sınıra tabi değildir (sınır yalnız planlama ve yerleştirmede garanti). Mock ve gerçek veri aynı projede birlikte yaşamadığı için sayım `isMock`'a bakmaz (kabul edilen sınır).
8. **Metin:** plan başına tek lite çağrı (`seo.content-plan`); modele ≤20 maskeli Google dizgisi gider; başlık kuralları (marka kuralları, uydurma rakam yok, anahtar kelime token'ı var). Bütçe dolarsa ayın 5'ine kadar `EMPTY(AI_LIMIT)` satırı yazılır ve ertesi gün denenir, sonra BASIC (proje diline göre büyük harfli anahtar kelime başlığı) ile yazılır ve bölüm bunu söyler. İngilizce olmayan projelerde temel açı/açıklama boş bırakılır (planlayıcı fikir kavramının gerektirdiği yerde başlığı koyar). Mock modda belirlenimci MOCK metni (bütçe/denetim yan etkisi yok).
9. **İç link planı:** her slot için "bu makaleyi şu sayfalardan linkle" (güçlü pillar önce, ≤4) ve "makale şunlara link vermeli" (≤3); sayfalar kendi tarayıcımızdan (doğrulanmış) ya da yalnız GSC verisinden (doğrulanmamış, uyarı notu). Çapa metinleri çeşitli, ≤60 karakter, tek tam eşleşme. Yayın sonrası link eylemi v1'de yok.

## Slotlar ve takvim

Slot = `module: "seo"` fikri (`PLANNING`; eşleşen havuz fikri varsa o tüketilir ve önceki durumu saklanır) + bir Post + bir DRAFT `seo.article` Creative (`planId` yok, sürüm yok; takvimde "Needs content"). Hiçbir kod APPROVED yapmaz (`rails.test.ts` yazma kalıpları taraması; `createSlotPiecesInTx`'in durum parametresi yok). "Write this article" mevcut SEO Manager akışını (`?module=seo&idea=…`) açar (kart varsa "Continue"); kartın ipucu `keyword` ve `plannedAt` taşır: Plan adımında ana anahtar kelime planın sorgusu olur (modelin seçtiği kelime ikincile iner, kullanıcı yine düzenleyebilir), Deliver adımının tarih seçicisi planlı günle başlar (gelecekteyse). Makale Review → Deliver'dan geçince `placeSeoArticle` slotu tüketir (`Post.ideaId` ile bulur; `planId` = kartın Command'ı), CreativeVersion 1 yazar ve ancak o zaman APPROVED olur. Taşıma/silme takvimden de çalışır; plan durumu Creative'dan okunur. Skip / Replace / Move / Refresh plan (plan başına en çok 3) Search sayfasında; Skip konuyu üç ay dışlar ve havuzdan alınmış fikri eski durumuna döndürür. Planın `planId` taşımaması bilinçlidir: `planId` her yerde "kayıtlı plan kartının Command'ı" demektir (journey, plan paneli, post-results, plan-run buna bakar).

## Haftalık taslak (Faz 4/5)

SEO slotları plan kartına girmez (Save çift parça yaratırdı). Haftalık adım, SEO planı o proje için etkinse seo kanalı parçalarını "hafta dolu" saymaz (`channel IS NULL OR channel <> 'seo'`) ve cevabına "bu hafta SEO makalesi var" notu ekler. Faz 5 otomatik üretimi slotlara dokunamaz (`planId` yok). Planın "SEO makaleleri taslağa girebilir" satırından kayıtlı sapma.

## Ölçüm

`NEW_CONTENT` eylemini W5 açar/bağlar (`openKey card:<commandId>`); SC-F7 ayrı izleyici içermez. Slot tüketilen parça kart üzerinden aynı yoldan gider; entegrasyonda doğrulanmalı. İç link eylemi (`INTERNAL_LINKS`) yayın sonrası ileride.

## Arayüz

- **Search sayfası** (`/projects/[projectId]/arama#content-plan`): "This month's articles" bölümü (aylık sınır ve otomatik plan formu bölümün içinde), slot satırları ve Skip / Replace / Move menüsü (satır içi açılır menü), Refresh plan, Plan this month.
- **SEO roadmap kartı:** "This month's articles" bölümü; YALNIZ içinde bulunulan ay için canlı blok (`ThisMonthsArticlesLive`; geçmiş ayın raporu değişmez anlık görüntü kalır; yükleniyor, 404, hata, plan yok, ay uyuşmazlığında anlık görüntü bölümü aynen görünür). Bayrak açıkken bölüm başlığı "This month's articles", kapalıyken "Planned SEO articles"; madde sınırı 10'dan 12'ye çıktı.
- **Takvim:** SEO parçaları ("Needs content").
- **Sohbet:** `get_seo_content_plan` (okuma, external, yalnız SEO modül ve genel sohbet; sosyal/reklam modül sohbetinde `SEO_CONTENT_TOOL_NAME_SET` ile gizli) ve `regenerate_seo_content_plan` (not, sensitive + decisive: mesajın ilk eylemi olmalı, taint'li turda reddedilir).
- **/health** (yalnız operatör): "SEO content plan" sayaç kartı (yalnız sayılar).

## Gizlilik ve Limited Use

Sorgular yalnız `SeoContentPlan.data`'da; LLM ≤20 maskeli dizgi (`limitGoogleStrings`); sohbet sonuçları ≤20; operatörlere yalnız sayaç; Telegram yok. Disconnect / Delete stored data / W1 saklama: planın tüm slotları taranır; dokunulmamış slot parçaları (Creative+Post) ve plana ait fikirler KALICI SİLİNİR; havuzdan alınmış fikir `search` kaynaklıysa ve `prevIdeaStatus` APPROVED değilse silinir, değilse eski durumuna döner ve yalnız plan kanıt girdisi (`#content-plan`) çıkar; yazılmış makale referanslayan fikir yalnız kanıtını kaybeder; yazılmış makaleler kullanıcının içeriğidir ve kalır (başlıkları Google türevi olabilir, kabul edilen risk, gizlilik metniyle uyumlu). `SeoContentSetting` kalır (proje silinince gider). Plan satırları 14 ay; 14 aylık silme önce forget'i çalıştırır (günlük, küresel iş izni olduğunda; bayrak açık ya da plan satırı varsa). Forget bağ başına `forgetSeoContentPlansForLinks/Credential/Projects`; Disconnect, Delete stored data ve `seo/retention.ts` bağları silmeden önce çağırır. `forgetSeoContentPlansForProjects` için çağıran yok (proje silme akışı yok; satırlar cascade ile gider).

## Testler

`flags`, `cap` (özellik döngüsü), `schedule`, `candidates` (zayıf pillar tablosu, puan sayıları), `doorway`, `allocate` (özellik döngüsü, gevşetme), `links`, `titles`, `view` (`src/lib/seo/content-plan/*.test.ts`); planlayıcı (sınır asla aşılmaz, EMPTY nedenleri, bütçe, P2034), `calendar` (slot tüketimi, sınır, muafiyetler, idempotans, bayrak kapalıyken özdeş), `runner`, `sweep`, `forget` (kalıcı silme), `retention`, `rails` taraması (`src/server/seo/content-plan/*.test.ts`); eylemler ve API rotası; `seo-flow-actions.test.ts` (sınır mesajı, ön kontrol, `capExempt`), `weekly-plan-draft.test.ts`, `roadmap.test.ts`, `google-disconnect.test.ts`, `privacy/page.test.ts`, `data-deletion/page.test.ts`; DB entegrasyon testleri (`planner.integration.test.ts`, `lifecycle.integration.test.ts`: planla → yaz → sınır → disconnect) tek kullanımlık Postgres ister.

## Doğrulanmalı

W3/W4/W5 imzaları (adaptörler `inputs.ts` ve `planInputFromSnapshot` içinde); kapı sayfası ve zayıf pillar eşikleri gerçek verilerle (konumu 20, kapsam 0.5, 100 gösterim, Jaccard 0.6/0.8, D'Hondt ağırlıkları başlangıç değerleridir; önce sahibin kendi projesinde planı gözden geçir); roadmap snapshot'ının ay anahtarı (`period.from`, rapor ayın 4'ünde içinde bulunulan ay için yazılır) ve `readContentPlan` limiti; `/takvim` ve Outputs panelinde `planId`'siz DRAFT `seo.article` görünümü ve sürükleme (Post `workId` null); W5 `NEW_CONTENT` izleyicisinin slot tüketilen parçada başlaması; sayfa metinlerinde başlık dili.

## Riskler ve sınırlar

- Slot parçaları `planId` taşımaz; Outputs paneli ve takvim sürüklemesi `workId` null Post için kaynak okumasıyla doğrulanmadı (görsel doğrulama yok).
- Aylık sınır bayrağın arkasında, Search Console bağı olan projelerde elle SEO Manager makalelerini de engeller; AI üretim ön kontrolü, kullanıcı gelecek ay için yazmak istese de içinde bulunulan ay doluysa slotsuz makaleyi reddeder (mesaj Search sayfasındaki sınıra yönlendirir).
- Serializable çekişme: `placeSeoArticle` işlem içinde ek okuma yapar; bir P2034 yeniden denemesi (`withSerializableRetry`) vardır, kalıcı çatışma `retry BUSY` / genel yerleştirme hatası olarak görünür.
- Saat dilimi ve ay kenarları: sınır ayı `scheduledFor`'un proje yerel ayıdır; geçersiz saat dilimi `safeTimezone` ile varsayılana düşer. 24'ünden sonraki günler otomatik planlanmaz.
- `SEO_INSIGHTS=on` bağımlılığı: kümeler yoksa plan boş (`NO_CLUSTERS`/`NO_DATA`); 1.000'den az web gösterimi olan siteler plan almaz; varsayılan sınır 4 ve küme başı 1 olduğundan az kümeli sitelerde plan küçük ya da boş (`NO_GAPS`) olabilir (dolgu yok, tasarım gereği).
- Roadmap snapshot'ı ayın 4'ünde yazılır; plan işi o gün başarısız/bütçe bekliyorsa snapshot'ta slot olmaz ve canlı blok yalnız içinde bulunulan ayı gösterdiği için geçmiş roadmap sonradan göstermez (kabul edilen).
- Limited Use: yazılmış makalenin ve arkasındaki fikrin başlığı/anahtar kelimesi Google türevi olabilir ve Disconnect'te kalır (gizlilik cümlesiyle uyumlu; sahiple teyit edilmeli).
