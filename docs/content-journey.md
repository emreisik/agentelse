# İçerik yolculuğu: plan → üret → incele → yayınla → ölç

Plan kaydedildikten sonra süreç durmaz: sistem gerçek kayıtlara bakıp "sıradaki adım"ı söyler, müşteri yazı yazmadan tıklayarak ilerler, her aşama bir sonuçla biter. Bu belge o katmanın nasıl çalıştığını ve sınırlarını anlatır. Plan sihirbazı ve kartı için bkz. [chat-engine.md](./chat-engine.md) "İçerik planlama".

## Neden

Kaydedilen plan takvime boş `DRAFT` `Creative` satırları yazıyordu ve orada duruyordu. `generate_image` ile içerik paketi her seferinde **yeni** bir `Creative` açtığı için plan satırı ile üretilen içerik hiç eşleşmiyordu; sohbet de sıradaki adımı bilmiyordu (öneriyi yalnızca model tahmin ediyordu). Onaylanan Instagram içeriği ise, yayın zamanlaması yoksa, planlı tarihini beklemeden hemen yayınlanıyordu.

## İlkeler

- **Model-bağımsız.** Sıradaki adım `Creative`, `Task`, `Approval`, bağlantılar ve zamanlamalardan deterministik hesaplanır; `CHAT_ENGINE=legacy` ve `agent` altında aynı çalışır. Modele yalnızca **bilgi** olarak verilir (`prompt.ts` tur-başı not; `CHAT_INSTRUCTIONS` değişmedi, önbellekli önek bozulmadı).
- **Yeni tablo ya da migration yok.** Durum türetilir. İlerleme saklanmaz: plan kartındaki `slots` sayfa çizilirken kayıtlardan eklenir (`plan-slots.ts`), saklanan kartta asla yer almaz.
- **Tıkla → anında → canlı.** Üretim sohbet isteğinin içinde `driveJobInline` ile, SSE ile akar (bkz. "İçerik paketi").
- **Maliyet sınırı.** Tek tık, bir planın en yakın haftasındaki (ilk boş günden +6 gün) en çok 7 parçayı üretir, `medium` kalitede, aynı anda 3 iş (paylaşımlı OpenAI kredisi ve istek zaman aşımı). Sonraki hafta ayrı bir sıradaki adımdır.
- **Karar müşteride.** Creative onayı yayın rızasıdır (mevcut `autoPublishCreative` mantığı); reklam `approval` modunda kalır.

## Parçalar

| Parça | Dosya | Görev |
| --- | --- | --- |
| Plan satırı durumu | `src/server/agency/journey/plan-progress.ts` | `PLANNED / PRODUCING / FAILED / IN_REVIEW / REJECTED / APPROVED / PUBLISHED`; `selectProductionBatch` |
| Sıradaki adım motoru | `…/journey/next-steps.ts` | Saf `computeNextSteps(snapshot)`; en çok 3 adım |
| Okuyucu | `…/journey/snapshot.ts` | `loadJourneySnapshot`, `loadNextSteps` (asla fırlatmaz) |
| Kart hidrasyonu | `…/journey/plan-slots.ts` | Kaydedilmiş plan kartına `slots` ekler |
| Devam planı | `…/journey/continuation.ts` | Son planın amaç/kanal/format ve bitişinden sonraki gün |
| Sonuçlar | `…/journey/results.ts` | Ölçüm döngüsünün bildirdikleri, olduğu gibi |
| Tipler | `src/lib/journey.ts` | `NextStep`, `JourneySnapshot`, `nextStepHref`, `selectProductionBatch` (izomorfik) |
| Bağlama | `src/server/execution/plan-creative-link.ts` | Üretimin sonucunu plan satırına yazar |
| Üretim koşucusu | `src/server/chat/plan-run.ts`, `production-run.ts` | Claim + canlı koşu; paket koşucusuyla ortak çekirdek |
| Rota | `src/app/api/projects/[projectId]/chat/plan/route.ts` | SSE (`run.items`, `item.*`, `package.done`) |
| Eylemler | `src/server/actions/plan-progress-actions.ts` | Toplu onay, yayın zamanlamasını aç, "yayınladım", sonuçlar |
| Şerit | `src/components/commands/next-steps-bar.tsx` | Composer üstünde; `useRunNextStep` |

## Plan satırı ↔ üretim bağı

`saveContentPlanAction` her slot için boş bir `DRAFT` Creative yazar. Üretim (`plan-run.ts`) görevin payload'ına `planCreativeId` koyar. Görev bitince:

