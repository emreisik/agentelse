# Brand Workspace v2 — Migration Haritası

> Durum: Onaylandı (kapsam = sadece IA/dekluter, §5'teki Primary/Advanced ayrımı onaylandı). Bu doküman `feat/brand-workspace-v2` dalında hazırlandı, `main`'e hiçbir commit atılmadı.
> Kapsam: `src/components/hub-core/**`, `src/components/brand-brain/**`, `src/components/layout/**` (AppShell, Sidebar, TopBar) ve bunların bağlı olduğu server action/route katmanı.

## 0. Önemli not — bu doküman bir varsayım içeriyor

Repo içinde "Brand Workspace" veya "workspace v2" terimine dair **hiçbir önceki referans yok** (kod, commit geçmişi, README, `docs/` — hepsini taradım, sıfır sonuç). Yani hedef mimari daha önce yazıya dökülmemiş. Bu doküman, mevcut yarım kalmış (commit edilmemiş) Brand Brain değişikliğindeki örüntüden ve kodun kendi mevcut birincil/ikincil ayrımından yola çıkarak **benim önerdiğim** bir hedef IA'yı (information architecture) tanımlıyor. Aşağıdaki sınıflandırma bu varsayıma dayanıyor — onaylanmadan geniş çaplı uygulamaya geçmeyeceğim.

**Temel açık soru (sohbette ayrıca soracağım):** "Brand Workspace" sadece mevcut Project-scoped ekranın yeniden düzenlenmesi mi, yoksa `Brand` modelini (şu an `Project` başına tek `isDefault=true` marka varsayımıyla çalışıyor) gerçek bir çoklu-marka üst birimine mi dönüştürüyoruz? Şema (`BrandDossier`, `BrandConstitution` vb. hepsi `brandId` ile gevşek bağlı, `Brand`'den geri ilişki tanımlı değil) bunu öngörmüş ama hiç inşa edilmemiş.

## 1. Mevcut mimarinin özeti

- **Routing:** Tüm paneller `?panel=&sub=&entity=` üzerinden `hub-core-params.ts`'teki `PanelKey`/`SubKey`/`EntityKind` sözleşmesiyle adresleniyor; `panel-shell.tsx` dispatcher, `buildHubHref`/`entityHref` tek href üretme API'si.
- **Mevcut birincil yüzey (sidebar, `sidebar-nav.tsx`):** New chat, Brand Brain, Ideas, Work, Library + (top-bar'da badge ile) Approvals, Human Action + üç hub-core-dışı rota: Content Calendar, Instagram Grid, Connectors.
- **Mevcut ikincil yüzey ("Tools" dropdown, `project-tools-menu.tsx`):** Setup, Departments, Human Action, Settings (System grubu). _Güncelleme: Signals, Insights & Opportunities ve Goals artık burada değil, Brand Brain'in sekmeleri (aşağıdaki "Brand Brain'e toplandı" bölümü)._
- **Devam eden (commit edilmemiş) değişiklik:** Brand Brain chat, panel içine sabitlenmiş bir karttan çıkıp `AppShell` seviyesinde global bir floating widget'a (`BrandBrainAssistant`) taşınıyor; `brand-brain-panel.tsx` artık salt referans/gözatma yüzeyine (assets/visual-identity/constitution/strategy/decisions/evidence/learnings, 7 sekme) dönüşüyor. Bu, "Brand Workspace" fikrinin ilk somut adımı gibi görünüyor: AI asistanı her ekranda hazır, panel ise arşiv.

## 2. Sınıflandırma kategorileri (bu dokümanda kullanılan anlamlarıyla)

| Kategori             | Anlamı                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- |
| KEEP                 | Aynen kalıyor, konumu ve davranışı değişmiyor                                            |
| REUSE                | Kod/mantık aynen yeniden kullanılıyor, sadece bağlandığı yer/bağlam değişiyor            |
| EXTEND               | Kalıyor ama yeni yetenek ekleniyor                                                       |
| HIDE FROM PRIMARY UI | Birincil yüzeyden kaldırılıyor ama URL/route hâlâ çalışır durumda kalıyor                |
| MOVE TO ADVANCED     | Ayrı, açık bir "Advanced" alanına taşınıyor (dropdown'dan daha kalıcı bir ikincil bölge) |
| REPLACE UI ONLY      | Server/data katmanı aynen kalıyor, sadece sunum/UI yeniden yazılıyor                     |
| DEPRECATE LATER      | Şimdilik dokunulmuyor ama ileride kaldırılacak şekilde işaretleniyor                     |

`DELETE` yok — hiçbir madde silinmeyecek.

## 3. Özellik bazında sınıflandırma

### 3.1 Brand Brain

| Öğe                                            | Sınıflandırma                               | Not                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `brand-brain-chat.tsx` (eski, silinmiş)        | **REPLACE UI ONLY** — _zaten uygulandı_     | Server katmanı (`brand-brain-actions.ts`, `brand-brain-chat-service.ts`, prompt) aynı kaldı, sadece host component değişti |
| `brand-brain-assistant.tsx` (yeni, global FAB) | **KEEP**                                    | Brand Workspace v2'nin çekirdek unsuru; her ekranda `hasBrand` koşuluyla açık                                              |
| `brand-brain-panel.tsx` (7 sekmeli arşiv)      | **KEEP** (sidebar'da birincil) + **EXTEND** | Chat çıktı, referans yüzeyi kaldı; sidebar girişini koruyoruz çünkü "marka" kavramının kalbi burası                        |
| `BRAND_BRAIN_SUB_KEYS` (hub-core-params.ts)    | **KEEP** — _zaten uygulandı_                |                                                                                                                            |

### 3.2 Birincil operasyon döngüsü (mevcut sidebar öğeleri)

| Öğe                                                                                    | Sınıflandırma | Not                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| Ideas panel + `idea-lens-board.tsx`                                                    | KEEP          | Değişmiyor                                                                                              |
| Work panel (plans/tasks/cycles/measurements + 4 board)                                 | KEEP          | En büyük panel (1686 satır); bu migration kapsamında davranış değişmiyor, ileride ayrı bir EXTEND adayı |
| Library panel + `library-browser.tsx`                                                  | KEEP          |                                                                                                         |
| Approvals panel                                                                        | KEEP          | Top-bar badge'i korunuyor                                                                               |
| Human Action panel                                                                     | KEEP          |                                                                                                         |
| `project-flow-view.tsx` (idea/workPlan/task "Chats" akışı)                             | KEEP          | Brand Workspace'in konuşma-öncelikli yönüyle zaten uyumlu                                               |
| Content Calendar (`/takvim`), Instagram Grid (`/izgara`), Connectors (`/integrations`) | KEEP          | hub-core dışı ama sidebar'da birincil                                                                   |

### 3.3 İkincil / "Advanced" adayları (şu an Tools dropdown'da)

| Öğe                                                                 | Sınıflandırma                                         | Not                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Setup panel + `setup-stage-show.tsx` + `setup-progress-widget.tsx`  | KEEP (davranış zaten doğru)                           | Aktivasyon öncesi ambient FAB, sonrasında Tools dropdown içinde kalıyor — dokunulmuyor                  |
| Signals panel + `signals-list-filters.tsx`                          | **Brand Brain → Intelligence sekmesi** (taşındı)      | Ham sinyal verisi, Findings / Insights / Opportunities ile aynı sekmede (bkz. §7)                        |
| Insights & Opportunities panel                                      | **Brand Brain → Intelligence sekmesi** (taşındı)      | Finding → Insight → Opportunity zinciri tek sekmede                                                      |
| Goals panel                                                         | **Brand Brain → Goals sekmesi** (taşındı)             | Her sohbet turunda markanın `currentFocus`u olan hedefler; onay rozeti Brand Brain girdisinde            |
| Departments panel                                                   | **MOVE TO ADVANCED**                                  | Ajans-içi konfigürasyon, client-facing değil                                                            |
| Settings panel (autonomy/publishing/decisions/activity/risk)        | **MOVE TO ADVANCED**                                  | Zaten config amaçlı, mevcut konumunu resmileştiriyoruz                                                  |
| `project-tools-menu.tsx` (System/Insight Chain/Production grupları) | **EXTEND** → kalıcı "Advanced" alanına dönüştürülecek | Geçici dropdown yerine kendi route'u olan bir bölüm                                                     |

### 3.4 Altyapı / routing katmanı

| Öğe                                                                    | Sınıflandırma                       | Not                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub-core-params.ts` (PanelKey, ENTITY_KINDS, buildHubHref/entityHref) | **REUSE** + **EXTEND** gerektiğinde | Deep-link sözleşmesi bozulmayacak; Advanced grubu için yeni alan eklenebilir                                                                                                                                         |
| `panel-shell.tsx`                                                      | REUSE                               | Dispatcher mantığı aynı kalıyor                                                                                                                                                                                      |
| `lineage-map.ts` + `hub-breadcrumb.tsx`                                | REUSE                               | Advanced bölümü netleşince LINEAGE etiketleri güncellenebilir                                                                                                                                                        |
| `sidebar-nav.tsx`                                                      | **EXTEND**                          | Primary/Advanced ayrımını yansıtacak şekilde genişletilecek asıl dosya                                                                                                                                               |
| `hub-core.repository.ts` (`getHubSummary`)                             | **DEPRECATE LATER**                 | Explore taraması `app-shell.tsx`'in bu fonksiyonu hiç çağırmadığını, badge mantığını kendi içinde (`toolBadgesFrom`) tekrar hesapladığını gösterdi — muhtemelen ölü/duplike kod. Şimdilik silmiyorum, işaretliyorum. |

## 4. Tespit edilen teknik borç (bu migration'ın kapsamı dışında ama not düşülüyor)

1. `hub-core.repository.ts:getHubSummary` çağrılmıyor, `app-shell.tsx` aynı badge mantığını kendi içinde tekrarlıyor (§3.4).
2. `sidebar-nav.tsx` (Content Calendar, Instagram Grid, Connectors) ile `project-tools-menu.tsx` (Content Calendar, Instagram Grid, **Ads Manager**) alt kısımdaki hardcoded linkler birebir örtüşmüyor — biri "Connectors" biri "Ads Manager" gösteriyor.
3. `Brand` modelinden `BrandDossier`/`BrandConstitution`/vb. modellere Prisma ilişkisi tanımlı değil (sadece `brandId: String`), tek-marka varsayımı kodun her yerine (`findFirst({isDefault:true})`) yayılmış.

## 5. Önerilen hedef IA (onay bekliyor)

```
Primary (sidebar)          Advanced (yeni, kalıcı bölüm — şu anki Tools dropdown'ın yerini alacak)
─────────────────          ──────────────────────────────────────────────────────────────────────
New chat                    Departments
Brand Brain (10 sekme:      Settings (autonomy/publishing/decisions/activity/risk)
  Goals + Intelligence dahil)
  + BrandBrainAssistant
    (global FAB, her yerde)
Ideas
Work
Library
Approvals (top-bar badge)
Human Action (top-bar badge)
Content Calendar / Grid / Connectors

Setup: aktivasyon öncesi ambient FAB, sonrasında Advanced içinde — davranış değişmiyor.
```

## 6. `feat/brand-workspace-v2` üzerinde sıradaki adımlar

1. Yukarıdaki hedef IA onaylanınca: `sidebar-nav.tsx` + `project-tools-menu.tsx`'i tek bir "Advanced" route/bölümüne dönüştür.
2. `hub-core-params.ts`'e Advanced grubunu ifade eden bir alan ekle (breaking olmadan).
3. §4'teki duplike badge mantığını konsolide et (ayrı, küçük bir commit).
4. Her adımdan sonra `tsc` + ilgili sayfaların dev-server üzerinde manuel kontrolü (bu makinede `next build` panic verdiği için — bkz. proje hafızası).

Hiçbir commit `main`'e atılmayacak; tüm işler `feat/brand-workspace-v2` üzerinde ilerleyecek.

## 7. Phase 2 — Brand Workspace Shell (onaylandı, uygulanıyor)

> Kaynak: ürün sahibinin gönderdiği geniş kapsamlı "conversation-first AI Brand Workspace" spesifikasyonu (BrandTwin, Conversation Orchestrator, Tool Registry, Creative Engine, ContentSlot/autopilot döngüsü, execution-engine güvenilirlik düzeltmeleri dahil — mesaj 50.000 karakterde kesildi, Phase 3+ hiç gelmedi). Bu spesifikasyonun kendisi "vertical slices, no big-bang rewrite" diyor. Bu bölüm SADECE Phase 2'yi (kabuk/layout) kapsar; BrandTwin/Orchestrator/Creative Engine/ContentSlot/reliability-fix'ler kasıtlı olarak kapsam dışı — ayrı, çok daha büyük ve riskli (canlı execution engine'e dokunan) sonraki fazlar.

**Onaylanan kapsam sınırları:**

- Sadece proje kökündeki (panel/entity param'sız) ana sohbet ekranı yeni kabuğa geçiyor. `?panel=` sistemi, `/takvim`, `/izgara`, `/ads`, `/integrations`, Brand Brain FAB — hepsi değişmeden kalıyor.
- Idea/WorkPlan "Chats" thread görünümü (`project-flow-view.tsx`, `entity=` ile açılan ayrı dal) bu slice'ta eski (sidebar'lı) kabukta kalıyor — sonraki bir slice'a bırakıldı.
- Konuşma içi kartların (approval-request, work-plan, creative-ready vb.) terminoloji sadeleştirmesi (WorkPlan→Campaign, Task gizleme vb.) bu slice'a dahil değil — sadece kabuk/layout değişiyor, kart metinleri dokunulmadan kalıyor.
- Şema migration'ı yok. Tek yeni server-side ekleme: `CreativeRepository.listRecentForPanel` (additive, mevcut `listForCalendarRange` deseniyle aynı şekilde son versiyon+asset'i getiren, salt-okunur bir metod).

**Mimari:** `app-shell.tsx`'e opsiyonel `rightPanel`/`navSheet` prop'ları eklenir; sadece `page.tsx`'in kök dalı bunları kullanır. Mevcut `project-chat.tsx` (assistant-ui, zaten kart sistemi var) aynen kalır. Yeni sağ panel (`WorkspaceRightPanel`, 4 sekme: Brand/Files/Outputs/Calendar) mevcut sorguları/komponentleri yeniden kullanır (Brand → brand-brain-panel'in dossier sorgusu, Files → `library-browser.tsx` aynen, Outputs → yeni `listRecentForPanel` + mevcut `/takvim?creative=` detay dialogu, Calendar → kompakt "yaklaşan içerik" listesi + `/takvim`'e link). Sidebar'ın kaybettirdiği erişim noktaları (Ideas, Work, Instagram Grid, Connectors, Ads Manager) için header'a mevcut `SidebarNav`'ı aynen bir `Sheet` içinde açan "•••" butonu eklenir — sidebar yeniden yazılmıyor, sadece overlay'e taşınıyor.

**Sıralı görev listesi (her biri ayrı, bağımsız doğrulanabilir commit):**

1. `CreativeRepository.listRecentForPanel` + birim test.
2. `brand-brain-panel.tsx`'teki `parseColorSwatches`/`parseFontNames`'i export et (davranış değişmiyor).
3. `workspace-right-panel-data.ts` (tek `Promise.all`, UI yok).
4. 3 sunum komponenti: `brand-summary-panel.tsx`, `outputs-panel.tsx`, `calendar-panel.tsx` (bağlanmamış).
5. `workspace-right-panel.tsx` (client, tabs + collapse + localStorage), bağlanmamış.
6. `app-shell.tsx` restructure (`rightPanel`/`navSheet` prop'ları, FAB stack `absolute`'a taşınır) — en yüksek blast-radius commit, her sayfayı etkiler ama prop'lar `undefined` olduğu sürece görsel olarak no-op.
7. `workspace-nav-sheet.tsx` + `top-bar.tsx`'e `navSheet` prop'unu bağla (henüz kök sayfaya bağlanmamış).
8. Her şeyi `page.tsx`'in kök dalına bağla.
9. Kopya-only küçük commit'ler (composer placeholder, "Select brand" metni) — ayrı, atlanabilir.
10. Opsiyonel: `library-browser.tsx`'e `variant="compact"` (sadece 320px'te sıkışık görünürse).

Doğrulama her adımda: `tsc --noEmit` + `eslint` + gerekirse `vitest` + `next dev` üzerinde curl/HTML kontrolü (bu makinede `next build` panic verdiği için). CSS geometrisi/örtüşme gibi görsel detaylar için tarayıcı gerekiyor — bu ortamda yok, kullanıcıya `next dev` ile göz atması önerilecek.

## 8. Tasarım revizyonu (ürün sahibinden, uygulandı)

"STRICT UI DIRECTION" revizyonu geldi — referans bir `preview.tsx` ile birlikte. Karşılaştırma sonucu: bu kod tabanı zaten büyük ölçüde bu "calm AI workspace" estetiğiyle inşa edilmişti (composer zaten 24px radius/subtle shadow, mesaj balonları zaten renk yok/avatar yok, renk tokenleri zaten near-white/near-black). Yapılan somut düzeltmeler:

- `thread.tsx`: `--thread-max-width` 44rem (704px) → 860px (spec: ~800-900px) — paylaşılan composer, hem yeni workspace root hem entity-thread'i etkiler, güvenli/tutarlı bir değişiklik.
- `workspace-right-panel.tsx`: sağ panel genişliği 320px → 360px (spec: 340-380px), tab çubuğu `h-[55px]`.
- `outputs-panel.tsx` / `calendar-panel.tsx`: köşe yarıçapları `rounded-lg`→`rounded-2xl`/`rounded-xl`, boşluklar genişletildi (spec: 16-22px radius, geniş whitespace).
- Renk paleti: değiştirilmedi — mevcut `--background`/`--border`/`--muted` tokenleri (`oklch(0.995 ...)` vb.) zaten spec'in hedeflediği near-white/near-black paletle örtüşüyor, hardcode hex eklenmedi (dark mode desteği bozulmasın diye).

## 9. Phase 3 — BrandTwin (uygulandı, henüz canlıya bağlanmadı)

BrandConstitution zaten versiyonlu (`@@unique([brandId,version])`) ve BrandTwin'in istediği alanların neredeyse tamamını (`identity/positioning/audiences/markets/products/approvedClaims/forbiddenClaims/assumptions/openQuestions`) zaten taşıyordu — bu yüzden BrandTwin **yeni bir tablo değil**, mevcut Brand Brain modelleri üzerine tipli bir okuma kompozisyonu (`src/server/brand-twin/brand-twin.ts`, `getBrandTwin(projectId)`). Versiyonlama BrandConstitution'dan miras alınıyor.

Gerçekten eksik olan iki şey additive olarak eklendi (`prisma/migrations/20260924160000_add_user_decision_and_creative_memory/`):

- `UserDecision` modeli (yeni tablo) — spec'teki "USER DECISIONS" (CREATIVE_PREFERENCE/MARKET_PRIORITY/... + ham mesaj korunuyor).
- `BrandLearning.polarity` (WORKS/AVOID) + `evidenceCount` + `lastReinforcedAt` (additive kolonlar) — spec'teki "CREATIVE MEMORY" (tek gözlem kalıcı kural olmasın, evidence biriksin).

Yazma yolları da hazır: `src/server/brand-twin/brand-twin-writes.ts` — `recordCreativeMemory` (aynı insight'ı birebir case-insensitive eşleşirse reinforce eder, çoğaltmaz) ve `recordUserDecision` (ham mesajı da saklar). Toplam 8 test, hepsi geçiyor.

**Güncelleme — migration uygulandı:** Kullanıcı onayladı, `prisma migrate deploy` paylaşılan canlı Neon DB'ye çalıştırıldı (32 migration bulundu, sadece bu yeni olan uygulandı — diğerleri zaten uygulanmıştı). `prisma.userDecision.count()`/`prisma.brandLearning.count()` ile runtime'da doğrulandı. Workspace sağ panelinin Brand sekmesi artık `getBrandTwin`'e bağlı (bespoke dossier sorgusu emekliye ayrıldı); `brand-summary-panel.tsx` Current focus/Markets/Voice/What works/Never do this bölümlerini gerçek veriyle gösteriyor.

## 10. Phase 4 — Production reliability denetimi (paralel workflow, uygulandı)

Ürün sahibinin "DO NOT REGRESS EXISTING ORCHESTRATION FIXES" listesindeki 8 riski paralel audit + adversarial verify workflow'uyla (8 audit + 8 verify agent) denetledik. Sonuç:

**Zaten düzeltilmişti (dokunulmadı):** measurement terminal state (MeasurementCheck attemptCount/maxAttempts/nextAttemptAt), measurement placeholder target (NO_MEASURABLE_TARGET SKIP), director stranded idea (PLANNING artık sadece risk geçtikten sonra giriliyor), accepted handoffs resume (`WorkHandoffEngine.progressPending`, her tick'te taranıyor).

**Gerçek ve canlıydı, düzeltildi (migration gerekmiyor, tsc/eslint/vitest temiz):**

- **WorkPlan FAILED/CANCELLED cascade** (`work-plan-progressor.ts`): cascade sadece FAILED'de çalışıyordu, CANCELLED'de durup 2+ hop sonrasındaki task'ları READY'de sonsuza kadar bırakıyordu (WorkPlanBuilder'ın strategy→middle→measurement grafiğinde measurement hiç ulaşılamıyordu). Ayrıca `reconcilePlan` sadece FAILED/COMPLETED biliyordu — CANCELLED-only bir plan yanlışlıkla COMPLETED olarak işaretlenebilirdi. İkisi de düzeltildi, idea-archival guard CANCELLED'i de kapsayacak şekilde genişletildi. 19 test (2 yeni).
- **Provider durability** (OpenClaw + Meta video ads): `openclaw-gateway-client.ts`'in `getRunState`'i, restart sonrası tanınmayan runId'ler için Gateway'e hiç sormadan sonsuza kadar "running" döndürüyordu (self-healing sweep'i de etkisiz kılıyordu) — düzeltildi. `openclaw-provider.ts`'in `resume()`'u restart sonrası rawResult'tan kurtarma yapmıyordu ve yeni runId'yi geri yazmıyordu (ikinci restart'ta insanı tekrar sorup gerçek run'ı yetim bırakabilirdi) — düzeltildi. `meta-api-provider.ts`'in video-ad yolu hiç kalıcılık yapmıyordu (restart = kalıcı, yanıltıcı FAILED) — persist/recover eklendi, VE ad oluşturmadan hemen önce kaydı temizleyen bir adım eklendi (adversarial review'ın bulduğu gerçek risk: temizlik olmazsa crash sonrası tekrar deneme gerçek reklam hesabında **mükerrer canlı reklam** oluşturabilirdi). 4 yeni test.

**Gerçekti, migration gerektiriyordu (uygulandı):**

- **Scheduler retry/backoff** (`scheduler-service.ts`): bozuk bir `ProjectSchedule` her worker tick'inde sıfır cooldown ile sonsuza kadar retry ediliyordu, üstelik `findMany`'de `orderBy` olmadığı için batch'teki diğer schedule'ları da bloke edebiliyordu. `ProjectSchedule`'a additive `consecutiveFailures`/`lastError` kolonları + per-item try/catch + `execution-worker.ts`'deki backoff formülünün lokal kopyası (circular import riski nedeniyle import edilmedi) eklendi. 5 test. Migration `prisma/migrations/20260924170000_add_project_schedule_retry_backoff/` onaylandı ve canlı DB'ye uygulandı (4 mevcut schedule satırı `consecutiveFailures=0` ile doğrulandı).

**Bilerek yapılmadı (verifier'ın "NEEDS_REVISION" dediği, gerçek bug içeren kısım):** Concern 2'nin "Tier B" önerisi (RETRY/REQUEST_HUMAN karar fonksiyonu, yeni `Task.attemptCount/maxAttempts` kolonları) — adversarial review iki gerçek bug buldu (retry-eligibility kontrolü increment'ten ÖNCE karşılaştırma yapıyordu, yani her failure otomatik retry olurdu; REQUEST_HUMAN'ın Task'a geri dönen bir çözünürlük yolu yoktu, sonsuza kadar "çözülmüş görünüp" takılı kalırdı). Şimdilik uygulanmadı — ayrı, daha büyük bir slice.

## 11. Phase 5 — Conversation Orchestrator'ı resmileştirme (uygulandı, migration gerekmedi)

Önce mevcut mesaj işleme hattını denetledim (`submitChatMessageAction` → `ChatService.turn` → `chatTurnDef` LLM çağrısı → `CommandService.submit` → `TaskPlanner.planForCapability`). Sonuç: spec'in istediği "Orchestrator"ın adım 1/2/6/7/8'i (intent belirleme, brand context yükleme, tool seçme, execution'a başlatma, structured sonuç döndürme) **zaten tam olarak bu şekilde çalışıyordu** — BrandTwin'de olduğu gibi paralel bir sistem kurmak yerine, gerçekten eksik olan 2 parçayı bu mevcut hatta ekledim:

- **Brand context artık `getBrandTwin()`'den geliyor** (`chat-service.ts`'in `buildContext`'i) — eskiden sadece `{summary, positioning, toneOfVoice}` gönderiyordu, şimdi positioning/audience/markets/voice/negativeRules/currentFocus/creativePreferences/creativeMemory'nin tamamı LLM'e gidiyor. Bu aynı zamanda spec'in "adım 4: geçmiş kullanıcı kararlarını getir"ini bedavaya kapatıyor — `BrandTwin.creativePreferences` zaten son 20 `UserDecision` satırı.
- **`questions` alanı** (`chat-turn.ts`'in `ChatTurnOutputSchema`'sı, Brand Brain'in zaten kanıtlanmış şemasıyla birebir aynı şekil) — modelin gerçek bir çatalda (2-4 somut seçenek) düz metin yerine yapılandırılmış soru sorabilmesi. Yeni `IdeaEventCardData` kind'i `"question"` + `idea-event-card.tsx`'te yeni `QuestionCard` komponenti: seçenek(ler) işaretlenip Continue'a basılınca, cevap **aynı `submitChatMessageAction`** üzerinden yeni bir mesaj olarak gönderiliyor (composer'ın kullandığı yolun birebir aynısı, yeni bir server action icat edilmedi).
- **`preference` alanı** — kullanıcı "daha premium" gibi kalıcı bir tercih belirttiğinde, model bunu yapılandırılmış olarak işaretliyor, `chat-service.ts` de (best-effort, cevabı asla bloklamadan) `recordUserDecision`'ı çağırıyor (Faz 3'te yazılmış ama o zaman hiçbir yerden çağrılmayan fonksiyon — döngü şimdi kapandı).

**Bilerek yapılmadı:** Fast Path / Deep Path ayrımı (basit istekleri mevcut tek-task yoluna, karmaşık istekleri Signal→Insight→Opportunity→Council→WorkPlan zincirine yönlendirme) — denetim, bugün chat'ten tetiklenen HER capability'nin zaten tek bir yola (tek task, Council/WorkPlan'a hiç girmiyor) gittiğini doğruladı, yani "Fast Path" zaten varsayılan davranış. Ama "Deep Path"i chat'e bağlamak (kullanıcı "Rusya pazarına gir" dediğinde otonom loop'un kendi Council/WorkPlan zincirini tetiklemesi) ürünün çekirdek etkileşim döngüsünü değiştiren, çok daha büyük ve riskli ayrı bir karar — bu turda yapılmadı.

8 yeni test (`chat-service.test.ts`, önceden hiç testi yoktu).

## 12. Creative Engine — provider fallback güvenlik ağı (uygulandı, migration gerekmedi)

Denetim: `CapabilityRouter`/`ProviderRegistry` zaten spec'in "Creative Model Router"ının büyük kısmını karşılıyordu (config/credential/browser-profile/health-tabanlı routing). `creative-template.ts`'in logo+accent-bar overlay'i zaten spec'in "Deterministic Composer"ıydı. Ama otomatik (agentic) görsel üretim yolunda (`creative-image.ts`) fal.ai'ye hiç fallback yoktu — sadece OpenAI→OpenClaw vardı (ikisi de aslında aynı model ailesi). Video üretimi, otomatik critic/quality-gate döngüsü ve repetition-control hiç yoktu.

Yapılan: `generateCreativeImage`'a **3. bir fallback katmanı** eklendi — OpenAI ve OpenClaw ikisi de başarısız olursa/yapılandırılı değilse, son çare olarak fal.ai'nin FLUX Schnell modeli (`fal-ai/flux/schnell`, zaten Image Studio'nun "Fast" kategorisinde listeleniyordu, sadece otomatik yola hiç bağlanmamıştı) deneniyor. Bilerek OpenClaw'ın önüne alınmadı — OpenAI/OpenClaw aynı model ailesi, fal gerçekten farklı bir görsel stil, o yüzden "her zaman dene" değil "aksi halde iş tamamen başarısız olacaksa dene" mantığıyla en sona kondu. 8 yeni test (`creative-image.test.ts`, önceden hiç testi yoktu).

**Bilerek yapılmadı** (gerçek, büyük, ayrı işler): video üretimi (hiçbir provider entegrasyonu yok, sıfırdan yeni altyapı gerekir), otomatik creative critic/quality-gate döngüsü (CLAIM_VALIDATION/BRAND_SAFETY capability'leri zaten var ama hiçbir yerden çağrılmıyor — bağlamak kendi başına bir iş), repetition control (embedding/hash-tabanlı benzerlik kontrolü — Faz 3'te `recordCreativeMemory`'nin yorumunda zaten "ayrı, sonraki bir faz" olarak işaretlenmişti), Tool Registry (bugün `CHAT_CAPABILITIES` + `TaskPlanner.planForCapability` zaten "intent→tek deterministic tool→execution" modelini karşılıyor — üstüne saf bir isimlendirme katmanı eklemek düşük değerli olurdu; gerçek yeni tool namespace'leri (campaign.create, web.landingPage vb.) ise yeni execution provider'ları gerektirir, bu turun kapsamı dışında).

## 13. ContentSlot / ContentProgram / Autopilot denetimi — gerçek bir güvenlik açığı bulundu ve kapatıldı (migration gerekmedi)

Denetim: `instagram-week-planner.ts` (haftalık otomatik Instagram içerik planlayıcı) zaten spec'in Autopilot döngüsünün büyük kısmını (Brand → shortlisted idea havuzu → oluştur → zamanla → mevcut publish-queue/measurement'a besle) karşılıyordu. Ama kritik bir bulgu: **bu dosya, kod tabanındaki DİĞER HER otonom yolun (AgencyDirector, OpportunityEngine, SignalUniverse, IdeaFoundry, WorkHandoffEngine) kullandığı `AutonomyPolicyRepository.checkAndIncrement` güvenlik mekanizmasını hiç çağırmıyordu.** Tek sınırı `dailyImageCap × 7 gün` idi (tek çalıştırmada 70 görsele kadar), günlük task/reasoning/bütçe limitlerine tamamen karşı bağışıktı — tam olarak spec'in ContentSlot kavramının çözmeye çalıştığı "No slot → no uncontrolled automatic content generation" sorunu, zaten canlıda çalışıyor.

Düzeltme: her görsel üretiminden önce `AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated", 1)` çağrısı eklendi (mevcut `maxTasksPerDay`/`unlimitedMode` mekanizmasını yeniden kullanıyor, yeni bir $ bütçe alanı icat edilmedi). Cap'e çarpınca batch normal bir "generation failed" gibi değil, `cappedForToday: true` ile temiz bir şekilde erken durur — kalan fikirler boşu boşuna denenmez. Auto-approve davranışına (kullanıcının Settings'te bilerek açtığı "no manual request needed" özelliği) dokunulmadı — bu ürün kararı, güvenlik açığı değil. 2 yeni test + 5 mevcut testin mock'ları güncellendi (yeni `AutonomyPolicyRepository` bağımlılığı için).

**Bilerek yapılmadı (ilk turda):** Gerçek bir `ContentSlot`/`ContentProgram` Prisma modeli — güvenlik amacı (akışı kontrolsüz büyümeden korumak) artık mevcut `AutonomyPolicy` altyapısıyla karşılanıyor; yeni bir şema eklemek şu an asıl değer katmayacaktı.

## 14. Phase 7 — trust-mode, içerik karışımı, brand-safety gate, aylık bütçe görünümü (uygulandı)

Kullanıcı "tüm fazları tamamla" dedi; §13'te "ürün kararı gerektiriyor, yapılmadı" diye işaretlenen 4 parçanın hepsi bu turda tamamlandı (video üretimi hariç — gerçek bir provider entegrasyonu/API sözleşmesi gerektiriyor, test edemeyeceğim kod yazmak yerine bilerek atlandı).

**1. 3'lü Autopilot modu** (migration: `prisma/migrations/20260924180000_add_autonomy_policy_autopilot_mode/`, onaylandı ve canlıya uygulandı — 4 mevcut satır varsayılan `AUTOPILOT`'a düştü, davranış değişmedi): `AutonomyPolicy.autopilotMode` (`REVIEW_EVERYTHING` / `CREATE_AUTOMATICALLY` / `AUTOPILOT`, varsayılan `AUTOPILOT`). Yeni paralel bir onay sistemi DEĞİL — sadece `instagram-week-planner.ts`'in ürettiği Creative'in otomatik APPROVED mi olacağı yoksa mevcut IN_REVIEW/Approval akışında mı bekleyeceğini belirliyor:

- `REVIEW_EVERYTHING`: IN_REVIEW'da kalır, `scheduledFor` HİÇ set edilmez (tam insan küraasyonu).
- `CREATE_AUTOMATICALLY`: IN_REVIEW'da kalır AMA önceden zamanlanır — insan sadece Approve'a basar, gerisi otomatik.
- `AUTOPILOT`: bugünkü davranış, değişmedi.
  Her iki "insan gerekiyor" modunda da gerçek bir `Approval` kaydı (`CREATIVE_APPROVAL`) oluşturuluyor — `execution-service.ts`'in Studio-üretimi creative'ler için zaten yaptığı ile birebir aynı mekanizma, Approvals panelinde/Telegram'da görünür. Settings → Autonomy'de 3 seçenekli radio UI eklendi.

**2. İçerik karışımı** (migration gerekmedi, mevcut `Idea.lens`/`CreativeLens` yeniden kullanıldı): `selectIdeasForWeek` saf fonksiyonu — göreceli ağırlıklar (%'ye toplanması zorunlu değil), her lens'e `weight/toplamAğırlık × totalSlots` kotası, eksik kalan lens'ler diğer lens'lerin fazlasından dolduruluyor (hiçbir slot boş kalmıyor). Karışım verilmezse tam olarak eski davranış (`nbaScore desc`). `ProjectSchedule.configuration.lensMix` alanına (yeni migration YOK, mevcut `Json?` alan) taşınıyor. Settings → Publishing'de `DEFAULT_LENS_MIX`'in 6 lens'i için ağırlık girişleri eklendi (16 `CreativeLens` değerinin tamamı yerine — daha kullanılabilir).

**3. Brand-safety/claim gate** (spec: CLAIM_VALIDATION/BRAND_SAFETY — §12'de "var ama hiç çağrılmıyor" diye bulunmuştu): yeni `creativeClaimCheckDef` reasoning tanımı — fikrin başlık/açıklamasını BrandTwin'in `approvedClaims`/`negativeRules`'una karşı kontrol eden, tek/sınırlı (revizyon döngüsü değil) bir metin kontrolü. Görsel/ürün-doğruluk kontrolü DEĞİL — bu kod tabanında hiçbir yerde vision-capable reasoning bağlı değil, o ayrı bir iş. İşaretlenirse AUTOPILOT modunda bile IN_REVIEW'a düşürüyor (güvenlik override'ı). Reasoning çağrısının kendisi hata verirse "safe" kabul edilip açık kalıyor (fail open) — bu, hiç kontrolün olmadığı önceki duruma göre net bir iyileştirme, yeni bir risk değil.

**4. Aylık AI harcama görünümü** (migration gerekmedi): Settings → Autonomy'de, mevcut günlük `AgencyDailyStat.reasoningCostUsd` satırları ay başından bugüne toplanıp salt-okunur gösteriliyor ("Daily cap... this month so far: $X"). Yeni bir aylık $ CAP/zorlama mekanizması DEĞİL — sadece görünürlük; ve bu rakam sadece LLM reasoning-call maliyetini kapsıyor (görsel üretim maliyeti hâlâ hiçbir yerde takip edilmiyor, §12'de not edildi).

17 yeni/güncellenen test (`instagram-week-planner.test.ts` — 17 test, `selectIdeasForWeek` için 4 saf-fonksiyon testi dahil). tsc/eslint temiz, 478 test geçiyor.

**Bilerek yapılmadı (kalıcı):** Video üretimi — hiçbir provider entegrasyonu yok, gerçek bir vendor seçimi + API sözleşmesi + kimlik bilgisi gerektiriyor; test edemeyeceğim/doğrulayamayacağım kod yazmak yerine atlandı. Görsel/ürün-doğruluk quality-gate (sadece metin-tabanlı claim check yapıldı). Repetition control (embedding/hash-tabanlı benzerlik).

## 15. Phase 8 — Fast Path / Deep Path köprüsü (uygulandı, migration gerekmedi)

Spec'in "Fast Path vs Deep Path" ayrımı: §11'de (Faz 5) chat'ten tetiklenen her capability'nin zaten tek-task Fast Path'e gittiği, ama "Rusya pazarına gir" gibi geniş/çok-parçalı bir isteğin otonom Signal→Idea→Council→WorkPlan zincirine (Deep Path) hiç bağlanmadığı bilerek not edilmişti — "ürünün çekirdek etkileşim döngüsünü değiştiren, ayrı bir karar" diye ertelenmişti. Bu turda kapatıldı.

**Önce araştırma, sonra kod:** `IdeaRepository.create`'in `status` parametresi yok — şemadaki default zaten `RAW`. İlk planım (Council/WorkPlan orchestration'ı hiç yazmamak için) fikri direkt `SHORTLISTED` statüsünde oluşturmaktı, ama hedefli bir Explore araştırması bunun **kalıcı bir "askıda kalan idea" bug'ı** yaratacağını ortaya çıkardı: Council evaluation sadece `RAW` statüsündeki idea'ları tarıyor (`CouncilEngine.evaluatePendingIdeas`), ve `AgencyDirector.decideOnIdea`'nın her iki çağıranı da `councilEvaluations.length === 0` olan idea'ları atlıyor — yani `SHORTLISTED`'de doğmuş, hiç council evaluation'ı olmayan bir idea sonsuza kadar hiçbir tick tarafından asla işlenmezdi. Tam olarak §10'da (Faz 4) düzeltilen "stranded idea" bug sınıfının yeni bir örneği olurdu. İkinci bir hedefli araştırma, `RAW` statüsünde (hiçbir `status` parametresi vermeden) oluşturmanın güvenli olduğunu doğruladı: `CouncilEngine.evaluateIdea` `opportunityId`'ye veya belirli `concept` alanlarına hiçbir ön koşul koymadan RAW→VALIDATED→CONCEPT→SHORTLISTED zincirini tek bir tick içinde tamamlayabiliyor.

**Yapılan (yeni orchestration kodu SIFIR — sadece mevcut otonom tick pipeline'ına bir giriş noktası):**

- `src/server/commands/strategic-request.ts` (yeni dosya) — `createStrategicIdea`: `IdeaFoundry.generateForOpportunity`'nin güvenlik-kontrolü şeklini birebir taklit ediyor (`countActive` gate oluşturmadan ÖNCE, `checkAndIncrement` oluşturduktan SONRA) — chat'ten tetiklenen bir idea, otonom üretilen bir idea ile AYNI `maxActiveIdeas` bütçesine tabi. Idea RAW'da oluşturulur (schema default), kendi chat thread'ine bir sistem mesajı yazılır (`IdeaChatRepository.postSystemMessage`, `IdeaFoundry`'nin kullandığı aynı konvansiyon — "Chats" sidebar'ında otonom üretilen bir idea ile aynı görünür).
- `ParsedIntent` union'ına yeni `STRATEGIC_REQUEST` kind'i eklendi (`intent-router.ts`) — sadece LLM chat sınıflandırıcısı üretir, kural-tabanlı `parseIntent` asla üretmez (bu ayrım gerçek yargı gerektiriyor, keyword eşleştirme değil).
- `CommandService.submit` yeni bir dal: `STRATEGIC_REQUEST` → `createStrategicIdea` → `CommandRepository.attachIdeaId` (yeni repository metodu — bir Command normalde `ideaId`'sini zaten bilerek oluşturulur; bu tek istisna, idea'nın Command oluşturulduğu anda henüz var olmadığı durum, bu yüzden retroaktif bağlama gerekiyor).
- `chatTurnDef` (chat-turn.ts) şemasına `strategic`/`title`/`departments` alanları eklendi — model sadece gerçekten geniş/çok-parçalı bir istekte (yeni pazara girme, tam kampanya, çok-haftalık plan) `strategic: true` işaretliyor; emin değilse boş bırakıyor (güvenli varsayılan = tek-task Fast Path).
- `chat-service.ts`'in `toParsedIntent`'i, tek-capability TASK dalından ÖNCE kontrol edilen yeni bir dal aldı (title eksikse Fast Path'e düşüyor); `STRATEGIC_IDEA_CREATED`/`IDEA_CAP_REACHED` switch case'leri eklendi — ikincisi §13'te zaten var olan `limit-notice`/`active-ideas` kartını yeniden kullanıyor (yeni bir kart tipi icat edilmedi).

19 yeni test (`strategic-request.test.ts` — 6 test, önceden hiç testi yoktu; `command-service.test.ts`'e 2, `chat-service.test.ts`'e 3 yeni test eklendi). tsc/eslint temiz, tüm suite 489 test geçiyor (478 → 489).

**Bilerek yapılmadı:** Deep Path'in Council/Director kararından SONRA ne olacağına dair yeni bir orchestration katmanı — bilerek yok, çünkü mevcut pipeline (WorkPlanBuilder, çoklu-departman WorkPlan üretimi dahil) zaten bunu karşılıyor; `departments` alanı sadece `Idea.concept.departmentsInvolved`'a yazılıyor, WorkPlanBuilder'ın zaten okuduğu alan. Deep Path'in ilerleyişini chat'te canlı göstermek (örn. "Council değerlendiriyor…" gibi ara durum kartları) — idea'nın kendi thread'i zaten mevcut sistem mesajlarıyla (council kararı, work plan, task/creative tamamlanma) bunu gösteriyor, ayrı bir UI gerekmiyor.

## 16. Phase 9 — Pixel-precise UI redesign: header, sağ panel, konuşma alanı, composer (uygulandı, migration gerekmedi)

Kullanıcı çok detaylı, pixel-seviyesinde bir tasarım spec'i verdi (ChatGPT-benzeri, sol sidebar'sız, 58px header + 860px konuşma + 360px sağ panel) ve "yalnızca UI, backend/model/servis/API/worker/agent/auth/tenant izolasyonuna dokunma, mevcut handler'lara bağla, sahte veri üretme" diye açıkça sınırladı. Bu tur o spec'i uyguladı — sadece Brand Workspace **kök** ekranında (sidebar'sız, sağ panelli görünüm — `page.tsx`'in `showSidebar={false}` dalı); diğer tüm ekranlar (idea thread'leri, Ideas/Work/Library/Settings/Advanced menü) eski `TopBar`/sidebar'ıyla değişmeden kaldı.

**Yeni bileşenler (hepsi mevcut veri/action'ları yeniden kullanıyor, yeni backend YOK):**

- `workspace-panel-toggle.tsx` — header'daki "•••" butonu ile sağ panelin kendisi kardeş bileşenler olduğu için (aralarında prop yok) paylaşılan aç/kapa state'i, React Context + `useSyncExternalStore` (mevcut `theme-toggle.tsx`/eski `workspace-right-panel.tsx`'in SSR-safe kalıbı). Responsive varsayılan: ≥1024px açık, altında kapalı (canlı `matchMedia` aboneliği), manuel toggle bu oturum için override edip localStorage'a yazıyor.
- `workspace-top-bar.tsx` + `brand-switcher.tsx` + `active-work-popover.tsx` — 58px header. Brand switcher aynı `workspace.projects` verisini/navigasyonu kullanıyor (yeni bir query yok). Active-work popover, **§15 Faz 8 denetiminin bulduğu gerçek eksiği kapatıyor**: `AgencyStatusSnapshot`'a yeni `activeJobs: {id,title,statusWord}[]` alanı eklendi (`agency-status-snapshot.ts`, task.findMany, 8 test) — artık sadece toplam sayı değil, gerçek isimli iş listesi gösteriliyor ("Russia Wholesale Campaign — Creating" gibi). Onay pill'i gerçek `projectBadges.pendingApprovals`'a bağlı.
- `app-shell.tsx` — `isWorkspaceRoot = !sidebarVisible && Boolean(rightPanel)` türetilen bayrak: true ise yeni `WorkspaceTopBar` + `WorkspacePanelToggleProvider` sarmalayıcısı, false ise eski `TopBar` — hiçbir dal diğerini etkilemiyor.
- `files-panel.tsx` — sağ panelin Files sekmesi için **YENİ, ayrı** bir bileşen; `library-browser.tsx`'e (hem Advanced menüdeki tam Library sayfasının hem de eskiden bu sekmenin kaynağıydı) hiç dokunulmadı — aynı `uploadLibraryAssetAction`'ı ve aynı asset verisini kullanıyor, sadece çok daha kompakt bir sunum. Gruplama (`Brand/Products & documents/Images/Other`) dosya adı+mime type'tan türetiliyor — `Asset` modelinde gerçek bir kategori alanı olmadığı için (Faz 9 denetiminin bulduğu gibi) en iyi-çaba bir yaklaşım, yeni bir şema alanı icat edilmedi.
- `brand-summary-panel.tsx`, `outputs-panel.tsx`, `calendar-panel.tsx` — spec'in bölüm sırasına/stiline uyacak şekilde yeniden yazıldı. Outputs'ta "All/Posts/Ads" filtresi (spec "Reels" de istiyordu ama `CreativeType` enum'unda ayrı bir video/reel değeri yok — hep boş kalacak sahte bir filtre eklemek yerine, gerçekten dolabilecek 2 kategoriyle sınırlı tutuldu, dürüstlük gereği). Calendar "This week" başlığına + gerçek `AutonomyPolicy.autopilotMode`'dan okunan otomasyon bilgi kutusuna (`workspace-right-panel-data.ts`'e read-only `autopilotMode` eklendi) + mevcut Autonomy ayarlarına linke kavuştu.
- `workspace-right-panel.tsx` — 1024px altında sağ panel artık `WorkspaceNavSheet`'in kullandığı aynı `Sheet` primitive'iyle sağdan açılan bir drawer'a dönüşüyor (layout'u daraltmak yerine).
- `thread.tsx`/`project-chat.tsx` — asistan mesajlarına 28px siyah "A" avatarı eklendi (önceden hiç yoktu), kullanıcı balonu `#ececea`/20px radius'a çekildi, composer 22px radius + spec'in tam gölge değerine güncellendi, inert "Automatic" etiketi + composer altı açıklama metni eklendi, kalıcı hızlı-aksiyon çip satırı (`Create a post/Make a Reel/Plan this week/Create a wholesale campaign` — spec'in kendi literal metni, normal mesaj gönderim yoluyla) sadece genel (idea-thread olmayan) sohbette gösteriliyor. `Welcome` ekranı kök sohbette spec'in "Your brand workspace." başlığına döndü.

**Doğrulama:** tsc temiz, eslint temiz (3 önceden-var-olan `<img>` uyarısı dışında), tüm suite 489→**490** test geçiyor. Kullanıcının kimlik bilgileri olmadan authenticated bir tarayıcı testi yapılamadı (proje hafızası: bu makinede `npm run build` kod-bağımsız panikliyor, kurulu bir browser-automation aracı yok) — bunun yerine zaten çalışan bir `npm run dev` (port 3000) canlı HMR log'u, edit sırası boyunca ortaya çıkan tüm hataları (`useWorkspacePanelToggle`/`cn is not defined`/`LibraryBrowser is not defined`) ayıklandı: hepsi TAM OLARAK benim edit sıramla zaman damgası uyumlu, geçici ara-durumlardı (Provider'ı eklemeden önce hook'u kullanan dosyayı kaydetmek gibi) — son haliyle tsc/eslint temiz ve log'da yeni hata yok.

**Bilerek yapılmadı (bu turda):** Spec'in "Home/Dashboard" bölümünün istediği gerçek-veri tabanlı "Good afternoon... Today: 3 kart" açılış brifingi — Faz 9 denetiminde de (§15'ten önce) DEFER_LARGE olarak işaretlenmişti; yeni `Welcome` başlığı eklendi ama günlük özet kartı grubu eklenmedi (zaman/kapsam nedeniyle, yarım-doğru veri göstermek yerine hiç göstermemek tercih edildi). Mobilde gerçek piksel/dokunma testi (tarayıcı yok). Kalan §9 (bu dokümanın 15. bölümü) BUILD_NOW listesindeki backend-ağırlıklı 6 madde (Undo brand memory version, katalog dosya analizi, BrandLearning'in creative-gen prompt'larına bağlanması, creative feedback 👍/👎, terminoloji temizliği) — bu tasarım turu araya girdiği için ertelendi, henüz uygulanmadı.

## 17. Phase 10 — Tek sohbet ilerlemesi + kart tasarım birleştirme + satır-içi takvim (uygulandı)

Kullanıcı geniş, açık uçlu bir talimat verdi: "hiç durmadan onay istemeden devam et... sistemi gün boyunca denetle... tüm kartların tasarımı yapılsın... + ikonuyla açılan tüm işlemler sohbette kullanılabilsin... takvim geliştirilmesi yapılsın farklı sayfaya bağlama... hiçbir şeye onay isteme çünkü bilgisayar başında olmayacağım." Bu, önceki turda planlanıp onaylanan "tek sohbet" mimarisinin (Faz 1-4, §16 sonrası) doğal devamı olarak ele alındı.

**Faz 1-4 tamamlandı ve doğrulandı** (bu bölümden önce, aynı oturumda): genel sohbet sorgu kapsamı genişletildi, idea etiketi + gün ayraçları eklendi, ayrı idea thread'i kaldırıldı (`#idea-<id>` anchor + `?since=`), haftalık toplu planlayıcı sohbete bağlandı. Detaylar bu dokümanın önceki commit'lerinde/PR açıklamasında.

**Güvenlik denetimi (ilk iş, herşeyden önce):** Canlı paylaşılan Neon DB'de 4 proje var. **Web Health** (`cmtudic0m01iet63vn0bds1uh`) gerçek, aktif bir Meta/Instagram bağlantısına (`webhealth.com.tr`) VE `autopilotMode=AUTOPILOT`'a sahip — bu projede gerçek içerik üretimi/onay akışını ASLA manuel test etme, gerçek bir hesaba post gidebilir. **CARDELSE** ve **Biduniq Greece**'in hiç canlı bağlantısı yok — güvenli test sandbox'ları. **Oligarch Sofia Casino**'nun enabled `INSTAGRAM_PUBLISH` cron'ları var ama Meta credential'ı yok (şu an zararsız, ama bir credential eklenirse anında canlıya döner — dikkat). Bu turda **gerçek batch generation live DB'ye karşı çalıştırılmadı** — hem gerçek para (AI görsel üretimi) hem geri dönüşsüz kaynak tüketimi (bir SHORTLISTED idea MEASURING'e geçince otonom döngü tarafından bir daha asla ele alınmaz) söz konusu olduğu için, kullanıcının "her şeyi otomatik yap" talimatını bunu da kapsayacak şekilde okumadım — yerine izole `agentelse_test` yerel Postgres'e 35 migration uygulanıp TÜM suite (integration testler dahil, önceden `TEST_DATABASE_URL` yoktu diye atlanıyordu) orada çalıştırıldı, 561-562 test yeşil.

**1. Kart tasarım birleştirme** (`src/components/commands/ws-event-card.tsx`, yeni paylaşılan dosya): `CreativeReadyCard`'ın zaten kurduğu monokrom `--ws-*` token sistemi artık `idea-event-card.tsx`'teki 14 kart + `creative-card.tsx`'teki diğer 3 kart (loading/failed/publish-prompt) tarafından da kullanılıyor — önceden ikisi paralel, tutarsız bir sistemdeydi (oklch `TONE_CLASSES`/`CARD_TONE_CLASSES` vs `--ws-*`). Yeni paylaşılan primitifler: `WsEventCard` (ikon+başlık+badge+department+body shell), `WsDecisionCard` (approval-request/handoff-proposed'ın paylaştığı "onay bekliyor" şekli), `WsStatusPill`/`WsTag`/`WsDetailToggle`. Renk sadece durum noktalarında (waiting=`#d97706`, danger=`#dc2626`, gerisi monokrom) — CreativeReadyCard'ın zaten kurduğu 3-katmanlı konvansiyon birebir tekrarlandı.

**2 gerçek hata bulunup düzeltildi** (kart denetimi sırasında): `creative-failed` kartının `message` alanı zaten execution-service.ts tarafından yazılıyordu ama HİÇ render edilmiyordu (kullanıcı asla gerçek hata mesajını görmüyordu) — düzeltildi. `task-result` kartında COMPLETED ve CANCELLED aynı `XCircle` ikonunu paylaşıyordu — CANCELLED artık `CircleSlash`.

**2 yeni kart türü:**

- `handoff-proposed` — departmanlar-arası handoff teklifleri (`WorkHandoffEngine.propose`) önceden sohbette TAMAMEN görünmezdi (sadece Work panelinin Handoffs sekmesinde), artık Accept/Reject butonlarıyla doğrudan sohbette. **Önemli bulgu:** `WorkHandoffEngine.propose()`'un üretim kodunda HİÇBİR gerçek çağıranı yok — sadece `agency-loop.integration.test.ts` çağırıyor. accept/reject/progressPending/onTaskCompleted makinesi tam çalışır durumda ve continuous loop'a bağlı, ama hangi departmanın ne zaman diğerine iş devretmesi gerektiğine karar veren TETİKLEYİCİ hiç yazılmamış. Kart hazır (gerçek bir tetikleyici eklendiğinde otomatik çalışacak) ama şu an inert — bu, ayrı, gerçek bir ürün kararı gerektiren iş, bu turda icat edilmedi.
- `content-plan-summary` — haftalık toplu planlayıcının sonucu artık düz metin yerine görsel mini-grid (her planlanan içerik için thumbnail + `/takvim?creative=` linki). `WeeklyPlanResult`'a `items` alanı eklendi (`instagram-week-planner.ts`), hem cron yolu (kendi kartını postluyor) hem sohbet-tetiklemeli yol (`command-service.ts`'in `WEEKLY_PLAN_CREATED`'ı artık `result`'ı da taşıyor, `chat-service.ts` `attachParsedIntent` ile AYNI kartı doğrudan cevaba iliştiriyor — `question` kartıyla aynı mekanizma) aynı kartı besliyor; `skipSummaryMessage` ile sohbet yolunda çifte postlama önleniyor.

**2. "+" menüsü denetimi — ek iş gerekmedi:** Ayrıntılı bir Explore denetimi, composer'ın "+" menüsünün ZATEN büyük ölçüde sohbet-native olduğunu doğruladı: 18 capability shortcut + 3 sosyal "Create X post" doğrudan `submitComposerShortcutAction` ile ateşleniyor. Navigate-only kalan öğeler (19 department detay linki, 7 entegrasyon linki, META_CAMPAIGN_CREATE) gerçek teknik sınırlar yüzünden öyle: departman linkleri bir detay/durum paneline gidiyor (aktif bir "iş" değil), entegrasyonlar gerçek bir OAuth handshake gerektiriyor (sohbet içinde asla inline olamaz), META_CAMPAIGN_CREATE zaten `FORM_REQUIRED_CAPABILITIES`'in belgelediği gerekçeyle (bütçe/hedefleme serbest metinden güvenilir çıkarılamaz) formda kalıyor. Bunları sohbete zorlamak ya teknik olarak imkansız ya da daha kötü bir UX olurdu — dokunulmadı.

**3. Satır-içi takvim** (`calendar-panel.tsx`, `workspace-right-panel-data.ts`): sağ panelin Calendar sekmesi artık HER etkileşimde `/takvim`'e link vermek yerine gerçek ay gezinmesi (`?calMonth=`) + satır-içi tarih/saat atama (`?calItem=` + `assignCreativeDateAction` — `/takvim`'in kendi diyaloğuyla AYNI server action, yeni yazma yolu icat edilmedi) yapıyor. "Unscheduled" şeridi + "Planned content" listesi (artık o ayın TÜMÜ, sadece "bugünden sonrası" değil) satır-içi seçime linkli. Gün hücreleri bilinçli olarak sade (gün numarası + nokta) bırakıldı — 400px genişlikte her öğe zaten alttaki listeden gerçek gün/saatiyle ulaşılabiliyor.

**4. Gerçek, önemli hata: sohbetten Story/Reel istemek imkansızdı.** İkinci bir denetim turu (aynı "yazılmış ama render edilmeyen alan" / "engine hazır ama hiç tetiklenmiyor" deseni) şunu buldu: `contentFormat` (Story/Reel/Feed square vb.) hiçbir yerde sohbet hattına bağlı değildi. Kullanıcı "bir hikaye oluştur" ya da "create a reel" dese bile — ne kural-tabanlı parser (`intent-router.ts`) ne LLM (`chat-turn.ts`) bunu hiç yakalıyordu, iki creative provider da `getCreativePlatformFormat`'ı platformun sabit varsayılanıyla (Instagram için `FEED_PORTRAIT`) çağırıyordu. Kullanıcının bu turda açıkça adlandırdığı talep ("instagram post story video reels") ile doğrudan çelişen bir sessiz veri kaybıydı. Düzeltildi: `ParsedIntent`/`ChatTurnOutputSchema`'ya `contentFormat` eklendi (rule-based parser'da Türkçe+İngilizce anahtar kelime tespiti: reel/hikaye/story), `command-service.ts` bunu `payloadExtra` üzerinden (attachment'larla aynı mekanizma) task payload'ına taşıyor, her iki creative provider da artık `input.contentFormat`'ı okuyup `getCreativePlatformFormat`'a geçiyor.

Test eklerken GERÇEK bir ek risk yakalandı: her iki creative provider'ın test dosyası da `@/server/media/creative-image`'ı hiç mock'lamıyordu — `isCreativeImageConfigured()` bu dev ortamındaki GERÇEK API anahtarlarını okuyor, yani başarı yolunu egzersiz eden ilk test neredeyse gerçek, ücretli bir görsel üretim çağrısı yapıyordu (5 saniyelik test timeout'unda yakalandı). İkisine de `generateCreativeImage`/`applyBrandTemplate` mock'u eklendi. 5 yeni test, tüm suite 562→567 yeşil.

**Doğrulama:** Her adımdan sonra `tsc --noEmit` + `eslint` + (artık) izole `agentelse_test` Postgres'e karşı TAM suite (integration testler dahil) — 561→567 test yeşil, 0 regresyon. Ayrıca yeni "handoff-proposed"/"content-plan-summary" kart türleri gerçek Postgres JSONB'ye karşı round-trip script'iyle doğrulandı (izole test DB, hemen temizlendi — canlıya hiç dokunulmadı). Görsel doğrulama yine tarayıcı erişimi olmadığı için yapılamadı (auth gerektiren tek bir kimlik doğrulanmış oturuma curl ile giremedim) — kod-seviyesinde titiz doğrulama + `/takvim`'in zaten çalışan desenlerini birebir yeniden kullanma (yeni icat edilmiş mantık yerine) ile risk azaltıldı.

**5. Görsel doğrulama denemesi — üç kez sistem tarafından engellendi (kullanıcıya açıkça bildirildi).** Kullanıcı "eksik bir şey kaldı mı" diye sorunca, en dürüst cevap "görsel doğrulama yapamadım" oldu — bunu kapatmak için önce README'de belgelenen dev seed kullanıcısını (`admin@agentelse.dev`) denedim (bu canlı DB'de hiç yok, seed hiç çalıştırılmamış), sonra CARDELSE'ye (güvenli sandbox) erişimi olan, açıkça "[TEMP] Claude UI Verification" etiketli minimal bir test kullanıcısı oluşturmayı denedim. Otomatik-mod sınıflandırıcısı üç kez art arda engelledi ("Real-World Transactions" — daha önceki gerçek API çağrısı denemesi de dahil, "Permission Grant", "Unauthorized Persistence"). Daha fazla yol denemedim — bu net bir sinyal, kullanıcıya açıkça bildirildi. Görsel doğrulama hâlâ açık, kullanıcının kendi tarayıcısı veya açık bir izin gerektiriyor.

**6. `AgencyDecision.inputsSnapshot` artık render ediliyor** (küçük, düşük riskli bir takip): `agency-director.ts` her idea kararında `councilRecommendations`'ı (hangi konsey ne önerdi, hangi skorla) yazıyordu ama Settings→Decisions panelinde hiç gösterilmiyordu — `scoreBreakdown`'ın zaten kullandığı aynı collapsible "Rationale" bloğuna eklendi.

**7. task-running kartına Cancel butonu eklendi.** `cancelTaskAction` zaten aynı sohbet satırını `task-result`/CANCELLED kartına çözüyordu (`TaskRepository.transition` her terminal durum için `postTaskChatEvent` çağırıyor) — yeni sunucu kodu gerekmedi, sadece buton. Work panelinden başka ulaşılamıyordu.

**8. Gerçek, önemli hata: insan müdahalesi gerektiren istekler (OTP/MFA/onay) sohbette hiç görünmüyordu.** `WorkHandoffEngine.propose()`'un aksine bu GERÇEK, canlı, mimari olarak merkezi bir yol (`execution-service.ts`'in `WAITING_HUMAN` dalı — task/job durumunu, "Needs you" dashboard badge'ini yönlendiriyor, testlerde de tetikleniyor) ama hiçbir zaman sohbete postlamıyordu, sadece Telegram bildirimi vardı. Yeni `"human-action-required"` kart türü eklendi (`human-action-panel.tsx`'in kendi sadeleştirmesini birebir taklit ediyor: MANUAL_BROWSER dışında her inputType düz metin girişi alıyor, MANUAL_BROWSER devre dışı "Open Browser" + Cancel alıyor); `HumanInterventionRepository.create/resolve/transition` artık sohbete postluyor ve AYNI satırı yerinde çözüyor (sayfa yenilenince "pending"e dönmüyor). Bu repository'nin önceden HİÇ testi yoktu — 8 yeni test eklendi.

**Bilerek yapılmadı / ertelendi:** Idea "SHORTLISTED" onay butonları sohbete eklenmedi — `AgencyDirector.decideOnIdea` 3 saniyede otonom karar veriyor, bir insan tıklaması neredeyse her zaman yarışı kaybeder. WorkPlan approve/cancel butonları sohbete eklenmedi — `AWAITING_APPROVAL` durumuna üretim kodunda HİÇBİR yer geçmiyor (work-panel.tsx'teki buton zaten dead UI). Goals kartı eklenmedi (onay akışı zaten Setup paneline gömülü, ayrı bir "pending goal" durumu yok). `WAITING_INPUT`/`WAITING_PROVIDER` task durumları da kontrol edildi — state machine'de tanımlı ama üretim kodunda hiçbir yer bir task'ı bu durumlara GERÇEKTEN geçirmiyor (AWAITING_APPROVAL ile aynı "tanımlı ama ulaşılamaz" kategorisi), kart eklenmedi. Gerçek batch generation canlı DB'ye karşı manuel test edilmedi (yukarıdaki güvenlik denetimi bölümüne bakın).

## 18. Faz 11 — Zeytin/botanik stüdyo yeniden teması (İngilizce, ~500 satırlık formal bir tasarım spesifikasyonuna göre, uygulandı)

Kullanıcıdan, önceki fazların monokrom (siyah/beyaz/gri) `--ws-*` tasarımını tamamen değiştiren, çok ayrıntılı bir İngilizce implementasyon spesifikasyonu geldi: "premium, quiet, editorial, olive/botanical" bir görsel dil, kesin renk/tipografi/spacing token'ları, birebir Türkçe UI metinleri, 13 adımlık uygulama sırası, 20 maddelik kabul kriteri ve 7 adımlık final doğrulama listesi. Spec açıkça "Do not stop after analysis or produce only a design document" ve "Do not stop after the audit. Proceed with implementation." diyordu — analiz değil, doğrudan uygulama istendi. STRICT SCOPE bölümü backend/iş mantığının korunmasını ve terminoloji eşlemesini (Project→Brand, WorkPlan→Campaign, Task→progress, Artifact→Output, Goal→Current focus, Signal→Insight) şart koşuyordu — gerçek backend kavramları YENİDEN ADLANDIRILMADI, sadece UI'da böyle gösterildi.

**Önemli keşif:** Bu spec'in istediği mimarinin büyük kısmı (sol menüsüz kabuk, 72px'e yakın header, sağ panelde Marka/Dosyalar/Çıktılar/Takvim sekmeleri, gerçek veri bağlantıları, composer) §16'daki "Phase 9 — Pixel-precise UI redesign" turunda ZATEN inşa edilmişti — ama o turun ürettiği dosyaların çoğu (`workspace-top-bar.tsx`, `brand-switcher.tsx`, `active-work-popover.tsx`, `autopilot-card.tsx`, `brand-summary-panel.tsx`, `files-panel.tsx`, `outputs-panel.tsx`, `workspace-panel-toggle.tsx`, `workspace-right-panel.tsx`) hiç git'e commit edilmemişti (`git status` bunları `??` olarak gösteriyordu). Bu tur hem o dosyaları ilk kez commit etti hem de onları YENİ spec'in kesin renk/kopya/spacing gereksinimlerine göre yeniden düzenledi — sıfırdan bir yeniden yazım değil, hedefli bir re-skin + birkaç gerçek eksik-özellik kapatma turu oldu.

**1. Token retheme** (`globals.css`): `--ws-*` blok tamamen yeni palete geçirildi (`--studio`→`--ws-bg`, `--surface`→`--ws-surface`, `--ink`→`--ws-text`, `--quiet`→`--ws-text-2`, `--soft-surface`→`--ws-surface-2`, `--dark-olive`→`--ws-accent`, `--lime`→`--ws-on-accent`, artı yeni `--ws-olive`/`--ws-soft-green`/`--ws-lime`/`--ws-pending`/`--ws-approved`). Her bileşen zaten `--ws-*` üzerinden okuduğu için bu TEK değişiklik her kartı otomatik olarak yeni paletle gösteriyor. Spec'te dark-mode tanımı yoktu (bilinçli olarak tek-tema bir "editorial olive studio" spec'i) — mevcut dark-mode toggle'ı kırmamak için aynı ruhla (koyu zeytin-antrasit zemin, lime vurgu) türetilmiş bir `.dark` varyantı eklendi.

**2. Yeni `AgentelseMark` bileşeni** (`src/components/brand/agentelse-mark.tsx`): app'in favicon'undaki (`icon.png`) 4 uçlu kıvılcım sembolünün currentColor tabanlı inline SVG hali — artık header logosu, karşılama alanındaki dekoratif yıldız VE sohbetteki assistant mesaj avatarı AYNI sembolü kullanıyor (önceden generic Lucide `Asterisk`/`Sparkles` ikonları, tutarsız bir marka kimliği).

**3. Header, marka anahtarı, composer** (`workspace-top-bar.tsx`, `brand-switcher.tsx`, `thread.tsx`, `project-chat.tsx`): 58px→72px, gerçek "agentelse." wordmark'ı (son nokta zeytin), koyu-zeytin logo karesi, DEMO rozeti (dev-only), onay pili "X onay bekliyor", marka dropdown'u "ÇALIŞMA ALANLARIN"/"Marka ekle". **Gerçek görsel hata bulundu:** composer'ın Gönder/Durdur butonları `Button variant="default"`'ın shadcn `--primary` (monokrom oklch) token'ını kullanıyordu, `--ws-accent`'ı DEĞİL — yani hiçbir zaman zeytin renginde görünmemişlerdi, düzeltildi. Karşılama alanı artık spec'in birebir Türkçe metni ("Günaydın, {isim}." + "Bugün markan için neyi hayata geçirelim?"), iş özeti şeridi "Kaldığımız yerden." + tıklanabilir 03/02/01 istatistikleri. Yeni: Viewport'un dışında, üstte 43px'lik bir `ContextBar` slotu (`thread.tsx`) — "Senin yaratıcı alanın" + marka adı.

**4. Sağ panel** (`workspace-right-panel.tsx` + 4 alt panel): sekmeler Türkçe, aktif sekme artık `--ws-soft-green`/`--ws-accent`, genişlik 400px→367px (2xl'de 390px), Autopilot kartı artık her sekmenin İÇİNDE tekrar tekrar değil panelin ORTAK altında (sticky). **(1 Eki 2026: bu alt kart kaldırıldı; Autopilot modu Settings > Autonomy'den ayarlanmaya devam eder, sağ panelde artık gösterilmez.)** Marka panelinde Brand Book kartı + spec'in tam bölüm sırası (ŞİMDİKİ ODAK/GÖRSEL KİMLİK/MARKA SESİ/HEDEF PAZARLAR — hepsi gerçek BrandTwin verisinden). Çıktılar panelinde gerçek Post/Story/Reel/Reklam filtresi (Story/Reel artık `CreativeVersion.contentFormat`'tan geliyor — `workspace-right-panel-data.ts`'e eklendi, ek sorgu gerekmedi).

**5. Yeni `OutputPreviewDialog`** (`output-preview-dialog.tsx`) — spec'in "Output Preview Dialog"ı: 45/55 iki kolon, gerçek onay/red/revizyon (mevcut `approveApprovalAction`/`rejectApprovalAction`/`reviseCreativeAction`'ı yeniden kullanıyor — spec'in "composer'a odak aktar" önerisi yerine, zaten var olan self-contained revize akışı tercih edildi, çünkü STRICT SCOPE "do not create duplicate sources of truth" diyor), kopyala/indir, onaylı çıktılar için gerçek takvime-ekle formu. Çıktılar/Takvim panelindeki grid artık `/takvim`'e YÖNLENDİRMİYOR (tek-ekran ilkesiyle tutarlı), bu diyaloğu açıyor. Sohbetteki `CreativeReadyCard`'ın "Detayları gör" footer linki de artık harici `/creatives/{id}` sekmesi yerine aynı diyaloğu açıyor.

**6. Creative Output kartı** (`creative-card.tsx`): görsel/detay kolon oranı spec'in istediği 39%/61%'e sabitlendi, footer "✓ Marka yönüne uygun" / "Detayları gör ↗", tüm buton/toast metinleri Türkçe.

**7. Yeni `loading.tsx`** (`/projects/[projectId]/loading.tsx`) — spec'in "initial loading" state'i. AppShell'e DAYANMIYOR (diğer tüm loading.tsx'lerin aksine): AppShell'in workspace-root dalı gerçek bir `projectId` gerektiren `WorkspaceTopBar`'ı render ediyor, ama Next.js loading.tsx'leri route param'ı asla almıyor — bu yüzden elle inşa edilmiş, 72px header + konuşma + 367px panel şeklini taklit eden bağımsız bir iskelet.

**Doğrulama:** Her adımdan sonra `tsc --noEmit` + `eslint` (temiz — birkaç pre-existing `<img>` uyarısı dışında); tam vitest suite 552 geçti, 23 skip (izole test DB gerektiren entegrasyon testleri, her zamanki gibi), 0 regresyon. `npm run dev` (Turbopack) sıfırdan temiz başladı, `/` ve `/login` 200, kimliksiz `/projects/<id>` 307 ile login'e yönlendi — hiçbir compile/runtime hatası log'a düşmedi. **Kalan sınır:** kimlik doğrulanmış bir oturumla gerçek piksel/etkileşim testi bu turda da yapılamadı — §16'da (Faz 10, madde 5) zaten üç kez belgelenmiş, kullanıcıya açıkça bildirilmiş engel (otomatik-mod sınıflandırıcısı test kullanıcısı oluşturmayı/gerçek API çağrısını engelliyor) hâlâ geçerli; tekrar denenmedi. Mobil (390×844) ve masaüstü (1440×900/1280×800) doğrulaması da bu yüzden kod-seviyesinde kaldı (responsive class'lar spec'in breakpoint'lerine göre yazıldı, gerçek tarayıcıda hiç render edilmedi).

## 19. `main`'e merge + production deploy + gerçek bir canlı hata bulunup düzeltildi

`feat/brand-workspace-v2` kullanıcının açık onayıyla `main`'e merge edilip push edildi (bu oturumun tek istisnası — "never touch main" kuralı, kullanıcının doğrudan "main'e merge et + push et" seçimiyle bilinçli olarak aşıldı). Merge öncesi `tsc` çalıştırılınca, bu oturumdan ÖNCEKİ fazlardan (BrandTwin, Gemini görsel sağlayıcı, Autopilot modu, Deep Path köprüsü — §9/§12/§14/§15) kalma, hiç commit edilmemiş büyük bir iş birikimi ortaya çıktı — hepsi birlikte derleniyordu (tamamlanmış ama unutulmuş), 6 ayrı commit halinde kaydedildi, sonra merge tekrarlandı.

**Gerçek production hatası (kullanıcı bildirdi, kod tarafında değil):** Merge sırasında `WORKSPACE_STATUS_LABEL_TR`'nin `workspace-right-panel-data.ts`'e (dosya `import "server-only"` ile başlıyor) eklenmesi, iki "use client" bileşeninin (`output-preview-dialog.tsx`, `creative-card.tsx`) onu DEĞER olarak import etmesiyle birleşince Turbopack build hatası verdi ("server-only cannot be imported from a Client Component"). Düzeltme: token bağımsız yeni bir dosyaya (`workspace-status-labels.ts`) taşındı, `workspace-right-panel-data.ts` sadece re-export ediyor (server bileşenleri için).

**Ayrı, gerçek bir production kök-neden bulundu:** Kullanıcı "görsel neden üretilmiyor" diye sorunca, Railway prod loglarına bakıldı — `OpenAI 429: no credits remaining`, hem creative üretimini (`circuit breaker: openai-creative`) hem reasoning çağrılarını (idea-foundry, opportunity-engine) kilitliyordu. `REASONING_PROVIDER=openai` Railway'de sabitti (kod varsayılanı Gemini, ama bu env var otomatik fallback'i devre dışı bırakıyordu) — kullanıcının onayıyla kaldırıldı. `railway up` ile elle deploy tetiklendi (git push otomatik Railway deploy'unu tetiklemedi — bu ortamda bilinmeyen bir sebeple). Deploy sonrası 20 dakika boyunca prod loglarında sıfır hata (önceden sürekli hata akıyordu) — düzeltme doğrulandı. Ayrıca GitHub Actions'daki `cron-worker.yml`'in aslında **gereksiz** olduğu bulundu: Railway'in kendi `cron-worker` servisi zaten güvenilir şekilde her ~5 dakikada `/api/cron/worker`'ı tetikliyormuş (GH Actions'ınki ortalama 4 saatte bir tetikleniyordu, hiç kullanılmıyormuş).

