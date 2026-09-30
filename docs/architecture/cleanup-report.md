# Temizlik raporu: ajans simülasyonundan Main Agent'a

Hedef mimari: **Agency Desk sohbeti → Main Agent → (Brand Core + Brand Memory + Current Context) → Skill + Tool → sonuç.** Çok adımlı işlerde araya bir **Work Session** girer. Ürün yetenekleri (Ideas, Signals, Insights, Goals, Calendar, Library, Ads, Connectors, Autopilot) korundu; UI, rota ve navigasyon değişmedi.

İlke: **skill yerine departman, tool yerine ajan, hafıza yerine tekrar keşif, Work Session yerine her mesajı kuyruğa atmak.**

Bu belge `feat/brand-workspace-v2` dalındaki 13 refactor commit'inin (F1a-F9) ve bu raporun (F10) kaydıdır. Hiçbir şey push edilmedi, deploy edilmedi, Railway env'ine dokunulmadı.

## Kapsam ve doğrulama

| Ölçü           | Başlangıç (F0 sonrası)                                  | Şimdi                                                     |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `tsc --noEmit` | temiz                                                   | temiz                                                     |
| ESLint         | 0 hata / 17 uyarı                                       | 0 hata / 17 uyarı (aynı uyarılar)                         |
| Vitest dosyası | 110 geçti / 4 atlandı                                   | 138 geçti / 4 atlandı                                     |
| Vitest testi   | 992 geçti / 23 atlandı                                  | 1595 geçti / 23 atlandı                                   |
| Değişiklik     |                                                         | 109 dosya, +15.289 / −1.716 satır (test ve doküman dahil) |
| `next build`   | bu makinede Turbopack panic'i veriyor (koddan bağımsız) | **CI'da doğrulanmalı**                                    |

Yeni davranışların korumaları mutasyonla sınandı (ilgili satırı kaldır, testlerin kırıldığını gör): orkestratör kapıları, skill kayıt defteri, dış içerik (taint) koruması, oturum döngüsü sınırları. Canlı OpenAI anahtarı ve paylaşımlı Neon veritabanı bu turda kullanılmadı; canlı doğrulama sizdedir (aşağıya bak).

## Yeni mimari

| Katman          | Nerede                                      | Not                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main Agent      | `src/server/chat/chat-agent.ts`             | Streaming, tool çağıran tek beyin. Legacy `ChatService`'ten ayrıldı.                                                                                                                                                                                     |
| Bağlam          | `chat/context.ts`, `brand-twin/`, `memory/` | **Brand Core** (ACTIVE constitution + dossier + görsel kimlik) her tur; **Brand Memory** yalnız alakalı olanlar; **Current Context** (tarih, bekleyen onaylar, son 3 görev sonucu, son mesajlar). Tüm geçmiş ve tüm tercihler artık her tur gönderilmez. |
| Skill'ler       | `chat/skills/registry.ts`                   | `research`, `strategy`, `creative`, `content`, `ads`, `seo`. Alt ajan yok; ajan `load_skill` ile talimatı yükler.                                                                                                                                        |
| Hafıza          | `memory/memory-service.ts`                  | `BrandLearning` üzerinde kaynaklı/güvenli hafıza (yeni tablo yok).                                                                                                                                                                                       |
| İlk tanışma     | `brand/quick-discovery.ts`                  | İlk sohbet turunda site + web araması + tek LLM çağrısı → constitution v1.                                                                                                                                                                               |
| Work Session    | `work-session/`, `chat/run-guard.ts`        | Migrationsız (`Command` satırı), kuyruksuz; aynı mesajda sınırlı çok adım.                                                                                                                                                                               |
| Derin araştırma | `agency/setup/`                             | Zorunlu kurulum yerine isteğe bağlı **Deep Brand Enrichment**.                                                                                                                                                                                           |
| Arka plan       | `agency/legacy-loop.ts`                     | Eski simülasyon `LEGACY_AGENCY_LOOP=on\|drain\|off` ile kademeli kapatılır.                                                                                                                                                                              |

## Çalışma zamanı bayrakları

