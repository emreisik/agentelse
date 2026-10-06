# Ideas: sürekli dolan fikir havuzu ve post gibi görünen pano (6 Ekim 2026)

Ideas paneli artık kendiliğinden dolan bir fikir havuzudur. Her fikir, hangi modül için olduğunu bilir ve o modülün bitmiş çıktısının taslağını taşır. Pano her fikri o çıktının kendisi gibi çizer: bir post, bir Google sonucu ya da sponsorlu bir gönderi. "Make this post" fikri tek tıkla plan kartına çevirir.

Sahip kararları (6 Ekim 2026):

- Kart görseli marka şablonuyla anında ve ücretsiz çizilir. Gerçek AI görseli yalnız post yapılırken üretilir.
- Havuz akıllı doldurulur: ~20 taze fikir tutulur, 8'in altına inince tamamlanır. "Generate ideas" ile anında da üretilir.

Plan: `~/.claude/plans/precious-cuddling-ullman.md`.

## Mimari: tek havuz, modül tipli fikir

- **Araştırma ortak:** web taraması, sinyal → içgörü → fırsat, bağlı hesaplar, sonuçlardan öğrenilenler ve marka hafızası değişmedi.
- **Fikir modülünü bilir:**
  - Social → post: kanca, görsel başlığı, sahne, altyazı, kanallar, biçim, layout.
  - SEO → makale: anahtar kelime, niyet, başlık, meta açıklama, açı.
  - Ads → öne çıkarma: hangi post, açı, hedef.
  - Analytics fikir üretmez, sinyal kaynağıdır.
- **Tek havuz, tek pano:** modüller süzgeçtir. Üreticiler modül başınadır (istem + şema); kayıt, döndürme ve pano ortaktır.

Neden: ayrı havuzlar araştırmayı ve öğrenmeyi böler, aynı fikri üç kez üretir. Genel fikir ("sonbaharı anlat") ise uygulanamayacak kadar soyuttur. Modül taslağı fikri yapılabilir kılar ve kartı "postun kendisi" yapar.

## 1. Veri (migration yok)

Tipli veri mevcut `Idea.concept` alanında, sürümlü durur. Okurken zod ile doğrulanır; doğrulanmayan, eski ("Older") fikirdir.

```
{ v: 2, module: "social" | "seo" | "ads", source, why?, strength: 1-3,
  expiresAt?, evidence?: [{ title, url }], feedback?, relatedIdeaId?, draft }
```

- `source`: `trend`, `season`, `results`, `brand`, `chat`, `opportunity`, `search`, `manual`.
- Taslaklar:

  | Modül  | `draft`                                                                                                                                     |
  | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | social | `hook` (≤160), `headline` (≤6 kelime), `highlight?`, `visual`, `caption`, `channels` (1-5), `formatKey?`, `layoutId?`, `pillar?`, `timing?` |
  | seo    | `keyword`, `intent`, `title` (≤90), `description` (≤200), `angle`                                                                           |
  | ads    | `creativeId`, `assetId?`, `angle`, `objective` (`traffic` / `awareness` / `engagement`), `audience?`                                        |

- Yeni fikirler **`VALIDATED`** doğar. Eski Council yalnız RAW'ı, Director yalnız SHORTLISTED'ı işler. Böylece `LEGACY_AGENCY_LOOP` hangi moddaysa yeni fikirlere dokunamazlar.
- Satır alanları:
  - `title` = kanca (ya da makale başlığı)
  - `description` = altyazı. Eski okuyucular çalışmaya devam eder.
  - `fingerprint` = modül + kancanın katlanmış kelimeleri. Tekrar kontrolü bunu ve kelime örtüşmesini (≥0,6) kullanır.
