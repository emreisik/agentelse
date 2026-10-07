# Öneri → uygulama → ölçüm döngüsü (SC-F6)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §2.3, §3.8, §4, §5, §6.4, SK15 (a), §9 SC-F6. Fırsatlar: [search-opportunities.md](search-opportunities.md). Sağlık: [search-health.md](search-health.md). Bağlantı ve silme: [google-connections.md](google-connections.md). SEO Manager: [modules.md](modules.md). Bu dosya SC-F6'nın uygulanmış hâlini anlatır.

## Durum (7 Ekim 2026)

Bayraklı (`SEO_ACTIONS`). Migration `20261006218000_add_seo_action` (tek tablo: `SeoAction`). Canlıda ve tarayıcıda denenmedi; DB entegrasyon testleri tek kullanımlık Postgres'te koşturulacak.

## Bayraklar ve açılış

- `SeoActionFlags.manager()` = `SEO_ACTIONS=true` (tam "true"). SEO Manager açık maddelerini açar: yeni SEO kartlarına özellik damgası, "Write another", arka plan model çağrısı + SSE, Brief dili kuralı, SEO Manager ve SEO fikir isteminde öğrenmeler, `liveSlotCount` düzeltmesi, kart durum ucu.
- `SeoActionFlags.loop()` = `SEO_ACTIONS` + `SEO_HEALTH` + `SEO_CRAWL`. Eylem kaydı, Fix this, "I fixed this", Done → ölçüm, "Refresh a page" ve "Fix the snippet" modları, makale akışından NEW_CONTENT eylemi, `seo-action-verify` ve `seo-action-evaluate` tick adımları, Search sayfasında "Actions & results" (sayfa ayrıca `GSC_SEARCH_PAGE` ister), /health "SEO actions" sayaçları ve Delete stored data'daki ek cümleyi açar.
- İzin listeleri W2'nin listeleridir: `SEO_DEV_PROJECTS` (yerel süreç canlı veritabanını paylaşırken yalnız bu projeler; o süreç global iş, heartbeat `seo.actions`, `claimPeriodic` `seo.actions-retention` ve saklama çalıştırmaz) ve `SEO_ROLLOUT_PROJECTS` (kademeli açılış). Koşucular `seoActionsRestrictedProjects()`'i WHERE'e koyar. URL Inspection istekleri ayrıca `SeoFlags.health() && GscFlags.sync() && gscSyncAllowedFor(projectId)` ister.
- Bayraklar kapalıyken: her koşucu veritabanına gitmeden 0 döner (saklama yalnız eylem satırı varsa, günde bir bellekli varlık denetimiyle); okuyucular sorgusuz null verir; `/arama`, fırsat listesi, sağlık sorunu listesi, SEO Manager kartı, modül akışı başlangıcı, `liveSlotCount` sorgusu, reasoning istemleri, dil yönergesi, fikir istemi ve ambar kartı metni bugünküyle aynıdır.
- HİÇBİR ZAMAN bayrağa bağlı olmayanlar (Google türevi verinin silinmesi): `forgetSeoActionsForCredential` / `ForLinks` / `ForProjectMode`, `scrubSeoCardsSearchData` ve `SeoActionRetention`'ın bağı kalmayan satır temizliği.
- Açılış sırası: gizlilik ve veri silme metni değişiklikleri önce, sonra sahibin projesi (agentelse.com), `SEO_ROLLOUT_PROJECTS` ile.

## Tablo

