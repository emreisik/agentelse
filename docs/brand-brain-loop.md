# Brand Brain döngüsü (4 Ekim 2026)

Her şey New chat (Works) tek ekranından ilerler; arkada sürekli çalışan bir Brand Brain döngüsü sinyal toplar, fikir üretir ve sohbetteki planlamaya öneri yapar. Bu belge döngünün parçalarını, neyin kaldırıldığını ve nasıl açılacağını anlatır.

## Zincir

| Adım                       | Ne yapar                                                                                                                        | Nerede                                                                                                                                              | Sıklık / sınır                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web taraması               | Rakip hamleleri, sektör ve sosyal trendler, yaklaşan kültürel anlar, haberler; her sinyalin kaynak URL'si var                   | `src/server/agency/intelligence/web-signal-scanner.ts`, istem `src/server/reasoning/prompts/web-signal-scan.ts` (`signal.webScan`, web search açık) | Aktif proje başına haftada 1 çağrı; hata olursa 6 saat sonra; tur başına en çok 2 proje; en çok 8 sinyal                                                         |
| Bağlı hesaplar             | Meta Ads (~7 saat), GA4 / Search Console (~24 saat)                                                                             | `src/server/agency/performance/*-scanner.ts`                                                                                                        | değişmedi                                                                                                                                                        |
| Puanlama → içgörü → fırsat | Sinyal puanlanır, içgörü özetlenir, fırsat değerlendirilir                                                                      | `intelligence-engine.ts`, `opportunity-engine.ts`                                                                                                   | İçgörü özeti artık yalnız **son denemeden sonra yeni sinyal/bulgu geldiyse** (`needsInsightSynthesis`); eskiden her turda aynı sinyallerle LLM çağrısı yapıyordu |
| Günlük fikir               | En iyi değerlendirilmiş fırsattan 3 fikir, sessizce (sohbete kart yok)                                                          | `IdeaFoundry.generateDaily` (`idea-generation` adımı)                                                                                               | Proje başına günde 1 çağrı; hata olursa 1 saat sonra; havuz dolunca (`maxActiveIdeas`) çağrı yok; **yalnız `LEGACY_AGENCY_LOOP=drain                             | off` iken** |
| Fikir havuzu               | Ideas paneli: Havuzda / Planlandı / Arşiv; "Put forward" (öne al), "Plan in chat", "Archive"                                    | `src/components/hub-core/panels/ideas-panel.tsx`, durumlar `src/lib/idea-pool.ts`                                                                   | —                                                                                                                                                                |
| Fikirden plan              | Sohbet modeli her turda havuzun ilk 12 fikrini görür; `propose_content_plan` gönderileri önce bunlardan kurar ve `ideaId` yazar | `src/server/chat/idea-pool.ts`, `works-notes.ts` (`worksIdeaPoolNote`), `content-plan.ts` (`keepPoolIdeaIds`)                                       | Sunucu `ideaId`'yi doğrular (projenin havuz fikri mi, tekrar mı); kartta "From: Idea pool"; plan kaydedilince fikir "Planned" olur (`markIdeasPlanned`)          |
| Öneri                      | Plan yokken ve havuzda fikir varken "Plan from ideas"; plan biterken "N ideas are ready in the pool"                            | `next-steps.ts` (`plan_from_ideas`), `next-steps-bar.tsx`                                                                                           | Ideas panelindeki "Plan in chat" = `?planIdea=<id>` → sohbet o fikri planlar                                                                                     |
| Fırsat → fikir (elle)      | Brand Brain → Intelligence → fırsat kartında "Turn into ideas"                                                                  | `opportunityToIdeasAction`                                                                                                                          | Havuz sınırına ve bütçeye tabi                                                                                                                                   |

Tüm LLM çağrıları Autonomy'deki günlük AI çağrı limiti ve bütçesine tabidir (sohbetle ortak).

## Açmak için (sende)