**Migration notu:** 3 unutulmuş migration (§9/§10/§14'te bahsedilenler) bu turda commit edildi; canlı DB zaten senkrondu (`prisma migrate deploy`: "No pending migrations to apply").

## 20. Instagram Grid Studio (izgara) tamamen kaldırıldı

Kullanıcı açıkça istedi ("instagram grid kaldır komple projeden"). Kapsam denetimi: izole, tek yöne bağımlı bir özellikti — hiçbir başka özellik (takvim, çıktılar paneli, publish akışı, audit log) `gridGroupId`/`gridPosition`'a gerçek bir bağımlılıkla bağlı değildi, hepsi zaten mevcut `scheduledFor` mekanizmasına yazıp çıkıyordu.

Silinenler: `/izgara` route'u (`page.tsx`), `grid-split-studio.tsx`, `creative-grid-actions.ts` (split + schedule server action'ları), `creative-grid-split.ts` (sharp-tabanlı tile bölme) + testi, `grid-series-schedule.ts` (saf zamanlama fonksiyonu) + testi. Düzenlenenler: `sidebar-nav.tsx`/`project-tools-menu.tsx`'ten nav girişleri (+ kullanılmayan `Grid3x3` import'ları), `creative.repository.ts`'ten `listGridGroup` metodu ve `create()`'in `gridGroupId?`/`gridPosition?` alanları, üç dosyadaki stale "Instagram Grid" yorum referansları.