- **Görsel parçalar:** `materializeCreativeFromResult` ([execution-service.ts](../src/server/execution/execution-service.ts)) yeni Creative açmak yerine `claimPlanCreative` ile slotu devralır: yalnızca aynı projenin **boş `DRAFT`** satırı alınır ve koşullu `updateMany` ile atomik (yeniden deneme ya da yarışan ikinci iş aynı slotu iki kez dolduramaz). Slot `IN_REVIEW` olur, sürüm 1 ve `CREATIVE_APPROVAL` açılır; `scheduledFor`, `channel`, `planId` korunur. Sürüm yazılamazsa slot `DRAFT`'a geri verilir (`releasePlanCreative`).
- **Yazı parçaları** (Reel/TikTok senaryosu, LinkedIn/X metni, makale, reklam metni): `postTaskChatEvent` ([task.repository.ts](../src/server/repositories/task.repository.ts)) sonuç metnini aynı slota `CreativeVersion(copy)` olarak yazar ve onayı açar (`fillPlanCreativeWithText`). Sohbet kartı (`task-result`) ayrıca kalır; bu yazma kartı bozmaz.

Format → üretim eşlemesi `plan-run.ts` `productionFor`: Instagram post/story/carousel görsel (carousel **tek kapak görseli**, slaytlar caption'da), geri kalanı `CREATE_COPY`. Kataloğun her formatının bir yolu vardır (testle pinli). Çalışmayan departman (`agency-focus.ts`) için slot üretilmez.

## Claim ve çift tık

Plan kartı `production: { state: "running", creativeIds, startedAt }` alanını Serializable transaction'da alır; taze (10 dk'dan genç) bir "running" ikinci claim'i reddeder, terk edilmiş olan etmez. Uygun slot = boş DRAFT + açık işi olmayan + üretim yolu olan, plan başına en yakın hafta. Hiçbir görev açılamazsa claim bırakılır.

## Sıradaki adımlar (öncelik sırası)

1. **Tekrar dene**: son denemesi başarısız slot (engelleyici).
2. **Yayınla (N)**: onaylı, müşterinin kendi yayınlayacağı ve günü gelmiş parçalar (engelleyici). "Kendi yayınlayacağı" = kanal `manual` formatta, ya da hesap bağlı değil, ya da Instagram dışı (LinkedIn/X de dahil: otonom yayın yalnızca Instagram).
3. **İncele (N)**: onay bekleyen parçalar. İlk bekleyen kartı sohbette öne çıkarır (`data-creative-id`), yoksa takvimde açar.
4. **Üret (N)**: boş slotların en yakın haftası.
5. **Zamanlı yayını aç**: onaylı, gelecek tarihli Instagram parçası var ama yayın zamanlaması yok.
6. **Bağla**: plandaki bağlı olmayan sosyal kanal (üretimi engellemez, yalnızca otomatik yayını).
7. **Sonraki haftaları planla**: plan bitmeye ≤3 gün kala ya da bitmişse; sihirbaz son planın amaç/kanal/formatıyla önceden dolar ve başlangıç "After your plan" (bitişin ertesi günü) olur.
8. **Sonuçları gör**: ölçüm döngüsü gerçek (mock olmayan) sonuç bildirdiyse. En sonda: hiçbir bekleyen işin önüne geçmez.

Şerit yalnızca **bekleyen işi** gösterir, en çok 3 adım. **Sessiz** (`quiet`) adımlar şeride girmez ve 3'lük sınırdan yer almaz: "Bağla" gibi hiçbir işi engellemeyen ve haftalarca doğru kalabilen adımlar plan kartında ve takvimde kalır, sohbette sürekli yer kaplamaz. Sabit kısayollar (Create a post, Plan the week...) şeritle birlikte her zaman görünür.

Şeridin sağındaki **×** ("Hide for now") o anki adımları gizler. Gizleme tarayıcıda tutulur (`src/lib/journey-dismissal.ts`, yalnızca kolaylık; saklama yoksa şerit olduğu gibi kalır) ve şu kuralla geri gelir: bir adım **büyürse** (gizlendiğinde 9 parça onay beklerken şimdi 10), **yeni bir adım** çıkarsa ya da **24 saat** geçerse. Parçaları onaylayıp sayı azalırsa şerit geri gelmez (ilerleme haber değildir). Takvim aynı adımı üstte bant olarak gösterir; sohbette çalışması gereken adımlar `?next=<tür>` ile sohbete gider ve açılışta **bir kez** çalışır (URL parametresi düşürülür).

