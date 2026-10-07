# Modüller (New Chat yeniden kurgusu, P4–P7)

Onaylı plan: `~/.claude/plans/shiny-cuddling-rossum.md`. Social tarafının post modeli (1 fikir = 1 post, mecralar teslimat): `docs/works.md` "Posts".

## Ne değişti

New Chat artık dört **modüle** ayrılır; her biri aynı standart adımlarla ve aynı tasarım diliyle, tıklayarak sonuca gider:

| Modül                            | Anahtar     | Son adım | Nerede yaşar                                               |
| -------------------------------- | ----------- | -------- | ---------------------------------------------------------- |
| Social Media Planner             | `social`    | Publish  | Plan kartı + plan paneli + post kartları (`docs/works.md`) |
| Ads Manager (Meta; Google sonra) | `ads`       | Launch   | `module-flow` kartı                                        |
| Analytics                        | `analytics` | Share    | `module-flow` kartı                                        |
| SEO Manager                      | `seo`       | Publish  | `module-flow` kartı                                        |

Standart adımlar: **Brief → Plan → Create → Review → Deliver** (`src/lib/modules/flow.ts`, `FlowStepper`).

## Bayrak

`MODULES_UI=true` (yalnız tam bu değer) + `WORKS_UI=true` + `CHAT_ENGINE=agent`. Sunucu: `isModulesEnabled()` (`src/server/works/flag.ts`). Kapalıyken her ekran eskisi gibidir. Migration gerekmez: `Work.module` `20261004120000_add_post_and_work_module` içinde.

## Katalog ve Work

- `src/lib/modules/catalog.ts`: `MODULES[key]` (etiket, tek satır açıklama, son adım fiili, `ready`, kanallar). Bir modül `ready` olmadan başlatıcıda tıklanamaz ("Coming soon").
- `Work.module` (null = genel sohbet). `WorkRepository.createOrReuseBlank({ module })`, `setModule` (yalnız boş sohbette), `createWorkAction(…, module)`, `setWorkModuleAction`. `buildWorkHost` `module` ve `modulesUi` verir (bayrak kapalıyken modül hep null).
- Adresle açma: `/projects/<id>?module=<key>` (kenar çubuğundaki Modules grubu, "Boost with an ad" vb.). `NewWorkOpener` boş sohbeti o modülle açar; Ads/Analytics/SEO hazırsa akış kartını da hemen yazar (`startModuleFlowAction`), `?post=<creativeId>` kartın `data.hint.sourceCreativeId` ipucu olur. Düz New Chat boş bir modül sohbetini genel sohbete çevirir.

## New Chat ekranı