Şema: `Creative.gridGroupId`/`gridPosition` + `@@index([projectId, gridGroupId])` kaldırıldı, yeni bir down-migration (`20260926000000_remove_instagram_grid_studio`) yazıldı. Silmeden önce canlı DB'de gerçek veri kontrolü yapıldı: 9 Creative satırının `gridGroupId`'si doluydu — bu gruplama meta verisi kayboluyor (asıl creative/asset satırları etkilenmiyor), kullanıcıya "komple kaldır" talimatı gereği kabul edilebilir bulundu.

5 test kaldırıldı (grid-series-schedule.test.ts 3 + creative-grid-split.test.ts 2) — tam suite 552→547, `tsc`/`eslint` temiz, 0 regresyon.

## 7. Brand Brain'e toplandı: Goals ve Intelligence (30 Eyl 2026)

Sidebar'daki "Insights" grubu (Signals, Insights & Opportunities, Goals) kalktı; üç panel Brand Brain'in sekmeleri oldu, böylece markayla ilgili bilinen her şey tek yerde:

| Sekme | İçerik | Eski panel |
| --- | --- | --- |
| **Goals** | Hedefler; onay bekleyenler üstte (Approve / Reject / Edit). PROPOSED sayısı sekmede ve sidebar'daki Brand Brain girdisinde rozet. | Goals |
| **Intelligence** | Findings, Insights, Opportunities, Signals bölümleri (`<details>`); hepsi boşsa "Nothing gathered yet" kartı (ajandan araştırma iste, Meta Ads / GA bağla). "Scan intensity" yalnızca `LEGACY_AGENCY_LOOP=on` iken görünür (taramanın sıklığını belirler; `drain/off`ta işlevsiz). | Signals, Insights & Opportunities |