| Env                           | Varsayılan | Etki                                                                                                                                                                                       |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHAT_ENGINE`                 | `legacy`   | `agent` yeni motoru açar. Quick Discovery, skill'ler, hafıza, Work Session yalnız `agent` motorunda çalışır.                                                                               |
| `LEGACY_AGENCY_LOOP`          | `on`       | `drain`: yeni legacy iş üreten 4 tick adımı kapanır. `off`: açık satırları bitiren 10 birim de kapanır. Sayım sorguları ve sıra `legacy-loop-rollout.md`'de.                               |
| `GUIDED_SETUP`                | `false`    | Butonlu kurulum sheet'inin ana anahtarı. Kapalıyken her yüzey yok, `/projects/new` dört adımlı sihirbaz, ajan istemleri ve Quick Discovery HEAD ile aynı. Ayrıntı: `docs/guided-setup.md`. |
| `GUIDED_SETUP_DISCOVERY`      | `false`    | Yalnızca sheet'in ücretli "Get ideas" adımı (`false` \| `true` \| çalışma alanı kimlikleri). B1 gelene kadar kapalı kalır.                                                                 |
| `GUIDED_SETUP_DISCOVERY_CAPS` | boş        | 5/10/20 (kullanıcı/çalışma alanı/genel, 24 s) tavanlarını yalnızca düşürür; çalıştırma sayısını sınırlar, doları değil.                                                                    |

**Bayrağa bağlı olmayan** (deploy edilince herkes için geçerli) değişiklikler: kurulum artık işin kapısı değil (yalnız `PAUSED`/`CLOSED` projeler iş başlatamaz), trigger işleyicileri birbirinden izole (bir işleyicinin hatası diğerlerini durdurmuyordu), `ResultMaterializer`'ın ek LLM çıkarımı yalnız araştırma capability'lerinde, constitution → Brand Brain aktarımı müşterinin onayladığı satırları silmiyor, `BrandTwin` her yerde ACTIVE constitution'ı okuyor, keşif aşamaları takılırsa zaman aşımına düşüyor, `BrowserProfile`'lar ilk ihtiyaçta tembel oluşuyor.

## KEPT (korundu)

| Ne                                                                                               | Neden                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ideas, Signals, Insights, Opportunities, Goals, Library, Calendar, Ads, Connectors, Autopilot    | Bağımsız kullanıcı değeri. `signal-processing`, `insight-synthesis`, `opportunity-evaluation` hafif arka plan zekâsı olarak çalışmaya devam eder. |
| Task → ExecutionJob → Outbox → provider'lar, `ApprovalPolicy` L3/L4                              | Çıktı tarafı. Yayın ve harcama onayı gerçek değer.                                                                                                |
| Telegram, Meta/GA tarayıcıları, `CreativePublishCompletion`, Meta zincir aktarıcıları, heartbeat | Adı legacy'ye benzese de gerçek özellikler; `LEGACY_AGENCY_LOOP` bunlara dokunmaz.                                                                |
| `ConstitutionService`, `BrandTwin`, `BrandLearning`, `Evidence`/`Finding`                        | Brand Core / Brand Memory / araştırma önbelleği olarak yeniden kullanıldı.                                                                        |
| `safeFetch` + `site-scan`                                                                        | SSRF-güvenli; Quick Discovery'nin temeli.                                                                                                         |
| `department-registry`, `agency-focus`                                                            | Capability sahipliği ve panellerin veri kaynağı; silinirse ~26 test dosyası kırılır. Skill'ler üstüne eklendi.                                    |
| Autopilot'un haftalık planlayıcısı                                                               | `SHORTLISTED` fikirlere bağlı; council-lite bu bağımlılığı karşılıyor.                                                                            |

## SIMPLIFIED (sadeleştirildi)

| Ne                    | Önce                                              | Şimdi                                                                         |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Proje kapısı          | 12 aşamalı kurulum bitene kadar iş başlatılamazdı | `Project.status` tek kapı; `ensureProjectActive` ilk mesajda projeyi aktifler |
| Ajan aşamaları        | `setupPhase` ile tool kısıtı                      | `ACTIVE` / `ON_HOLD`                                                          |
| Fikir → SHORTLISTED   | Council + Director (LLM)                          | **council-lite**: LLM'siz, `IDEA_TRANSITIONS` üzerinden `promoteToShortlist`  |
| Görev sonucu          | Sohbet yalnız "Task completed" görürdü            | Son 3 sonuç bağlamda, eskisi `get_task_result` ile                            |
| Metin görevleri       | Kuyruğa girer, worker tick'ini beklerdi           | `driveJobInline` ile aynı mesajda                                             |
| Marka tanıma          | Zorunlu Deep Discovery, sonsuza takılabilirdi     | Quick Discovery; Deep Discovery isteğe bağlı ve zaman aşımlı                  |
| Constitution aktarımı | Silip yeniden yazardı (onaylı satırlar giderdi)   | Merge-aware                                                                   |
| Tercihler             | Son 20 tercih + 40 öğrenme, alakasız da olsa      | Kaynak/güven taşıyan hafıza, alakaya göre, en çok 12 kalıcı + 8 ilgili        |
| Departmanlar          | Statik tablolar                                   | Skill kayıt defteri (talimat + tool + çıktı türü)                             |

## DECOUPLED (bağımsızlaştırıldı)

| Ne                                | Nasıl                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Main Agent ↔ legacy `ChatService` | `buildContext` ve sabitler ayrı modüle taşındı; `QuestionCard` ve composer kısayolu yanlış motora gitmiyor    |
| Sohbet ↔ kurulum                  | Kurulum kapı olmaktan çıktı, `SetupMode.ENRICHMENT` ile opt-in                                                |
| Ajans simülasyonu ↔ ürün          | 4 üretici + 10 tüketici tick birimi bayrak arkasında; gerçek özellikler dışarıda                              |
| Trigger işleyicileri              | Her biri izole (eski hata: öndeki işleyicinin patlaması `Creative → PUBLISHED` ve Meta aktarımını engellerdi) |
| Work Session ↔ kuyruk             | `Task`/`ExecutionJob`/`Outbox` kullanmaz                                                                      |
| Web araştırması ↔ çoklu LLM       | Tek `OpenAI hosted web_search` çağrısı ve `Evidence` önbelleği                                                |

## REMOVED (silindi, kanıtlı ölü)

Her biri için import grafı, docs, scripts, prisma ve `package.json` taranıp sıfır dış referans doğrulandı.

| Dosya                                                                                                                     | Neden ölüydü                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `server/agency/continuous/trigger-service.ts`                                                                             | `TriggerService`'i çağıran yok; canlı yol `AgencyTriggerRepository.enqueue`    |
| `server/repositories/pipeline.repository.ts`, `lib/pipeline/derive-stage.ts`, `lib/labels/pipeline.ts`                    | `PipelineRepository`, `derivePipelineStage`, `PIPELINE_STAGE*` kullanılmıyordu |
| `server/reasoning/prompts/measurement-analysis.ts` (`measurement.analyze`)                                                | Yalnız şema testinin listesinde kayıtlıydı                                     |
| `components/hub-core/data/hub-core.repository.ts`                                                                         | `getHubSummary` çağrılmıyordu                                                  |
| `server/actions/integration-actions.ts`                                                                                   | Üç server action'ı hiçbir forma bağlı değildi                                  |
| `hub-core/primitives/entity-badge-row.tsx`, `shared/detail-row.tsx`, `shared/marquee-text.tsx`, `shared/section-tabs.tsx` | Import yok                                                                     |
| `app/api/debug/headers/route.ts`                                                                                          | "Geçici, sonra kaldır" yorumu; production'da zaten 404                         |

Ayrıca: `start_brand_setup` tool'u (yerine `start_deep_enrichment`), sabit `MAX_ROUNDS` (yerine `run-guard.ts`); Settings → Autonomy'deki **"Idea Generation Frequency"** kartı, `updateIdeaGenerationScheduleAction` ve scheduler'ın `GENERATE_IDEAS` dalı. Fikir üretimi yalnızca sohbetten istenince çalışır; takvim/plan akışı (`content-plan`) fikir havuzunu hiç kullanmıyor. Önceden bu kartı açmış bir proje varsa satırı ilk vadesinde kapatılır (`lastError`'da "Retired" yazar), görev olarak planlanmaz. `Capability.GENERATE_IDEAS` enum değeri migration gerektireceği için durur.

**Rotalar:** yalnızca `/api/debug/headers` kalktı; sayfa rotaları ve navigasyon aynı. **Prompt'lar:** `measurement.analyze` silindi, `brand.quickDiscovery` eklendi, ajan talimatı genişledi (skill'ler, hafıza, Work Session). **Worker / cron:** hiçbiri silinmedi; GitHub cron'u ve `/api/cron/worker` aynı. **DB:** hiçbir tablo, sütun ya da enum düşürülmedi; bu refactor **yeni migration eklemedi** (F0'daki iki eklemeli migration önceden yazılmış işti).

## DEPRECATED (kullanım dışı işaretlendi, silinmedi)

| Ne                                                                                                                                                         | Ne zaman gidebilir                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Legacy `ChatService`, `chat-turn`, `submitChatMessageAction`                                                                                               | `CHAT_ENGINE=agent` canlıda doğrulandıktan sonra (geri dönüş için bir sürüm kalıyor) |
| Council / Director motorları, `WorkPlanBuilder`/`Progressor`, `WorkHandoffEngine`, `MeasurementEngine`, `LearningEngine`, `StrategyEngine.resynthesizeDue` | `LEGACY_AGENCY_LOOP=off` ve tablo sayımları sıfır olduktan sonra                     |
| `ProjectDepartment.mode`                                                                                                                                   | Etkisiz ayar (yalnız `WorkHandoffEngine.accept` okuyor)                              |
| `Skill`, `ProjectSkill`, `SocialAccount`, `CompetitorSource` modelleri; `ExecutionJob.skillId`                                                             | `db-deprecation.md`'deki sırayla, sizin kararınızla                                  |
| `Account`, `Session`, `VerificationToken`                                                                                                                  | Kalmalı (NextAuth `PrismaAdapter` sözleşmesi); ayrıntı `db-deprecation.md`'de        |

## NEEDS LATER UI DECISION (arayüz kararı gerekiyor, dokunulmadı)

- **Work** ve **Departments** panelleri: eski döngü beslemeyi bırakınca bayatlar; tabloları durur, paneller açılır ama yeni içerik gelmez.
- **Settings → Decisions / Measurements** panelleri ve başlık açılır penceresindeki fikir/sinyal sayaçları (0'da kalabilir).
- **Brand Brain strateji sekmesi**: v1'den sonra yenilenmez.
- Work Session için **kart ve iptal düğmesi**: şimdilik ilerleme ajanın anlatımı ve canlı tool göstergeleriyle görünür.
- `tool-fallback`, `tool-group`, `reasoning` bileşenleri (`thread.tsx` import ediyor).
- Eski Türkçe yönlendirme sayfaları (aşağıdaki bulgu).

## Bilinen bulgular (rapor edildi, bu turda düzeltilmedi)

1. **Eski Türkçe yönlendirme sayfaları** (`departmanlar`, `fikirler`, `isler`, `ayarlar`, `zeka`…) hub'ın İngilizce `PANEL_KEYS` / `SUB_KEYS` değerlerini tanımayan anahtarlarla yönlendiriyor (ör. `zeka` → `panel=sinyaller`, `isler` → `sub=planlar`; hub `signals`, `plans` bekliyor). Uygulama içinde bu yollara bağlantı yok; yalnız eski yer imleri etkilenir.
2. **`/api/webhooks/product-offers`** kendi token doğrulamasına sahip ama `public-paths`'te olmadığı için dışarıdan gelen çağrı proxy'de 307 ile `/login`'e gidiyor; yani dışarıdan çalışmıyor. Bir güvenlik kararıdır: açmak mı, kaldırmak mı, sizde.
3. **Kurulumda bir aşamanın reddi de aşamayı tamamlıyor**: `ProjectSetupOrchestrator.submitClientDecision` `approve: false` iken hedefleri onaylamıyor ama yine `completeStage` çağırıyor. Davranışa dokunulmadı.
4. **`ExecutionVerification`** `ExecutionJob.rawResult`'ı kopyalıyor (doğrulama totoloji).
5. **Üreticisi olmayan tablo**: `WorkHandoff`'u yaratan `WorkHandoffEngine.propose`'un hiçbir çağıranı yok; `AgencyCycle.listRecentForProject` çağrılmıyor. Ayrıntı `db-deprecation.md`'de.
6. **Kullanılmayan bağımlılıklar** (`src/` ve config'te sıfır referans): `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `@tanstack/react-query`, `@tanstack/react-query-devtools`, `recharts`. Kilit dosyasını tutarsız bırakmamak için çıkarılmadı: kendi makinenizde `npm uninstall @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities @tanstack/react-query @tanstack/react-query-devtools recharts`.
7. F0 checkpoint commit'leri, daha önce commit'lenmemiş işi mantıksal gruplara böldü; tek tek derlenmeleri garanti değil (ör. bir grubun içe aktardığı dosya sonraki grupta olabilir). Dalın ucu derleniyor: tsc, eslint ve testler temiz.