- **Başlatıcı** (`src/components/modules/module-launcher.tsx`): yazma kutusunun altında dört kutu (dar sohbette 2×2, geniş sohbette 4'lü; sohbet sütununa göre container query). Hazır modül "Start →"; hazır olmayan sessizce "Coming soon".
- Kutuya dokunmak (`use-module-choice.ts`) modülü `setWorkModuleAction` ile kaydeder ve **sohbetin içinde devam eder**: yazma kutusunun altında sihirbaz ya da panel açılmaz, modül başlarken "What is this plan for?" hedef seçici (`PlanBriefWizard`) hiç gösterilmez. **Social**: sohbete "Plan next week's posts from my idea pool." gönderilir; ajan haftayı fikir havuzundan planlar (`src/server/chat/idea-pool.ts`, `worksIdeaPoolNote`; plan parçaları `ideaId` ile havuz fikrine bağlı, `keepPoolIdeaIds`) ve plan kartı sohbette canlı akar. **Ads/Analytics/SEO**: akış kartı yazılır (`startModuleFlowAction`) ve sohbette o kartın Brief'iyle görünür.
- **Yazı yönlendirme** (`src/lib/modules/route-intent.ts`, saf, LLM yok): boş ve modülsüz bir sohbette yazılan istek açıkça bir modüle aitse (TR+EN anahtar kelimeler, kanal adları, "haftada 3", "story"...) mesaj gönderilmez; modülün başlangıcı Brief'i doldurulmuş olarak açılır. Soru biçimindeki ya da belirsiz yazı her zamanki gibi sohbete gider.
- Kenar çubuğu: New Chat'in altında **Modules** grubu (dar şeritte dört ikon); Recents satırında modül ikonu; Explore'daki eski "Ads Manager" sayfası "Ads account" adını aldı.

## Sohbet ajanı

Modüllü sohbette ajan yalnız o modülün araçlarını görür (`MODULE_TOOLS`, `src/server/chat/tools.ts`; okuma araçları hep kalır) ve bağlama modülün tek satırlık notu eklenir (`MODULE_NOTES`, `src/server/chat/prompt.ts`). Modülsüz sohbette liste ve istem birebir eskisi gibidir.

## Akış kartı (Ads / Analytics / SEO)

- Zarf: `src/lib/module-flows/card.ts` — `{ kind: "module-flow", module, title, step, data }`. Kart sohbette **yerinde değişir**: her adım aynı kartta ilerler; `data` modülün kendisinindir ve okunurken doğrulanır.
- Yazma: kartı yalnız `updateModuleFlowCard` (`src/server/modules/flow-card.ts`, atomik; tamamlanmış Work'te reddeder) değiştirir. Başlatma: `startModuleFlowAction` (`src/server/actions/module-flow-actions.ts`; aynı sohbette ikinci basış mevcut kartı döndürür, Work'ün adı modülün adı olur).
- Çizim: `src/components/module-flows/module-flow-card.tsx` → `<module>/<module>-flow.tsx`.
- Sohbette görünme: `page.tsx`'in Work sohbet sorgusu WEB satırlarını, `content-plan-draft` ve `module-flow` kartlı SYSTEM satırlarını listeler; başka SYSTEM satırı girmez. Kartı olan Work artık "dokunulmamış" yeni sohbet değildir: başlatıcı gizlenir, sohbet Recents'e girer.
- Tekrar yok: kartın yürüttüğü görevlerin bekleyen kararları (`src/server/modules/flow-tasks.ts`: Command'ı kart olan görevler + Meta zincir relay'lerinin parmak iziyle bulduğu ad set / ad) o sohbette kartın altında "Waiting for your decision" olarak tekrar gösterilmez; onay kartın içinde verilir.
- Google verisi: `findActiveGoogleConnections` artık `src/server/integrations/google-connections.ts`'te (ANALYTICS_ANALYSIS sağlayıcısı, Analytics ve SEO paylaşır).

## Ads Manager

Meta (Facebook + Instagram); Google Ads "Coming soon". Adımlar:

1. **Brief**: Meta Ads hesabının durumu (bağlı değil / reklam hesabı yok / Page yok: tek düğme "Connect Meta Ads"; Page şart, reklam kreatifi onsuz kurulamaz), görseli olan son 12 APPROVED/PUBLISHED post (post başına bir görsel), hedef (Traffic / Awareness / Engagement), günlük bütçe + süre (3/7/14/30 gün), ülke / yaş / cinsiyet, web linki, CTA. Kayıtta kaynak post (creativeId, assetId, başlık, caption), para birimi ve Page adı dondurulur.
2. **Plan**: tek ReasoningService çağrısı (`adsPlanDef`; marka sesi, never-rules, approved claims) kampanya / ad set / reklam adlarını ve ana metni (≤125 karakter, link ve hashtag'siz) yazar; her alan düzenlenir. Mock modda ya da AI çalışmazsa postun kendi sözleri.
3. **Create**: reklam önizlemesi postun kendi görseliyle (yeni görsel çizilmez).
4. **Review**: hedef, harcama ("20 TRY a day × 7 days = 140 TRY"), kitle, link, CTA. Her şey PAUSED kurulur, her halka onay ister.
5. **Launch**: kart atomik claim edilir (iki basış iki kampanya kurmaz), `META_CAMPAIGN_CREATE` görevi `commandId` = kartın Command'ı ile planlanır; zincir kampanya → ad set (`meta-campaign-chain-relay.ts`) → reklam (`meta-adset-chain-relay.ts`). Kart her halkayı okur (`src/server/modules/ads/chain.ts`), bekleyen halkada satır içi "Approve campaign / ad set / ad", çalışırken 5 sn'de bir yeniler (~3 dk). Bitince "Created paused in your Meta Ads account." + "Open Ads Manager"; hata ya da retten sonra "Edit and launch again".

- Hedefler (hepsi IMPRESSIONS faturalı): Traffic = `OUTCOME_TRAFFIC` + `LINK_CLICKS`, Awareness = `OUTCOME_AWARENESS` + `REACH`, Engagement = `OUTCOME_ENGAGEMENT` + `POST_ENGAGEMENT` (ad set `destination_type: ON_POST` gönderir).
- Bütçe yalnız ad set'tedir (Meta ikisini birden almaz); bütçesiz kampanyada `createMetaCampaign` `is_adset_budget_sharing_enabled=false` gönderir (Graph v24+ şartı, hata 100 / 4834011). Para birimi Meta'nın minor-unit ofsetiyle (JPY gibi ondalıksızlarda 1).
- `card.data`: `{ hint?: { sourceCreativeId }, brief?, plan?, launch?: { claimId, startedAt, campaignTaskId?, completedAt? } }` (`src/lib/module-flows/ads/state.ts`; her parça ayrı zod ile okunur, bozuk parça yok sayılır).
- Sunucu eylemleri (`src/server/actions/ads-flow-actions.ts`): `loadAdsBriefOptionsAction`, `saveAdsBriefAction`, `draftAdsPlanAction`, `saveAdsPlanAction`, `setAdsStepAction`, `launchAdsAction`, `loadAdsLaunchAction`, `relaunchAdsAction`.
- "Boost with an ad": plan panelindeki post'un "···" menüsü → `/projects/<id>?module=ads&post=<creativeId>` (Brief o postla açılır).
- Açık kalanlar: bitiş zamanı gönderilmiyor (süre yalnız toplam harcamayı hesaplar; reklam duraklatılana kadar döner); her halka worker'ı bekler (~10 sn); "Edit and launch again" yeni kampanya kurar, yarım kalan kampanya / ad set reklam hesabında PAUSED kalır; Meta'nın asgari günlük bütçesi ve Instagram yerleşimi kodda denetlenmiyor; ad set ve reklam görevlerinin Command'ı yok, reklamı kapsayan aktif sohbet yokken başka başlamış sohbetlerde karar olarak da görünürler; eski CampaignWizard + AdSetAdWizard yolu bütçeyi hem kampanyaya hem ad set'e koyar.

## Analytics

Adımlar: **Brief** (dönem: Last 7 / 28 / 90 days; kaynaklar: Instagram, Meta Ads, Google Analytics, Search Console, canlı bağlantı durumuyla; bağlı olmayan işaretlenemez, Connect / Reconnect bağlantısı) → **Plan** (kaynak başına bölüm anahtarı, "Build report") → **Create** (kaynaklar okunur, özet yazılır) → **Review** (özet + kaynak başına KPI kutuları, Meta sonuçları ve ilk 3 kampanya, Search Console ilk 5 arama; başarısız kaynak nedeniyle) → **Share** ("Copy summary", "Download Markdown", "Print / Save as PDF"; ilk paylaşım akışı bitirir).

- `card.data`: `{ period, sources, sections, build: { id, startedAt, from }, report, error, sharedAt }` (`src/lib/module-flows/analytics/state.ts`).
- Kaynaklar paralel ve birbirinden bağımsız okunur (`src/server/modules/analytics/collect.ts`); başarısız olan kodlu nedenle düşer (not_connected / setup / expired / permission / rate_limited / no_data / error), diğerleri sürer. Instagram en fazla 30 gün verir (90 günde "Last 30 days" notu), GA4 dünkü güne kadar tam gün, Search Console 2–3 gün gecikmeli.
- Özet: tek `ReasoningService.run` ("analytics.reportSummary"); isteme yalnız rapordaki sayılar gider. Rapordaki bir sayıya dayanmayan cümle atılır (yuvarlanmış, Türkçe biçimli ve K/M yazımları kabul).
- Sunucu eylemleri (`src/server/actions/analytics-flow-actions.ts`): `analyticsSourcesAction`, `saveAnalyticsBriefAction`, `openAnalyticsStepAction`, `buildAnalyticsReportAction` (kartı claim eder, ikinci basış reddedilir), `markAnalyticsSharedAction`.
- Açık kalanlar: rapor Outputs'a kaydedilmiyor (yalnız `card.data`; şema kararı bekliyor); derleme tek Server Action'da 10–60 sn sürer ve aynı sekmedeki diğer eylemleri bekletir (5 dk'dan eski derleme "durdu" sayılır, "Try again"); mock modda özet yok; Meta insights alanları, GA4 metrik adları ve Safari'de yazdırma canlı hesapta denenmedi.

## SEO Manager

Adımlar: **Brief** (konu, site: proje domain'i ya da Search Console mülkü, dil: marka dili, kitle) → **Plan** (web aramalı araştırma: ana anahtar kelime + niyet, 5–8 ikincil, 3 başlık, meta açıklama, 5–8 H2; Search Console "quick wins": son 28 gün, ortalama pozisyon 8–20) → **Create** (makale; marka sesi, never-rules, approved claims) → **Review** (arama önizlemesi, makale, 9 on-page denetimi, en fazla 5 "Rewrite") → **Publish** (başlık / meta / Markdown / HTML kopyala, "Add to calendar", "Mark as published").

- `card.data`: `{ brief, plan, article, delivery, run }` (`src/lib/module-flows/seo/state.ts`; parça parça zod + varsayılanlar).
- Her model çağrısı önce kartta claim yazar (`run`, 5 dk TTL): ikinci basış "Already working…" alır, yanıt yalnız claim hâlâ o koşununsa yazılır, hata olursa kart önceki adıma döner (brief ve plan düzenlemeleri kalır). Mock modda reddeder.
- Takvim: bir Post + bir APPROVED `seo.article` Creative (kanal seo, `planId` = kartın Command'ı) + CreativeVersion 1; kart başına idempotent, migration yok.
- Sunucu eylemleri (`src/server/actions/seo-flow-actions.ts`): `seoBriefDefaultsAction`, `researchSeoAction`, `writeSeoArticleAction`, `rewriteSeoArticleAction`, `goToSeoStepAction`, `scheduleSeoArticleAction`, `markSeoPublishedAction`.
- SC-F6 (`SEO_ACTIONS`, ayrıntı [search-actions.md](search-actions.md)): modlar **Refresh a page** ve **Fix the snippet** (`SEO_ACTIONS` + `SEO_HEALTH` + `SEO_CRAWL`); **Write another** aynı Work'te yeni kart açar; araştırma ve yazma `after()` ile arka planda koşar ve SSE ile canlı faz gösterir (aynı sekmedeki diğer eylemler beklemez); Brief dili kesin kuraldır (`ReasoningInput.language`, doğrulanır; marka kuralları `brandRuleLanguageOf` ile yine gider); Deliver'da takvim parçası ve eylem durumu (sonuç, soru, "Suggested from Search Console" konu önerisi); "Mark as published" isteğe bağlı Live URL alır. `liveSlotCount` `SEO_ACTIONS` altında SEO kartlarının Creative'lerini de sayar; `startModuleFlowAction` Work'ün EN YENİ SEO kartını döner; Disconnect'te `plan.quickWins` ve `target.queryCount` temizlenir.
- Açık kalanlar: CMS'e yazma (SC-F8); mock modda model eylemleri reddeder; `SEO_ACTIONS` kapalıyken eski davranış (Work başına tek kart, sekmeyi bekleten ~1 dk'lık eylemler, yalnız content-plan-draft sayan `liveSlotCount`) aynen sürer.