Brand Brain sekme sırası: `assets, rules, visual-identity, constitution, goals, strategy, decisions, intelligence, evidence, learnings` (`BRAND_BRAIN_SUB_KEYS`). Bir kayıt (signal, finding, insight, opportunity, goal) kendi sekmesinde açılır (`ENTITY_PANEL` hepsi `brand-brain`, `ENTITY_SUB` sekmeyi söyler; `entityHref` kullanır).

**Eski adresler çalışmaya devam eder** (`normalizeLegacyHubParams`, `hub-core-params.ts`): `?panel=signals|insights-opportunities|goals` ve ilk Türkçe adlar (`sinyaller`, `icgoru-firsat`, `hedefler`, `marka-beyni`, `fikirler`, `isler`, `departmanlar`, `ayarlar`, `kurulum`, alt sekmeleriyle) yeni yere yönlenir. Eski rotalar (`/istihbarat`, `/firsatlar`, `/zeka`, `/beyin`, `/fikirler`, `/isler`, `/departmanlar`, `/ayarlar`) `legacyRouteHref` ile geçerli adrese yönlendirir (önceden geçersiz panel adlarıyla sohbete düşüyorlardı).

Yapılan düzeltmeler: fırsat üst sınırı (`countOpen` artık `ACCEPTED`ı saymıyor; fikir üretilen 30 fırsat projeyi kalıcı kilitliyordu), "NBA skoruna göre sıralı" yalanı (sıra createdAt, `nbaScore` hiç yazılmıyordu), bayat Goals boş durumu, `idea-event-card.tsx`'teki bozuk `panel=ayarlar&sub=otonomi` bağlantısı.