`SeoAction` (kolonlar schema.prisma'da yorumlu): `source` (FINDING | SEO_MANAGER | HEALTH_ISSUE | OPPORTUNITY_DONE), `kind` (TITLE_META, CONTENT_REFRESH, NEW_CONTENT, LOCALIZE, INTERNAL_LINKS, CONSOLIDATE, TECH_FIX, SCHEMA, CWV_FIX, SITEMAP_FIX), `status`, `proposal` / `baseline` / `verification` / `evaluation` Json (`src/lib/seo/actions/types.ts`; kademeli ve cömert ayrıştırıcılar: bozuk öğe tek tek düşer, hiçbiri fırlatmaz).

- `openKey`: `finding:<id>` | `card:<commandId>` | `alert:<dedupeKey>`; `@@unique([projectId, isMock, openKey])` açık eylemi tekilleştirir. Her terminal geçiş onu null yapar (aynı bulguya sonra yeni Fix this ya da yeniden açılan uyarı yeni satır doğurur). P2002 mevcut açık satırı döndürür. Bir kart en çok bir eylem taşır.
- `measureFrom`: ölçüm çapası. Eylem EVALUATING'e girerken her yolda (doğrulayıcı, "It's live", DETECTED) bir kez yazılır; değerlendirici onu olduğu gibi okur. Kural (`measuringFields`): CONTENT_REFRESH, NEW_CONTENT, LOCALIZE için `googleCrawlAt ?? verifiedAt ?? appliedAt`, diğerleri için `appliedAt`; "It's live" (method USER) için `verifiedAt` null sayılır; DETECTED için `appliedAt` = `SeoPage.firstSeenAt`. `evaluateAfter = measureFrom + ACTION_WINDOW_DAYS[kind]`; uyarı kaynaklılarda max(bu, `verifiedAt` + 7 gün).
- Pencere günleri: TITLE_META 28, CONTENT_REFRESH 56, NEW_CONTENT 90, LOCALIZE 90, INTERNAL_LINKS 42, CONSOLIDATE 56, TECH_FIX 28, SCHEMA 28, CWV_FIX 56, SITEMAP_FIX 14.
- `linkId`: bulgu ve Done kaynaklı eylemde `finding.linkId`; SEO Manager eyleminde oluşturulduğu andaki aynı kipin birincil bağı; GSC kaynaklı sağlık uyarısında birincil bağ, SEO kaynaklı (tarayıcı) uyarıda null. `linkId`'si null olan her eyleme ölçüme geçerken aynı kipte birincil bağ varsa geç bağlama yapılır (sonra Disconnect onu da siler: artık GSC kaynaklı değerlendirme taşır).
- Saklama: 36 ay; bağı artık olmayan `linkId` satırları günlük temizlenir.
- Denetim kayıtları: `seo_action.created / accept / dismiss / apply / undo_apply / confirm_live / evaluated` (entityType `SeoAction`; yalnız tür, kaynak, durum, sonuç, yöntem; Google metni yok).

## Yaşam döngüsü

| Durum                         | Arayüz etiketi                         | Kim ilerletir                                                                                            |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| PROPOSED                      | Suggested                              | Fix this ya da SEO Manager kartı oluşturur                                                               |
| ACCEPTED                      | To do                                  | Kullanıcı Fix this'e basınca (bulgu da ACCEPT olur)                                                      |
| APPLIED                       | Checking your site                     | Kullanıcı "Mark as published" / "Mark as done" / "I fixed this" der ya da kart makale/kopya yayına çıkar |
| VERIFIED                      | Live · waiting for Google              | Doğrulayıcı (kendi tarayıcımız değişikliği canlıda gördü, Google'ın yeniden taramasını bekler)           |
| EVALUATING                    | Measuring                              | Doğrulayıcı / "It's live" (çapa yazılır)                                                                 |
| WORKED / DIDNT / INCONCLUSIVE | Worked / Didn't work / No clear result | Değerlendirici                                                                                           |
| DISMISSED / EXPIRED           | Dismissed / Expired                    | Kullanıcı / zaman aşımı                                                                                  |

- Google aşaması (VERIFIED): yalnız `needsGoogleStage(kind, inspectionAvailable, fromAlert)`: tür CONTENT_REFRESH, TECH_FIX, SCHEMA, NEW_CONTENT, LOCALIZE; uyarı kaynaklı değil; `linkId` var ve inceleme mümkün. En çok 21 gün, 3 günde bir yeniden istek. `requestInspection` "full" dönerse kayıt düşülmez ve ertesi 3 günlük denetimde yeniden denenir. SCHEMA'da incelemenin zengin sonuç kararı kontrol olarak kaydedilir.
- Doğrulanmamış APPLIED 24 saatte bir yeniden denenir; getirme hatası 30 dk sonra, günde en çok 3 kez.
- Soru / zaman aşımı (türe göre): varsayılan 14. günde sor, 45. günde EXPIRED; CWV_FIX 35 / 70 (CrUX 28 günlük kayan p75, haftalık çekilir); `GSC_CANONICAL_MISMATCH` ve `GSC_RICH_RESULTS` uyarıları 21 / 60. 60 gün dokunulmamış PROPOSED ya da 90 gün dokunulmamış ACCEPTED EXPIRED olur; istisna: creative'i olan ACCEPTED NEW_CONTENT/LOCALIZE doğrulayıcının 90. güne kadar izlediği eylemdir.
- "It's live" (CONFIRM_LIVE): method USER, `appliedAt`'tan ölçmeye başlar. "Not done yet" (UNDO_APPLY): eylem ACCEPTED'e döner.
- Bulgu senkronu: Fix this → W3 `decideFinding` ACCEPT (OPEN iken). Eylem APPLIED (ya da DETECTED) → bulgu OPEN|ACCEPTED'den DONE (`decidedAt`, `evaluateAfter = now + EVALUATION_WINDOW_DAYS`). EVALUATING'e geçince bulgunun `evaluateAfter`'ı eylemin `evaluateAfter + EVAL_GIVE_UP_DAYS` olur (yalnız DONE iken; W3'ün konu bastırması eylem değerlendirilebilene dek sürer, aynı sayfa için ikinci OPEN bulgu ya da ikinci Fix this çıkmaz). UNDO_APPLY → bulgu DONE ve `evaluatedAt` null ise ACCEPTED'e döner. Eylem değerlendirilince bulgu EVALUATED + sonuç + `evaluatedAt`. Bulguya bağlı eylem DISMISS/EXPIRE olursa bulgu olduğu gibi kalır (ACCEPTED ise Accepted listesinde Done/Dismiss mümkün).

## Doğrulama

Kendi tarayıcı yığınımızla (siteFetch, saklı kapsam; `SeoPage` yazılmaz çünkü sahibi tarayıcıdır):

- robots: köken alan adı saklı robots'a, www/apeks eşi kendi robots.txt'sine bakar (koşu başına bir kez getirilir) `robotsGate` ile (hafif bağlam için `RobotsGateContext`, `robots.ts`'te yalnız tip genişletmesi); başarısız hüküm varsa HİÇBİR şey getirilmez (neden ROBOTS, kullanıcı onayı önerilir). Eş alan adındaki hedef köken alan adına yeniden yazılır.
- ≤ 1 istek/sn (ev sahibi hızlandırıcısı, `Crawl-delay`), eylem başına ≤ 6 getirme (bağ/birleştirme kontrollerinde ≤ 5 sayfa), günde en çok 1 olağan kontrol, koşu başına ≤ 5 eylem/proje ve ≤ 10 eylem, 45 sn koşu bütçesi (`VERIFY_RUN_BUDGET_MS`, W2'nin tarama bütçesiyle aynı; her eylem ve getirmeden önce kontrol edilir; ulaşılamayanlar `nextCheckAt`'lerini korur).
- Türe göre kontroller (`verify-checks.ts`): başlık/meta (önerilen "after" başlık NFKC + küçük harf + boşluk sadeleştirmesiyle eşit ya da W2 `tokenSimilarity` ≥ 0,85; "after" yoksa canlı başlık taban çizgisinden farklı olmalı ya da tarayıcı BAŞLIK değişikliği kaydetmiş olmalı: `SeoPage.previous.title` farklı, `lastChangedAt ≥ appliedAt − 14 gün`, `lastChangedAt > firstSeenAt`; yalnız metin ya da ilk görülme değişiklikleri başlığı doğrulamaz; meta yalnız öneri onu değiştirdiyse), içerik yenileme ("recently changed" için `lastChangedAt > firstSeenAt`), iç linkler, birleştirme, TECH_FIX (CANONICAL için null olmayan canonical = normalize son URL), SCHEMA, canlı sayfa. Getirme hatası `fetchFailed`; TECH_FIX'te çözülmemiş 404/5xx olumsuz sonuç sayılır (hızlı yeniden deneme tetiklemez); robots engeli hiçbir zaman `fetchFailed` değildir.
- Sağlık sorunu düzeltmeleri: AdsAlert (aynı `dedupeKey`) `resolvedAt ≥ appliedAt` ile RESOLVED olunca doğrulanır. `GSC_CANONICAL_MISMATCH` ve `GSC_RICH_RESULTS` için doğrulayıcı en çok 5 anahtar sayfayı ilk koşuda ve sonra 3 günde bir yeniden inceleme ister (`watchdog`, bütçeli; W2 `keyPagesFor` + `readInspectionsFor`: `googleCanonical ≠ userCanonical` ya da zengin sonuç hataları). CWV CrUX ile, site haritaları site haritası verisiyle. URL Inspection yalnız W2 `SeoInspection.requestInspection` (200/gün bütçesi) üzerinden gider; mock kip mock site taşıyıcısını kullanır.
- NEW_CONTENT keşfi: makale takvimde `scheduledFor`'dan itibaren aranır; sayfa görülürse `appliedAt = firstSeenAt` ve method DETECTED (`decidedByUserId` null).

## Değerlendirme

Değerlendirme Google'a hiç istek atmaz (bütçe 0); W1 ambarındaki haftalık sayfa serilerini okur (`GscWeeklyPage`). Kaydedilen sapma (§6.4 "günler üzerinden bootstrap" yerine): haftalık seri + hafta/sayfa bootstrap'i.

- Pencereler yalnız PT gün anahtarlarıyla: `anchorDay = gscToday(measureFrom)`; ön pencere çapanın haftasından önceki 8 tam ISO haftası (en az 4'ü kapsanmış olmalı); değişiklikten sonraki ilk 7 gün dışarıda; son pencere `anchorDay+7`'de ya da sonrasında başlayıp `anchorDay+windowDays`'te ya da öncesinde biten haftalar, en az 2 haftaya uzatılır. Güncelleme çakışması, diğer eylem dışlaması ve çakışan değişiklik `gscToday(instant)` ile karşılaştırılır. `GscSiteLink.lastWeeklyWeek ≥ son son-hafta` olana dek beklenir; `evaluateAfter`'dan 21 gün sonra INCONCLUSIVE NO_DATA ile vazgeçer.
- Metrikler: TITLE_META ve SCHEMA konum düzeltmeli CTR `ln((tıklama+0,5)/(beklenen+0,5))` (beklenen = Σ sayfa-hafta gösterimi × `expectedCtr(eğri, ortalama konum)`; eğri W3 `readSeoCurves(projectId).nonBrand`, yoksa `priorCurve('non-brand')`); CONTENT_REFRESH ve CONSOLIDATE `ln(tıklama+1)` (CONSOLIDATE'te hedef + birleşen sayfalar toplanır); INTERNAL_LINKS ve bulgudan TECH_FIX `ln(gösterim+1)`; NEW_CONTENT ve LOCALIZE lansman kuralı (hiç görünmeyen sayfa 0 gösterim sayılır, DIDNT; hedef/sayfa yoksa INCONCLUSIVE NO_PAGE). Sağlık sorunu düzeltmeleri uyarı çözümüyle ölçülür.
- Kaydedilen §3.8 sadeleştirmeleri: CONTENT_REFRESH'te sorgu sayısı ve konum yok; CONSOLIDATE sorgu kümesi yerine sayfaları kullanır, oynaklık yok; SCHEMA arama görünümü gösterimi yerine CTR_adj; SITEMAP_FIX'te "yeni indekslenen URL" yok.
- Kontrol grubu: adaylar aynı `pageGroup`'taki sayfalar; 4'ten azsa bağın bütün sayfaları. ±%50 bandı (ön pencere tabanı: tıklama, impressions metriğinde gösterim) SQL'de uygulanır (ilk-300 kesimi bütün kontrolleri düşürmesin). Dışlananlar: pencerede başka (HEALTH_ISSUE olmayan) bir `SeoAction`'ın hedeflediği sayfalar (`pageId ∪ normalizePageUrl(targetUrl).hash ∪ CONSOLIDATE from-url'leri` ile GscPage kimliğine; asla tarayıcı hash'i `targetUrlHash` ile değil) ve tarayıcı kaydı pencerede kritik değişiklik gösterenler (`lastChangedAt` pencerede, `> firstSeenAt + 1 gün` ve önceki başlık, canonical, noindex ya da durum farklı; yalnız metin değişikliği dışlamaz). HEALTH_ISSUE eylemleri hiçbir zaman dışlamaya ya da çakışmaya girmez. Kontrol, ön haftaların en az yarısında gösterim ister; en çok 10, |ln oran|'a göre en yakın.
- Yöntem: ≥ 3 kontrol → DID. Aksi hâlde uygun bütün grup içi adaylar tek toplu kontrol (DID_SITE, DIRECTIONAL). Hiçbiri yoksa PRE_POST, DIRECTIONAL; ön ve son pencerenin bütün geçen yıl haftaları kapsanmışsa YoY düzeltmeli (`d_w = v(T,w) − v(T,w−52)`), değilse düz ve `yoyAdjusted: false`. YoY bağlamı (son pencere tıklaması / 52 hafta önceki) raporlanır, DID/DID_SITE'de asla karar vermez.
- Bootstrap: ön haftalar, son haftalar VE kontrol sayfaları yerine koyarak yeniden örneklenir (1.000 örnek, eylem kimliğiyle tohumlu, %90 yüzdelik aralığı). Geniş aralık INCONCLUSIVE'e yaslanır (muhafazakâr yön).
- Karar kuralları (neden önceliği NO_DATA > LOW_DATA > GOOGLE_UPDATE > OVERLAPPING_CHANGE): sonuç yok → INCONCLUSIVE NO_DATA; LOW_DATA (hedef ön gösterim < 100 ya da tıklama/CTR metriklerinde ön tıklama < 10) → INCONCLUSIVE LOW_DATA; aksi hâlde temel sonuç: alt sınır > 0 ve etki ≥ +%10 → WORKED, üst sınır < +%5 → DIDNT, değilse INCONCLUSIVE. Yalnız temel sonuç kesinse iki sınır uygulanır: `[anchorDay − 28 gün, son son-hafta sonu]` aralığıyla çakışan sıralama güncellemesi (`ACTION_UPDATE_KINDS`: CORE, SPAM, REVIEWS, HELPFUL_CONTENT, OTHER_RANKING) → INCONCLUSIVE GOOGLE_UPDATE; hedef sayfaya uygulanmış başka HEALTH_ISSUE-dışı eylem → INCONCLUSIVE OVERLAPPING_CHANGE. Çakışan güncellemeler her zaman `evaluation.updates`'te listelenir.
- SIGNIFICANT yalnız yöntem DID, sınır yok, kesin sonuç, veri kırpılmamış ve ön tıklama ≥ 30 (impressions metriğinde ön gösterim ≥ 500) iken.
- Lansman, uyarı (ALERT: hâlâ çözülmüş → WORKED, yeniden açık → DIDNT, satır yok → INCONCLUSIVE ALERT_GONE; her zaman DIRECTIONAL, öğrenme yok; CWV_FIX CrUX p75 önce/sonra ekler), CrUX ve site haritası değerlendiricileri ayrıdır. Eylem değerlendirilince bulgu EVALUATED olur.
- Beklenen INCONCLUSIVE payı yüksek olabilir (haftalık granülerlik, güncelleme çakışması); /health sayacı son 30 gün INCONCLUSIVE'i nedene göre gösterir, plan §1.4'teki "≥ %80 sonuca ulaşır" hedefi buradan okunur ve `ACTION_UPDATE_KINDS` ayarlanabilir.
- §6.4'ten kaydedilen sapmaların nedeni: W1 ambarı sayfa metriğini yalnız PT haftası olarak tutar ve §5 değerlendirmeye Google bütçesi vermez.

## Öğrenmeler

- GA-F4 emsali: `BrandLearning` (`sourceType` "SEO", `sourceRef` = eylem kimliği, idempotent) YALNIZ şu hepsi doğruysa yazılır: sonuç WORKED ve güven SIGNIFICANT; yöntem DID ve ≥ 3 kontrol; güncelleme çakışmamış; eylem mock değil; tür TITLE_META, CONTENT_REFRESH, INTERNAL_LINKS, SCHEMA, CONSOLIDATE ya da TECH_FIX; metrik `ctr_adj`, `clicks` ya da `impressions`; 30 gün içinde değerlendirilmiş. Polarite hep WORKS (DIDNT öğrenme yazmaz: AVOID metinleri yanıltır). `confidence` 0,8 (alt sınır ≥ 0,1) ya da 0,6.
- Metin sayısız, yolsuz, sorgusuz ve URL'siz şablondur: "On this site, rewriting a page's title and meta description to match what people search for raised click-through compared with similar pages." Sayılar yalnız `SeoAction.evaluation`'da durur. (Öğrenmeleri `context-builder` ve `strategy-service` de okuduğu için Google sayısı denetimsiz anlatıya ya da kalıcı BrandStrategy'ye ulaşmasın.)
- Okuyanlar: SEO Manager istemleri (araştırma, makale, snippet, refresh) ve SEO fikir istemi; en yeni 5 öğrenme, "PAST RESULTS on this site (prefer what worked):" satırıyla.
- Disconnect'te öğrenme kimliği ya da `sourceRef` ile (`sourceType`'tan bağımsız: memory-service onu yeniden yazabilir) silinir.

## SEO Manager

- Modlar ve adımlar: makale (Brief → Plan → Create → Review → Deliver), "Fix the snippet" (Brief → Plan'da en çok seçenekli başlık/meta önerileri, SERP önizlemesi → Deliver: kopyala, "I changed it") ve "Refresh a page" (araştırma + önce/sonra farkı → Deliver). Kart verisi `state.features {modes, live}` ile damgalanır; istemci kartın verisine bakar, bayrak öncesi ve bayrak kapalıyken oluşan kartlar baytı baytına aynı çizilir. Sunucu eylemleri bayrakları çağrı anında yeniden denetler.
- Fix this: bulgu kinine göre TITLE_META → snippet modunda yeni Work `seofix_<actionId>`, CONTENT_REFRESH → refresh modu, NEW_CONTENT / LOCALIZE → makale modu. Kart, sayfa görüntüsüyle (kendi tarayıcımızla bir kez okunan, kendi site verisi) ve `origin {findingId, ruleKey}` ile önceden doldurulur. Makale modunda Brief konusu BOŞ kalır; bulgunun anahtar kelimesi (maskeli bir GSC sorgusu) yalnız `SeoAction.proposal.primaryKeyword`'de durur ve durum ucunda "Suggested from Search Console" çipi olarak sunulur; kullanıcı tek dokunuşla benimser, o andan itibaren kullanıcı içeriğidir. Makale takvime alınınca AYNI eylem `creativeId` alır (`attachCreative`), asla ikinci eylem açılmaz. Work ve kart kimlikleri belirleyicidir (`seofix_<actionId>` / `seofixcard_<actionId>`): çift dokunuş aynı şeyi kullanır; kullanıcı Work'ü sildiyse aynı kimliklerle yeniden kurulur.
- INTERNAL_LINKS, CONSOLIDATE, TECH_FIX ve SCHEMA bulguları "Actions & results"ta kontrol listesi maddesidir ("Mark as done"). INVESTIGATE bulgusunda Fix this yoktur.
- "Write another" / "Refresh a page" / "Fix a snippet" aynı Work'te YENİ kart açar (`startSeoCardAction`); `startModuleFlowAction` Work'ün en yeni SEO kartını döner, arayüz kartları hep `commandId` ile adresler.
- Arka plan koşusu: `next/server` `after()` + veritabanı yoklamalı SSE (`/api/projects/[projectId]/seo/cards/[commandId]/live`, 1,5 sn yoklama, en çok ~6 dk; fazlar "Reading your page…" gibi, `lastError` durmuş koşuyu bildirir, EventSource kapanınca bırakılır; yedek: yoklama). Kayıtlı sapma: plan `driveJobInline` der, ama SEO Manager koşuları kuyruğa alınmış Job değil kart sahiplenmesidir; outbox olayı yoktur. `after()` dağıtım yeniden başlatmasında ölür; mevcut 5 dk'lık koşu TTL'i kartı açar ve SSE ucu bitişi bildirir. Yenileme yolu SSE `end` olayı + `router.refresh()`'tir, yanıttan sonra `revalidatePath` yoktur.
- Brief dili sert kuraldır: `ReasoningInput.language` (SUPPORTED_LANGUAGES ile doğrulanır, geçersiz kod yok sayılır) proje dili yönergesinin yerine geçer; marka kuralları `brandRuleLanguageOf` ile yine yüklenir ve istem hangi dilde yazıldıklarını söyler. Yerel yönerge önbelleği anahtarı `projectId|dil` olur.
- Kart durumu: takvim parçasının durumu + eylem durumu, bayrak kapalı sorgu yok (`/api/projects/[projectId]/seo/cards/[commandId]/status`, no-store). `Mark as published` isteğe bağlı Live URL alır. Eylem satırı silindiyse (Disconnect) Deliver: "These results were removed when Search Console was disconnected."
- `liveSlotCount` `SEO_ACTIONS` altında SEO modül akışı kartlarının Creative'lerini de sayar (takvimde parçası olan SEO sohbeti silinemez).
- Google verisi kartlarda: `plan.quickWins` ve `target.queryCount`; yeni kart alanları asla GSC sorgu metni taşımaz. Disconnect ve Delete stored data'da bayraksız `scrubSeoCardsSearchData` quick wins'i `{state:'not-connected'}`, `queryCount`'u 0 yapar (kullanıcının içeriği kalır).

## Arayüz

- `/projects/[id]/arama` "Actions & results" (`#actions`; `?action=<id>` satırı vurgular): "Needs you", "In progress", "Results" grupları; boşken "No changes tracked yet. Use “Fix this” on an opportunity to start." Gereken: `SEO_ACTIONS` + `SEO_HEALTH` + `SEO_CRAWL`, `GSC_SEARCH_PAGE`.
- "Opportunities" satırlarında "Fix this" (varsa "Open fix · <durum>"); `SEO_INSIGHTS=on` kartları gerekir. "Mark done" artık ölçümü başlatır.
- "Index & technical health" sorunlarında "I fixed this" (TECH_FIX / SCHEMA / CWV_FIX / SITEMAP_FIX türleri) ve izlenen sorunda durum çipi.
- SEO Manager kartı: mod seçici, hedef sayfa seçici, snippet adımı, refresh farkı, canlı fazlar, Deliver'da sonuç / soru ve "Next" satırı.
- /health "SEO actions" sayaçları (açık, doğrulama bekleyen, sorulan, ölçülen, değerlendirilen, INCONCLUSIVE nedenleri, 30 günde süresi dolan, öğrenmeler); `healthy`'ye sayılmaz.
- Search Console ambar kartında Delete stored data: "Measured results of SEO changes and what Agentelse learned from them are deleted too and don't come back." (yalnız `loop()` açıkken).

## LLM ve Limited Use

- Snippet ve refresh istemleri sayfanın ilk ≤ 10 sorgusunu (`maskGoogleText`, son 4 tam hafta için toplu gösterim/tıklama/konum; W3 `limitGoogleStrings(rows, r => [r.text], { limit: 10 })`) ve 1 maskeli yolu alır. Refresh araştırması quick wins satırı eklemez; her çağrı ≤ 11 Google dizgisi (sınır 20). Kullanıcının kendi sitesinin sayfa metni (≤ 6.000 karakter) Google verisi değildir.
- Google sayıları üzerine anlatı üretilmez: sonuç metinleri şablondur, öğrenmeler sayısızdır. Snippet istemi FACTS/approvedClaims dışındaki sayı ve iddiaları yasaklar.
- Telegram: hiçbir şey. Operatörler: yalnız sayaçlar.

## Silme

- Disconnect, "Delete stored data", W1 saklama (seçimi değişmiş, sahipsiz ve mock bağlar), bağı kalmayan satır temizliği, proje silme ve 36 aylık saklama: bağa ait `SeoAction` satırları (ölçüm sonuçları, inceleme kanıtı) ve türeyen SEO öğrenmeleri silinir; kartlardaki Google verisi temizlenir. Hiçbiri bayrağa bağlı değildir. Ev kuralı §4'ün "Disconnect yalnız Gsc* siler" cümlesini geçersiz kılar: eylem geçmişi gider, kartlar içeriğini korur. `linkId`'si null (yalnız tarayıcı) eylemler kalır.

## Testler

Birim ve entegrasyon: `src/lib/seo/actions/*.test.ts` (kinds, types, lifecycle, windows, did, verify-checks, drafts, copy, learning-prompt), `src/server/seo/actions/*.test.ts` ve `*.integration.test.ts` (store, page-check, verify, forget, retention, series, evaluate, learnings, operator-counters, panel, fix-this), `src/lib/module-flows/seo/*.test.ts`, `src/server/modules/seo/*.test.ts`, `src/server/actions/seo-*.test.ts`, `src/components/module-flows/seo/*.test.ts`, `src/components/search-actions/*.test.ts`, `src/app/api/projects/[projectId]/seo/cards/**/route.test.ts`. Kabul testleri: başlık fikstürü, DiD/bootstrap, güncelleme çakışması → INCONCLUSIVE, öğrenme kapısı, `liveSlotCount`, Fix this NEW_CONTENT → tek eylem.

## Ertelenenler

- Değerlendirmede GA köprüsü (`getLandingPageOutcomes` yok); sonuçların "Search & SEO" sohbetine kart olarak yazılması (SC-F5 haftalık rapor EVALUATED bulguları zaten listeler); eylemler için sohbet araçları; Today brief satırı ya da sorulan eylemler için sıradaki adım; SC-F5 yol haritası maddelerinde Fix this; CMS yazması (SC-F8; `appliedVia` 'CMS' ayrılmıştır); cihaz başına CTR eğrileri; günlük sayfa serisi; SEO öğrenmelerini strateji sentezinden çıkarma (metinler sayısız olduğundan gerekmedi); §6.5 aylık AI makale sınırı (SC-F7): "Write another" ve Fix this NEW_CONTENT toplu makaleyi kolaylaştırır, sınır SC-F7'ye bağlıdır.

## Doğrulanmalı

- Haftalık bootstrap aralığının genişliği ve gerçek KOBİ sitelerinde INCONCLUSIVE payı; ±%50 bandı; 0,85 başlık benzerliği; Google yeniden tarama süresi; kritik değişiklik dışlama kuralı (dinamik sayfalar; `SeoPage.previous` yalnız son taramanın durumunu tutar); CWV 35/70 zamanlaması; Railway yeniden başlatmalarında `after()` tamamlanması.