Railway `@agentelse` env: **`LEGACY_AGENCY_LOOP=drain`**. Kod varsayılanı hâlâ `on`; değiştirmek otomatik izin denetiminde reddedildi (canlı davranışı env'siz değiştirirdi). `on` iken eski Council → Director yolu fikirleri kendiliğinden göreve/iş planına çevireceği için günlük fikir adımı çalışmaz. Web taraması ve fırsat→fikir düğmesi her modda çalışır. Sayım sorguları ve `off`'a geçiş: `docs/architecture/legacy-loop-rollout.md`.

## Kaldırılanlar (veri silinmedi, yalnız ekran ve ölü kod)

- **Brand Brain:** Decisions sekmesi; Strategy ve Evidence sekmeleri Constitution sekmesinin altına bölüm oldu ("Strategy versions", "Sources"); Intelligence'taki kırık "Scan intensity"; Learnings → "Memory".
- **Ideas paneli:** lens tahtası, NBA skoru, kurul puanları, ajans kararı, kırık Revise. "Approve" artık "Put forward": ham fikri önce kısa listeye alır (eskiden RAW → APPROVED geçişi hata veriyordu).
- **Work paneli:** Plans, Cycles (handoff), Measurements; panel artık yalnız "Task log", Gelişmiş menüde. Kenar menüden "Work" kalktı.
- **Paneller:** Departments (ve sohbetteki "+" menüsünün Departments grubu), Human Action (+ `/human-actions` sayfası panoya yönleniyor). Setup Gelişmiş menüden çıktı; kurulum sürerken ilerleme rozetinden açılır.
- **Ayarlar:** Decisions sekmesi; Autonomy'de yalnız günlük AI çağrı limiti, fikir havuzu boyutu, günlük bütçe ve Unlimited mode kaldı (görev limiti, bekleme süresi, araştırma limiti, açık fırsat limiti, kurulum otomatik onayı, NBA ağırlıkları, autopilot modları formdan çıktı; DB değerleri duruyor); Publishing'den Auto Content Planning (zamanlayıcı kalan satırı ilk çalıştığında kapatır); Activity'de yalnız AI Reasoning kartı.
- **Döngü:** ölü `signal-scans` adımı (OpenClaw'sız SIGNAL_SCAN görevleri açıp hemen düşüyordu) yerine `web-signal-scan`.
- **Diğer:** panellerden "Back to chat" artık son açık sohbete döner (`ae_last_work_<projectId>` çerezi, `src/lib/works/last-work.ts`); üst bardaki "Today" kutusu "Brand Brain today" (sinyal, yeni fikir, AI maliyeti).

## Faz 4: öğrenme ve haftalık taslak (4 Ekim 2026)

Sahip kararları: `memory/project_faz4_decisions.md` (öğrenmeyi sahip işaretler; Instagram sayaçları saklanmaz, AI'a gitmez; haftalık taslak varsayılan açık).

**Öğrenme ("İşe yaradı / Yaramadı"):**

- Yayınlanan gönderinin kartında (`social-post-card.tsx` → `src/components/works/post-result.tsx`) ve "See results" penceresinde (`plan-results-dialog.tsx`) canlı beğeni/yorum, hesabın son gönderileriyle kıyas (medyan, ±%20; yalnız gösterilir) ve iki düğme.
- Canlı okuma `GET /api/projects/[projectId]/post-results` → `src/server/agency/learning/post-results.ts` (`loadPostResults`): hesabın son 50 medyası tek Graph çağrısı, 10 dk süreç içi önbellek, eşzamanlı okumalar tek istek, Meta limitinde 30 dk duraklama; medya kimliği yayın işinin `rawResult.postId`'si. **Saklanmaz.**
- Karar `recordPostVerdictAction` → `recordPostVerdict`: Memory'ye sayısız ders (`MemoryService.rememberPostResult`, `creative:<id>:result`, OUTPUT_ACCEPTED / OUTPUT_REJECTED: kural değil, ipucu), fikir `LEARNED` + `Idea.scores.results` (gönderi başına karar, sayım), denetim satırı `creative.result_verdict` (karar verildi işareti).
- Fikir bağı: kayıtlı plan kartı (`savedCreativeIds[i]` ↔ `items[i].ideaId`); kart silinirse yayın anında yazılan `creative.published` denetim satırı (`recordPublishedIdeaLink`, `creative-publish-completion.ts`).
- Takas: havuz fikirli bir gönderi başka bir alternatifle değiştirilirse `ideaId` ve onu adlandıran `origin {kind:"idea"}` birlikte alternatife taşınır, geri takasta döner (`src/lib/works/plan-alternatives.ts`). Böylece fikir, artık kullanmayan bir gönderi için ne "scheduled" çipinde görünür, ne "Plan it" yinelenme denetimine takılır, ne de o gönderinin sonucuyla öğrenir.
- Dersler geri besleniyor: günlük fikir istemi (`idea-generation.ts` `postResults`), haftalık taslak, sohbet planı (`worksPostLessonsNote`).
- Şerit: "See results (N)" artık karar bekleyen yayınlanmış gönderileri sayar (`awaitingVerdict`).

**Haftalık plan taslağı:**

- `weekly-plan-draft` adımı (`src/server/agency/content/weekly-plan-draft.ts`): projenin saat diliminde **pazar 18:00–24:00**, gelecek Pzt–Paz için; Works açık, Settings → Autonomy → **Weekly plan draft** açık (`autopilotMode` ≠ REVIEW_EVERYTHING; varsayılan açık), hafta boş, açık taslak yok, havuzda fikir var.
- Slotlar sunucuda sabit (varsayılan kanal, haftada 3, Pzt/Çar/Cum 10:00); proje başına haftada **1 lite AI çağrısı** (`plan.weeklyDraft`) slot başına metin yazar; sunucu fikir kimliklerini (`keepPoolIdeaIds`), metni (`cleanWorksText`) ve marka kurallarını denetler.
- Sonuç: `wkplan_<projectId>_<pazartesi>` kimlikli ayrı sohbet ("Weekly plan · 5–11 Oct") + içinde SYSTEM satırında normal plan kartı (aynı Save/üret akışı); ikisi tek işlemde yazılır, ikinci yazım P2002 ile düşer. Eski dokunulmamış taslak sohbetleri arşivlenir.
- Diğer tüm sohbetlerde şerit: "Review next week's plan" (haftası başlamamış, kaydedilmemiş taslak varken; "Plan from ideas" ve "Plan the next weeks" yerine).
- Dünyada hiçbir yerde pazar akşamı değilken (pazar 04:00 UTC öncesi, pazartesi 12:00 UTC sonrası) adım hiç sorgu atmaz.

## Faz 5: haftalık taslağın otonom üretimi (4-5 Ekim 2026)

Sahip kararı (AskUserQuestion, hepsi önerilen seçenek): **"Hazırla, yayını ben onaylarım"** — onay ve yayın her zaman elle kalır; **"2 saat dokunmazsam kaydet"**; **"Tek dokunuş: gördüklerimi onayla"**; **sorunlu/görselsiz parça atlanır, geri kalan sürer**.

- Yeni, ayrı anahtar: `AutonomyPolicy.weeklyAutoProduce` (migration `20261004180000_add_weekly_auto_produce`, varsayılan **kapalı**) — `autopilotMode`'dan bağımsız (o alan zaten haftalık taslak anahtarı). Settings → Autonomy → "Weekly plan draft" kartının altında "Prepare it automatically"; yalnız üsttekiyle birlikte çalışır.
- `weekly-plan-produce` adımı (`src/server/agency/content/weekly-plan-produce.ts`, `agency-wiring.ts`'de `idea-generation` ile aynı `LEGACY_AGENCY_LOOP≠on` koşulu): haftalık taslağın SYSTEM satırı **2 saatten eski** ve Work'te hiç WEB mesajı yoksa (pano düzenlemesi/takas aynı satırı güncellediği için saymaz — kaydetme zaten o anki hâliyle kaydeder), kaydeder (`savePlanSlotsInTx` + `plan-save-guards.ts`, marka kuralı okunamazsa **kapalı sayılır**, elle kaydetmenin tersine) ve `runContentPlan`'ı (`plan-run.ts`) **SYSTEM aktörüyle** (`userId: null`) sohbetten gelen tıklamayla birebir aynı yoldan, beklenmeden (fire-and-forget) çalıştırır — tick'i bloklamaz.
- `plan-run.ts`/`production-run.ts`: `userId` artık `string | null`; SYSTEM koşusu `createdByType: "SYSTEM"`, kendi Settings bütçe tavanına (`AutonomyPolicyRepository.checkAndIncrement`, `lib/works/cost.ts`'teki tahmini dolarla) tek seferde yazılır — aşarsa hiçbir parça başlamaz, elle "Prepare content"ten üretilebilir kalır (yalnız SYSTEM koşusu; elle tıklama hâlâ bütçesiz).
- `ApprovalRepository.create`'e `notify?: boolean`: SYSTEM görevinden gelen onay Telegram'a gitmez (owner'ın "arka planda bildirim yok" kararı); elle üretilen her şey eskisi gibi bildirim atar.
- Plan panosundaki "Approve and schedule" artık `approvePlansAction`'ı çağırıyor (eskiden kendi gevşek `approvePlanItemsAction`'ı): yalnız panonun o an gösterdiği parçaları onaylıyor, görülmemiş/resim-alternatifli parça varsa tüm onayı reddediyor ("N more pieces are ready. Review them first.") — hem elle hem otomatik üretilen planlar için.
- Görsel çıkmayan parça (decision: atla, devam et) zaten var olan davranışla karşılanıyor: her parça bağımsız üretiliyor, biri başarısız olsa diğerleri sürüyor; ayrıca bir durdurma/onay-engelleme eklenmedi (bilinçli, kapsam dışı — aşağıya bakın).

## Açık kalanlar

- Publishing slotları: gönderi kendi planlanan saatinde değil, saatinden sonraki ilk slotta çıkıyor. Gönderinin kendi saatine geçiş için karar bekleniyor.
- Tam otomatik ölçüm (arka planda okuma, saklama): gizlilik sayfası ve App Review metni değişmeden yapılamaz.
- Legacy kod (Council, Director, WorkPlan, handoff, measurement, `instagram-week-planner` legacy sohbet yolu) `off` doğrulanınca silinebilir.
- **Faz 5'in kapsam dışı bıraktıkları** (haritalama ajanlarının bulduğu, bilerek dokunulmayan gerçek açıklar): `LEGACY_AGENCY_LOOP` kod varsayılanı hâlâ `on` (Railway'de `drain` teyit edilmeli); görselsiz tamamlanan bir parça IN_REVIEW'a düşebiliyor (metin-only post onaya gidebilir); yayın kuyruğu proje PAUSED/Work durumunu okumuyor; Instagram Login token'ı 60 günde yenilenmiyor; aynı saatteki feed+Story'den biri slotta kaybolabiliyor; başarısız yayın 24 saat sonra sessizce "on hold" kalıyor. Hiçbiri Faz 5'in yeni kodunu çalıştırmıyor (onay/yayın hâlâ tamamen elle), ama otonomi ileride "tam otomatik"e taşınırsa önce bunlar kapatılmalı.
