# Works ikinci dilim: kart odaklı üretim hattı (dalga 1 ve 2)

Bayrak: `WORKS_UI` (varsayılan **kapalı**) ve `CHAT_ENGINE=agent` (`isWorksEnabled()`, `src/server/works/flag.ts`). Bu dilimde **şema değişikliği ve yeni migration yok**, yeni bağımlılık yok. Birinci dilimin temeli için `docs/works.md`.

## Amaç ve dalga 1 kapsamı

Work, kanal kapılı bir sohbetten **kart odaklı bir üretim hattına** dönüşür: plan -> takvim -> üret -> onayla -> yayınla adımlarının her biri ortak bir kart setinden bir karttır ve her kart bir sonraki butonla biter. Müşteri düz metne bakakalmaz.

Dalga 1 kapsamı (tek başına yayınlanabilir):

- Plan seçenekleri (2-3 yön), slot başına alternatif fikirler, marka kuralı doğrulaması.
- Fikir -> takvim -> üretim -> yayın hızlı akışı.
- Slot-first üretim (bağımsız üretim kalktı).
- Yayın güvenliği (hold kuralı, story, platform bazlı bağlantı kontrolü, çift yayın kilidi).
- Work kapsamlı yolculuk (`approve_plan`).
- Birinci dilimden kalan düzeltmeler (`?integration=` ve Work'e dönüş bağlantısı, "Change channels", çalışıyor göstergesi).

**Dalga 2** (aşağıdaki bölümler): ana mesaj + kanallara uyarlama, üç görsel varyant, Today Work ve günlük özet, Meta Ads kartı, "kanal bağlandı -> Work aç" teklifi.

## Kart seti

Kartlar `src/components/works/` altındaki ortak parçalardan kurulur: `action-card.tsx` (kart iskeleti), `card-actions.tsx`, `card-focus.tsx` (odak), `live-region.tsx` (duyuru), `use-card-action.ts` (buton durumu, görünür "neden kapalı" nedeni), `work-card-host.tsx` ve saf yardımcılar `src/lib/works/host.ts`, `card-action.ts`. Kullanıcıya görünen her metin tek yerden gelir: `src/lib/works/copy.ts` (`WORKS_COPY`, `copyText`).

Yeni kart türleri: `PlanOptionsCard` (`plan-options-card.tsx`), `IdeaOptionsCard` (`idea-options-card.tsx`), `PlannedSlotCard` (`planned-slot-card.tsx`), `PlanCardExtras` (`plan-card-extras.tsx`), `CreativePublishLine` (`creative-publish-line.tsx`), kanal seçim kartı (`channel-select-card.tsx`) ve başlangıç kartları (`starter-cards.tsx`). Eski plan ve creative kartları yalnızca Work içinde (host kapılı) yeni görünümü alır; Work dışında aynı işaretleme kalır.

Kartlar atomik yazılır: `src/server/chat/card-store.ts` (`updateCardInTx`, `updateCommandCard`).

## Plan seçenekleri ve slot alternatifleri

1. "Plan the week" bir `[Plan brief]` ile başlar (sihirbaz, `plan-brief-wizard.tsx`). Model `propose_plan_options` çağırır: 2-3 **yön** (`OPTIONS_MIN`, `OPTIONS_MAX` = `src/lib/works/plan-layout.ts`). Günler modelden değil sunucudan gelir: `layoutPlanSlots` bugünü çapa alır ve ileri taşır; model her seçenek için slot başına tam bir fikir yazar (`worksPlanSlotsNote`).
2. Yön seçimi: `pickPlanOptionAction` (`src/server/actions/plan-options-actions.ts`). Seçilmeyen yönlerin fikirleri plan kartına **bedava alternatif** olarak gelir.
3. Slot başına alternatif: `swapPlanItemAction` (tek dokunuşla değiştirir, maliyeti yok). Sessiz ücretli **More ideas** `POST /api/projects/[projectId]/chat/plan/alternatives` rotasıdır (LLM'li adım Route Handler'dır, Server Action değil); iki alternatif ekler. Maliyet satırı `src/lib/works/cost.ts`.
4. Yönleri değiştirmek ("daha eğlenceli") her zaman **yeni** bir yön kümesi üretir; revize turu yoktur. Tek bir plan istenirse `propose_content_plan` kullanılır.
5. Tek öğelik fikir listesi için `propose_ideas` (`IdeaOptionsCard`).

## Fikir -> takvim -> üretim -> yayın

- **Plan it** -> **Add to calendar**: `scheduleSlotsAction` (`src/server/actions/schedule-slots-actions.ts`). Boş gün/saat önerisi `suggestSlotsAction` ve saf `suggestSlots` (`src/lib/works/free-slots.ts`) ile gelir; bir basışta en çok `MAX_TARGETS_PER_PRESS` (6) hedef, en az `MIN_SLOT_LEAD_MINUTES` (60 dk) ilerisi (`src/lib/works/slot-rules.ts`).
- Slotlar tek yerde yaratılır: `createSlots` (`src/server/chat/schedule-slots.ts`); köken anahtarı `slotOriginKey` (`src/lib/works/slot-origin.ts`) aynı fikrin çift slotunu engeller.
- Yanlış basış geri alınır: `removeSlotAction` (içerik yokken), taşıma: `moveSlotAction`.
- Üretim ve onay aynı kart setiyle sürer; onaylanan parça için kartın altında **yayın satırı** durur (aşağıda).

## Slot-first üretim (bağımsız üretim kalktı)

Work içinde hiçbir şey takvim slotu dışında üretilmez. `generate_image` ve `create_task` (metin: LinkedIn / X / SEO / Ads) önce parçayı **sıradaki boş güne** takvime koyar, sonra o slota üretir: `slotFirstImage` ve `slotFirstText` (`src/server/chat/slot-first.ts`). Görsel yalnızca Instagram (post ve story). Model gün ya da saat sormaz ve vaat etmez.

Work içinde şunlar yoktur: `propose_content_package` ve `generate_ideas_from_opportunities` (`WORKS_HIDDEN_TOOLS`, `src/server/chat/works-skills.ts`). `load_skill` Work'te bu araçları anmayan bir beceri kopyası döner (`worksSkill`). Üretim kapısı: `worksProductionGate` (`src/server/works/production-gate.ts`).

## Marka kuralı doğrulaması

Deterministik denetleyici (LLM yok): `src/lib/works/brand-rules.ts` (`checkText`, `checkItems`, `brandCheckOf`) ve sözlükleri `brand-rule-lexicons.ts`; metin katlama `src/lib/text-fold.ts` (Türkçe ve İngilizce önce). Kurallar `loadBrandRules` (`src/server/works/brand-rule-loader.ts`, en çok `MAX_BRAND_RULES` = 60) ile Brand Brain'den okunur: "asla" kuralları, müşteri kuralları, onaylı iddialar, rakip adları.

Plan, fikir, yön ve slot-first tek gönderilerde çalışır; engelleyen bulgu varsa araç modele düzeltme notu döner (`brandRepairMessage`), müşteri istediyse kuralı değiştirmeyi sormasını söyler. Kural yüklenemezse sessiz geçilmez: "Brand rules couldn't be checked" gösterilir.

## Yayın güvenliği

Hepsi `isWorksEnabled()` arkasında. Saf karar: `src/lib/works/publish-guard.ts` (`canPublishNow`, `describePublishLine`, `PAST_GRACE_MS` = 24 saat).

- **Hold kuralı:** Work'e ait onaylı parçada zaman yoksa ya da zaman 24 saatten eskiyse parça **tutulur** (`QUEUED`, `held`), yayın zamanlaması açık olsa bile. Yayın zamanlamasını açmak eski tutulan parçayı salmaz. Yalnızca gelecek ve vadesi gelmiş (24 saat içinde geçmiş) parçalar salınır. Tutulan parça için **Set a time** (`moveSlotAction`) ya da iki adımlı **Post now** vardır. Sahiplik: `workOwnershipOf` / `ownedPlanIds` (`src/server/works/work-owned.ts`); plan Command'ı silinmiş parça Work'e ait sayılır (fail closed).
- **Story:** `instagram.story` formatı STORIES olarak çıkar; format, istemciden değil parçanın katalog `formatKey`'inden gelir. `formatKey` boşsa FEED.
- **Bağlantı:** kontrol platform bazlıdır (yalnızca LinkedIn bağlı projede Instagram'a yayın reddedilir). El ile formatlar (carousel, reel, tiktok, seo, x.thread) uygulamanın otomatik yayınladığı şey değildir: **Post it** düğmesi her gün elle teslim penceresini açar. Otomatik yayın yalnızca Instagram.
- **Kuyruk:** `publishNextQueuedInstagramCreative` Work'e ait adaylardan yayınlanamayanları ve son 24 saatte yayını başarısız olanları atlar; başı tıkayan Reel kalmaz. Work'e ait olmayan adaylarda eski kural aynen sürer.
- **Çift yayın kilidi:** `publishCreativeCore` (`src/server/commands/publish-creative.ts`) işlemi `pg_advisory_xact_lock(hashtext(creativeId))` altında çalıştırır; sürmekte olan ya da tamamlanmış yayın görevi veya `PUBLISHED` durumu varsa ikinciyi reddeder. İki sekme, iki cihaz ya da eski kart tek gönderi üretir.
- **Dürüst satır:** `publishing` ve `failed` her zaman zamana dayalı satırlardan önce okunur (`publishState` / `publishError`).

## Work kapsamlı yolculuk

- `loadJourneySnapshot(projectId, { workId })` yalnızca o Work'ün plan Command'larındaki parçaları sayar; seçenek verilmezse sorgu aynıdır. `snapshot.workScoped` iki kuralı açar: >= 2 parça incelemedeyse `approve_plan` adımı `review` adımından önce gelir; `connect-<kanal>` adımı artık sessiz (quiet) olmaz.
- `approve_plan`, `approvePlansAction(projectId, { planIds, creativeIds })` (`src/server/actions/work-approve-actions.ts`) çalıştırır: yalnızca **gösterilen** ve hâlâ bekleyen parçaları onaylar; bu arada daha fazlası bittiyse `CHANGED` döner ve hiçbir şey onaylamaz.
- Canlı kart durumu: `withLiveCreativeState` (`src/server/agency/journey/live-creative-state.ts`) kartın durumunu, görselini, planlı zamanını ve yayın satırını Creative satırından üstüne yazar; yalnızca bir parçanın **en yeni** creative-ready kartı. Ayrıntı `docs/content-journey.md`.

## Bayrak kapalıyken değişmeyenler

`WORKS_UI` kapalıyken (varsayılan) ürün bayt bayt eskisi gibidir: modelin gördüğü araç listesi (`toolsForPhase` `works` seçeneği olmadan), istemler, rotalar, sorgular, işaretleme ve saklanan satırlar. Her davranış değişikliği yalnızca `isWorksEnabled()`, bir Work / `workId` varlığı ya da yalnızca Works yollarının yazdığı bir alan arkasındadır. Eski `CHAT_ENGINE` aynen çalışır. Hiçbir şey açık onay ve bir dokunuş olmadan yayınlanmaz, harcanmaz, gönderilmez.

## Açma sırası (migration yok)

Bu dilimde yeni migration yok; ama birinci dilimin `20261001000000_add_work` migration'ı `Command` tablosuna yabancı anahtar ve `CONCURRENTLY` olmayan bir indeks ekler ve tabloyu kısa süre kilitler:

1. Migration'ı **trafiğin az olduğu saatte** uygula (`prisma migrate deploy`), kod **ondan sonra**: önce migration, sonra kod. Birinci ya da ikinci dilim kodu migration'dan önce çalışmamalı.
2. `CHAT_ENGINE=agent` ve `WORKS_UI=true`.
3. Yeni Work -> kanal kartı -> plan yönleri -> kaydet -> üret -> onayla -> yayın satırı.

### Yerel çalıştırma uyarısı

Yerel geliştirme ve production **tek bir Neon veritabanını** paylaşır. `WORKS_UI=true` ile yerelde çalışan bir süreç, **gerçek projelere** Work satırları yazar; bayrağı kapalı ya da eski bir production sürümü bunları görür. Gerçek müşterisi olan bir projeye karşı yerelde asla `WORKS_UI=true` çalıştırma; bayrak açık denemeyi yalnızca bu iş için ayrılmış bir projede yap.

### Bayrağı geri alma (rollback)

`WORKS_UI`'yi kapatmak yayını olduğu gibi bırakmaz: tutulan (held) `APPROVED` Work parçaları sıradan onaylı creative'lere döner ve eski kuyruk onaylı her Instagram parçasını sabit FEED formatıyla yayınlar (story feed gönderisi olarak çıkar, hata veren bir Reel kuyruk başını tıkar). Bu yüzden bayrağı kapatmadan **önce**, zamanlı yayın **kapalıyken**, şu **salt okunur** sorguyu çalıştır ve dönen her satırı ele al (arşivle ya da zaman ver):

```sql
SELECT c.id, c.title, c."formatKey", c."scheduledFor"
FROM "Creative" c
WHERE c.status = 'APPROVED'
  AND c.platform = 'INSTAGRAM'
  AND (
    c."formatKey" IS DISTINCT FROM 'instagram.post'
    OR c."scheduledFor" IS NULL
    OR c."scheduledFor" < now() - interval '24 hours'
  )
  AND c."planId" IN (SELECT id FROM "Command" WHERE "workId" IS NOT NULL);
```

Sorgu boş dönmeden bayrağı kapatma. Today Work satırlarını (`today_` önekli id'ler) `DELETE` ile silmek **güvenli bir temizlik değildir**: o Work'lerin canlı parçaları varken silme parçaları Work'süz bırakır. Bunun yerine Work'ü **arşivle**.

## Test ve elle kontrol listesi

Testler DB'siz (`src/lib/works/*.test.ts`, `src/server/chat/works-*.test.ts`, `slot-first.test.ts`, `schedule-slots.test.ts`, `src/server/actions/schedule-slots-actions.test.ts`, `src/server/commands/*.works.test.ts`, `src/components/works/*.test.ts`). Bayrak kapalı eşdeğerliği için `src/server/chat/tools.works.test.ts` ve `*.works.test.ts` dosyaları.

Elle (paylaşımlı canlı DB ve kredi nedeniyle otomatik değil), ayrılmış bir projede:

1. Yeni Work, kanal seç, "Plan the week": 2-3 yön gelir; birini seç, bir slotta fikir değiştir, More ideas dene.
2. Marka kuralına aykırı bir konu iste: kart uyarır / engeller.
3. Bir fikri takvime ekle (bir basışta birden çok kanal), sonra `Remove` ile geri al.
4. Bir gönderi iste: önce slot, sonra üretim görünür; başka bir gün sorulmaz.
5. Parçaları tek dokunuşla onayla: yayın satırı doğru durumu söyler (tutuldu, planlandı, zamanlı yayın kapalı, sana ait, kilitli).
6. Tutulan parçada `Post now` iki adımlıdır; iki sekmede aynı anda basınca tek gönderi çıkar.
7. Bayrağı kapatmadan önce yukarıdaki geri alma sorgusunu çalıştır.

## Dalga 2: master içerik ve kanal uyarlama

Tek bir ana mesaj yazılır (`propose_master_content`, `src/server/chat/works-tools.ts`; kart `buildMasterCard`, `src/lib/works/master-content.ts`), kanal çipleri seçilir:

- Çipler kartta saklanmaz, bağlantı durumundan her çizimde türetilir: dahil, kilitli ("Publishing locked" + `Connect` bağlantısı) ya da dışarıda (`+ Add`, `addMasterChannelAction`). Varsayılan hedefler Work'ün kanalları eksi reklamdır; reklam yalnızca kişi işaretlerse eklenir. Facebook ve e-posta çip değildir (yayıncısı yok).
- `Adapt to channels` rotası `POST /api/projects/[projectId]/chat/master/adapt`: tekrar çalıştırılabilir, en fazla 3 koşu, 2 dakikalık talep (claim). Yalnızca `targets[*].adaptation` ve `state` yazılır; son kanal metnini yine slot üretimi yazar.
- `Add to calendar` (`scheduleMasterAction`): öncü kanal panelde gösterilen slotu alır (bayatsa `STALE` ve yeni öneri), diğer kanallar ertesi günden kendi serbest slotunu alır. **Önce yalnızca öncü kanalın önerisi görünür**: panel, kaydetmeden önce öncü kanalın önerilen gün ve saatini gösterir ("Other channels follow on the next free day."); diğer kanalların tarihleri kaydedince hesaplanır ve takvimde görünür. Tek Serializable işlemde aynı Command'ın kartı `content-plan-draft` olur (tekrar çalıştırma aynı slotları döndürür).
- Üretim, `Master message:` satırıyla ana mesajla tutarlı kalır; eski kartlarda bu satır yoktur.

## Dalga 2: üç görsel varyant

- Sabitler `src/lib/works/variants.ts`: `VARIANT_COUNT = 3`, `VARIANT_QUALITY = "medium"`, `MAX_VARIANT_ALTERNATIVES = 5`.
- **Maliyet notu:** tek bir açık dokunuşun maliyeti hata yoksa Post için yaklaşık 0,24 USD, Story için 0,32 USD; düğmede yazar ("Makes 3 pictures, about $0.24."). Rota (`POST /api/projects/[projectId]/chat/variants`) önce talep eder, sonra bütçeyi ayırır; ayrılan tutar koşu başarısız olsa da iade edilmez (harcamayı abartır, güvenli taraf).
- **Tek sabit Creative:** slot tek Creative'dir, v1 = varyant 1; diğerleri Asset olarak `generationMetadata.alternatives` içindedir. Ek `CreativeVersion` açılmaz, böylece yayın hep seçilen görseli alır.
- **Onaydan önce seç:** `adoptCreativeVariantAction` yalnızca `IN_REVIEW` ya da sürümlü `DRAFT` parçada çalışır (karşılaştır-ve-yaz, istemciye güvenilmez, Approval üretmez). Onaylandıktan sonra görsel kilitlidir ("Pick before approving. Once approved, the picture is locked.").
- **Kendiliğinden yeniden deneme yok:** varyant işleri (`variantCount`) kendini iyileştirme kuyruğu tarafından yeniden denenmez; aksi halde bir dokunuş 4 kat faturalanabilirdi. Yeniden deneme yine kişinin dokunuşudur.
- **Toplu onay:** Sıradaki Adım şeridindeki `Approve n` adımı (`excludeVariantPieces`, `src/lib/works/variants.ts`, `page.tsx` içinde Work için uygulanır), seçilmemiş alternatifi olan parçaları adımın listesinden çıkarır; onları tek tek seçmek gerekir. Eleme iki yerde yapılır: sayfa tarafı yalnızca düğmenin sayısını ve etiketini düzeltir; asıl karar `approvePlansAction` içindedir. Sunucu, bekleyen her parçanın v1 sürümündeki alternatiflerini kendisi okur; alternatifi olan parça ne onaylanır ne de "görülmemiş" sayılır (tek tek incelenmeye kalır).
- `Make 3 more` (`variantsOnly`) var olan parçaya ekler, üst sınır 5 alternatiftir ve yazma içinde yeniden denetlenir. Düğme yalnızca bütün bir set (3 resim) sığıyorsa görünür: 3 ya da 4 alternatifte gizlidir, böylece ücretli bir resim atılmaz; rota da aynı kuralı (`have + VARIANT_COUNT <= MAX_VARIANT_ALTERNATIVES`) uygular.
- **Alternatifi olmayan parça:** planına bağlı, incelemedeki bir parçada şerit yalnızca `Make 3 more` düğmesi ve maliyet notunu gösterir (üstteki kart resmi zaten gösterir: ikinci küçük resim ve "Pick before approving" notu yoktur). Alternatif gelince küçük resimler, `Current` etiketi ve her biri için `Use this one` görünür. Alternatiften biri seçilince eski resim listede onun yerine geçer; her resim listede tam bir kez görünür (`swapCurrentPicture`, `src/server/execution/variant-card.ts`).
- **Hata okuma:** üç ücretli düğme (şerit, tek slot kartı, master kart) ortak istemci `postVariants` (`src/components/works/variants-client.ts`) üzerinden gider. Rota, ön kontrol reddlerini (BUSY / STATE / LIMIT / BUDGET / PROJECT_INACTIVE) HTTP 200 ile tek bir SSE `error` olayı olarak döndürür; istemci akışı sonuna kadar okur ve HTTP 200'ü tek başına başarı saymaz.
- **Hiç resim çıkmazsa iş başarısız olur:** sağlayıcı, varyant işinde tek resim bile üretilemediyse işi `FAILED` yapar (boş bir parça slotu almaz); slot yeniden denenebilir. Ayrılan bütçe yine iade edilmez.

## Dalga 2: Today Work ve günlük özet

- **Deterministik kimlik:** `today_<projectId>_<dayKey>` (`todayWorkId`, `src/lib/works/work.ts`; gün proje saat diliminde). Şema değişmedi; birincil anahtar tekilliği sağlar. Tek yazan `openTodayWorkAction` (`ensureToday`); sayfa GET'te yazmaz, `?work=today` takma adı açıcıyı gösterir. Today Work tamamlanamaz, arşivlenemez, yeniden adlandırılamaz, silinemez (sunucuda reddedilir). Eski günler listeden gizlenir, bağlantıyla erişilir. Kanallar bağlantı gerektiren bağlı kanallardır (Meta Ads dahil; bağlı bir şey varsa `seo` da); hiçbiri yoksa kanalsız başlar.
- **Canlı kart:** özet (`buildDailyBrief`, `src/lib/works/daily-brief.ts`) saklanmaz, her çizimde gerçek satırlardan (`loadBriefExtras`) hesaplanır; model çağrısı ve ağ çağrısı yoktur. Sayılar yalnızca gerçek satır sayısıdır, uydurma metrik yok.
- **`Plan today` yalnızca plan önerir:** varsayılan plan brifini bugünden başlatır (saat uymuyorsa düğme `Plan the week` olur). Üretmez, onaylamaz, yayınlamaz. Para harcayan ya da onaylayan adım ayrı **Next** satırıdır; kendi etiketi ve maliyetiyle ("Produce 3 · about $0.24"). Test `brief-primary` birincil düğmenin asla sıradaki adım olmamasını korur.
- `Check performance` yalnızca analitik ya da Meta Ads bağlıysa; değilse `Connect analytics` bağlantısı.

## Dalga 2: Meta Ads kartı

- **Hibrit veri:** bütçe önerisi bekleyen `META_CAMPAIGN_UPDATE` / `META_ADSET_UPDATE` görevlerinden (`proposedDailyBudgetCents`), maliyet ve değişim yüzdesi tarayıcının `adsDigest` özetinden (`buildAdsDigest`) gelir. Yeni onay nesnesi ve migration yoktur; onay mevcut `approveApprovalAction` yoluyla yapılır.
- **Beş boş durum** (`buildAdsInsight`, `src/lib/works/ads-insight.ts`): bağlı değil, reklam hesabı seçilmemiş, hiç taranmamış, raporlanacak bir şey yok, bayat (26 saatten eski; "as of" ile eski sayılar).
- **Para birimi yoksa tutar yazılmaz:** öneri yükü para birimi taşımaz; para birimi bilinmiyorsa ya da kuruşsuzsa (JPY/KRW) kart tutar yerine "Change the daily budget (waiting for your approval)" der. "CPL" yalnızca sonuç etiketi Leads ise yazılır; "+%" "son kontrole göre"dir.
- **Özet anahtarı atomik yazılır:** hem tarayıcı hem `refreshAdsPulseAction` yalnızca `adsDigest` anahtarını `jsonb_set` ile yazar; böylece özet yazımı `selectedAdAccountId`'yi geri döndürmez (tarayıcının kendi, eskiden beri var olan son tam-metadata güncellemesi tarama sırasında yapılmış bir hesap seçimini hâlâ geri alabilir). Özet, okunduğu reklam hesabının kimliğini (`adAccountId`) taşır: seçili hesap değişince eski hesabın özeti kartta gösterilmez ve tazelemeyi kısıtlamaz. Tazeleme salt okunur, 5 dakikalık kısıtlamalı ve hız sınırlıdır; kart canlıdır (`ads-<workId>`), saklanmaz.
- **Lead tercihi yalnız özet değildir:** `WORKS_UI` açıkken tarayıcı, `OUTCOME_LEADS` kampanyaları için lead eylemini (`preferLeadFor`) tercih eder; aynı sonuç kuralları (HIGH_CPA, SCALE_BUDGET, trend) ve onay bekleyen bütçe önerileri de bu lead tabanlı maliyeti görür (tıklama tabanlı değil). Bayrak kapalıyken davranış aynıdır. Bayrak açıldıktan sonraki ilk taramada ya da sonuç adı değiştiğinde, eski taramanın anlık görüntüsü sonuç adını taşımadığı için "son taramaya göre" karşılaştırması ve trend bulgusu atlanır (`Leads` maliyeti `Link Clicks` maliyetiyle kıyaslanmaz). `refreshAdsPulseAction` da kampanyaları aynı lead tercihiyle okur ve yalnızca aynı sonuç adını taşıyan önceki satırla karşılaştırır.
- Gerçek para onayları: sahibi olmayan `META_*` kararları `decisionBelongsToWork` ile `ads` kanallı Work'e, Today Work'e ya da hiçbir aktif Work reklamı kapsamıyorsa her Work'e aittir (ulaşılmaz kalmaz).

## Dalga 2: kanal bağlandı -> Work aç

`channelOffers` (`src/lib/works/channel-offers.ts`) canlı bağlantı durumuna bakar (OAuth dönüşüne değil; Instagram Sayfa seçilince kullanılabilir olur). Açık bir Work'ün kapsadığı kanal için `Back to <Work>`, hiçbir açık Work'ün kapsamadığı kanal için `Open a Work for <kanal>` teklifi çıkar (entegrasyon sayfası bandı ve günlük özette bir satır). `openChannelWorkAction` kanalı tam olarak kapsayan aktif Work'ü yeniden kullanır, yoksa açar (iki dokunuş tek Work).

## Sahip kararları (yerleşik varsayılanlar)

Tasarım sırasında sahibine ait çıkan kararlar, önerilen varsayılanla kodlandı. Her biri tek sabit ya da küçük bir değişiklikle tersine çevrilebilir.

| # | Konu | Kodlanan varsayılan | Alternatif |
| --- | --- | --- | --- |
| O1 | Slot başına alternatif | Kaynak başına 2 (seçimde bedava 2, ücretli `More ideas` koşusu başına 2 daha; saklanan toplam 4) | 3 |
| O2 | Büyük planlarda yönler | Yönler yalnızca <= 10 gönderilik planda; büyük plan tek plan aracından geçer | tam plan için tembel genişletme |
| O3 | Varyant varsayılanı | Her açık dokunuşta 3 orta kalite resim, Post ≈ 0,24 USD, Story ≈ 0,32 USD, maliyet düğmede | ilk dokunuşta 1, sonra "2 more" |
| O4 | Onay ve seçim | Onay resmi kilitler ("Pick before approving") | seçime kadar Approval'u ertele |
| O5 | Zamansız ya da 24 saatten eski onaylı parça | Tutulur (held), iki adımlı `Post now`; 24 saat içinde geçmiş zaman sıradaki slotta salınır | eskisi gibi hemen yayınla; farklı tolerans (`PAST_GRACE_MS`) |
| O6 | Takvime alınan fikrin durumu | MEASURING | yayın kancası gelene dek ACTIVE |
| O7 | "Add to calendar" kullanıcı balonu | Görünür, yalnızca kanal etiketiyle | fikir başlığıyla; sessiz SYSTEM satırı |
| O8 | Marka kuralı sertliği | Birebir terim ve sıkı ön ayarlar engeller (`Add anyway` / `Save anyway`), sezgisel olanlar uyarır; Türkçe ve İngilizce sözlük | yalnızca uyar; daha çok dil |
| O9 | Facebook / E-posta / Website | Çıkarıldı; Website = master kartta `seo` etiketi | sonra elle yayınlı `facebook.post` |
| O10 | Çıplak adres ve Today | Çıplak adres en yeni Today olmayan Work'ü açar; Today deterministik kimlikle | çıplak adres Today'i açsın |
| O11 | Kanal bağlandı teklifi | Kanal başına tek açık Work (yeniden kullan) | her seferinde yeni Work |
| O12 | Kart kabuğu | Yeni türlerde model metni gizli, yalnızca kart olan mesajlarda eylem çubuğu gizli | tek satır giriş, Copy |
| O13 | Slot kuralları | Aynı gün 60 dk ilerisi, basış başına 6 hedef, 10:00 / 12:00 / 15:00 / 18:00, Instagram yayın zamanlaması saatleri | başka tolerans, kanal başına sınır, sessiz saatler |
| O14 | Meta çip metni | "Cost / <etiket>", sonuç Leads ise CPL; "+x% vs last check" | gerçek haftalık karşılaştırma |
| O15 | Reddedilen bütçe önerisi | Değişmedi: reddedilen öneri sonraki taramada yeniden doğabilir | bayrak kapılı ret hafızası |
| O16 | 1. dilim migration'ı | `20261001000000_add_work` önce uygulanır (bayrak kapalıyken bile ön koşul); 2. dilim yeni migration eklemez | - |
| O17 | LinkedIn / X / TikTok resimleri | Reddedilir: resim yalnızca Instagram için planlanır, bu kanallar metin alır | resim üreten yol (3. dilim) |
| O18 | `Plan today` | Bugün başlayan plan; harcamaz, onaylamaz | tam olarak bir gönderi |
| O19 | Eklenen slotu geri alma | `Remove` (içerik yokken, satır içi onayla) | geri al bildirimi |
| O20 | `Add & produce` | Kaldı, resim maliyeti düğmede | kaldır |
| O21 | Seçimden sonra tüm yönü değiştirme | Yapılmadı (gönderi başına alternatif var) | "Use another direction" (3. dilim) |
| O22 | Hiçbir şey bağlı değilken Today | Kanalsız (kanal seçici görünür, özet "Connect a channel" der) | yalnızca `seo` |
| O23 | `Post now` | Sessiz ve iki adımlı (satır içi onay) | tek dokunuş |

## Bilinen sınırlar (bilerek kapatılmadı)

İkinci dalga incelemesinde bulunup kapatılmayan, hepsi düşük etkili maddeler. Hiçbiri para ya da yayını sessizce yanlış yapmaz; biri yalnızca birden çok sunucu işleminde fazladan bir set harcayabilir.

- **Ücretli varyant rotasında talep-önce-öde sırası tek işlem içinde kesindir.** `runningProjects` bellek içi kilidi aynı sunucu işleminde ikinci basışı `BUSY` yapar. Birden çok sunucu işlemi (ölçeklenmiş dağıtım) aynı anda aynı parçaya `Make 3 more` alırsa ikisi de bütçeyi ayırıp birer iş açabilir; atomik talep, bütçe ayrılmasından sonra (`plan-run.ts`, `production-run.ts`) alınır ve `more: true` talep almaz. En kötü sonuç bir fazladan set (yaklaşık 0,24-0,32 USD) ve yazmada sınır yeniden denetimiyle atılan resimlerdir. Çözüm gerekirse Postgres advisory kilidi ya da talep-sonra-ayır sırası.
- **Kendini iyileştirme** (`self-healing.service.ts`) atlanan varyant işlerinin ölü mektuplarını `resolvedAt` ile kapatmaz; yalnızca ilk 10 adaylık pencereyi doldurur (gürültü, yan etki yok).
- **Reddedilen bütçe önerisi için bekleme süresi yok** (sahip kararı O15 varsayılanı): reddedilen öneri sonraki taramada yeniden doğabilir.
- **Today kanalları ve günlük özet:** Today Work'ün kanalları bağlı ve bağlantı gerektiren kanallardır (Meta Ads dahil), özetin plan mesajı ise Work kanallarından kurulur; ikisi farklı görünebilir.
- **Odak ve etiketler:** `Review budget change`, `Dismiss` ve `Use this one` sonrası odak açılan satıra taşınmaz; özet kartındaki `Open`/`Review` ve master kartındaki `Connect` bağlantıları kanal bağlamı taşıyan `aria-label` almadı (ortak `CardButton` alanı gerekir).
- **Tarayıcı son metadata güncellemesi:** tarayıcının eskiden beri var olan son tam-metadata güncellemesi tarama sırasında yapılmış bir reklam hesabı seçimini geri alabilir; özet yazımı bunu yapmaz ve hesap damgası eski özetin yanlış hesapta gösterilmesini engeller.
- **Tasarım kopyası:** `copy.ts` tek gerçek kaynaktır; tasarım paketindeki `copy.md` (depo dışı) yeni anahtarları (`ads.checked`, `ads.approved`, `variants.moreDone`, `master.adaptLimit`, `master.channelOutside`, `ads.pause*`) içermez.

## Dalga 2: açma sırası ve son kontrol listesi

Dalga 2'de de **yeni migration yoktur**. Sıra dalga 1 ile aynıdır: migration'ı (`20261001000000_add_work`) önce uygula, kod sonra; `CHAT_ENGINE=agent` ve `WORKS_UI=true`. Yukarıdaki rollback sorgusu ve uyarılar geçerlidir; Today Work satırlarını silme, arşivle.

Son kontrol (ayrılmış bir projede, kredi harcar):

1. Ana mesaj yaz, kanal çiplerini değiştir, `Adapt to channels`, tarihlerin onaydan önce göründüğünü doğrula, `Add to calendar`.
2. Bir parçada `Make 3 visuals` (maliyet notu görünür), birini seç, sonra onayla; onaydan sonra seçimin kilitli olduğunu gör.
3. Seçilmemiş alternatifli parça varken toplu `Approve n` o parçayı atlar.
4. `?work=today`: özet açılır, `Plan today` yalnızca plan önerir, `Next` satırı ayrı ve maliyetli.
5. Meta Ads: beş boş durumu ve para birimsiz öneriyi kontrol et; `Check performance` sonrası hesap seçiminin bozulmadığını doğrula.
6. Yeni kanal bağla: entegrasyon sayfasında `Open a Work for ...` çıkar, iki kez dokununca tek Work oluşur.
7. Bayrağı kapatmadan önce rollback sorgusunu çalıştır.