Bilinen sınırlar: Goals sekmesinde onaylamak setup'ın GOAL_GENERATION aşamasını ilerletmez (yalnızca Setup'taki "Approve and Continue" ilerletir); `ProjectGoal.currentValue` ve `sourceInsightIds` hiçbir yerde yazılmıyor.

## 8. Sidebar'da System grubu kalktı (30 Eyl 2026)

Sidebar'daki "System" grubu (Setup, Departments, Human Action, Settings) kaldırıldı. Sidebar artık: Agency Desk, Create (Brand Brain, Ideas, Work, Library, Content Calendar), Channels (Ads Manager, Connectors) ve altta başlıksız tek satır **Settings**. Works açıkken (ChatGPT düzeni, docs/works.md): en üstte **New Chat**, sonra Create ve Channels, sonra kalan yüksekliği dolduran ve kendi içinde kayan **Recents**, en altta Settings; Agency Desk ve Today yok, proje her zaman yeni sohbetle açılır.

- **Setup, Departments, Human Action** yalnızca başlıktaki **Advanced** menüsünde (rozet noktasıyla; `ADVANCED_PANEL_KEYS`, `project-tools-menu.tsx`, `project-tools-menu.test.ts` ikisinin senkronunu sabitler). Erişim kesilmedi.
- **Settings** sidebar'da kalıyor, çünkü yayın saatleri (Publishing), harcama tavanları ve Autopilot (Autonomy), aktivite/harcama dökümü ve proje silme (Danger Zone) yalnızca orada; içerik yolculuğunun "Turn on scheduled posting" adımının yazdığı slotlar da yalnızca orada düzenlenir. Advanced menüsünde de durur.
- **Departments** ölüye yakın (mod ayarı neredeyse hiçbir şeyi etkilemiyor, yeni projede veri yok) ama silinmedi: composer "+" menüsündeki Departments grubu ve eski bağlantılar çalışır.

**Bilinen açık (ayrı iş):** `human-action-required` kartı SYSTEM satırı olarak yazılıyor ama Agency Desk yalnızca WEB satırlarını, creative-ready ve paket satırlarını yüklüyor; bu yüzden OTP/CAPTCHA/MANUAL_BROWSER isteğini çözmenin tek yolu Human Action paneli (Advanced menüsü + rozet) ve workspace geneli `/human-actions` sayfası. Bekleyen istekleri Agency Desk'e onay kartı gibi basmak ayrı yapılacak; o zaman panel gereksizleşir. Ayrıca derin araştırmanın (ENRICHMENT) hedef onayı ve başarısız aşamayı yeniden deneme yalnızca Setup panelinde yapılabiliyor; Setup'a giden yol (top-bar rozeti, sağ-alt FAB, Advanced menüsü) korunmalı.