- Durum geçişleri (`src/server/state-machine/transitions.ts`):
  - VALIDATED → APPROVED (Save)
  - APPROVED → VALIDATED / SHORTLISTED (Save'i geri al), ARCHIVED, REJECTED. Böylece öne alınmış fikirde "Archive" hatası kapandı.
- Saf dosyalar (istemci güvenli), `src/lib/ideas/`:
  - `concept.ts`: şemalar, `captionIdeaOf`, parmak izi
  - `board.ts`: pano durumları, süzgeç, sıralama
  - `normalize.ts`: model çıktısının temizliği
  - `preview.ts`: kart biçimleri ve layout
  - `copy.ts`: eylem yanıtları

## 2. Üretim (`src/server/ideas/`)

| Modül  | Ne yapar                                                                                                                                                                                                            | Nerede                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Post   | Tek lite çağrı, her biri hazır post olan N fikir. Bağlam: marka profili, başlıklı layout'lar, kanallar, son 8 web sinyali, açık fırsatlar, post sonuçları, öne alınanlar, "Not for us" denenler, son postlar, havuz | `idea-engine.ts` (`IdeaEngine.generate`), `idea-context.ts`, istem `idea-social.ts` (`idea.social`) |
| Makale | Lite çağrı. Search Console "quick wins" sorgularından makale fikirleri; anahtar kelime bir quick win ise kaynak `search` olur                                                                                       | `idea-modules.ts` (`generateSeoIdeas`), istem `idea-seo.ts` (`idea.seo`)                            |
| Reklam | **Modelsiz.** "İşe yaradı" işaretli postlar önce (BrandLearning `creative:<id>:result`, WORKS), yoksa son öne çıkarılabilir postlar. Zaten önerilmiş post yeniden önerilmez                                         | `idea-modules.ts` (`refreshAdIdeas`)                                                                |

Her üretimin son işlemi aynıdır:

1. Temizle: başlık 6 kelimeye kırpılır, kanallar izinliyle kesişir, bilinmeyen layout düşer, son tarih bugün ile +120 gün arasında olmalı, kanıt bağlantısı modelden değil sunucunun sinyalinden gelir.
2. Marka kuralları: ihlalli fikir atılır.
3. Tekrar kontrolü: havuz ve son postlarla karşılaştırılır.
4. Kayıt: `saveIdeaConcepts`.
5. Havuz `maxActiveIdeas` (Settings → Autonomy → Idea pool size) dolunca en eski, dokunulmamış VALIDATED tipli fikirler `ARCHIVED` olur; süresi geçenler önce gider. Öne alınan ya da planlanan fikre asla dokunulmaz.

Tüm çağrılar Autonomy'deki günlük AI limiti ve bütçesine tabidir. Limit dolunca "Today's AI limit is reached" denir.

Motoru çağıranlar:

- Panodaki **Generate ideas** (konu isteğe bağlı; 3 ya da 6; modüller açıkken Posts / Articles)
- **Another angle** (bir fikrin 2 yeni açısı)
- **Turn into a post idea** (eski fikri post fikrine çevirir, eskisini arşivler)
- Brand Brain fırsat kartındaki **Turn into ideas** (`opportunityToIdeasAction`, 3 post fikri)
- Sohbetin `generate_ideas_from_opportunities` komutu (5 post fikri)

Eski `IdeaFoundry` yalnız `reviseIdeaAction` için duruyor.

## 3. Sürekli doldurma

| Ne               | Ne zaman                                                                                                                                                                             | Nerede                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Post fikirleri   | Taze post fikri 8'in altına inince (havuz boyutu daha küçükse o), 20'ye doğru tamamlar, çağrı başına en çok 6. Son `idea.social` çağrısından 6 saat sonra; hata olduysa 1 saat sonra | `idea-refill.ts` (`refillIfDue`)        |
| Makale fikirleri | `MODULES_UI` açık, Search Console bağlı ve 3'ten az taze makale fikri varken; haftada en çok 1 (hata: 6 saat), çağrı başına 3                                                        | `idea-modules.ts` (`moduleRefillIfDue`) |
| Reklam fikirleri | `MODULES_UI` açık ve reklam hesabı bağlıyken; 3'ten az bekliyorsa; en çok 20 saatte 1                                                                                                | `idea-modules.ts` (`moduleRefillIfDue`) |

İki tetikleyici var:

- **Arka plan:** tick adımı `idea-pool-refill` (`src/server/agency/continuous/agency-wiring.ts`, `IdeaRefill.runDue`).
  - Son 14 günde sohbet edilmiş projeler, tur başına model çağrısı yapılan en çok 2 proje, proje başına 10 dakikalık bekleme, `isProjectAgencyActive`.
  - Eski `idea-generation` adımının yerini aldı ve her `LEGACY_AGENCY_LOOP` modunda çalışır.
- **Pano açılınca:** doldurma vadesi geldiyse pano bir kez `generateIdeasAction({ trigger: "refill" })` çağırır ("Topping up your ideas…", iskelet kartlar). Sunucu vadeyi yeniden denetler.
  - Canlıda işçi tetiklenmese de havuz böyle dolar.

Plan fikir kullanınca (`markIdeasPlanned`) havuz azalır; sonraki tur ya da açılış tamamlar.

## 4. Pano

Yer: `/projects/<id>?panel=ideas`.

- `ideas-panel.tsx` veriyi sunucuda `loadIdeaBoard` ile yükler (`src/server/ideas/idea-board.ts`):
  - fikirler ve bağları (`idea.made_post` denetim satırı, `Post.ideaId`)
  - marka kiti, Instagram kullanıcı adı, kanallar
  - havuzun sağlığı, açık modüller
- Bileşenler `src/components/ideas/`: `ideas-board.tsx`, `idea-card.tsx`, `idea-detail.tsx`, `copy.ts`. Tüm metin `copy.ts`'te (W01 kuralı).

**Üst satır:**

- "Ideas", sağlık satırı ("18 fresh · topped up 2h ago").
- **Generate ideas** açılır menüsü: For: Posts / Articles (yalnız modüller açıkken), About, 3/6.

**Süzgeçler:**

- Modül: All · Posts · Articles · Ads · Older. Articles, Ads ve Older yalnız o tür fikir varken görünür.
- Durum: Fresh · Saved · Planned · Done · Archived. Archived, süresi geçenleri de gösterir.
- Kaynak, kanal, sıralama (Best first · Newest · Ending soon) ve arama.

**Kartlar:**

| Tür    | Görünüm                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Post   | Hesap satırı (logo, @kullanıcı, kanal ikonları, Post/Story/Carousel), altında marka layout'u: gerçek başlık metni, vurgu accent renkte, marka renkleri, logo ve bant, marka fontu. Sonra kanca, altyazı, kamera ikonlu sahne, neden, "Strong idea", son tarih |
| Makale | Google sonucu: site adresi, başlık, meta açıklama, anahtar kelime                                                                                                                                                                                             |
| Reklam | "Sponsored" gönderi: postun gerçek görseli ve CTA düğmesi                                                                                                                                                                                                     |
| Eski   | Metin kartı ve "Turn into a post idea"                                                                                                                                                                                                                        |

Kart ayrıntıları:

- Oranlar: Instagram post ve carousel 3:4, Story 9:16, Facebook 4:5.
- Kayıtlı layout'u olmayan markada "classic" düzen kullanılır: görselin üstünde yazı yoktur, kart postla birebir kalır.
- Kart görseli CSS ile çizilir (`LayoutPreview` metin modu: `text`, `ratio`, `fontFamily`, `showLogo`). Ücretsizdir; AI görseli yalnız üretimde yapılır.

**Eylemler:**

- **Make this post** (birincil)
- **Save** (öne al ↔ geri al)
- **⋯** menüsü:
  - Another angle
  - Plan in chat
  - Not for us…: Off-brand / Not relevant now / Done before / Too salesy / Other
  - Archive
- Makale kartında **Write this article**, reklam kartında **Boost this post**.
- Durum satırı: "Draft in chat →", "Planned · Thu 09:00", "Published".

**Detay** (kartı tıklayınca yan panel):

- Biçim sekmeleri (her biçimin layout'uyla) ve markanın başlıklı layout'larından seçici.
- Düzenlenebilir kanca, görsel başlığı (6 kelime sayacı), sahne, altyazı (`updateIdeaDraftAction`).
- Neden ve kanıt bağlantıları.

Eylemler `src/server/actions/idea-board-actions.ts` içinde. Hepsi `authorizeWorks` ve hız kovası kullanır; fikri proje kimliğiyle arar ve yalnız durum makinesiyle taşır.

## 5. Make this post

`makeIdeaPost` (`src/server/ideas/idea-post.ts`), model turu yok, anında açılır. Fikri **takvime tek post olarak koyar**. Sohbetteki fikirde "Add to calendar" ile aynı yazımı kullanır (`createSlots`, `src/server/chat/schedule-slots.ts`):

1. Fikri doğrular: silinmemiş ya da arşivlenmemiş olmalı, post taslağı taşımalı.
2. Kanallar: taslak ∩ izinli kanallar. Her kanal aynı gün, saat ve fikirle tek Post'un bir teslimatıdır.
3. Saat: ilk kanal için `loadSuggestedSlots`; yoksa yarın 10:00.
4. Marka kuralı engeli varsa reddeder ("A brand rule stops this idea…").
5. Hedefler:
   - `topic` = kanca
   - `captionIdea` = `"başlık" | sahne | altyazı`
   - `origin` = `{ kind: "idea", ref }`
   - `ideaId`
6. `createSlots({ newWork })` tek Serializable işlemde yazar: yeni Social Work, WEB satırı ve kaydedilmiş plan kartı (`via: "idea"`), Post ve Creative'ler.
   - Kullanıcı mesajı ve yanıt modele tekrar okunduğu için yalnız kanal, biçim ve saat içerir, fikir metni içermez (SC-7).
   - Fikir zaten takvimdeyse yeni sohbet açılmaz. O postu tutan sohbet açılır.
7. Fikir "Planned" olur (`markIdeasPlanned`) ve `idea.made_post` denetim satırı yazılır.

Sohbet, planlanmış postun kartıyla açılır:

- **Tek kanal:** `PlannedSlotCard` gelir: "Added to your calendar · Thu 8 Oct, 09:00 · Instagram Post". Düğmeler:
  - **Make post:** AI görselini ve metni sohbette canlı üretir. Maliyet satırı düğmenin altındadır.
  - **Change time**
  - **Open calendar**
  - **Remove from calendar**
- **Birden çok kanal:** kayıtlı plan kartı gelir. Tıklayınca sağda plan paneli açılır, üretim oradan başlar.

Not (6 Ekim 2026 düzeltmesi): ilk sürüm taslak bir kart yazıyordu. Taslak kart `via: "idea"` taşıdığı için "takvime eklendi" kartı olarak çiziliyordu. Kart "Added to your calendar" diyordu ama hiçbir düğme göstermiyordu. Bunu iki değişiklik kapattı:

- `isSingleSlotPlan` (`src/lib/works/compact-card.ts`) artık yalnız kayıtlı kartlar için geçerli. O sürümle açılmış eski sohbetlerdeki kart normal plan kartı olarak açılır (Save / Prepare content).
- "Make this post" artık postu gerçekten takvime koyuyor.

**Layout üretime taşınır:**

- `plan-run.ts`, post → `ideaId` → `concept.draft.layoutId` okur.
- Kendi görselini çizen parçanın `payloadExtra.layoutId`'sine koyar.
- Sağlayıcı (`openai-creative.provider.ts`) preset yoksa onu `requestedId` olarak kullanır.
- Başlık brief'te tırnak içinde gider; metin adımı onu aynen basar. Kart = post.

**Makale ve reklam fikirleri:**

- **Write this article:** `?module=seo&idea=<id>` adresine gider.
  - SEO akışının ipucu `{ ideaId, topic }` olur; Brief konusu bununla dolar.
  - Takvime konunca `Post.ideaId` bağlanır ve fikir "Planned" olur.
- **Boost this post:** mevcut `?module=ads&post=<creativeId>` adresine gider.

## 6. Sohbet ve plan

- `loadIdeaPoolForPrompt` (`src/server/chat/idea-pool.ts`) sıralaması:
  1. Öne alınanlar
  2. Panonun post fikirleri, en güçlüsü önce
  3. Eski kısa liste
  4. Geri kalanlar
- Süresi geçen fikirler, makale ve reklam fikirleri sohbete gitmez.
- Post fikri, plan maddesinin kendisi olarak gider: `title` = kanca, `captionIdea`, `channels`.
- `worksIdeaPoolNote` ve haftalık taslak istemi "captionIdea'lı fikri aynen kullan" der. Haftalık taslağın altyazı sınırı bu yüzden 1500'e çıktı.
- **Plan panelindeki "New idea":** alternatif ucu (`/chat/plan/alternatives`, gövdede `index`) önce o post için havuzun kullanılmamış post fikirlerini ekler.
  - Fikirler o postun kanalına göre sıralanır ("From: Idea pool").
  - Model çağrısı yoktur ve ücretli tur harcanmaz.
  - Havuz bitince eski AI alternatiflerine düşer.
  - Kaydedilmiş planda havuz fikrine geçilirse fikir hemen "Planned" olur (`swapPlanItemAction`).

## 7. Öğrenme

- **Not for us:** neden `concept.feedback`'e yazılır, durum REJECTED olur. Son 15'i üretim isteminde "bunlardan kaçın" listesidir.
- **Save:** öne alınanlar "bunlar gibi" örneğidir.
- **Worked / Didn't work:** mevcut `postLessons` aynen kullanılır.

## Sahipte kalanlar

- Migration ve yeni env yok.
- Arka plan doldurma canlıda işçinin tetiklenmesine bağlı: `CRON_SECRET` eşitlemesi ya da `ENABLE_INPROCESS_WORKER=true`. Pano açılınca tamamlama bundan bağımsız çalışır.
- Makale ve reklam fikirleri `MODULES_UI=true` ister:
  - Otomatik makale fikirleri için Search Console bağlı olmalı.
  - Reklam fikirleri için reklam hesabı bağlı olmalı.
  - Post fikirleri her durumda çalışır.
- Tarayıcıda görülmedi.

## Kapsam dışı

- Fikir başına ayrı AI görseli ("Make visual"): ikinci bir görsel yolu ve çift maliyet demek.
- Telegram ya da arka plan bildirimi.
- Video fikirleri.