## Sizin yapacaklarınız (sıralı)

1. Dalı push edin (kararınız) ve CI'ın yeşil olmasını bekleyin: tsc, lint, vitest, `next build`, `prisma migrate deploy`. `npm run build` bu makinede çalışmadığı için `next build` doğrulaması yalnız CI'dadır.
2. Deploy'da iki **eklemeli** migration uygulanır: `20260930000000_add_creative_plan_fields`, `20260930100000_add_brand_layout_templates`. Yıkıcı bir şey içermez.
3. Railway'de `CHAT_ENGINE=agent`. Deneyin: yeni proje → ilk mesaj (Quick Discovery göstergesi) → bir görsel ya da plan → bir tercih söyleyin ("neon renk kullanma") ve sonraki mesajda uyulduğuna bakın → üç adımlı bir istek ("rakipleri araştır, üç konsept yaz, birini görselleştir") ve Work Session'ın aynı mesajda ilerlemesi.
4. Memnunsanız `LEGACY_AGENCY_LOOP=drain`; `legacy-loop-rollout.md`'deki sayım SQL'lerini çalıştırın; açık satır kalmayınca `off`. Yanlış giderse env'i `on`'a çevirmek yeter (kod geri alma gerekmez).
5. `CHAT_ENGINE=agent` bir süre sorunsuzsa legacy sohbet kodunun silinmesi için haber verin (F8'in bilerek bırakılan kısmı).
6. `npm uninstall …` (yukarıdaki bulgu 6) ve, isterseniz, `db-deprecation.md`'deki düşürme sırası.
7. Gerekiyorsa: Work Session için arayüz kartı, ürün webhook'u kararı, eski yönlendirme sayfalarının onarımı ya da kaldırılması.