## Yayın

- **Doğruluk düzeltmesi:** `autoPublishCreative` artık planlı saati **gelecekteki** bir Instagram parçasını onay anında yayınlamaz: `APPROVED` kalır, `QUEUED` döner. Bir yayın zamanlaması varsa `publishNextQueuedInstagramCreative` saati geçen parçayı bırakır. Zamanlama yoksa sohbet dürüstçe söyler ("Turn on scheduled posting so it goes out then") ve sıradaki adım onu açtırır. Bu, takvimden elle tarih verilen parçalar için de geçerlidir.
- **Zamanlı yayını aç** (`enablePlanPublishingAction`): müşterinin slotları varsa yalnızca açar (saatlerine dokunmaz); yoksa planın kullandığı saatlerden (en çok 3, en sık kullanılandan) Ayarlar → Publishing formunun yazdığı aynı `ProjectSchedule` satırlarını yazar, böylece Ayarlar'da görünür ve düzenlenir. Bağlı Instagram hesabı gerekir.
- **Yayınladım** (`markCreativePublishedAction`): yalnızca `APPROVED` parça, durum makinesiyle `PUBLISHED` olur; sohbet kartı güncellenir, audit yazılır.
- Onay butonu: planlı saati ileride olan Instagram parçasında `approveIntent = "planned"` (etiket "Approve", bildirim "it goes out at its planned time"): kart yayın vaat etmez.

## Ölçüm ve devam

Sonuçlar `MeasurementPlan/MeasurementCheck` kayıtlarından (24s/72s/7g kontroller) okunur; yalnızca tamamlanmış, `isMock` olmayan, metin `observation` taşıyan kontroller ve yalnızca plan parçalarının yayın görevine bağlı olanlar gösterilir; **bildirildiği gibi**, hesaplama ya da tahmin yok, metin kaçışlı. Müşterinin "Yayınladım" dediği parçanın yayın görevi olmadığı için ölçülmez; diyalog bunu söyler.

## Sınırlar

- Carousel tek kapak görseli; slayt metni caption'da.
- Yazı parçalarının onay kartında metin 2 satıra kırpılır; tamamı `task-result` kartında açık durur (bir parça için iki kart).
- Ölçüm verisi serbest metindir (yapılandırılmış metrik yok); sonuç kalitesi ölçüm görevinin kalitesidir. `AGENCY_FOCUS=social_ads` iken ölçüm döngüsü kapalıdır, sonuç adımı çıkmaz.
- Sonuç adımı, sonuç olduğu sürece (30 gün pencere) şeritte kalır; "gördüm" durumu saklanmaz.
- Çalışan üretim sırasında sunucu ölürse kart 10 dk sonra yeniden üretilebilir hale gelir; açık işi olan slot (`PRODUCING`) o sırada atlanır.
- Gerçek görsel üretimi bu makinede denenemedi (paylaşımlı kredi, canlı DB): uçtan uca deneme 2 satırlık bir planla elle yapılmalıdır.

## Work kapsamı

Bir Work içinde yolculuk yalnızca o Work'ün parçalarını sayar: `loadJourneySnapshot(projectId, { workId })` Work'ün plan Command'larındaki creative'leri okur (seçenek verilmezse sorgu eskisiyle aynıdır) ve `snapshot.workScoped` açılır. Ayrıntı: `docs/works-slice2.md`.

- **`approve_plan` adımı:** incelemede >= 2 parça varsa `review` adımından önce gelir ve hesaplandığı parçaları adıyla taşır (`planIds`, `creativeIds`). `approvePlansAction` yalnızca gösterilen ve hâlâ bekleyen parçaları onaylar; bu arada daha fazla parça bittiyse `CHANGED` döner ("N more pieces are ready. Review them first.") ve hiçbir şey onaylamaz. Tamamlanmış Work'ün planları atlanır.
- **Hold kuralı:** Work'e ait onaylı parçada zaman yoksa ya da zaman 24 saatten eskiyse parça, yayın zamanlaması açık olsa bile **tutulur**; zamanlamayı açmak eski parçayı salmaz. Tutulan parça için `Set a time` ya da iki adımlı `Post now` gerekir.
- **`publishLine`:** her creative kartı canlı bir yayın satırı taşır (`scheduled`, `held`, `manual`, `locked`, `publishing`, `failed`, `published`). `publishing` ve `failed` zamana dayalı satırlardan önce okunur; başarısız yayın "goes out ..." demez. Bağlı olmayan kanal için `connect-<kanal>` adımı Work'te sessiz değildir.
